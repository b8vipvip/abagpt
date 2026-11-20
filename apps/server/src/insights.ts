import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CompletionBody } from "./openai.js";
import { getEgressStatus } from "./egress.js";
import { configuredApiKeys } from "./security.js";
import { recentFailures } from "./api-errors.js";
import { DATABASE_SCHEMA_VERSION } from "./schema.js";
import { databaseHealthy, getSession, getConversation, getInstructions, listMessages, searchConversations, relatedConversations, getDefaultSystemInstructions, setDefaultSystemInstructions, getHotkeys, setHotkeys } from "./store.js";

export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200) });
export const ExportQuery = z.object({
  format: z.enum(["json", "markdown"]).default("json"),
  attachments: z.enum(["true", "false"]).default("false"),
  metadata: z.enum(["true", "false"]).default("false"),
});
export const IdParams = z.object({ id: z.string().min(1).max(200) });
export const DefaultSystemInstructionsBody = z.object({ content: z.string().max(20_000) });
export const HotkeysBody = z.object({ hotkeys: z.record(z.string(), z.string().max(60)) });

export function capabilities() {
  return {
    schemaVersion: 1,
    routes: ["GET /v1/models", "POST /v1/chat/completions", "POST /v1/responses", "GET /v1/capabilities"],
    fields: Object.keys(CompletionBody.shape),
    metadataFields: ["conversation_id", "mirror_model", "private"],
    approximations: ["system/developer instructions"],
    ignored: ["stop", "max_tokens", "max_completion_tokens"],
    unsupported: ["tools", "tool_choice", "response_format", "temperature", "top_p", "seed", "n", "audio", "work_mode"],
    responses: { textInput: true, streaming: true, previousResponseId: false, retrieval: false, tools: false, continuation: "metadata.conversation_id or full input history" },
    usage: null,
    conversation: { minimalContinuation: true, fullHistory: true, assistantEditable: false, streamId: "SSE comment", jsonId: "x-mirror-conversation-id" },
  };
}

export async function registerInsightRoutes(app: FastifyInstance) {
  const account = () => getSession()?.accountId ?? "default";
  app.get("/v1/capabilities", async () => capabilities());
  app.get("/api/diagnostics", async () => {
    const egress = getEgressStatus();
    return {
      schemaVersion: 1,
      build: { version: process.env.MIRROR_VERSION ?? "development", revision: /^[a-f0-9]{7,40}$/.test(process.env.MIRROR_BUILD_REVISION ?? "") ? process.env.MIRROR_BUILD_REVISION : "development" },
      api: { reachable: true, keyConfigured: configuredApiKeys().length > 0 },
      storage: { engine: "sqlite", healthy: databaseHealthy(), schemaVersion: DATABASE_SCHEMA_VERSION },
      egress: { required: egress.required, verified: egress.verified, mode: egress.mode, checkedAt: egress.checkedAt },
      session: { saved: Boolean(getSession()), generationVerified: false },
      recentFailures: recentFailures(),
      nextAction: !egress.verified ? "请检查 WARP 容器的运行状态。" : !getSession() ? "请在 Mirror 控制台中保存 ChatGPT 会话。" : "请先测试模型发现，再在 API 测试台中显式发起一次生成请求。",
    };
  });
  // Account-wide sticky default for the Playground's System box: saved
  // explicitly (not on every keystroke) so a half-typed edit is never
  // silently promoted to the account default; see App.tsx's save trigger.
  app.get("/api/settings/default-system-instructions", async () => ({
    content: getDefaultSystemInstructions(account()),
  }));
  app.put("/api/settings/default-system-instructions", async req => {
    const { content } = DefaultSystemInstructionsBody.parse(req.body);
    setDefaultSystemInstructions(account(), content);
    return { content };
  });
  // Per-account keyboard shortcut overrides. Only overrides are stored
  // server-side - the built-in defaults (DEFAULT_HOTKEYS in the web app's
  // hotkeys.ts) apply for anything missing here, so resetting a shortcut
  // is just omitting its key rather than re-sending the default value.
  app.get("/api/settings/hotkeys", async () => ({ hotkeys: getHotkeys(account()) }));
  app.put("/api/settings/hotkeys", async req => {
    const { hotkeys } = HotkeysBody.parse(req.body);
    setHotkeys(account(), hotkeys);
    return { hotkeys };
  });
  app.get("/api/conversations/search", async req => ({ items: searchConversations(account(), SearchQuery.parse(req.query).q) }));
  app.get("/api/conversations/:id/branches", async (req, reply) => {
    const conversation = getConversation(IdParams.parse(req.params).id);
    if (conversation?.accountId !== account()) return reply.code(404).send({ error: "未找到对话。" });
    return { selected: conversation.id, parent: conversation.currentNodeId,
      items: conversation.conversationId ? relatedConversations(account(), conversation.conversationId) : [conversation],
      nodes: listMessages(conversation.id).map(({ id, upstreamNodeId, role, status }) => ({ id, upstreamNodeId, role, status })),
    };
  });
  app.get("/api/conversations/:id/export", async (req, reply) => {
    const conversation = getConversation(IdParams.parse(req.params).id);
    if (conversation?.accountId !== account()) return reply.code(404).send({ error: "未找到对话。" });
    const query = ExportQuery.parse(req.query);
    const messages = listMessages(conversation.id).map(message => ({ role: message.role, content: message.content,
      ...(query.metadata === "true" ? { status: message.status, createdAt: message.createdAt, upstreamNodeId: message.upstreamNodeId } : {}),
      // store.ts's attachments_json column is NOT NULL DEFAULT '[]', so
      // listMessages() always returns a real (possibly empty) array here -
      // the field is optional only in StoredMessage's input/write shape.
      ...(query.attachments === "true" ? { attachments: message.attachments!.map(file => ({ fileId: file.fileId, fileName: file.fileName, mimeType: file.mimeType })) } : {}),
    }));
    const exported = { schemaVersion: 1, kind: "mirror-transcript-archive", resumableImport: false,
      title: conversation.title, instructions: getInstructions(conversation.id), messages,
      ...(query.metadata === "true" ? { metadata: { mirrorId: conversation.id, upstreamId: conversation.conversationId, currentNodeId: conversation.currentNodeId, model: conversation.model } } : {}),
    };
    reply.header("content-disposition", `attachment; filename="mirror-conversation.${query.format === "json" ? "json" : "md"}"`);
    if (query.format === "json") return exported;
    return reply.type("text/markdown; charset=utf-8").send([
      `# ${conversation.title}`, "对话转录归档；导入此文件不会创建可续接的上游对话线程。",
      ...[...exported.instructions, ...messages].map(message => `## ${message.role}\n\n${message.content}`),
      ...(query.attachments === "true" || query.metadata === "true" ? ["## 所选归档详情", JSON.stringify(exported, null, 2)] : []),
    ].join("\n\n"));
  });
}
