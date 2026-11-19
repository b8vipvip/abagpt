export function responseText(value: any): string {
  if (value?.status !== "completed" || !Array.isArray(value.output))
    throw new Error(value?.error?.message ?? "响应未能成功完成。");
  const parts = value.output.filter((item: any) => item.type === "message" && item.role === "assistant")
    .flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === "output_text");
  if (!parts.length || parts.some((part: any) => typeof part.text !== "string"))
    throw new Error("不支持的响应格式：未返回助手文本。");
  return parts.map((part: any) => part.text).join("");
}

export async function readResponsesStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void, onRaw: (raw: string) => void, onConversation: (id: string) => void): Promise<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", raw = "", completed = false;
  function frame(value: string) {
    const data = value.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    raw += data + "\n"; onRaw(raw);
    const event = JSON.parse(data);
    if (event.type === "error" || event.error || event.type === "response.failed" || event.type === "response.incomplete")
      throw new Error(event.response?.error?.message ?? event.error?.message ?? event.message ?? "响应失败或未完整结束，已保留部分输出。");
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") throw new Error("响应文本增量格式无效。");
      text += event.delta; onText(text);
    }
    if (event.type === "response.completed") {
      text = responseText(event.response); onText(text); completed = true;
      const id = event.response.metadata?.conversation_id;
      if (typeof id === "string" && id) onConversation(id);
    }
  }
  try {
    while (!completed) {
      const result = await reader.read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop()!;
      for (const value of frames) frame(value);
      if (result.done) { if (buffer.trim()) frame(buffer); break; }
    }
    if (!completed) throw new Error("响应在完成前中断，已保留部分输出。");
    return text;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
