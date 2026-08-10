import { chromium } from "playwright";
import fs from "fs";

const URL = "https://luckycharmgold.com/sell-osrs-gold";
const STATE_FILE = "state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// Replace this with your actual Discord User ID.
const DISCORD_USER_ID = "905941622196428901";
const MENTION = `<@${DISCORD_USER_ID}>`;

if (!WEBHOOK) {
  throw new Error("DISCORD_WEBHOOK_URL GitHub secret is missing.");
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

let browser;

try {
  browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    locale: "en-US"
  });

  const page = await context.newPage();

  await page.goto(URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(2500);

  let pageText = await page.locator("body").innerText();
  let currentPrice = extractUsdPrice(pageText);

  // LuckyCharmGold may load in EUR/GBP depending on location.
  // If USD is not found, try switching the site's currency to USD.
  if (!currentPrice) {
    const currencySelector = page.getByText(
      /^(USD \(\$\)|EUR \(€\)|GBP \(£\))$/,
      { exact: true }
    );

    const opened = await clickFirstVisible(currencySelector);

    if (opened) {
      await page.waitForTimeout(500);

      const usdOption = page.getByText("USD ($)", {
        exact: true
      });

      await clickFirstVisible(usdOption);

      await page.waitForTimeout(2000);

      pageText = await page.locator("body").innerText();
      currentPrice = extractUsdPrice(pageText);
    }
  }

  if (!currentPrice) {
    await page.screenshot({
      path: "debug.png",
      fullPage: true
    });

    throw new Error(
      'Could not find a USD "Offering up to $x.xxx/M" price on the page.'
    );
  }

  console.log(`Current LuckyCharmGold USD sell price: $${currentPrice}/M`);

  let previousPrice = null;
  let allTimeHigh = null;
  let allTimeLow = null;

  // Read previous state if it exists.
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
      );

      previousPrice = state.price ?? null;
      allTimeHigh = state.allTimeHigh ?? null;
      allTimeLow = state.allTimeLow ?? null;
    } catch {
      console.log("Existing state.json could not be read.");
    }
  }

  const currentNumber = Number(currentPrice);

  /*
   * MIGRATION / FIRST RUN OF THIS VERSION
   *
   * Older versions of state.json only contained "price".
   * If allTimeHigh/allTimeLow do not exist yet, initialise both
   * using the current genuine LuckyCharmGold price.
   *
   * This means the earlier fake $0.209 test will not become the
   * monitor's permanent all-time low.
   */
  if (allTimeHigh === null) {
    allTimeHigh = currentPrice;
  }

  if (allTimeLow === null) {
    allTimeLow = currentPrice;
  }

  let highNumber = Number(allTimeHigh);
  let lowNumber = Number(allTimeLow);

  if (previousPrice === null) {
    // Completely fresh monitor.
    allTimeHigh = currentPrice;
    allTimeLow = currentPrice;

    await sendDiscord(
      `✅ **LuckyCharmGold monitor started**\n` +
      `Current OSRS sell price: **$${currentPrice}/M**`
    );

    console.log("Initial price recorded.");

  } else if (previousPrice !== currentPrice) {
    const oldNumber = Number(previousPrice);

    let direction;
    let directionEmoji;

    if (currentNumber > oldNumber) {
      direction = "increased";
      directionEmoji = "🟢";
    } else {
      direction = "decreased";
      directionEmoji = "🔴";
    }

    const difference = Math.abs(
      currentNumber - oldNumber
    ).toFixed(3);

    /*
     * Work out the high/low status BEFORE updating the records.
     */
    let recordMessage = "";

    if (currentNumber > highNumber) {
      recordMessage =
        `\n\n🏆 **New all-time high since monitoring began!**`;
      allTimeHigh = currentPrice;

    } else if (currentNumber === highNumber) {
      recordMessage =
        `\n\n🔁 **Matched the all-time high since monitoring began.**`;

    } else if (currentNumber < lowNumber) {
      recordMessage =
        `\n\n📉 **New all-time low since monitoring began!**`;
      allTimeLow = currentPrice;

    } else if (currentNumber === lowNumber) {
      recordMessage =
        `\n\n🔁 **Matched the all-time low since monitoring began.**`;
    }

    await sendDiscord(
      `${MENTION}\n` +
      `${directionEmoji} **LuckyCharmGold OSRS sell price ${direction}**\n\n` +
      `The sell price has **${direction} to $${currentPrice}/M** ` +
      `from **$${previousPrice}/M** since the last change.\n\n` +
      `Change: **$${difference}/M**` +
      recordMessage
    );

    console.log(
      `PRICE CHANGE: $${previousPrice}/M -> $${currentPrice}/M`
    );

    /*
     * If it wasn't caught above, make sure the stored records
     * remain correct.
     */
    if (currentNumber > Number(allTimeHigh)) {
      allTimeHigh = currentPrice;
    }

    if (currentNumber < Number(allTimeLow)) {
      allTimeLow = currentPrice;
    }

  } else {
    console.log("Price unchanged. No Discord notification sent.");

    /*
     * Safety check: ensure records remain valid even if state.json
     * was manually edited.
     */
    if (currentNumber > Number(allTimeHigh)) {
      allTimeHigh = currentPrice;
    }

    if (currentNumber < Number(allTimeLow)) {
      allTimeLow = currentPrice;
    }
  }

  // Save the latest price and historical monitor records.
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        price: currentPrice,
        allTimeHigh: allTimeHigh,
        allTimeLow: allTimeLow,
        checkedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n"
  );

} catch (error) {
  console.error(error);

  // Notify Discord if the monitor cannot retrieve the price
  // or otherwise fails.
  try {
    await sendDiscord(
      `${MENTION}\n` +
      `⚠️ **LuckyCharmGold price monitor failed**\n\n` +
      `I could not retrieve the OSRS sell price.\n\n` +
      `**Error:** ${error.message}\n\n` +
      `Check the latest GitHub Actions run for details.`
    );
  } catch (discordError) {
    console.error(
      "Could not send failure notification to Discord:",
      discordError
    );
  }

  process.exitCode = 1;

} finally {
  if (browser) {
    await browser.close();
  }
}
