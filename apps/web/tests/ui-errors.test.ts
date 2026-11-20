import assert from "node:assert/strict";
import test from "node:test";
import { localizeUiError } from "../src/ui-errors.js";

test.describe("web / UI error localization", () => {

test("localizeUiError preserves Chinese messages and trims surrounding whitespace", () => {
  assert.equal(localizeUiError(new Error("  会话已过期，请重新连接。  "), "操作失败"), "会话已过期，请重新连接。");
});

test("localizeUiError maps aborted requests", () => {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  assert.equal(localizeUiError(error, "操作失败"), "请求已取消。");
});

test("localizeUiError maps network errors from Error and string values", () => {
  assert.equal(localizeUiError(new Error("Failed to fetch"), "操作失败"), "网络连接失败，请检查服务器地址和网络后重试。");
  assert.equal(localizeUiError("network offline", "操作失败"), "网络连接失败，请检查服务器地址和网络后重试。");
});

test("localizeUiError maps known HTTP status codes", () => {
  assert.equal(localizeUiError(new Error("HTTP 503 upstream unavailable"), "操作失败"), "服务暂时不可用，请稍后重试。");
});

test("localizeUiError uses a safe fallback for unknown HTTP codes and unknown messages", () => {
  assert.equal(localizeUiError("HTTP 418 unexpected", "转换失败"), "服务器请求失败，请稍后重试。");
  assert.equal(localizeUiError(new Error("unrecognized upstream message"), "转换失败"), "转换失败");
});

test("localizeUiError sanitizes mixed Chinese and English transport/upstream errors", () => {
  assert.equal(localizeUiError(new Error("连接失败：ERR_NAME_NOT_RESOLVED"), "操作失败"), "网络连接失败，请检查服务器地址和网络后重试。");
  assert.equal(localizeUiError("上游服务失败：upstream unavailable", "操作失败"), "操作失败");
  assert.equal(localizeUiError("请求失败（HTTP 503：upstream unavailable）", "操作失败"), "服务暂时不可用，请稍后重试。");
  assert.equal(localizeUiError("ChatGPT 会话已过期，请重新登录。", "操作失败"), "ChatGPT 会话已过期，请重新登录。");
});

test("localizeUiError maps additional HTTP statuses and connection failures", () => {
  assert.equal(localizeUiError(new Error("HTTP 413 payload too large"), "操作失败"), "上传内容过大，请缩小文件或减少附件后重试。");
  assert.equal(localizeUiError(new Error("HTTP 421 Misdirected Request"), "操作失败"), "请求主机名未获信任，请检查服务器地址。");
  assert.equal(localizeUiError(new Error("HTTP 428 challenge required"), "操作失败"), "ChatGPT 要求完成交互式验证，请先在 ChatGPT 中完成验证后重试。");
  assert.equal(localizeUiError(new Error("connect ECONNREFUSED 127.0.0.1:8799"), "操作失败"), "网络连接失败，请检查服务器地址和网络后重试。");
});

test("localizeUiError handles empty messages and unsupported thrown values", () => {
  assert.equal(localizeUiError(new Error("   "), "操作失败"), "操作失败");
  assert.equal(localizeUiError({ message: "failed" }, "操作失败"), "操作失败");
});
});
