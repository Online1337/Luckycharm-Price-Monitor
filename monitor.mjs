import { chromium } from "playwright";
import fs from "fs";

const URL = "https://luckycharmgold.com/sell-osrs-gold";
const STATE_FILE = "state.json";
const HISTORY_FILE = "price-history.csv";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// IMPORTANT:
// Replace this with your actual numeric Discord User ID.
const DISCORD_USER_ID = "905941622196428901";

const MENTION = `<@${DISCORD_USER_ID}>`;

// Number of attempts before declaring the monitor failed.
const MAX_ATTEMPTS = 3;

// Delay between retry attempts.
const RETRY_DELAY_MS = 15000;

if (!WEBHOOK) {
  throw new Error("DISCORD_WEBHOOK_URL GitHub secret is missing.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function clickFirstVisible(locator) {
  const count = await locator.count();

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);

    try {
      if (await item.isVisible()) {
        await item.click();
        return true;
      }
    } catch {
      // Try the next matching element.
    }
  }

  return false;
}

function extractUsdPrice(text) {
  const match = text.match(
    /Offering\s+up\s+to\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*M/i
  );

  return match ? match[1] : null;
}

async function sendDiscord(message) {
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: message,
      allowed_mentions: {
        users: [DISCORD_USER_ID]
      }
    })
  });

  if (!response.ok) {
    throw new Error(
      `Discord webhook failed: ${response.status} ${response.statusText}`
    );
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );
  } catch (error) {
    throw new Error(
      `Could not read state.json: ${error.message}`
    );
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2) + "\n"
  );
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function ensureHistoryFile() {
  if (!fs.existsSync(HISTORY_FILE)) {
    const header = [
      "timestamp",
      "price",
      "previous_price",
      "direction",
      "change_amount",
      "percent_change",
      "record_status"
    ].join(",");

    fs.writeFileSync(
      HISTORY_FILE,
      header + "\n"
    );

    return true;
  }

  return false;
}

function appendHistory({
  timestamp,
  price,
  previousPrice,
  direction,
  changeAmount,
  percentChange,
  recordStatus
}) {
  const row = [
    timestamp,
    price,
    previousPrice,
    direction,
    changeAmount,
    percentChange,
    recordStatus
  ]
    .map(csvEscape)
    .join(",");

  fs.appendFileSync(
    HISTORY_FILE,
    row + "\n"
  );
}

async function saveDiagnostics(page) {
  if (!page) {
    return;
  }

  try {
    await page.screenshot({
      path: "debug.png",
      fullPage: true
    });

    console.log("Saved debug.png");
  } catch (error) {
    console.error(
      "Could not save debug screenshot:",
      error.message
    );
  }

  try {
    const html = await page.content();

    fs.writeFileSync(
      "debug.html",
      html
    );

    console.log("Saved debug.html");
  } catch (error) {
    console.error(
      "Could not save debug HTML:",
      error.message
    );
  }
}

async function retrievePrice(browser, saveDebugFiles = false) {
  let context;
  let page;

  try {
    context = await browser.newContext({
      locale: "en-US"
    });

    page = await context.newPage();

    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(2500);

    let pageText = await page.locator("body").innerText();
    let currentPrice = extractUsdPrice(pageText);

    /*
     * LuckyCharmGold may initially load EUR, GBP,
     * or another local currency.
     *
     * If no USD price is visible, try opening
     * the currency selector and explicitly choosing USD.
     */
    if (!currentPrice) {
      const currencySelector = page.getByText(
        /^(USD \(\$\)|EUR \(€\)|GBP \(£\))$/,
        { exact: true }
      );

      const opened = await clickFirstVisible(
        currencySelector
      );

      if (opened) {
        await page.waitForTimeout(500);

        const usdOption = page.getByText(
          "USD ($)",
          {
            exact: true
          }
        );

        await clickFirstVisible(usdOption);

        await page.waitForTimeout(2000);

        pageText = await page
          .locator("body")
          .innerText();

        currentPrice = extractUsdPrice(pageText);
      }
    }

    if (!currentPrice) {
      if (saveDebugFiles) {
        await saveDiagnostics(page);
      }

      throw new Error(
        'Could not find a USD "Offering up to $x.xxx/M" price on the page.'
      );
    }

    return currentPrice;

  } catch (error) {
    if (saveDebugFiles && page) {
      await saveDiagnostics(page);
    }

    throw error;

  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // Nothing else needed.
      }
    }
  }
}

async function retrievePriceWithRetries(browser) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      console.log(
        `Price retrieval attempt ${attempt}/${MAX_ATTEMPTS}`
      );

      const price = await retrievePrice(
        browser,
        attempt === MAX_ATTEMPTS
      );

      console.log(
        `Price successfully retrieved on attempt ${attempt}.`
      );

      return price;

    } catch (error) {
      lastError = error;

      console.error(
        `Attempt ${attempt} failed: ${error.message}`
      );

      if (attempt < MAX_ATTEMPTS) {
        console.log(
          `Waiting ${RETRY_DELAY_MS / 1000} seconds before retrying...`
        );

        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(
    `Price retrieval failed after ${MAX_ATTEMPTS} attempts. ` +
    `Last error: ${lastError?.message ?? "Unknown error"}`
  );
}

let browser;

// Load state BEFORE attempting the website.
// This allows us to remember whether an outage
// notification has already been sent.
let state = loadState();

try {
  browser = await chromium.launch({
    headless: true
  });

  const currentPrice =
    await retrievePriceWithRetries(browser);

  console.log(
    `Current LuckyCharmGold USD sell price: $${currentPrice}/M`
  );

  const currentNumber = Number(currentPrice);
  const eventTime = nowIso();

  const previousPrice =
    state.price ?? null;

  const previousNumber =
    previousPrice !== null
      ? Number(previousPrice)
      : null;

  /*
   * ------------------------------------------------
   * MIGRATION / INITIAL SETUP
   * ------------------------------------------------
   *
   * Older state.json versions may already contain:
   *
   * price
   * allTimeHigh
   * allTimeLow
   * checkedAt
   *
   * We preserve those values and add the new fields.
   */

  let stateChanged = false;

  const migrationTimestamp =
    state.checkedAt ?? eventTime;

  if (state.allTimeHigh === undefined) {
    state.allTimeHigh =
      previousPrice ?? currentPrice;

    state.allTimeHighAt =
      migrationTimestamp;

    stateChanged = true;
  }

  if (state.allTimeLow === undefined) {
    state.allTimeLow =
      previousPrice ?? currentPrice;

    state.allTimeLowAt =
      migrationTimestamp;

    stateChanged = true;
  }

  if (state.allTimeHighAt === undefined) {
    state.allTimeHighAt =
      migrationTimestamp;

    stateChanged = true;
  }

  if (state.allTimeLowAt === undefined) {
    state.allTimeLowAt =
      migrationTimestamp;

    stateChanged = true;
  }

  if (state.outageActive === undefined) {
    state.outageActive = false;
    stateChanged = true;
  }

  if (state.outageStartedAt === undefined) {
    state.outageStartedAt = null;
    stateChanged = true;
  }

  if (state.lastRecoveredAt === undefined) {
    state.lastRecoveredAt = null;
    stateChanged = true;
  }

  /*
   * checkedAt existed in the older monitor.
   * We no longer update it because doing so created
   * a Git commit every 15 minutes.
   */
  if ("checkedAt" in state) {
    delete state.checkedAt;
    stateChanged = true;
  }

  /*
   * ------------------------------------------------
   * PRICE HISTORY INITIALISATION
   * ------------------------------------------------
   */

  const historyWasCreated =
    ensureHistoryFile();

  if (historyWasCreated) {
    appendHistory({
      timestamp: migrationTimestamp,
      price: previousPrice ?? currentPrice,
      previousPrice: "",
      direction: "baseline",
      changeAmount: "",
      percentChange: "",
      recordStatus: "monitoring baseline"
    });

    stateChanged = true;

    console.log(
      "Created price-history.csv with initial baseline."
    );
  }

  /*
   * ------------------------------------------------
   * RECOVERY DETECTION
   * ------------------------------------------------
   */

  if (state.outageActive === true) {
    await sendDiscord(
      `${MENTION}\n` +
      `✅ **LuckyCharmGold price monitor recovered**\n\n` +
      `Price retrieval is working again.\n` +
      `Current OSRS sell price: **$${currentPrice}/M**`
    );

    console.log(
      "Monitor recovered from previous outage."
    );

    state.outageActive = false;
    state.lastRecoveredAt = eventTime;
    state.outageStartedAt = null;

    stateChanged = true;
  }

  /*
   * ------------------------------------------------
   * COMPLETELY FRESH MONITOR
   * ------------------------------------------------
   */

  if (previousPrice === null) {
    state.price = currentPrice;

    state.allTimeHigh = currentPrice;
    state.allTimeLow = currentPrice;

    state.allTimeHighAt = eventTime;
    state.allTimeLowAt = eventTime;

    state.startedAt =
      state.startedAt ?? eventTime;

    stateChanged = true;

    await sendDiscord(
      `✅ **LuckyCharmGold monitor started**\n` +
      `Current OSRS sell price: **$${currentPrice}/M**`
    );

    console.log(
      "Initial price recorded."
    );

  /*
   * ------------------------------------------------
   * PRICE CHANGED
   * ------------------------------------------------
   */

  } else if (previousPrice !== currentPrice) {
    const oldNumber =
      Number(previousPrice);

    const highNumber =
      Number(state.allTimeHigh);

    const lowNumber =
      Number(state.allTimeLow);

    const rawDifference =
      currentNumber - oldNumber;

    const absoluteDifference =
      Math.abs(rawDifference);

    const difference =
      absoluteDifference.toFixed(3);

    let percentageChange = 0;

    if (oldNumber !== 0) {
      percentageChange =
        (rawDifference / oldNumber) * 100;
    }

    const percentageText =
      `${percentageChange >= 0 ? "+" : ""}` +
      `${percentageChange.toFixed(2)}%`;

    let direction;
    let directionEmoji;
    let amountPrefix;

    if (currentNumber > oldNumber) {
      direction = "increased";
      directionEmoji = "🟢";
      amountPrefix = "+";
    } else {
      direction = "decreased";
      directionEmoji = "🔴";
      amountPrefix = "-";
    }

    /*
     * Determine record status BEFORE updating
     * the all-time high/low values.
     */
    let recordMessage = "";
    let recordStatus = "";

    if (currentNumber > highNumber) {
      recordMessage =
        `\n\n🏆 **New all-time high since monitoring began!**`;

      recordStatus =
        "new all-time high";

      state.allTimeHigh =
        currentPrice;

      state.allTimeHighAt =
        eventTime;

    } else if (currentNumber === highNumber) {
      recordMessage =
        `\n\n🔁 **Matched the all-time high since monitoring began.**`;

      recordStatus =
        "matched all-time high";

    } else if (currentNumber < lowNumber) {
      recordMessage =
        `\n\n📉 **New all-time low since monitoring began!**`;

      recordStatus =
        "new all-time low";

      state.allTimeLow =
        currentPrice;

      state.allTimeLowAt =
        eventTime;

    } else if (currentNumber === lowNumber) {
      recordMessage =
        `\n\n🔁 **Matched the all-time low since monitoring began.**`;

      recordStatus =
        "matched all-time low";
    }

    await sendDiscord(
      `${MENTION}\n` +
      `${directionEmoji} **LuckyCharmGold OSRS sell price ${direction}**\n\n` +
      `The sell price has **${direction} to $${currentPrice}/M** ` +
      `from **$${previousPrice}/M** since the last change.\n\n` +
      `Change: **${amountPrefix}$${difference}/M (${percentageText})**` +
      recordMessage
    );

    console.log(
      `PRICE CHANGE: $${previousPrice}/M -> $${currentPrice}/M ` +
      `(${percentageText})`
    );

    /*
     * Add this genuine price change to permanent history.
     */
    appendHistory({
      timestamp: eventTime,
      price: currentPrice,
      previousPrice: previousPrice,
      direction: direction,
      changeAmount:
        `${rawDifference >= 0 ? "+" : ""}` +
        rawDifference.toFixed(3),
      percentChange:
        percentageText,
      recordStatus:
        recordStatus
    });

    state.price =
      currentPrice;

    state.lastChangeAt =
      eventTime;

    stateChanged =
      true;

  /*
   * ------------------------------------------------
   * PRICE UNCHANGED
   * ------------------------------------------------
   */

  } else {
    console.log(
      "Price unchanged. No Discord notification sent."
    );
  }

  /*
   * ------------------------------------------------
   * SAVE ONLY WHEN SOMETHING MEANINGFUL CHANGED
   * ------------------------------------------------
   */

  if (stateChanged) {
    saveState(state);

    console.log(
      "Monitor state changed and will be saved."
    );
  } else {
    console.log(
      "Nothing meaningful changed. state.json left untouched."
    );
  }

} catch (error) {
  console.error(error);

  const failureTime =
    nowIso();

  /*
   * ------------------------------------------------
   * OUTAGE HANDLING
   * ------------------------------------------------
   *
   * Only alert on the FIRST failed run of an outage.
   *
   * Further failures remain silent until the monitor
   * successfully retrieves a price again.
   */

  if (state.outageActive !== true) {
    try {
      await sendDiscord(
        `${MENTION}\n` +
        `⚠️ **LuckyCharmGold price monitor failed**\n\n` +
        `I could not retrieve the OSRS sell price after ` +
        `${MAX_ATTEMPTS} attempts.\n\n` +
        `**Error:** ${error.message}\n\n` +
        `You will not be alerted again for this outage ` +
        `unless the monitor first recovers.`
      );

      console.log(
        "Initial outage notification sent."
      );

    } catch (discordError) {
      console.error(
        "Could not send failure notification to Discord:",
        discordError
      );
    }

    state.outageActive =
      true;

    state.outageStartedAt =
      failureTime;

    /*
     * Saving the outage state means the next scheduled
     * run knows not to spam another failure notification.
     */
    try {
      saveState(state);

      console.log(
        "Outage state saved."
      );
    } catch (stateError) {
      console.error(
        "Could not save outage state:",
        stateError
      );
    }

  } else {
    console.log(
      "Outage is already active. Suppressing duplicate Discord alert."
    );
  }

  process.exitCode = 1;

} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Nothing else needed.
    }
  }
}
