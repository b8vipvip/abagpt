import assert from "node:assert/strict";
import test from "node:test";
import { injectionJs, localizeMirrorErrorMessage } from "../dist/mirror-controls.js";
import { decoderChallengeJs } from "../dist/decoder-challenge-ui.js";

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
    assert.equal(localizeMirrorErrorMessage("HTTP 418"), "服务器请求失败，请稍后重试。");
  });

  test("uses a safe fallback for empty, unknown, and non-message errors", () => {
    assert.equal(localizeMirrorErrorMessage(""), fallback);
    assert.equal(localizeMirrorErrorMessage("unknown failure"), fallback);
    assert.equal(localizeMirrorErrorMessage({ detail: "failed" }), fallback);
    assert.equal(localizeMirrorErrorMessage(null), fallback);
  });

  test("localizes signup actions and recognizes Chinese composer placeholders", () => {
    assert.match(injectionJs, /Sign up/);
    assert.match(injectionJs, /免费注册/);
    assert.match(injectionJs, /注册/);
    assert.match(decoderChallengeJs, /textarea\\[placeholder\\*="消息"\\]/);
    assert.match(decoderChallengeJs, /textarea\\[placeholder\\*="发送"\\]/);
  });
});
