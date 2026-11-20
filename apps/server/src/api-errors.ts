import type { ZodError } from "zod";

/** Public errors and diagnostics contain no upstream payloads or exception text. */
const categories: Record<number, [string, string, string]> = {
  400: ["invalid_request_error", "invalid_request", "请求无效，请检查支持的字段和消息历史。"],
  401: ["authentication_error", "authentication_required", "请配置有效的 Mirror API 密钥，并检查 ChatGPT 会话是否就绪。"],
  403: ["permission_error", "request_forbidden", "请求已拒绝，请检查浏览器来源和账号权限。"],
  404: ["invalid_request_error", "not_found", "未找到请求的资源。"],
  409: ["invalid_request_error", "conversation_conflict", "会话或登录状态已变化，请刷新后继续。"],
  428: ["challenge_required_error", "challenge_required", "ChatGPT 要求完成交互式验证。请先在 ChatGPT 中完成验证后重试，或提供本次请求专用的验证令牌。"],
  429: ["rate_limit_error", "rate_limit_exceeded", "请求频率已达上限，请稍后再发送请求。"],
  504: ["timeout_error", "deadline_exceeded", "生成请求超时。请在重试前重新加载历史记录；上游是否已完成尚不确定。"],
};
const recent: Array<{ at: string; code: string; requestId: string; protocolCategory: string | null }> = [];

export function localizedZodError(error: ZodError): string {
  return error.issues.map((issue) => {
    if (/[㐀-鿿]/.test(issue.message)) return issue.message;
    if (issue.code === "invalid_union") {
      const localized = issue.unionErrors
        .flatMap((nestedError) => nestedError.issues)
        .find((nestedIssue) => /[㐀-鿿]/.test(nestedIssue.message));
      if (localized) return localized.message;
    }
    const field = issue.path.join(".");
    return issue.code === "invalid_type"
      ? `字段 ${field} 的类型不正确。`
      : `字段 ${field} 的格式无效。`;
  }).join("；");
}
export function apiError(status: number, message: string, requestId: string) {
  const [type, code, fallback] = categories[status] ?? ["server_error", "upstream_failure", "生成失败。请检查 WARP 连接和会话状态，然后重新加载历史记录并重试。"];
  return { error: { type, code, message: status === 400 ? message : fallback, request_id: requestId } };
}
export function recordFailure(code: string, requestId: string, protocolCategory: string | null = null) {
  recent.push({ at: new Date().toISOString(), code, requestId, protocolCategory });
  if (recent.length > 20) recent.shift();
}
export function recentFailures() { return recent.map(item => ({ ...item })); }
