import { chromium } from "@playwright/test";

const baseUrl = process.env.LABELKIT_VISUAL_BASE_URL || "http://127.0.0.1:3003";
const output = process.env.LABELKIT_VISUAL_OUTPUT || "artifacts/dataset-center-1536.png";
const viewportWidth = Number(process.env.LABELKIT_VISUAL_WIDTH || 1536);
const viewportHeight = Number(process.env.LABELKIT_VISUAL_HEIGHT || 1024);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto(`${baseUrl}/datasets`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const account = page.getByLabel("账号");
  await Promise.race([
    account.waitFor({ state: "visible", timeout: 20_000 }).catch(() => null),
    page.locator(".dataset-workspace").waitFor({ state: "visible", timeout: 20_000 }).catch(() => null),
  ]);
  if (page.url().includes("/login") || await account.isVisible()) {
    await account.fill(process.env.LABELKIT_VISUAL_USERNAME || "admin");
    await page.locator('input[autocomplete="current-password"]').fill(process.env.LABELKIT_VISUAL_PASSWORD || "admin");
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  await page.locator(".dataset-workspace").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".dataset-skeleton").waitFor({ state: "detached", timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(250);
  await page.mouse.move(viewportWidth - 4, 4);
  await page.screenshot({ path: output, fullPage: true });

  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      commandbar: rect(".app-commandbar"),
      main: rect(".app-main"),
      metrics: rect(".dataset-metrics"),
      toolbar: rect(".dataset-toolbar"),
      firstRow: rect(".dataset-row"),
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    };
  });
  geometry.consoleErrors = consoleErrors;
  process.stdout.write(`${JSON.stringify(geometry, null, 2)}\n`);
} finally {
  await browser.close();
}
