import { test, expect } from "@playwright/test";
import { injectionJs, injectionCss } from "../../apps/server/dist/mirror-controls.js";

test.describe("browser / cross-engine Chinese localization", () => {
  test("dynamic ChatGPT chrome labels localize, message text stays intact, and expired sessions are recoverable", async ({ page }) => {
    await page.route("**/api/session", route => route.fulfill({ json: { configured: true } }));
    await page.route("**/api/health", route => route.fulfill({ json: { egress: { mode: "direct" } } }));
    await page.goto("/mirror/playground");
    await page.evaluate(() => {
      const aside = document.createElement("aside");
      const account = document.createElement("button");
      account.setAttribute("data-testid", "accounts-profile-button");
      account.textContent = "Account";
      aside.append(account);

      const nav = document.createElement("nav");
      nav.id = "fixture-nav";
      const login = document.createElement("button");
      login.id = "fixture-login";
      login.textContent = "Log in";
      nav.append(login);

      const composer = document.createElement("div");
      composer.id = "fixture-composer";
      composer.setAttribute("data-testid", "composer");
      const textarea = document.createElement("textarea");
      textarea.setAttribute("placeholder", "Message ChatGPT");
      composer.append(textarea);

      const protectedContent = document.createElement("main");
      const turn = document.createElement("div");
      turn.setAttribute("data-message-author-role", "assistant");
      turn.id = "fixture-message";
      const protectedButton = document.createElement("button");
      protectedButton.textContent = "New chat";
      turn.append(protectedButton);
      protectedContent.append(turn);

      const expired = document.createElement("div");
      expired.id = "modal-expired-session";
      expired.textContent = "Your session has expired";
      document.body.append(aside, nav, composer, protectedContent, expired);
    });
    await page.addStyleTag({ content: injectionCss });
    await page.addScriptTag({ content: injectionJs });

    await expect(page.locator("#fixture-login")).toHaveText("登录");
    await expect(page.locator("#fixture-login")).toHaveAttribute("aria-label", "登录");
    await expect(page.locator("#fixture-composer textarea")).toHaveAttribute("placeholder", "发送消息给 ChatGPT");
    await expect(page.locator("#fixture-message button")).toHaveText("New chat");
    await expect(page.locator("#mirror-session-expired-notice")).toContainText("ChatGPT 会话已失效");
    await expect(page.locator("#modal-expired-session")).toBeHidden();

    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Settings";
      button.setAttribute("aria-label", "More options");
      button.setAttribute("title", "Settings");
      document.querySelector("#fixture-nav")?.append(button);
    });
    const dynamicButton = page.locator("#fixture-nav button").nth(1);
    await expect(dynamicButton).toHaveText("设置");
    await expect(dynamicButton).toHaveAttribute("aria-label", "更多选项");
    await expect(dynamicButton).toHaveAttribute("title", "设置");

    // Upstream controls can split labels across nested spans and icon fallbacks.
    await page.evaluate(() => {
      const button = document.createElement("button");
      const label = document.createElement("span");
      label.textContent = "Set";
      const suffix = document.createElement("span");
      suffix.textContent = "tings";
      button.append(label, suffix);
      document.querySelector("#fixture-nav")?.append(button);
    });
    await expect(page.locator("#fixture-nav button").nth(2)).toHaveText("设置");

    await page.evaluate(() => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.textContent = "Archive";
      menu.append(item);
      document.querySelector("#fixture-nav")?.append(menu);
    });
    await expect(page.locator("#fixture-nav [role=menuitem]")).toHaveText("归档");

    await page.getByRole("button", { name: "更新会话令牌" }).click();
    await expect(page.locator("#mirror-launcher .mirror-panel")).toHaveClass(/open/);
  });

  test("Playground remains readable without horizontal overflow on phone and tablet widths", async ({ page }) => {
    await page.goto("/mirror/playground");
    await expect(page.getByLabel("服务器地址")).toBeVisible();
    for (const width of [320, 360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(hasOverflow, "unexpected horizontal overflow at width " + width).toBe(false);
    }
  });
});
