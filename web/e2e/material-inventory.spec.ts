import { expect, test } from "@playwright/test";

test("unified material inventory supports details, archive and restore", async ({ page }) => {
  let archived = false;
  let uploadAttempts = 0;
  const now = new Date().toISOString();
  const project = {
    id: "project-1",
    name: "混合素材项目",
    description: "",
    task_type: "detect",
    label_prompt: "",
    review_prompt: "",
    categories: [{ class_id: 0, name: "bird", description: "", color: "#10a88f", required: true }],
    frame_count: 45,
    video_count: 0,
    disk_usage_mb: 0,
    has_custom_cover: false,
    created_by: "tester",
    created_at: now,
    updated_at: now,
  };
  const batch = () => ({
    id: "batch-public",
    project_id: project.id,
    origin: "public_dataset",
    title: "Bird Nest Public Set",
    status: archived ? "archived" : "ready",
    frame_count: 45,
    usable_frame_count: 45,
    pending_frame_count: 0,
    frame_status_counts: { human_ok: 45 },
    preview_frame_ids: ["frame-1", "frame-2"],
    metadata: { provider: "roboflow", license_name: "CC BY 4.0", public_import_id: "import-1" },
    archived_at: archived ? now : null,
    created_at: now,
    updated_at: now,
    next_action: archived ? "restore" : "archive",
  });

  await page.addInitScript(() => localStorage.setItem("labelkit.auth.token", "test-token"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/material-batches/batch-public/archive")) {
      archived = true;
      return route.fulfill({ json: { id: "batch-public", archived_at: now } });
    }
    if (url.pathname.endsWith("/material-batches/batch-public/restore")) {
      archived = false;
      return route.fulfill({ json: { id: "batch-public", archived_at: null } });
    }
    if (url.pathname.endsWith("/images/upload")) {
      uploadAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (uploadAttempts === 1) return route.fulfill({ status: 500, json: { detail: "压缩包校验失败" } });
      return route.fulfill({ json: { uploaded: 2, material_batch_id: "batch-upload" } });
    }
    if (url.pathname.endsWith("/material-batches/batch-public/frames")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = Array.from({ length: Math.max(0, Math.min(40, 45 - offset)) }, (_, index) => ({
        id: `frame-${offset + index + 1}`,
        filename: `frame-${offset + index + 1}.jpg`,
        status: "human_ok",
        split: "train",
        created_at: now,
      }));
      return route.fulfill({ json: { items, total: 45, offset, limit: 40 } });
    }
    if (url.pathname.endsWith("/material-batches")) {
      const includeArchived = url.searchParams.get("include_archived") === "true";
      const items = !archived || includeArchived ? [batch()] : [];
      return route.fulfill({ json: { summary: { active_batch_count: archived ? 0 : 1, archived_batch_count: archived ? 1 : 0, usable_frame_count: archived ? 0 : 45, pending_batch_count: 0, intake_blocking_batch_count: 0, review_batch_count: 0, review_sample_count: 0, first_review_import_id: null, counts_by_origin: archived ? {} : { public_dataset: 1 } }, items } });
    }
    if (url.pathname.endsWith("/frames/stats")) return route.fulfill({ json: { total: archived ? 0 : 4, human_ok: archived ? 0 : 4 } });
    if (url.pathname.endsWith("/models")) return route.fulfill({ json: [] });
    if (url.pathname === `/api/projects/${project.id}`) return route.fulfill({ json: project });
    if (url.pathname.includes("/frames/") && url.pathname.endsWith("/image")) return route.fulfill({ status: 404, json: { detail: "preview omitted" } });
    return route.fulfill({ json: [] });
  });

  await page.goto(`/projects/${project.id}/materials`);
  await expect(page.getByRole("heading", { name: "素材总账" })).toBeVisible();
  await expect(page.getByText("Bird Nest Public Set")).toBeVisible();

  await page.getByRole("button", { name: "添加素材" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /上传图片或 ZIP/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "巡检图片.zip", mimeType: "application/zip", buffer: Buffer.from("zip-test") });
  const uploadStatus = page.locator(".material-upload");
  await expect(uploadStatus).toBeVisible();
  await expect(uploadStatus.getByText(/巡检图片.zip/)).toBeVisible();
  await expect(page.getByText("素材上传失败")).toBeVisible();
  await expect(uploadStatus.getByText(/压缩包校验失败/)).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("已导入 2 张图片")).toBeVisible();
  await expect(page.getByText(/巡检图片.zip · 1 KB/)).toBeVisible();

  await page.getByText("Bird Nest Public Set").click();
  const drawer = page.getByRole("complementary", { name: "素材批次详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("figure")).toHaveCount(40);
  await drawer.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(drawer.getByText("已加载全部 45 张素材")).toBeVisible();
  await expect(drawer.locator("figure")).toHaveCount(45);
  await page.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("button", { name: "归档" }).click();
  await expect(page.getByText(/不会释放磁盘空间/)).toBeVisible();
  await page.getByRole("button", { name: "确认归档" }).click();
  await expect(page.getByText("Bird Nest Public Set")).toHaveCount(0);

  await page.getByText("显示归档").click();
  await expect(page.getByText("Bird Nest Public Set")).toBeVisible();
  await page.getByRole("button", { name: "恢复" }).click();
  await expect(page.locator(".material-ledger__status.status-ready")).toBeVisible();
});

test("mixed sources explain pre-label and public review as separate next steps", async ({ page }) => {
  const now = new Date().toISOString();
  const projectId = "mixed-project";
  const batches = [
    {
      id: "image-batch", project_id: projectId, origin: "image_upload", title: "图片上传（2 个文件）",
      status: "ready", frame_count: 2, usable_frame_count: 0, pending_frame_count: 2,
      frame_status_counts: { unlabeled: 2 }, preview_frame_ids: [], metadata: {}, archived_at: null,
      created_at: now, updated_at: now, next_action: "archive",
    },
    {
      id: "video-batch", project_id: projectId, origin: "video", title: "奔跑.mp4",
      status: "ready", frame_count: 5, usable_frame_count: 0, pending_frame_count: 5,
      frame_status_counts: { unlabeled: 5 }, preview_frame_ids: [], metadata: { video_id: "video-1" }, archived_at: null,
      created_at: now, updated_at: now, next_action: "archive",
    },
    {
      id: "public-batch", project_id: projectId, origin: "public_dataset", title: "Bird Nest",
      status: "action_required", frame_count: 9840, usable_frame_count: 9839, pending_frame_count: 1,
      frame_status_counts: { auto_ok: 9642, human_ok: 197, unlabeled: 1 }, preview_frame_ids: [],
      metadata: { public_import_id: "import-1", review_sample_count: 197 }, archived_at: null,
      created_at: now, updated_at: now, next_action: "review",
    },
  ];

  await page.addInitScript(() => localStorage.setItem("labelkit.auth.token", "test-token"));
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/material-batches")) return route.fulfill({ json: {
      summary: {
        active_batch_count: 3, archived_batch_count: 0, usable_frame_count: 9847, pending_batch_count: 1,
        intake_blocking_batch_count: 0, review_batch_count: 1, review_sample_count: 197,
        first_review_import_id: "import-1", counts_by_origin: { image_upload: 1, video: 1, public_dataset: 1 },
      },
      items: batches,
    } });
    if (url.pathname.endsWith("/frames/stats")) return route.fulfill({ json: { total: 9847, unlabeled: 8, human_ok: 9839 } });
    if (url.pathname.endsWith("/frames") && url.searchParams.get("status") === "unlabeled") {
      return route.fulfill({ json: Array.from({ length: 8 }, (_, index) => ({
        id: `pending-${index + 1}`,
        filename: `pending-${index + 1}.jpg`,
        split: "train",
        status: "unlabeled",
        note: "",
        review_note: "",
        source: "upload",
        uncertainty: 0,
        video_id: index < 5 ? "video-1" : null,
        material_batch_id: index < 5 ? "video-batch" : index < 7 ? "image-batch" : "public-batch",
        ingest_origin: index < 5 ? "video" : index < 7 ? "image_upload" : "public_dataset",
        has_labels: false,
        annotations: [],
      })) });
    }
    if (url.pathname.endsWith("/frames/page")) {
      return route.fulfill({ json: {
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `pending-${index + 1}`, filename: `pending-${index + 1}.jpg`, split: "train", status: "unlabeled",
          note: "", review_note: "", source: "upload", uncertainty: 0, video_id: index < 5 ? "video-1" : null,
          material_batch_id: index < 5 ? "video-batch" : index < 7 ? "image-batch" : "public-batch",
          ingest_origin: index < 5 ? "video" : index < 7 ? "image_upload" : "public_dataset",
          has_labels: false, annotations: [],
        })),
        next_cursor: null,
        total: 8,
      } });
    }
    if (url.pathname.endsWith("/frames")) return route.fulfill({ json: [] });
    if (url.pathname === `/api/projects/${projectId}`) return route.fulfill({ json: {
      id: projectId, name: "混合素材", description: "", task_type: "detect", label_prompt: "", review_prompt: "",
      categories: [{ class_id: 0, name: "bird", description: "", color: "#10a88f", required: true }],
      frame_count: 9847, video_count: 1, disk_usage_mb: 0, has_custom_cover: false,
      created_by: "tester", created_at: now, updated_at: now,
    } });
    return route.fulfill({ json: [] });
  });

  await page.goto(`/projects/${projectId}/materials`);
  await expect(page.getByRole("button", { name: "下一步 · 标注处理 8 张" })).toBeVisible();
  await expect(page.getByText("两项工作可以并行完成")).toBeVisible();
  await expect(page.getByText("8 张未标注 · AI 或人工")).toBeVisible();
  await expect(page.getByText("197 张样本 · 保留已有标注")).toBeVisible();
  await expect(page.locator(".material-ledger__status").filter({ hasText: "待预标注" })).toHaveCount(2);
  await expect(page.getByText("待完成抽检")).toBeVisible();

  await page.getByRole("button", { name: "下一步 · 标注处理 8 张" }).click();
  await expect(page.getByRole("heading", { name: "素材标注" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本次待标注素材（8 张）" })).toBeVisible();
  await expect(page.getByText("显示 8 / 8 张 · 只会处理以下未标注素材 · 单击查看")).toBeVisible();
  await expect(page.locator('img[alt^="pending-"]')).toHaveCount(8);
  await expect(page.getByText("视频抽帧")).toHaveCount(5);
  await expect(page.getByText("图片上传")).toHaveCount(2);
  await expect(page.getByText("公开数据", { exact: true })).toHaveCount(1);

  await page.getByRole("link", { name: "直接人工标注" }).click();
  await expect(page.getByRole("heading", { name: "人工标注", exact: true })).toBeVisible();
  await expect(page.locator('section[aria-label="项目生产流程"] > div strong')).toContainText("02");
  await expect(page.getByRole("button", { name: "人工标注 (8)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存标注" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "无目标" })).toBeVisible();
  await expect(page.getByRole("button", { name: "A 标注", pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "V 查看" }).click();
  await expect(page.getByRole("button", { name: "V 查看", pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "打开 pending-2.jpg" }).click();
  await expect(page.getByRole("button", { name: "A 标注", pressed: true })).toBeVisible();
});

test("public dataset sampling keeps its batch completion semantics", async ({ page }) => {
  const projectId = "sample-project";
  let sampleOpen = true;

  await page.addInitScript(() => localStorage.setItem("labelkit.auth.token", "test-token"));
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/frames/batch-feedback")) {
      sampleOpen = false;
      return route.fulfill({ json: { ok: true, updated: 2 } });
    }
    if (url.pathname.endsWith("/frames/stats")) {
      return route.fulfill({ json: sampleOpen
        ? { total: 10, needs_human: 2, human_ok: 8 }
        : { total: 10, needs_human: 0, human_ok: 10 } });
    }
    if (url.pathname.endsWith("/frames/page")) {
      const items = sampleOpen
        ? [1, 2].map((index) => ({
            id: `sample-${index}`,
            filename: `sample-${index}.jpg`,
            split: "train",
            status: "needs_human",
            note: "",
            review_note: "",
            source: "public_dataset",
            uncertainty: 0.8,
            public_import_id: "import-1",
            has_labels: true,
            annotations: [{ class_id: 0, x_center: 0.5, y_center: 0.5, width: 0.2, height: 0.2 }],
          }))
        : [];
      return route.fulfill({ json: { items, next_cursor: null, total: items.length } });
    }
    if (url.pathname.endsWith("/public-dataset-imports")) {
      return route.fulfill({ json: [{ id: "import-1", project_id: projectId, state: "review", review_frame_ids: ["sample-1", "sample-2"] }] });
    }
    if (url.pathname === `/api/projects/${projectId}`) {
      return route.fulfill({ json: {
        id: projectId,
        name: "抽检项目",
        description: "",
        task_type: "detect",
        label_prompt: "",
        review_prompt: "",
        categories: [{ class_id: 0, name: "bird", description: "", color: "#10a88f", required: true }],
        frame_count: 10,
        video_count: 0,
        disk_usage_mb: 0,
        has_custom_cover: false,
        created_by: "tester",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto(`/projects/${projectId}/review?filter=sample&publicImport=import-1`);
  await expect(page.getByRole("heading", { name: "标注复核" })).toBeVisible();
  await page.getByRole("button", { name: "一键确认 (2)" }).click();
  await page.getByRole("button", { name: "全部确认" }).click();

  await expect(page.getByRole("heading", { name: "公开数据抽检", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本批公开数据抽检完成" })).toBeVisible();
  await expect(page.getByText("本批抽检样本均已确认，原有标注已保留。", { exact: false })).toBeVisible();
  await expect(page.getByText("人工确认完成", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认抽检并返回素材" })).toBeVisible();
});
