import { expect, test } from "@playwright/test";
import path from "node:path";

const apiUrl = process.env.LABELKIT_E2E_API_URL!;
const previewBase = `${apiUrl}/api/projects/project-1/models/model-1/preview-sessions`;
const sessionId = "preview-session-1";
const onePixelJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);

test("RTSP realtime preview starts, reports detections and stops", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const login = await page.request.post(`${apiUrl}/api/auth/login`, {
    data: { username: "admin", password: "admin" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const token = (await login.json()).token as string;
  await page.addInitScript((authToken) => {
    window.localStorage.setItem("labelkit.auth.token", authToken);
  }, token);
  await page.route(`${apiUrl}/api/projects/project-1?**`, (route) => route.fulfill({
    json: {
      id: "project-1",
      name: "灭火器检测",
      task_type: "detect",
      categories: [{ class_id: 0, name: "灭火器", color: "#12A88F" }],
    },
  }));
  await page.route(`${apiUrl}/api/projects/project-1/models/predict?model_id=model-1`, (route) => route.fulfill({
    json: { boxes: [{ class_id: 0, x: 0.5, y: 0.5, w: 0.4, h: 0.4, conf: 0.91 }] },
  }));

  let createRequests = 0;
  let statusRequests = 0;
  await page.route(previewBase, async (route) => {
    expect(route.request().method()).toBe("POST");
    createRequests += 1;
    if (createRequests > 1) {
      await route.fulfill({
        status: 429,
        json: { detail: { code: "PREVIEW_CAPACITY_EXCEEDED", message: "实时预览容量已满，请稍后重试" } },
      });
      return;
    }
    const body = route.request().postDataJSON();
    expect(body.rtspUrl).toBe("rtsp://admin:secret@192.168.1.10:8554/live");
    await route.fulfill({
      status: 201,
      json: {
        sessionId,
        status: "STARTING",
        streamPath: `/api/projects/project-1/models/model-1/preview-sessions/${sessionId}/stream`,
        createdAt: new Date().toISOString(),
      },
    });
  });
  await page.route(`${previewBase}/${sessionId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ json: previewSnapshot("STOPPED") });
      return;
    }
    statusRequests += 1;
    const status = statusRequests === 1 ? "STARTING" : statusRequests === 2 ? "RECONNECTING" : "STREAMING";
    await route.fulfill({ json: previewSnapshot(status) });
  });
  await page.route(`${previewBase}/${sessionId}/stream**`, (route) => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: onePixelJpeg,
  }));

  await page.goto("/models/trial?projectId=project-1&modelId=model-1&name=%E7%81%AD%E7%81%AB%E5%99%A8%E6%A3%80%E6%B5%8B%E6%A8%A1%E5%9E%8B&version=V1");
  await page.screenshot({
    path: path.resolve("test-results/model-image-trial-empty-1440x900.png"),
    fullPage: true,
  });
  await page.locator(".model-trial-file-input").setInputFiles({
    name: "regression.jpg",
    mimeType: "image/jpeg",
    buffer: onePixelJpeg,
  });
  await expect(page.getByRole("heading", { name: "识别到 1 个目标" })).toBeVisible();
  await page.getByRole("tab", { name: "实时预览" }).click();
  const sourceInput = page.getByLabel("RTSP 视频地址");
  await sourceInput.fill("rtsp://admin:secret@192.168.1.10:8554/live");
  await page.getByRole("button", { name: "开始实时预览" }).click();

  await expect(page.getByRole("heading", { name: "在线测试" })).toBeVisible();
  await expect(page.getByText("正在重连").first()).toBeVisible();
  await expect(page.getByText("实时检测中").first()).toBeVisible();
  await expect(page.getByText("灭火器").last()).toBeVisible();
  await expect(page.getByText("2", { exact: true }).last()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("secret");
  await expect(page.getByAltText("RTSP 模型实时检测画面")).toBeVisible();

  await page.screenshot({
    path: path.resolve("test-results/model-realtime-preview-1440x900.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflows).toBe(false);
  await page.screenshot({
    path: path.resolve("test-results/model-realtime-preview-1366x768.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "停止预览" }).click();
  await expect(page.getByRole("button", { name: "开始实时预览" })).toBeVisible();
  await sourceInput.fill("rtsp://192.168.1.20/live");
  await page.getByRole("button", { name: "开始实时预览" }).click();
  await expect(page.getByText("实时预览容量已满，请稍后重试", { exact: true })).toBeVisible();
});

function previewSnapshot(status: "STARTING" | "STREAMING" | "RECONNECTING" | "STOPPED") {
  return {
    sessionId,
    status,
    modelName: "V1",
    frameWidth: status === "STARTING" ? null : 1280,
    frameHeight: status === "STARTING" ? null : 720,
    inferenceFps: status === "STARTING" ? 0 : 4.8,
    lastInferenceMs: status === "STARTING" ? null : 38,
    detectionCount: status === "STARTING" ? 0 : 2,
    classCounts: status === "STARTING" ? {} : { "灭火器": 2 },
    lastFrameAt: status === "STARTING" ? null : new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  };
}
