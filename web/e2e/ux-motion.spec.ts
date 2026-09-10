import { test, expect, type Page } from "@playwright/test";

const initial = Array.from({ length: 15 }, (_, i) => ({
  id: `${String(i + 1).padStart(6, "0")}-0000-0000-0000-000000000000`, project_id: "project-1", project_name: "道路检测", task_type: i === 1 ? "export" : "train",
  status: i === 1 ? "completed" : i === 2 ? "failed" : "running", progress: i === 1 ? 100 : 30, total: 100,
  params: { epochs: 100, imgsz: 640, batch: 8 }, can_resume: i === 2, log: "Epoch 30/100 loss=0.4", created_at: "2026-09-10T02:00:00Z", started_at: "2026-09-10T02:01:00Z", finished_at: null,
}));

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  (page as Page & { uxErrors?: string[] }).uxErrors = errors;
});
test.afterEach(async ({ page }) => { expect((page as Page & { uxErrors?: string[] }).uxErrors).toEqual([]); });

async function setup(page: Page, fail = false) {
  const state = { tasks: structuredClone(initial), fail, resumes: 0, deletes: 0, projectTasks: [structuredClone(initial[0])] };
  const project = { id: "project-1", name: "道路检测", description: "UX 回归项目", task_type: "detect", categories: [], frame_count: 100, video_count: 0, disk_usage_mb: 0, created_at: initial[0].created_at, updated_at: initial[0].created_at };
  await page.addInitScript(() => { localStorage.setItem("labelkit.auth.token", "ux-test-fixture"); });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tasks") return route.fulfill(state.fail ? { status: 503, json: { detail: "测试故障" } } : { json: state.tasks });
    if (path.includes("resume")) { state.resumes++; return route.fulfill({ status: 503, json: { detail: "请重试" } }); }
    if (path === "/api/projects/dashboard") return route.fulfill({ json: { summary: { total_projects: 6, total_data_items: 29025, active_annotators: 1, total_video_hours: .01, projects_last_30_days: 1, data_items_last_30_days: 30, completed_tasks_last_30_days: 32, video_hours_last_30_days: 0 }, projects: [{ project, created_by: "测试管理员", stats: { total: 100, human_ok: 100 }, preview_frame_id: null, model_count: 0, task_count: 15, completed_task_count: 1, total_video_hours: 0 }] } });
    if (path === "/api/projects/project-1") { if (route.request().method() === "DELETE") { state.deletes++; return route.fulfill({ json: { ok: true } }); } return route.fulfill({ json: project }); }
    if (path === "/api/projects/project-1/tasks") return route.fulfill({ json: state.projectTasks });
    if (path.endsWith("/frames/stats")) return route.fulfill({ json: { total: 100, human_ok: 90, needs_human: 10 } });
    if (path.endsWith("/frames/page")) return route.fulfill({ json: { items: [], next_cursor: null, has_more: false, total: 0 } });
    if (path === "/api/datasets") return route.fulfill({ json: { items: [], total: 0, summary: { total_versions: 0, total_projects: 0, total_frames: 0 } } });
    if (path.includes("auth")) return route.fulfill({ json: { id: "test-user", username: "ux", display_name: "测试管理员", role: "admin" } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  return state;
}

test("switching preserves the reading anchor and survives interruption", async ({ page }, info) => {
  await setup(page);
  await expect(page.locator(".task-card")).toHaveCount(10);
  const anchor = await page.locator(".task-cards").evaluate(root => {
    root.scrollTop = 240;
    const top = root.getBoundingClientRect().top;
    const card = Array.from(root.children).find(el => el.getBoundingClientRect().bottom > top) as HTMLElement;
    return { id: card.dataset.taskId!, offset: card.getBoundingClientRect().top - top };
  });
  await page.getByRole("button", { name: "网格视图" }).click();
  const target = page.locator(`[data-task-id="${anchor.id}"]`);
  await expect(target).toBeVisible();
  const measure = await target.evaluate(card => { const root = card.parentElement!; return { offset: card.getBoundingClientRect().top - root.getBoundingClientRect().top, top: root.scrollTop, max: root.scrollHeight - root.clientHeight }; });
  if (measure.top > 1 && measure.top < measure.max - 1) expect(Math.abs(measure.offset - anchor.offset)).toBeLessThanOrEqual(1);
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: i % 2 ? "网格视图" : "列表视图" }).evaluate((button: HTMLElement) => button.click());
    await page.waitForTimeout(25);
  }
  await expect(page.locator(".task-center-page")).toHaveClass(/--grid/);
  await page.mouse.move(800, 500); await page.mouse.wheel(0, 200);
  await page.waitForTimeout(350);
  expect(await page.locator(".task-card__identity").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).transform === "none"))).toBe(true);
  await page.screenshot({ path: info.outputPath("switch.png") });
  await page.getByRole("button", { name: "列表视图" }).evaluate((button: HTMLElement) => button.click());
  await page.getByRole("combobox", { name: "按状态筛选", exact: true }).evaluate((button: HTMLElement) => button.click());
  await page.getByRole("option", { name: "失败", exact: true }).evaluate((option: HTMLElement) => option.click());
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.waitForTimeout(350);
  expect(await page.locator(".task-card__identity").evaluate(node => getComputedStyle(node).transform)).toBe("none");
});

test("data remains truthful, filters remove completed tasks, load failure recovers", async ({ page }) => {
  const state = await setup(page, true);
  await expect(page.getByText("任务加载失败", { exact: true })).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.locator(".task-card")).toHaveCount(10);
  await page.getByRole("combobox", { name: "按状态筛选", exact: true }).click();
  await page.getByRole("option", { name: "进行中", exact: true }).click();
  state.tasks[0].progress = 42;
  await expect(page.locator(".task-card").first().locator(".task-card__progress strong")).toHaveText("42%");
  await page.waitForTimeout(2400);
  expect(await page.locator(".task-card").first().locator(".lk-changed-value").evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 0))).toBe(true);
  state.tasks[0].status = "completed";
  await expect(page.locator(`[data-task-id="${state.tasks[0].id}"]`)).toHaveCount(0);
  state.fail = true;
  await expect(page.getByText("刷新失败，当前显示上次数据。")).toBeVisible();
  expect(await page.locator(".task-card").count()).toBeGreaterThan(0);
  state.fail = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".task-refresh-error")).toHaveCount(0);
});

test("resume preserves edits across polling, retry and modal focus", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "继续训练", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "继续训练", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("批次大小", { exact: true }).fill("4");
  await page.waitForTimeout(2300);
  await expect(dialog.getByLabel("批次大小", { exact: true })).toHaveValue("4");
  await dialog.getByRole("button", { name: "开始续训" }).click();
  await expect(page.getByText(/续训失败/)).toBeVisible();
  await expect(dialog.getByLabel("批次大小", { exact: true })).toHaveValue("4");
  expect(state.resumes).toBe(1);
  await dialog.getByRole("button", { name: "开始续训" }).click();
  await expect.poll(() => state.resumes).toBe(2);
  await expect(dialog.getByRole("button", { name: "开始续训" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续训练", exact: true }).first()).toBeFocused();
  await page.getByRole("button", { name: "继续训练", exact: true }).first().click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
});

for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`card alignment and reduced motion ${size.width}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page);
    await page.getByRole("button", { name: "网格视图" }).click();
    await expect(page.locator(".task-card")).toHaveCount(10);
    const cards = await page.locator(".task-card").evaluateAll(nodes => nodes.map(card => { const r = card.getBoundingClientRect(); const status = card.querySelector(".task-card__mobile-summary > .task-status")!.getBoundingClientRect(); const buttons = Array.from(card.querySelectorAll(".task-card__mobile-actions button")).map(el => el.getBoundingClientRect()); return { offset: status.top - r.top, inside: buttons.every(b => b.bottom <= r.bottom && b.right <= r.right) }; }));
    expect(Math.max(...cards.map(c => c.offset)) - Math.min(...cards.map(c => c.offset))).toBeLessThanOrEqual(1);
    expect(cards.every(c => c.inside)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const header = await page.locator(".app-commandbar").evaluate(node => {
      const heading = node.querySelector("h1")!.getBoundingClientRect();
      const action = node.querySelector(".app-commandbar__create")!.getBoundingClientRect();
      return { heading: heading.toJSON(), action: action.toJSON(), width: node.getBoundingClientRect().width, display: getComputedStyle(node).display };
    });
    await info.attach("header-geometry", { body: JSON.stringify(header), contentType: "application/json" });
    expect(header.action.left).toBeGreaterThanOrEqual(header.heading.right);
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath("viewport.png") });
  });
}

test("shared confirm, toast, select, progress and segmented keyboard contract", async ({ page }) => {
  await setup(page);
  await page.goto("/dev/ux");
  await expect(page.getByRole("heading", { name: "UX 交互验证样例" })).toBeVisible();
  const open = page.getByRole("button", { name: "打开确认", exact: true });
  await open.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button", { name: "确认", exact: true }).evaluate((button: HTMLElement) => { button.click(); button.click(); });
  await expect(page.locator(".stat-strip__value")).toHaveText("1");
  await open.evaluate((button: HTMLElement) => button.click());
  await page.waitForTimeout(220);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await page.getByRole("tab", { name: "素材", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "复查", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "复查", exact: true })).toBeFocused();
  const select = page.getByRole("combobox", { name: "模型筛选样例" });
  await select.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(select).toHaveText("目标检测");
  await page.getByRole("button", { name: "更新进度" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "70");
  await page.getByRole("button", { name: "显示通知" }).click();
  await page.getByRole("button", { name: "记录", exact: true }).evaluate((button: HTMLElement) => { button.click(); button.click(); });
  await expect(page.locator(".stat-strip__value")).toHaveText("2");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("warmed motion does not introduce long tasks", async ({ page }, info) => {
  await setup(page);
  await page.getByRole("button", { name: "网格视图" }).click();
  await page.getByRole("button", { name: "列表视图" }).click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const data: number[] = [];
    const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => data.push(entry.duration)));
    observer.observe({ type: "longtask", buffered: false });
    Object.assign(window, { uxPerf: { data, observer } });
  });
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: i % 2 ? "列表视图" : "网格视图" }).evaluate((button: HTMLElement) => button.click());
    await page.waitForTimeout(350);
  }
  const longs = await page.evaluate(() => {
    const perf = (window as typeof window & { uxPerf: { data: number[]; observer: PerformanceObserver } }).uxPerf;
    perf.observer.disconnect(); return perf.data;
  });
  await info.attach("long-tasks", { body: JSON.stringify({ durations: longs, samples: 10 }), contentType: "application/json" });
  expect(longs).toEqual([]);
});

test("comparison recording of the three task interactions", async ({ page }, info) => {
  const state = await setup(page);
  await expect(page.locator(".task-card")).toHaveCount(10);
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "网格视图" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "列表视图" }).click();
  await page.waitForTimeout(700);
  state.tasks[0].progress = 70;
  await expect(page.locator(".task-card").first().locator(".task-card__progress strong")).toHaveText("70%");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "查看日志", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "训练日志", exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await page.getByRole("dialog", { name: "训练日志", exact: true }).getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: info.outputPath("comparison.png") });
});

test("public component callers: project confirmation, materials, review and training", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/");
  await page.getByLabel("更多项目操作").first().click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(state.deletes).toBe(0);
  state.projectTasks = [{ ...initial[0], task_type: "extract" }];
  await page.goto("/projects/project-1/materials");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  await expect(page.getByRole("tablist")).toBeVisible();
  state.projectTasks = [{ ...initial[0], task_type: "review" }];
  await page.goto("/projects/project-1/review");
  await page.getByRole("button", { name: "机器预审", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  state.projectTasks = [{ ...initial[0], task_type: "train" }];
  await page.goto("/projects/project-1/train");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
});
