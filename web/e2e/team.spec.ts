import { expect, test } from "@playwright/test";

test("admin can open team page and create a member", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const username = `pw_user_${suffix}`;

  await page.goto("/login");
  await page.getByLabel("账号").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "团队与成员" })).toBeVisible();
  await page.getByRole("button", { name: "添加成员" }).click();
  await page.getByLabel("显示名称").fill(`Playwright成员${suffix}`);
  await page.getByLabel("登录名").fill(username);
  await page.getByLabel("初始密码").fill("playwright-pass-1");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(`Playwright成员${suffix}`)).toBeVisible();

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill("playwright-pass-1");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
