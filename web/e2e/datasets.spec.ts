import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const apiUrl = process.env.LABELKIT_E2E_API_URL!;
const runtimeRoot = process.env.LABELKIT_E2E_RUNTIME!;
const python = process.env.LABELKIT_E2E_PYTHON!;
const repositoryRoot = path.resolve(__dirname, "../..");
const fixturesDir = path.join(runtimeRoot, "dataset-fixtures");

test.beforeAll(() => {
  execFileSync(python, [path.join(repositoryRoot, "tests/fixtures/generate_acceptance_media.py"), fixturesDir]);
});

test("dataset center creates and reuses an immutable version", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  const projectName = `数据版本验收-${Date.now()}`;
  const created = await page.request.post(`${apiUrl}/api/projects`, {
    data: {
      name: projectName,
      description: "验证数据集管理闭环",
      task_type: "detect",
      categories: [{ class_id: 0, name: "目标", color: "#12A88F" }],
    },
  });
  expect(created.ok()).toBeTruthy();
  const project = await created.json() as { id: string };

  await page.goto("/login?next=/datasets");
  await page.getByLabel("账号").fill("admin");
  await page.locator('input[autocomplete="current-password"]').fill("admin");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/datasets$/);
  await page.goto(`/projects/${project.id}/materials`);
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles([
    path.join(fixturesDir, "sample-00.png"),
    path.join(fixturesDir, "sample-01.png"),
    path.join(fixturesDir, "sample-02.png"),
    path.join(fixturesDir, "sample-03.png"),
  ]);
  await expect(page.getByText("已上传 4 张图片")).toBeVisible();

  const framesResponse = await page.request.get(`${apiUrl}/api/projects/${project.id}/frames/page?statuses=unlabeled&sort=recent&limit=100`);
  const frames = (await framesResponse.json()).items as Array<{ id: string }>;
  expect(frames).toHaveLength(4);
  for (const frame of frames) {
    const result = await page.request.put(`${apiUrl}/api/projects/${project.id}/frames/${frame.id}/annotations`, {
      data: { annotations: [{ class_id: 0, x_center: .5, y_center: .5, width: .4, height: .4 }], status: "human_ok" },
    });
    expect(result.ok()).toBeTruthy();
  }

  await page.goto("/datasets");
  await expect(page.getByRole("heading", { name: "数据管理" })).toBeVisible();
  await page.getByRole("button", { name: "创建数据集" }).click();
  const dialog = page.getByRole("dialog", { name: "创建数据集" });
  await dialog.getByRole("combobox").first().selectOption(project.id);
  await dialog.getByRole("button", { name: "创建版本" }).click();
  await expect(page.getByRole("button", { name: new RegExp(projectName) })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("dialog", { name: "数据集 v1" })).toBeVisible();
  await expect(page.getByText("内容校验值")).toBeVisible();
  const desktopShot = testInfo.outputPath("dataset-desktop.png");
  await page.screenshot({ path: desktopShot, fullPage: true });
  await testInfo.attach("dataset-desktop", { path: desktopShot, contentType: "image/png" });

  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(page.getByRole("link", { name: "用于训练" })).toBeVisible();
  const compactShot = testInfo.outputPath("dataset-compact-desktop.png");
  await page.screenshot({ path: compactShot, fullPage: true });
  await testInfo.attach("dataset-compact-desktop", { path: compactShot, contentType: "image/png" });

  await page.getByRole("link", { name: "用于训练" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/train\\?datasetVersion=`));
  const sourceSelect = page.getByLabel("训练数据来源");
  await expect(sourceSelect).not.toHaveValue("");
  await expect(page.getByText(/正在复用数据集 v1/)).toBeVisible();

  let postedVersion = "";
  await page.route(`${apiUrl}/api/projects/${project.id}/tasks`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    postedVersion = String(body.params?.dataset_version_id || "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "fake-train", project_id: project.id, task_type: "train", status: "pending",
        progress: 0, total: 0, params: body.params, result: {}, log: "", error: "",
        cancel_requested: false, heartbeat_at: null, retry_of_task_id: null, created_at: new Date().toISOString(),
      }),
    });
  });
  await page.getByRole("button", { name: "开始训练" }).click();
  await expect.poll(() => postedVersion).not.toBe("");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/datasets");
  await expect(page.getByRole("button", { name: new RegExp(projectName) })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("dialog", { name: "数据集 v1" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  const mobileShot = testInfo.outputPath("dataset-mobile.png");
  await page.screenshot({ path: mobileShot, fullPage: true });
  await testInfo.attach("dataset-mobile", { path: mobileShot, contentType: "image/png" });
  expect(errors).toEqual([]);
});
