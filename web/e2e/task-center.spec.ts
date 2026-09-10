import { expect, test } from "@playwright/test";

const task = {
  id: "84215a00-0000-0000-0000-000000000000",
  project_id: "project-1",
  project_name: "城市道路目标检测",
  assignee: "标注员小林",
  priority: "medium",
  task_type: "label",
  status: "running",
  progress: 6840,
  total: 10000,
  params: { assignee: "标注员小林" },
  result: {},
  log: "",
  error: "",
  cancel_requested: false,
  heartbeat_at: null,
  retry_of_task_id: null,
  created_at: "2026-08-20T08:00:00Z",
  started_at: "2026-08-20T08:01:00Z",
  finished_at: null,
};

test("task center preserves the reference geometry and interactive filters", async ({ page }) => {
  await page.route("**/api/tasks", (route) => route.fulfill({ json: [task] }));
  await page.route("**/api/projects/dashboard", (route) => route.fulfill({
    json: {
      summary: {
        total_projects: 24,
        total_data_items: 2863421,
        active_annotators: 89,
        total_video_hours: 142678,
        projects_last_30_days: 3,
        data_items_last_30_days: 240000,
        completed_tasks_last_30_days: 12,
        video_hours_last_30_days: 530,
      },
      projects: [{
        project: { id: "project-1", name: "城市道路目标检测", description: "", task_type: "detect", label_prompt: "", review_prompt: "", created_at: task.created_at, updated_at: task.created_at, categories: [], frame_count: 10000, video_count: 0, disk_usage_mb: 0 },
        created_by: "Workspace Admin",
        stats: { total: 10000 },
        preview_frame_id: null,
        model_count: 0,
        latest_model_version: null,
        task_count: 1,
        completed_task_count: 0,
        total_video_hours: 0,
        active_annotators: 1,
      }],
    },
  }));

  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto("/login?next=/tasks");
  await page.getByPlaceholder("请输入账号").fill("admin");
  await page.locator('input[autocomplete="current-password"]').fill("admin");
  await page.locator(".login-submit").click();
  await page.waitForURL("**/tasks");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.locator(".task-metrics article")).toHaveCount(4);
  await expect(page.locator(".task-card")).toHaveCount(1);

  const card = await page.locator(".task-card").boundingBox();
  expect(card).not.toBeNull();
  const results = await page.locator(".task-results").boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(results!.x);
  expect(card!.y).toBeGreaterThan(results!.y);
  expect(card!.x + card!.width).toBeLessThanOrEqual(results!.x + results!.width);

  await page.getByRole("button", { name: "网格视图" }).click();
  await expect(page.locator(".task-center-page")).toHaveClass(/task-center-page--grid/);
  await page.getByRole("button", { name: "列表视图" }).click();
  await page.getByRole("combobox", { name: "按状态筛选", exact: true }).click();
  await page.getByRole("option", { name: "已完成", exact: true }).click();
  await expect(page.getByText("没有符合条件的任务")).toBeVisible();
  await page.getByRole("combobox", { name: "按状态筛选", exact: true }).click();
  await page.getByRole("option", { name: "进行中", exact: true }).click();
  await expect(page.getByText("TASK-84215A")).toBeVisible();
  await page.screenshot({ path: "artifacts/task-center-zh-e2e.png" });
});
