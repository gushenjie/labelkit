import { expect, test } from "@playwright/test";
import path from "node:path";

const apiUrl = process.env.LABELKIT_E2E_API_URL!;

test("project dashboard API and visual controls stay connected", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const login = await page.request.post(`${apiUrl}/api/auth/login`, {
    data: { username: "admin", password: "admin" },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };

  const created = await page.request.post(`${apiUrl}/api/projects`, {
    headers,
    data: {
      name: "视觉回归项目",
      description: "用于验证项目管理页",
      task_type: "detect",
      categories: [{ class_id: 0, name: "目标", color: "#12A88F" }],
    },
  });
  expect(created.ok()).toBeTruthy();

  const dashboard = await page.request.get(`${apiUrl}/api/projects/dashboard`, { headers });
  expect(dashboard.ok()).toBeTruthy();
  const payload = await dashboard.json();
  expect(payload.summary.total_projects).toBeGreaterThanOrEqual(1);
  const row = payload.projects.find((item: { project: { name: string } }) => item.project.name === "视觉回归项目");
  expect(row).toBeTruthy();
  expect(row.task_count).toBe(0);

  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "欢迎登录" })).toBeVisible();
  await page.getByPlaceholder("请输入账号").fill("admin");
  await page.locator('input[autocomplete="current-password"]').fill("admin");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "视觉回归项目", exact: true }).first()).toBeVisible();
  await expect(page.locator(".pm-stat-card")).toHaveCount(4);
  const projectCover = page.locator(".pm-project-card__media").first();
  await expect(projectCover).toBeVisible();
  const projectCoverBox = await projectCover.boundingBox();
  expect(projectCoverBox).not.toBeNull();
  expect(Math.abs((projectCoverBox?.width ?? 0) - (projectCoverBox?.height ?? 0))).toBeLessThanOrEqual(1);
  const listShot = testInfo.outputPath("project-list-desktop.png");
  await page.screenshot({ path: listShot });
  await testInfo.attach("project-list-desktop", { path: listShot, contentType: "image/png" });
  await expect(page.locator(".pm-steps").first()).toBeVisible();

  const firstProjectCard = page.locator(".pm-project-card").first();
  await firstProjectCard.hover();
  await expect.poll(() => firstProjectCard.evaluate((element) => getComputedStyle(element).transform)).not.toBe("none");
  const currentStep = page.locator(".pm-steps li.current > span").first();
  await expect(currentStep).toBeVisible();
  expect(await currentStep.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("pm-current-pulse");

  await page.locator(".pm-filter-button").click();
  await expect(page.locator(".pm-more-filters__popover")).toBeVisible();
  expect(await page.locator(".pm-more-filters__popover").evaluate((element) => getComputedStyle(element).animationName)).toBe("pm-popover-in");
  await page.locator(".pm-filter-button").click();

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await firstProjectCard.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await currentStep.evaluate((element) => getComputedStyle(element, "::after").display)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("例如：产线零件缺陷检测")).toBeFocused();
  await page.waitForTimeout(250);
  const modalShot = testInfo.outputPath("create-project-modal-desktop.png");
  await page.screenshot({ path: modalShot });
  await testInfo.attach("create-project-modal-desktop", { path: modalShot, contentType: "image/png" });
  await dialog.locator('input[type="file"]').setInputFiles(path.join(process.cwd(), "public/project-art/default-project-cover.png"));
  await expect(dialog.getByText("自定义封面", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭新建项目弹框" }).click();

  await page.getByPlaceholder("按项目名称、ID 或描述搜索").fill("不存在的项目");
  await expect(page.getByText("没有匹配的项目")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByRole("link", { name: "视觉回归项目", exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "网格视图" }).click();
  await expect(page.locator(".pm-list")).toHaveClass(/pm-list--grid/);
  await page.getByRole("button", { name: "列表视图" }).click();
  await expect(page.locator(".pm-list")).toHaveClass(/pm-list--list/);

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const compactDesktopDialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(compactDesktopDialog).toBeVisible();
  await page.waitForTimeout(250);
  const dialogBox = await compactDesktopDialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect((dialogBox?.x ?? -1) >= 0).toBeTruthy();
  expect((dialogBox?.width ?? Number.POSITIVE_INFINITY) <= 1366).toBeTruthy();
  expect((dialogBox?.height ?? Number.POSITIVE_INFINITY) <= 768).toBeTruthy();
  const compactDesktopShot = testInfo.outputPath("create-project-modal-1366x768.png");
  await page.screenshot({ path: compactDesktopShot });
  await testInfo.attach("create-project-modal-1366x768", { path: compactDesktopShot, contentType: "image/png" });
  expect(browserErrors).toEqual([]);
});
