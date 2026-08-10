import { chromium } from "playwright";
import fs from "fs";

const URL = "https://luckycharmgold.com/sell-osrs-gold";
const STATE_FILE = "state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

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
        parse: []
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

  // If LuckyCharmGold loads a non-USD currency,
  // try to switch the page to USD.
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

  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
      );

      previousPrice = state.price ?? null;
    } catch {
      console.log("Existing state.json could not be read.");
    }
  }

  const checkedAt = new Date().toISOString();

  if (previousPrice === null) {
    await sendDiscord(
      `✅ **LuckyCharmGold monitor started**\n` +
      `Current OSRS sell price: **$${currentPrice}/M**\n` +
      `<${URL}>`
    );

    console.log("Initial price recorded.");

  } else if (previousPrice !== currentPrice) {
    const oldNumber = Number(previousPrice);
    const newNumber = Number(currentPrice);

    let direction = "🔵";

    if (newNumber > oldNumber) {
      direction = "🟢";
    } else if (newNumber < oldNumber) {
      direction = "🔴";
    }

    await sendDiscord(
      `${direction} **LuckyCharmGold OSRS sell price changed**\n` +
      `**$${previousPrice}/M → $${currentPrice}/M**\n` +
      `Checked: ${checkedAt}\n` +
      `<${URL}>`
    );

    console.log(
      `PRICE CHANGE: $${previousPrice}/M -> $${currentPrice}/M`
    );

  } else {
    console.log("Price unchanged. No Discord notification sent.");
  }

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        price: currentPrice,
        checkedAt
      },
      null,
      2
    ) + "\n"
  );

} catch (error) {
  console.error(error);

  // Try to notify Discord that the monitor itself has failed.
  try {
    const failedAt = new Date().toISOString();

    await sendDiscord(
      `⚠️ **LuckyCharmGold price monitor failed**\n` +
      `I could not retrieve the OSRS sell price.\n\n` +
      `**Error:** ${error.message}\n` +
      `Failed at: ${failedAt}\n` +
      `<${URL}>\n\n` +
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
