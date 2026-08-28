import { expect, test } from "@playwright/test";

const apiUrl = process.env.LABELKIT_E2E_API_URL!;

for (const provider of ["kaggle", "roboflow"] as const) {
  test(`${provider} controlled public dataset flow reaches review gate`, async ({ page }) => {
    const created = await page.request.post(`${apiUrl}/api/projects`, {
      data: {
        name: `public-${provider}-${Date.now()}`,
        task_type: "detect",
        categories: [{ class_id: 0, name: "bird" }],
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const project = await created.json() as { id: string };
    const sourceUrl = provider === "roboflow"
      ? "https://universe.roboflow.com/demo/birds/dataset/3"
      : "https://www.kaggle.com/datasets/demo/birds";
    const candidate = {
      provider,
      source_ref: provider === "roboflow" ? "demo/birds" : "demo/birds",
      source_version: "3",
      source_url: sourceUrl,
      title: `${provider} birds`,
      description: "A fixed test dataset",
      license_name: "CC0-1.0",
      license_url: sourceUrl,
      license_fingerprint: "a".repeat(64),
      download_bytes: 1024,
      image_count: 60,
      task_type: "detect",
      classes: ["bird"],
      updated_at: "2026-08-20",
      score: 1,
      requires_manual_license_confirmation: false,
    };
    let state = "fetched";
    const importPayload = () => ({
      id: "public-import-1",
      project_id: project.id,
      provider,
      source_ref: "demo/birds",
      source_version: "3",
      source_url: sourceUrl,
      title: `${provider} birds`,
      license_name: "CC0-1.0",
      license_url: sourceUrl,
      license_fingerprint: "a".repeat(64),
      state,
      expected_download_bytes: 1024,
      actual_download_bytes: 1024,
      extracted_bytes: 4096,
      artifact_checksum: "1234567890abcdef",
      detected_format: "yolo_detect",
      source_classes: [{ class_id: 5, name: "bird" }],
      class_mapping: {},
      suggested_mapping: { "5": 0 },
      quality_report: { blocking: [], warnings: [], image_count: 60, annotation_count: 60 },
      review_frame_ids: state === "review" ? ["frame-1", "frame-2"] : [],
      fetch_task_id: "fetch-task",
      import_task_id: state === "review" ? "import-task" : null,
      dataset_version_id: null,
      train_task_id: null,
      estimated_vlm_cost: 0,
    });

    await page.route(`${apiUrl}/api/public-datasets/providers`, (route) => route.fulfill({
      json: [
        { provider: "kaggle", available: true, discovery: true, url_import: false },
        { provider: "roboflow", available: true, discovery: true, url_import: true },
      ],
    }));
    await page.route(`${apiUrl}/api/projects/${project.id}/public-datasets/discover`, (route) => route.fulfill({ json: { candidates: [candidate], errors: {} } }));
    await page.route(`${apiUrl}/api/projects/${project.id}/public-datasets/fetch`, (route) => route.fulfill({ json: importPayload() }));
    await page.route(`${apiUrl}/api/projects/${project.id}/public-dataset-imports/public-import-1`, (route) => route.fulfill({ json: importPayload() }));
    await page.route(`${apiUrl}/api/projects/${project.id}/public-dataset-imports/public-import-1/publish`, (route) => {
      state = "review";
      return route.fulfill({ json: { id: "import-task", project_id: project.id, task_type: "public_import", status: "pending", progress: 0, total: 0, params: {}, result: {}, log: "", error: "", cancel_requested: false, heartbeat_at: null, retry_of_task_id: null, created_at: new Date().toISOString() } });
    });

    await page.goto(`/projects/${project.id}/materials`);
    await page.getByRole("tab", { name: /公开数据/ }).click();
    const prompt = provider === "roboflow" ? sourceUrl : "bird detection";
    await page.getByLabel("识别需求").fill(prompt);
    await page.getByRole("button", { name: "查找公开数据" }).click();
    await page.getByRole("button", { name: new RegExp(`${provider} birds`) }).click();
    await page.getByText(/我已核对许可/).click();
    await page.getByRole("button", { name: "下载并安全分析" }).click();
    await expect(page.getByText("确认类别映射与质量门禁")).toBeVisible();
    await page.getByRole("button", { name: "确认映射并发布到项目" }).click();
    await expect(page.getByText("需要完成风险抽样复查")).toBeVisible();
  });
}
