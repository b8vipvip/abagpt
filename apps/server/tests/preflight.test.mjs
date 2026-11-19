import assert from "node:assert/strict";
import test from "node:test";
import { classifyStartupFailure, formatStartupFailure } from "../dist/preflight.js";

test.describe("server / preflight", () => {
  test("classifies a port-in-use failure with its Node error code", () => {
    const error = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"), { code: "EADDRINUSE" });
    const result = classifyStartupFailure(error);
    assert.equal(result.category, "port-in-use");
    assert.match(result.nextAction, /PORT|MIRROR_PORT/);
    assert.match(result.nextAction, /另一个进程正在使用此端口/);
  });

  test("classifies a WARP egress verification failure", () => {
    const error = new Error("Mirror requires WARP, but WARP egress could not be verified: fixture");
    const result = classifyStartupFailure(error);
    assert.equal(result.category, "warp-egress");
    assert.match(result.nextAction, /WARP_ACCEPT_TOS/);
    assert.match(result.nextAction, /请确认随附的 WARP 容器/);
  });

  test("classifies an unsupported/incompatible database schema version", () => {
    const error = new Error("Unsupported database schema version; use a compatible Mirror release or restore a pre-upgrade backup.");
    const result = classifyStartupFailure(error);
    assert.equal(result.category, "database-migration");
    assert.match(result.nextAction, /RELEASE-RECOVERY/);
    assert.match(result.nextAction, /此数据库由更新版本的 Mirror 创建/);
  });

  test("classifies a malformed MIRROR_STORE_KEY", () => {
    const error = new Error("MIRROR_STORE_KEY must decode to exactly 32 bytes");
    const result = classifyStartupFailure(error);
    assert.equal(result.category, "configuration");
    assert.match(result.nextAction, /32 字节/);
  });

  test("falls back to an unknown category for anything else, including non-Error throws", () => {
    const result = classifyStartupFailure("a plain string throw");
    assert.equal(result.category, "unknown");
    assert.equal(result.message, "a plain string throw");
    assert.match(result.nextAction, /提交 Issue/);
  });

  test("formatStartupFailure renders the category, message and next step as one block", () => {
    const rendered = formatStartupFailure(new Error("Mirror requires WARP, but WARP egress could not be verified: fixture"));
    assert.match(rendered, /^Mirror 启动失败 \[warp-egress\]：Mirror requires WARP/);
    assert.match(rendered, /下一步建议：请确认随附的 WARP 容器/);
  });
});
