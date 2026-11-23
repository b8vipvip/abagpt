const STATUS_MESSAGES: Record<string, string> = {
  "400": "请求参数无效，请检查输入内容。",
  "401": "身份验证失败，请检查 API 密钥和 ChatGPT 会话。",
  "403": "当前账号或请求来源没有权限执行此操作。",
  "404": "请求的资源不存在或已过期。",
  "408": "请求处理超时，请检查网络后重试。",
  "409": "会话状态已变化，请刷新后重试。",
  "410": "请求的资源已失效，请刷新后重试。",
  "411": "请求缺少必要的内容长度信息。",
  "412": "请求前置条件未满足，请刷新后重试。",
  "414": "请求地址过长，请缩短请求内容后重试。",
  "416": "请求的文件范围无效，请重新选择文件。",
  "417": "服务器无法满足请求预期。",
  "425": "请求暂时无法处理，请稍后重试。",
  "426": "服务器要求升级连接协议，请检查代理配置。",
  "413": "上传内容过大，请缩小文件或减少附件后重试。",
  "415": "不支持此内容类型，请检查上传文件格式。",
  "421": "请求主机名未获信任，请检查服务器地址。",
  "422": "输入内容无法处理，请检查文件或参数。",
  "428": "ChatGPT 要求完成交互式验证，请先在 ChatGPT 中完成验证后重试。",
  "431": "请求标头过大，请检查客户端配置后重试。",
  "429": "请求过于频繁，请稍后再试。",
  "500": "服务器内部发生错误，请稍后重试。",
  "502": "上游服务暂时不可用，请检查网络或 WARP 连接。",
  "503": "服务暂时不可用，请稍后重试。",
  "504": "请求处理超时，请刷新会话后重试。",
  "451": "该资源因法律限制无法提供。",
  "507": "服务器存储空间不足，请联系管理员。",
  "508": "服务器检测到循环请求，请检查代理配置。",
  "511": "网络需要身份验证，请检查网络代理设置。",
};

const NETWORK_ERROR = /failed to fetch|networkerror|network request failed|load failed|fetch failed|offline|socket hang up|connection closed|connection reset|connection refused|econnrefused|econnreset|econnaborted|err_network|err_name_not_resolved|err_cert_[a-z_]+|err_connection_[a-z_]+|err_http2_protocol_error|err_empty_response|err_socket_not_connected|err_address_unreachable|err_network_changed|err_timed_out|err_internet_disconnected/i;
const UNTRANSLATED_ERROR = /\b(?:upstream|unauthorized|forbidden|not found|bad request|internal server error|service unavailable|temporarily unavailable|rate limit(?: exceeded)?|invalid(?: request| input| parameter)?|failed|failure|error|denied|expired|unsupported|timed out|timeout)\b/i;
const HAS_CHINESE = /[\u3400-\u9fff]/;

function localizeMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (!normalized) return fallback;
  if (NETWORK_ERROR.test(normalized)) {
    return "网络连接失败，请检查服务器地址和网络后重试。";
  }
  const status = normalized.match(/(?:HTTP\s*)?([45]\d{2})\b/i)?.[1];
  if (UNTRANSLATED_ERROR.test(normalized)) {
    return status ? STATUS_MESSAGES[status] ?? "服务器请求失败，请稍后重试。" : fallback;
  }
  if (HAS_CHINESE.test(normalized)) return normalized;
  if (status) {
    return STATUS_MESSAGES[status] ?? "服务器请求失败，请稍后重试。";
  }
  return fallback;
}

/** Convert transport/API failures into concise Simplified Chinese UI messages. */
export function localizeUiError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "请求已取消。";
    return localizeMessage(error.message, fallback);
  }
  if (typeof error === "string") return localizeMessage(error, fallback);
  return fallback;
}
