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

test("localizeUiError handles empty messages and unsupported thrown values", () => {
  assert.equal(localizeUiError(new Error("   "), "操作失败"), "操作失败");
  assert.equal(localizeUiError({ message: "failed" }, "操作失败"), "操作失败");
});
});
