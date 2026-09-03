import { chromium } from "@playwright/test";

const baseUrl = process.env.LABELKIT_VISUAL_BASE_URL || "http://127.0.0.1:3003";
const projectId = process.env.LABELKIT_VISUAL_PROJECT_ID;
const targetPath = process.env.LABELKIT_VISUAL_PATH || (projectId ? `/projects/${projectId}` : "/");
const targetSelector = process.env.LABELKIT_VISUAL_SELECTOR || ".project-overview";
const clickSelector = process.env.LABELKIT_VISUAL_CLICK;
const output = process.env.LABELKIT_VISUAL_OUTPUT || "artifacts/project-overview-1536.png";
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
  process.stdout.write("opening project page\n");
  await page.goto(`${baseUrl}${targetPath}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await Promise.race([
    page.waitForURL("**/login**", { timeout: 30_000 }).catch(() => null),
    page.locator(targetSelector).waitFor({ state: "visible", timeout: 30_000 }).catch(() => null),
  ]);
  process.stdout.write(`opened ${page.url()}\n`);
  if (page.url().includes("/login")) {
    await page.getByLabel("账号").fill(process.env.LABELKIT_VISUAL_USERNAME || "admin");
    await page.locator('input[autocomplete="current-password"]').fill(process.env.LABELKIT_VISUAL_PASSWORD || "admin");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForTimeout(500);
    process.stdout.write(`after login ${page.url()}\n`);
  }
  await page.locator(targetSelector).waitFor({ state: "visible", timeout: 15_000 });
  if (clickSelector) {
    await page.locator(clickSelector).click();
    await page.waitForTimeout(220);
  }
  await page.screenshot({ path: output, fullPage: true });

  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value
        ? { x: value.x, y: value.y, width: value.width, height: value.height }
        : null;
    };
    const navLinks = Array.from(document.querySelectorAll(".app-sidebar__nav-link")).slice(0, 5).map((element) => {
      const value = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: value.height,
        minHeight: style.minHeight,
        padding: style.padding,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
      };
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sidebar: rect(".app-sidebar"),
      header: rect(".app-commandbar"),
      main: rect(".app-main"),
      hero: rect(".project-overview__hero"),
      layout: rect(".project-overview__layout"),
      pipeline: rect(".project-pipeline"),
      quality: rect(".project-quality"),
      assets: rect(".project-overview__rail > .project-rail-section:nth-child(2)"),
      task: rect(".project-overview__rail > .project-rail-section:nth-child(1)"),
      navLinks,
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
