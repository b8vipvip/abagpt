/**
 * Startup preflight classification (MIR-35).
 *
 * Mirror's actual startup sequence (see the entrypoint block at the bottom of
 * `index.ts`) is: build the app (config parsing, master-key/`MIRROR_STORE_KEY`
 * decoding, database open + migration) -> verify required WARP egress -> bind
 * the HTTP listener. Each of those three phases fails in a recognizably
 * different way today; this module turns whichever one throws into one short,
 * actionable line instead of a raw stack trace, so a failed `npm start` (or
 * a failed container boot) says what to actually do next rather than just
 * where in the code it happened.
 *
 * Deliberately scoped to what can actually throw during *this* startup path.
 * A missing Playwright/Chromium browser (used lazily, only when a live
 * Turnstile challenge needs solving) and an expired ChatGPT session token
 * (only discovered on the first proxied/API request) are both real failure
 * modes, but neither one happens at boot in the current code - they already
 * surface through `GET /api/diagnostics` (MIR-09) with their own next-action
 * text once a request actually hits them. Claiming to preflight-check those
 * here would be checking something Mirror doesn't actually check yet.
 */

export type StartupFailureCategory =
  | "configuration"
  | "database-migration"
  | "warp-egress"
  | "port-in-use"
  | "unknown";

export interface ClassifiedStartupFailure {
  category: StartupFailureCategory;
  message: string;
  nextAction: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node sets `.code` on the `Error` for OS-level failures like a bound port. */
function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function classifyStartupFailure(error: unknown): ClassifiedStartupFailure {
  const message = messageOf(error);
  const code = codeOf(error);

  if (code === "EADDRINUSE") {
    return {
      category: "port-in-use",
      message,
      nextAction:
        "另一个进程正在使用此端口。请停止该进程，或将 PORT（直接运行）／MIRROR_PORT（Compose）设置为未占用的端口。",
    };
  }

  if (message.includes("Mirror 必须通过 WARP 出站") || message.includes("Mirror requires WARP")) {
    return {
      category: "warp-egress",
      message,
      nextAction:
        "请确认随附的 WARP 容器正在运行，并已设置 WARP_ACCEPT_TOS=yes，然后重新启动。Mirror 不会回退到直连网络。",
    };
  }

  if (
    message.includes("数据库 Schema 版本不受支持") ||
    message.includes("Unsupported database schema version") ||
    message.includes("database schema")
  ) {
    return {
      category: "database-migration",
      message,
      nextAction:
        "此数据库由更新版本的 Mirror 创建。请恢复兼容的备份或升级 Mirror，参阅 RELEASE-RECOVERY.md。",
    };
  }

  if (
    message.includes("MIRROR_STORE_KEY") ||
    message.includes("必须恰好为 32 字节") ||
    message.includes("must decode to exactly 32 bytes")
  ) {
    return {
      category: "configuration",
      message,
      nextAction:
        "请修正环境变量中的 MIRROR_STORE_KEY：它必须是 32 字节，并使用 Base64 或十六进制编码；也可以取消设置，让 Mirror 自动生成密钥。",
    };
  }

  return {
    category: "unknown",
    message,
    nextAction:
      "请检查上方的完整错误信息；如果问题持续发生，请携带此信息提交 Issue（其中已排除凭据和令牌）。",
  };
}

/** Renders a `classifyStartupFailure` result as the one block of text Mirror
 * actually prints to stderr on a failed boot. */
export function formatStartupFailure(error: unknown): string {
  const { category, message, nextAction } = classifyStartupFailure(error);
  return `Mirror 启动失败 [${category}]：${message}\n下一步建议：${nextAction}`;
}
