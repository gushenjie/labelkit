import { expect, Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const apiUrl = process.env.LABELKIT_E2E_API_URL!;
const runtimeRoot = process.env.LABELKIT_E2E_RUNTIME!;
const python = process.env.LABELKIT_E2E_PYTHON!;
const repositoryRoot = path.resolve(__dirname, "../..");
const fixturesDir = path.join(runtimeRoot, "fixtures");
const detectModel = process.env.LABELKIT_E2E_DETECT_MODEL || "yolo11n.pt";
const classifyModel = process.env.LABELKIT_E2E_CLASSIFY_MODEL || "yolo11n-cls.pt";

type Project = { id: string; task_type: "detect" | "classify" };
type Frame = { id: string; filename: string };
type Task = { id: string; task_type: string; status: string; error: string; result: Record<string, unknown> };

test.beforeAll(() => {
  execFileSync(python, [path.join(repositoryRoot, "tests/fixtures/generate_acceptance_media.py"), fixturesDir]);
});

async function createProject(page: Page, taskType: "detect" | "classify"): Promise<Project> {
  await page.goto("/?create=1");
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(dialog.getByText("请输入项目名称")).toBeVisible();

  await dialog.getByPlaceholder("例如：产线零件缺陷检测").fill(`v1-${taskType}-${Date.now()}`);
  if (taskType === "classify") {
    await dialog.getByText("图像分类", { exact: true }).click();
  }
  await dialog.getByRole("button", { name: "添加类别" }).click();
  const categoryInputs = dialog.locator('.category-field input[placeholder*="例如"]');
  await categoryInputs.nth(0).fill("square");
  await categoryInputs.nth(1).fill("circle");
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/);

  const project = await page.request.get(`${apiUrl}/api/projects/${page.url().split("/").pop()}`);
  expect(project.ok()).toBeTruthy();
  return project.json();
}

async function uploadImageBatches(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/materials`);
  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles(path.join(fixturesDir, "invalid.jpg"));
  await expect(page.getByText(/图片上传失败/)).toBeVisible();

  const images = Array.from({ length: 12 }, (_, index) => path.join(fixturesDir, `sample-${index.toString().padStart(2, "0")}.png`));
  await input.setInputFiles(images.slice(0, 6));
  await expect(page.getByText("已上传 6 张图片")).toBeVisible();
  await input.setInputFiles(images.slice(6));
  await expect(page.getByText("已上传 6 张图片")).toBeVisible();
}

async function pollTask(page: Page, projectId: string, taskType: string): Promise<Task> {
  let latest: Task | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`${apiUrl}/api/projects/${projectId}/tasks`);
    const tasks = await response.json() as Task[];
    latest = tasks.find((task) => task.task_type === taskType);
    return latest?.status;
  }, { timeout: 5 * 60 * 1000, intervals: [500, 1000, 2000] }).toMatch(/completed|failed/);
  expect(latest?.status, latest?.error).toBe("completed");
  return latest!;
}

async function seedReviewLabels(page: Page, project: Project): Promise<Frame[]> {
  const response = await page.request.get(
    `${apiUrl}/api/projects/${project.id}/frames/page?statuses=unlabeled&sort=recent&limit=100`,
  );
  expect(response.ok()).toBeTruthy();
  const frames = (await response.json()).items as Frame[];
  expect(frames.length).toBeGreaterThanOrEqual(12);
  for (let index = 0; index < frames.length; index += 1) {
    const classId = index % 2;
    const annotations = project.task_type === "classify"
      ? [{ class_id: classId }]
      : [{ class_id: classId, x_center: 0.5, y_center: 0.5, width: 0.55, height: 0.55 }];
    const result = await page.request.put(`${apiUrl}/api/projects/${project.id}/frames/${frames[index].id}/annotations`, {
      data: { annotations, status: "needs_human" },
    });
    expect(result.ok()).toBeTruthy();
  }
  return frames;
}

async function confirmReviewAndRemainder(page: Page, project: Project, frames: Frame[]): Promise<void> {
  await page.goto(`/projects/${project.id}/review?filter=pending`);
  await expect(page.getByRole("heading", { name: "人工确认" })).toBeVisible();
  if (project.task_type === "classify") {
    await page.getByRole("button", { name: "square", exact: true }).click();
  }
  await page.getByRole("button", { name: "Y 确认 (保存)", exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${apiUrl}/api/projects/${project.id}/frames/stats`);
    return (await response.json()).human_ok ?? 0;
  }).toBeGreaterThanOrEqual(1);

  const remaining = await page.request.get(
    `${apiUrl}/api/projects/${project.id}/frames/page?statuses=needs_human&sort=recent&limit=100`,
  );
  for (const [index, frame] of ((await remaining.json()).items as Frame[]).entries()) {
    const classId = index % 2;
    const annotations = project.task_type === "classify"
      ? [{ class_id: classId }]
      : [{ class_id: classId, x_center: 0.5, y_center: 0.5, width: 0.55, height: 0.55 }];
    const result = await page.request.put(`${apiUrl}/api/projects/${project.id}/frames/${frame.id}/annotations`, {
      data: { annotations, status: "human_ok" },
    });
    expect(result.ok()).toBeTruthy();
  }
  expect(frames.length).toBeGreaterThanOrEqual(12);
}

async function trainThroughUi(page: Page, project: Project): Promise<Task> {
  await page.route(`${apiUrl}/api/projects/${project.id}/tasks`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON();
    if (payload.task_type !== "train") return route.continue();
    payload.params = {
      ...payload.params,
      epochs: 1,
      imgsz: 64,
      batch: 2,
      workers: 0,
      device: "cpu",
      base_model: project.task_type === "classify" ? classifyModel : detectModel,
    };
    const response = await route.fetch({
      postData: JSON.stringify(payload),
      headers: { ...route.request().headers(), "content-type": "application/json" },
    });
    await route.fulfill({ response });
  });

  await page.goto(`/projects/${project.id}/train`);
  await expect(page.getByText("训练已就绪")).toBeVisible();
  const parameters = page.locator(".train-control-panel input[type=number]");
  await parameters.nth(0).fill("1");
  await parameters.nth(1).fill("64");
  await parameters.nth(2).fill("2");
  await page.locator(".train-control-panel select").selectOption("cpu");
  await page.getByRole("button", { name: "开始训练" }).click();
  const task = await pollTask(page, project.id, "train");
  await page.unroute(`${apiUrl}/api/projects/${project.id}/tasks`);
  return task;
}

async function exportAndTrial(page: Page, project: Project): Promise<void> {
  const exportPath = path.join(runtimeRoot, "exports", project.id);
  await page.goto(`/projects/${project.id}/train`);
  await page.getByPlaceholder(/dataset/).fill(exportPath);
  await page.getByRole("button", { name: "导出数据集" }).click();
  await page.getByRole("button", { name: "开始导出" }).click();
  await page.goto(`/projects/${project.id}/tasks`);
  const exportTask = await pollTask(page, project.id, "export");
  const publishedPath = String(exportTask.result.path);
  expect(path.basename(publishedPath)).toBe(project.id);
  expect(fs.existsSync(path.join(publishedPath, ".labelkit-export.json"))).toBeTruthy();

  const unsafe = await page.request.post(`${apiUrl}/api/projects/${project.id}/tasks`, {
    data: { task_type: "export", params: { output_dir: "C:\\", overwrite: true } },
  });
  expect(unsafe.ok()).toBeTruthy();
  const unsafeId = ((await unsafe.json()) as Task).id;
  let unsafeTask: Task | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`${apiUrl}/api/projects/${project.id}/tasks`);
    unsafeTask = (await response.json() as Task[]).find((task) => task.id === unsafeId);
    return unsafeTask?.status;
  }).toBe("failed");
  expect(unsafeTask?.error).toContain("根目录");

  await page.goto(`/models?project=${project.id}`);
  await expect(page.getByRole("heading", { name: "在线试用", exact: true })).toBeVisible();
  await page.locator('.model-trial-panel input[type="file"]').setInputFiles(path.join(fixturesDir, "sample-00.png"));
  await expect(page.getByTestId("model-trial-result")).toContainText(/检测到|未检测/, { timeout: 60_000 });
}

test("Windows detection workflow: create, upload, extract, review, train, export and trial", async ({ page }) => {
  const project = await createProject(page, "detect");
  await uploadImageBatches(page, project.id);

  const videoInput = page.locator('input[type="file"][accept="video/*"]');
  await videoInput.setInputFiles(path.join(fixturesDir, "acceptance.avi"));
  await expect(page.getByText(/已上传 1 个视频/)).toBeVisible();
  await page.getByRole("button", { name: /开始提取 1 个视频/ }).click();
  await pollTask(page, project.id, "extract");

  const frames = await seedReviewLabels(page, project);
  await confirmReviewAndRemainder(page, project, frames);
  await trainThroughUi(page, project);
  await exportAndTrial(page, project);
});

test("Windows classification workflow: create, upload, review, train, export and trial", async ({ page }) => {
  const project = await createProject(page, "classify");
  await uploadImageBatches(page, project.id);
  const frames = await seedReviewLabels(page, project);
  await confirmReviewAndRemainder(page, project, frames);
  await trainThroughUi(page, project);
  await exportAndTrial(page, project);
});

test("10,000 frame review stays paged and renders a bounded thumbnail window", async ({ page }) => {
  const created = await page.request.post(`${apiUrl}/api/projects`, {
    data: {
      name: `v1-10k-browser-${Date.now()}`,
      task_type: "detect",
      categories: [{ class_id: 0, name: "target" }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const createdProject = await created.json() as Project;
  const projectId = execFileSync(
    python,
    [
      path.join(repositoryRoot, "tests/fixtures/seed_10000_project.py"),
      "auto",
      path.join(fixturesDir, "sample-00.png"),
      createdProject.id,
    ],
    {
      encoding: "utf-8",
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: repositoryRoot },
    },
  ).trim();

  const projectResponse = await page.request.get(`${apiUrl}/api/projects/${projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const pageResponse = await page.request.get(
    `${apiUrl}/api/projects/${projectId}/frames/page?statuses=needs_human&sort=uncertainty&limit=100`,
  );
  expect(pageResponse.ok(), await pageResponse.text()).toBeTruthy();
  const firstPage = await pageResponse.json();
  expect(firstPage.total).toBe(10_000);
  expect(firstPage.items).toHaveLength(100);

  const pageSizes: number[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/frames/page") || !response.ok()) return;
    const body = await response.json();
    pageSizes.push(body.items.length);
  });
  const started = Date.now();
  await page.goto(`/projects/${projectId}/review?filter=pending`);
  await expect(page.getByText("1 / 10000", { exact: true })).toBeVisible();
  const interactiveMs = Date.now() - started;

  expect(interactiveMs).toBeLessThan(5_000);
  expect(pageSizes.length).toBeGreaterThan(0);
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(100);
  expect(await page.locator(".review-filmstrip button").count()).toBeLessThanOrEqual(101);
  console.log(`10k browser benchmark: interactive=${interactiveMs}ms, fetched=${pageSizes.join(",")}`);
});
