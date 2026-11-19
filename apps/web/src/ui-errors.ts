const STATUS_MESSAGES: Record<string, string> = {
  "400": "请求参数无效，请检查输入内容。",
  "401": "身份验证失败，请检查 API 密钥和 ChatGPT 会话。",
  "403": "当前账号或请求来源没有权限执行此操作。",
  "404": "请求的资源不存在或已过期。",
  "409": "会话状态已变化，请刷新后重试。",
  "422": "输入内容无法处理，请检查文件或参数。",
  "429": "请求过于频繁，请稍后再试。",
  "500": "服务器内部发生错误，请稍后重试。",
  "502": "上游服务暂时不可用，请检查网络或 WARP 连接。",
  "503": "服务暂时不可用，请稍后重试。",
  "504": "请求处理超时，请刷新会话后重试。",
};

const NETWORK_ERROR = /failed to fetch|networkerror|network request failed|load failed|fetch failed|offline/i;
const HAS_CHINESE = /[\u3400-\u9fff]/;

function localizeMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (!normalized) return fallback;
  if (HAS_CHINESE.test(normalized)) return normalized;
  if (NETWORK_ERROR.test(normalized)) {
    return "网络连接失败，请检查服务器地址和网络后重试。";
  }
  const status = normalized.match(/(?:HTTP\s*)?([45]\d{2})\b/i)?.[1];
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
