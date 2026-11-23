import assert from "node:assert/strict";
import test from "node:test";
import { injectionJs, localizeMirrorErrorMessage } from "../dist/mirror-controls.js";
import { decoderChallengeJs } from "../dist/decoder-challenge-ui.js";
import { translateUpstreamUiText } from "../dist/upstream-ui-localization.js";

const fallback = "操作失败，请检查会话令牌和服务器连接后重试。";
const network = "网络连接失败，请检查服务器地址和网络后重试。";

test.describe("server / Mirror control localization", () => {
  test("preserves Chinese-only errors and sanitizes mixed-language upstream errors", () => {
    assert.equal(localizeMirrorErrorMessage("会话已过期，请重新连接。"), "会话已过期，请重新连接。");
    assert.equal(localizeMirrorErrorMessage("上游服务失败：upstream unavailable"), fallback);
    assert.equal(localizeMirrorErrorMessage("请求失败（HTTP 503：upstream unavailable）"), "服务暂时不可用，请稍后重试。");
  });

  test("maps network failures and known or unknown HTTP statuses", () => {
    assert.equal(localizeMirrorErrorMessage(new Error("ERR_NAME_NOT_RESOLVED")), network);
    assert.equal(localizeMirrorErrorMessage("connect ECONNRESET"), network);
    assert.equal(localizeMirrorErrorMessage("HTTP 401 Unauthorized"), "身份验证失败，请重新连接 ChatGPT 会话。");
    assert.equal(localizeMirrorErrorMessage("HTTP 408 Request Timeout"), "请求处理超时，请检查网络后重试。");
    assert.equal(localizeMirrorErrorMessage("HTTP 410 Gone"), "请求的资源已失效，请刷新后重试。");
    assert.equal(localizeMirrorErrorMessage("HTTP 418"), "服务器请求失败，请稍后重试。");
    assert.equal(localizeMirrorErrorMessage("HTTP 418 upstream unavailable"), "服务器请求失败，请稍后重试。");
  });

  test("uses a safe fallback for empty, unknown, and non-message errors", () => {
    assert.equal(localizeMirrorErrorMessage(""), fallback);
    assert.equal(localizeMirrorErrorMessage("unknown failure"), fallback);
    assert.equal(localizeMirrorErrorMessage({ detail: "failed" }), fallback);
    assert.equal(localizeMirrorErrorMessage({ message: null }), fallback);
    assert.equal(localizeMirrorErrorMessage(null), fallback);
  });

  test("translates common upstream UI labels while leaving unknown and blank text untouched", () => {
    assert.equal(translateUpstreamUiText("New chat"), "新建聊天");
    assert.equal(translateUpstreamUiText("  Search  "), "搜索");
    assert.equal(translateUpstreamUiText("Message ChatGPT"), "发送消息给 ChatGPT");
    assert.equal(translateUpstreamUiText("Upload failed"), "上传失败");
    assert.equal(translateUpstreamUiText("Failed to upload image"), "文件上传失败，请重试。");
    assert.equal(translateUpstreamUiText("Failed to upload image: photo.png"), "文件上传失败，请重试。");
    assert.equal(translateUpstreamUiText("Image upload failed. Please try again."), "文件上传失败，请重试。");
    assert.equal(translateUpstreamUiText("This file is too large"), "文件过大，请缩小文件后重试。");
    assert.equal(translateUpstreamUiText("Unsupported image type"), "不支持此文件类型，请选择其他文件。");
    assert.equal(translateUpstreamUiText("User-authored sentence"), undefined);
    assert.equal(translateUpstreamUiText("   "), undefined);
  });

  test("injects a mutation-aware chrome-only localizer and a session-expiry recovery action", () => {
    assert.match(injectionJs, /MutationObserver/);
    assert.match(injectionJs, /upstreamProtectedSelector/);
    assert.match(injectionJs, /aria-label/);
    assert.match(injectionJs, /placeholder/);
    assert.match(injectionJs, /mirror-session-expired-notice/);
    assert.match(injectionJs, /findExpiredSessionDialog/);
    assert.match(injectionJs, /hasVisibleExpiredText/);
    assert.match(injectionJs, /translateUpstreamUiText/);
    assert.match(injectionJs, /更新会话令牌/);
  });

  test("localizes signup actions and recognizes Chinese composer placeholders", () => {
    assert.match(injectionJs, /Sign up/);
    assert.match(injectionJs, /免费注册/);
    assert.match(injectionJs, /注册/);
    assert.match(decoderChallengeJs, /textarea\[placeholder\*="消息"\]/);
    assert.match(decoderChallengeJs, /textarea\[placeholder\*="发送"\]/);
  });
});
