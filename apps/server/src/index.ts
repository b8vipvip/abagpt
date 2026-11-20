import { registerInsightRoutes } from "./insights.js";
import { registerDecoderChallengeRoutes } from "./decoder-challenges.js";
import { registerConversionRoutes } from "./conversion-routes.js";
import { uploadMimeType } from "./upload-mime.js";
import { registerAssetContentRoute } from "./asset-content.js";
import { apiError, recordFailure } from "./api-errors.js";
import { formatStartupFailure } from "./preflight.js";
import { syncConversationPage, hasRemoteHistory } from "./conversation-sync.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { stringify as toYaml } from "yaml";
import { z, ZodError } from "zod";
import { buildOpenApiDocument } from "./openapi-document.js";
import {
  SetSessionBody,
  ConversationIdParam,
  ModelUpdateBody,
  BranchBody,
  NewConversationBody,
  ConversationsQuery,
  AssetsQuery,
  ChatBody,
} from "./api-schemas.js";
import {
  ChatGptBackendClient,
  normalizeGizmos,
  normalizeModels,
  type NormalizedConversationEvent,
} from "@mirror/protocol";
import { getValidCredentials, verifyCandidateSessionToken } from "./auth.js";
import { runChat, stopConversation } from "./chat-service.js";
import { registerOpenAiRoutes } from "./openai.js";
import {
  injectionCss,
  injectionJs,
  proxyChatGpt,
  proxyWebSocketUpgrade,
} from "./proxy.js";
import {
  getEgressStatus,
  monitorRequiredEgress,
  verifyRequiredEgress,
} from "./egress.js";
import {
  controlCookie,
  authorizedLocalRequest,
  mayBootstrapBrowser,
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  tokenMatches,
} from "./security.js";
import {
  getSessionRevision,
  assertSessionRevision,
  getInstructions,
  branchConversation,
  claimDefaultAccountData,
  clearSession,
  countConversations,
  createConversation,
  databaseHealthy,
  deleteConversation,
  getConversation,
  getConversationSyncCursor,
  getSession,
  importRemoteConversation,
  listConversations,
  listMessages,
  saveFile,
  saveVerifiedSession,
  setConversationModel,
  setConversationSyncCursor,
  syncRemoteConversations,
  updateMintedToken,
  ownsFile,
  ownsUpstreamConversation,
} from "./store.js";

export const swaggerUiZhCnScript = "(() => {\n  const translations = new Map([\n    [\"Swagger UI\", \"接口文档\"], [\"Authorize\", \"授权\"], [\"Servers\", \"服务器\"],\n    [\"Server\", \"服务器\"], [\"Models\", \"模型\"], [\"Schemas\", \"数据结构\"],\n    [\"Parameters\", \"请求参数\"], [\"Responses\", \"响应结果\"], [\"Response\", \"响应\"],\n    [\"Request body\", \"请求体\"], [\"Request Body\", \"请求体\"], [\"Try it out\", \"试用\"],\n    [\"Cancel\", \"取消\"], [\"Execute\", \"发送请求\"], [\"Clear\", \"清空\"], [\"Reset\", \"重置\"],\n    [\"Download\", \"下载\"], [\"Copy\", \"复制\"], [\"Copied!\", \"已复制！\"],\n    [\"Example Value\", \"示例值\"], [\"Model\", \"模型\"], [\"Name\", \"名称\"],\n    [\"Description\", \"说明\"], [\"Type\", \"类型\"], [\"Required\", \"必填\"],\n    [\"Optional\", \"选填\"], [\"Deprecated\", \"已弃用\"],\n    [\"Response content type\", \"响应内容类型\"], [\"Request content type\", \"请求内容类型\"],\n    [\"Response samples\", \"响应示例\"], [\"Response schema\", \"响应结构\"],\n    [\"Response headers\", \"响应标头\"], [\"Request samples\", \"请求示例\"],\n    [\"Request URL\", \"请求地址\"], [\"Response body\", \"响应内容\"],\n    [\"Response code\", \"响应状态码\"], [\"Response time\", \"响应耗时\"],\n    [\"Headers\", \"请求标头\"], [\"Available authorizations\", \"可用的身份验证方式\"],\n    [\"Authorization\", \"身份验证\"], [\"Scopes\", \"权限范围\"],\n    [\"No operations defined in spec!\", \"当前 OpenAPI 文档未定义任何接口。\"],\n    [\"Loading...\", \"正在加载…\"], [\"Failed to load API definition.\", \"API 文档加载失败。\"],\n    [\"Fetch error\", \"获取失败\"], [\"Filter by tag\", \"按标签筛选\"], [\"Filter\", \"筛选\"],\n    [\"Show/Hide\", \"展开／收起\"], [\"List Operations\", \"接口列表\"],\n    [\"Expand Operations\", \"展开接口\"], [\"Collapse Operations\", \"收起接口\"],\n    [\"Available values\", \"可选值\"], [\"Undocumented\", \"未在文档中说明\"],\n    [\"Logout\", \"退出\"], [\"Close\", \"关闭\"], [\"Open\", \"打开\"], [\"Send\", \"发送\"],\n    [\"Select a definition\", \"选择 API 定义\"],\n    [\"Curl\", \"cURL 命令\"], [\"Server response\", \"服务器响应\"],\n    [\"Code\", \"状态码\"], [\"Details\", \"详情\"], [\"Schema\", \"数据结构\"],\n    [\"Example\", \"示例\"], [\"Value\", \"值\"], [\"Apply\", \"应用\"],\n    [\"Hide\", \"收起\"], [\"Show\", \"展开\"], [\"Expand all\", \"全部展开\"], [\"Collapse all\", \"全部收起\"],\n    [\"Client ID\", \"客户端 ID\"], [\"Client secret\", \"客户端密钥\"],\n    [\"Username\", \"用户名\"], [\"Password\", \"密码\"], [\"Available scopes\", \"可用权限范围\"],\n    [\"Authorization URL\", \"授权地址\"], [\"Token URL\", \"令牌地址\"],\n    [\"API definition\", \"API 定义\"], [\"Download API definition\", \"下载 API 定义\"],\n    [\"Copy to clipboard\", \"复制到剪贴板\"], [\"Copied to clipboard\", \"已复制到剪贴板\"],\n    [\"Try it out!\", \"试用\"], [\"Send API Request\", \"发送 API 请求\"],\n    [\"Parameter content type\", \"参数内容类型\"], [\"Parameter\", \"参数\"],\n    [\"Default\", \"默认值\"], [\"Format\", \"格式\"], [\"In\", \"位置\"],\n    [\"Body\", \"请求体\"], [\"Query\", \"查询参数\"], [\"Path\", \"路径\"], [\"Header\", \"请求标头\"],\n    [\"API Key\", \"API 密钥\"], [\"Enter API key\", \"输入 API 密钥\"],\n    [\"No API definition provided.\", \"未提供 API 定义。\"],\n    [\"No API definition provided\", \"未提供 API 定义\"],\n    [\"No operations found\", \"未找到接口\"], [\"Operations\", \"接口操作\"],\n    [\"Request duration\", \"请求耗时\"], [\"Response duration\", \"响应耗时\"],\n    [\"Server URL\", \"服务器地址\"], [\"Select a server\", \"选择服务器\"],\n    [\"Edit\", \"编辑\"], [\"Submit\", \"提交\"], [\"Add\", \"添加\"],\n    [\"Errors\", \"错误\"], [\"Error\", \"错误\"], [\"Links\", \"链接\"], [\"Link\", \"链接\"],\n    [\"No links\", \"没有链接\"], [\"No parameters\", \"没有请求参数\"], [\"No body\", \"没有请求体\"],\n    [\"No examples\", \"没有可用示例\"], [\"No example\", \"没有可用示例\"], [\"No response\", \"没有响应\"],\n    [\"No responses\", \"未定义响应\"], [\"Security\", \"安全\"], [\"Security Schemes\", \"安全方案\"],\n    [\"Server Variables\", \"服务器变量\"], [\"Variables\", \"变量\"], [\"Show More\", \"显示更多\"],\n    [\"Show Less\", \"收起更多\"], [\"Expand operation\", \"展开接口详情\"], [\"Collapse operation\", \"收起接口详情\"],\n    [\"Could not render this component, see the console.\", \"无法渲染此组件，请查看浏览器控制台。\"],\n    [\"No security requirements defined\", \"未定义安全要求\"], [\"Additional Information\", \"其他信息\"],\n    [\"Extensions\", \"扩展信息\"], [\"Explore\", \"加载文档\"]\n  ]);\n  const translatedAttributes = [\"aria-label\", \"placeholder\", \"title\"];\n  const skipSelectors = \"pre, code, .microlight, .highlight-code, .model-box\";\n\n  function visit(node) {\n    if (node.nodeType === Node.TEXT_NODE) {\n      const original = node.nodeValue;\n      if (typeof original !== \"string\") return;\n      const translated = translations.get(original.trim());\n      if (translated && translated !== original.trim()) {\n        node.nodeValue = original.replace(original.trim(), translated);\n      }\n      return;\n    }\n    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(skipSelectors)) return;\n    for (const name of translatedAttributes) {\n      const value = node.getAttribute(name);\n      if (!value) continue;\n      const translated = translations.get(value.trim());\n      if (translated && translated !== value) node.setAttribute(name, translated);\n    }\n    for (const child of node.childNodes) visit(child);\n  }\n\n  function start() {\n    if (!document.body) return;\n    document.documentElement.lang = \"zh-CN\";\n    document.title = \"Mirror API 接口文档\";\n    visit(document.body);\n    const observer = new MutationObserver((records) => {\n      for (const record of records) {\n        if (record.type === \"characterData\" || record.type === \"attributes\") visit(record.target);\n        for (const added of record.addedNodes) visit(added);\n      }\n    });\n    observer.observe(document.body, {\n      subtree: true, childList: true, characterData: true,\n      attributes: true, attributeFilter: translatedAttributes\n    });\n  }\n\n  if (document.readyState === \"loading\") {\n    document.addEventListener(\"DOMContentLoaded\", start, { once: true });\n  } else {\n    start();\n  }\n})();";
const swaggerUiZhCnCss = ".swagger-ui {\n  font-family: Inter, \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", sans-serif;\n}\n.swagger-ui .info .title,\n.swagger-ui .opblock-tag,\n.swagger-ui .opblock-summary-description,\n.swagger-ui .markdown,\n.swagger-ui .model-title {\n  overflow-wrap: anywhere;\n}\n.swagger-ui .opblock-summary { min-height: 48px; }\n.swagger-ui button,\n.swagger-ui input,\n.swagger-ui select,\n.swagger-ui textarea { font-family: inherit; }\n@media (max-width: 640px) {\n  .swagger-ui .wrapper { padding: 0 8px; }\n  .swagger-ui .topbar .wrapper { padding: 8px; }\n  .swagger-ui .topbar .download-url-wrapper { width: 100%; max-width: 100%; }\n  .swagger-ui .topbar .download-url-wrapper input { min-width: 0; }\n  .swagger-ui .opblock-summary { align-items: flex-start; flex-wrap: wrap; }\n  .swagger-ui .opblock-summary-control { min-width: 0; }\n  .swagger-ui .opblock-summary-path { max-width: 100%; overflow-wrap: anywhere; }\n  .swagger-ui .opblock-body { padding: 0 8px; }\n  .swagger-ui table { display: block; max-width: 100%; overflow-x: auto; }\n  .swagger-ui .model-box { overflow-wrap: anywhere; }\n}";

function isPublicApiPath(url: string): boolean {
  const pathname = url.split("?", 1)[0];
  return pathname === "/v1/responses" || pathname === "/v1/models" || pathname === "/v1/chat/completions" || pathname === "/v1/capabilities";
}

export async function buildApp() {
const app = Fastify({
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.sessionToken",
    ],
    serializers: {
      // Signed realtime/AJAX URLs can carry short-lived credentials in their
      // query string. Keep request logging useful without persisting them.
      req(req) {
        return {
          method: req.method,
          url: typeof req.url === "string" ? req.url.split("?", 1)[0] : req.url,
          host: req.headers?.host,
          remoteAddress: req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  bodyLimit: 30 * 1024 * 1024,
});
await app.register(cors, {
  delegator: async (req: FastifyRequest) => ({
    // API clients authenticate with explicit bearer keys, not ambient cookies.
    // Preflight has no key; the actual request is authenticated below.
    origin: isAllowedRequestHost(req.headers.host) &&
      (isPublicApiPath(req.url) || isAllowedOrigin(req.headers.origin, req.headers.host))
      ? (req.headers.origin || false) : false,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["x-mirror-conversation-id", "x-request-id"],
  }),
});
await app.register(rateLimit, {
  global: true,
  max: 180,
  timeWindow: "1 minute",
});
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const apiKeys = configuredApiKeys();
const accountKey = () => getSession()?.accountId ?? "default";
app.addHook("onRequest", async (req, reply) => {
  reply.header("x-request-id", req.id);
  if (!isAllowedRequestHost(req.headers.host)) {
    return reply.code(421).send({ error: "请求主机名不受信任。" });
  }
  // Image tags and new-tab downloads cannot attach a Mirror bearer header.
  // This exact read-only route validates its own sealed, file-scoped ticket.
  if (["GET", "HEAD"].includes(req.method) && req.url.split("?", 1)[0] === "/api/asset-content") return;
  if (isPublicApiPath(req.url) && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    if (!tokenMatches(bearerToken(req.headers.authorization), configuredApiKeys())) {
      return reply.code(401).send({ error: {
        message: "跨域 API 请求需要配置有效的 Mirror API 密钥。",
        type: "authentication_error",
      } });
    }
    return;
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    return reply
      .code(403)
      .send({ error: "已拒绝跨域控制请求。" });
  }
  if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req.headers.host))
    return reply.code(403).send({error: "请求来源未获允许。"});
  if (mayBootstrapBrowser(req.method, req.url, req.headers)) {
    req.log.info({ url: req.url }, "setting control cookie for bootstrap");
    reply.header("Set-Cookie", controlCookie());
    return;
  }
  if (req.url === "/api/health" || req.url.startsWith("/mirror/assets/")) return;
  if (!authorizedLocalRequest(req.headers)) {
    return reply.code(401).send({ error: { message: "请在浏览器中打开 Mirror，或提供已配置的 Mirror API 密钥。", type: "authentication_error" } });
  }
});

app.addHook("onSend", async (req, reply, payload) => {
  if (req.url.startsWith("/v1/") && reply.statusCode >= 400) {
    // Format direct route replies and Fastify/plugin failures alike. Every
    // /v1/ response - a route's own .send(), the notFoundHandler, the rate
    // limiter, and setErrorHandler above - is JSON, and Fastify's default
    // serializer has already turned it into a string by the time onSend
    // hooks run; likewise, every /v1/ error object this app itself
    // produces is shaped one of two ways: a bare string, or an object
    // with a .message (see openai.ts, insights.ts, and setErrorHandler).
    const parsed = JSON.parse(payload as string);
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error.message;
    const envelope = apiError(reply.statusCode, message, req.id);
    recordFailure(envelope.error.code, req.id);
    return JSON.stringify(envelope);
  }
  return payload;
});

function localizedZodError(error: ZodError): string {
  const messages = error.issues.map((issue) => {
    if (/[㐀-鿿]/.test(issue.message)) return issue.message;
    const field = issue.path.length ? issue.path.join(".") : "请求";
    switch (issue.code) {
      case "invalid_type":
        return `字段 ${field} 的类型不正确。`;
      case "invalid_enum_value":
        return `字段 ${field} 的取值不在允许范围内。`;
      case "too_small":
        return `字段 ${field} 的值或长度过小。`;
      case "too_big":
        return `字段 ${field} 的值或长度过大。`;
      case "unrecognized_keys":
        return "请求包含不支持的字段。";
      default:
        return `字段 ${field} 的格式无效。`;
    }
  });
  return messages.join("；") || "请求参数无效，请检查请求字段和数据格式。";
}

app.setErrorHandler((error, _req, reply) => {
  const status =
    error instanceof ZodError
      ? 400
      : Number((error as { statusCode?: number }).statusCode ?? 500);
  const message =
    error instanceof ZodError
      ? localizedZodError(error)
      : status >= 500
        ? "服务器内部发生错误。"
        : error instanceof Error
          ? error.message
          : "请求失败。";
  if (status >= 500) app.log.error({ err: error }, "request failed");
  reply.code(status).send({ error: message });
});

app.get("/api/health", async () => ({
  ok:
    databaseHealthy() &&
    (!getEgressStatus().required || getEgressStatus().verified),
  storage: "sqlite",
  configured: Boolean(getSession()),
  egress: getEgressStatus(),
}));

app.post("/api/session", async (req) => {
  const body = SetSessionBody.parse(req.body);
  const revision = getSessionRevision();
  const candidate = await verifyCandidateSessionToken(body.sessionToken, body.turnstileToken);
  const client = new ChatGptBackendClient(candidate.credentials);
  const me = await client.fetchMe();
  assertSessionRevision(revision);
  saveVerifiedSession(
    candidate.persistedSessionToken,
    client.accountId ?? undefined,
    candidate.credentials.deviceId,
    body.turnstileToken ?? candidate.turnstileToken,
  );
  if (client.accountId) claimDefaultAccountData(client.accountId);
  updateMintedToken(
    candidate.credentials.accessToken,
    candidate.expiresAt,
    null,
  );
  return {
    ok: true,
    accountId: client.accountId,
    email: typeof me.email === "string" ? me.email : null,
  };
});

app.get("/api/session", async () => {
  const session = getSession();
  return {
    configured: Boolean(session),
    savedAt: session?.savedAt ?? null,
    hasTurnstileToken: Boolean(session?.turnstileToken),
  };
});
app.delete("/api/session", async () => {
  clearSession();
  return { ok: true };
});

app.get("/api/models", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  return normalizeModels(await client.fetchModels()).map(
    ({ raw: _raw, ...model }) => model,
  );
});
app.get("/api/gpts", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  const [projects, gpts] = await Promise.all([
    client
      .fetchGizmoSidebar({
        ownedOnly: false,
        limit: 50,
        conversationsPerGizmo: 0,
      })
      .catch(() => ({})),
    client.fetchGizmoBootstrap({ limit: 20 }).catch(() => ({})),
  ]);
  const seen = new Set<string>();
  return [...normalizeGizmos(gpts), ...normalizeGizmos(projects)]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map(({ raw: _raw, ...gizmo }) => gizmo);
});

// Paginated so a UI (the Playground's "Load a conversation" list) can lazy
// load a large history as the user scrolls, instead of eagerly fetching
// every page of it up front. The full remote-sidebar sync - which walks
// every page of the real ChatGPT sidebar via fetchConversations, an O(total
// conversation count) series of upstream calls - only makes sense to redo
// on the *first* page of a fresh listing (or an explicit refresh); repeating
// it on every subsequent scroll-triggered page would turn "scroll down" into
// "re-fetch your entire ChatGPT history" on every scroll tick, so callers
// paging past offset 0 pass sync=false and get served straight from the
// local mirror of it instead.
app.get("/api/conversations", async (req) => {
  const { limit, offset, sync, resync } = ConversationsQuery.parse(req.query);
  if (sync) {
    const revision = getSessionRevision();
    const accountId = accountKey();
    const client = new ChatGptBackendClient(await getValidCredentials());
    assertSessionRevision(revision);
    await syncConversationPage(accountId, offset + limit, resync, async (options) => {
      assertSessionRevision(revision);
      const page = await client.fetchConversations(options);
      assertSessionRevision(revision);
      return page;
    });
  }
  const items = listConversations(accountKey(), { limit, offset });
  const total = countConversations(accountKey());
  return { items, total, hasMore: offset + items.length < total || hasRemoteHistory(accountKey()) };
});
app.post("/api/conversations", async (req) =>
  createConversation({
    ...NewConversationBody.parse(req.body),
    accountId: accountKey(),
  }),
);
app.get("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  let conversation = getConversation(id);
  if (conversation?.accountId !== accountKey())
    return reply.code(404).send({ error: "未找到会话。" });
  if (conversation.conversationId && listMessages(id).length === 0) {
    const client = new ChatGptBackendClient(await getValidCredentials());
    conversation = importRemoteConversation(
      id,
      await client.fetchConversation(conversation.conversationId),
    );
  }
  return { conversation, messages: listMessages(id), instructions: getInstructions(id) };
});
app.patch("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "未找到会话。" });
  return setConversationModel(id, ModelUpdateBody.parse(req.body).model);
});
app.delete("/api/conversations/:id", async (req) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return { ok: false };
  stopConversation(id);
  deleteConversation(id);
  return { ok: true };
});
app.post("/api/conversations/:id/stop", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "未找到会话。" });
  return { ok: stopConversation(id) };
});
app.post("/api/conversations/:id/branch", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "未找到会话。" });
  const body = BranchBody.parse(req.body);
  const target = listMessages(id).find(
    (message) => message.id === body.messageId && message.upstreamNodeId,
  );
  if (!target?.upstreamNodeId)
    return reply
      .code(400)
      .send({ error: "该消息不能用作会话分支节点。" });
  return branchConversation(
    id,
    target.upstreamNodeId,
    body.title,
    body.messageId,
  );
});

app.post("/api/files", async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: "未上传文件。" });
  const data = await part.toBuffer();
  const client = new ChatGptBackendClient(await getValidCredentials());
  await client.fetchMe().catch(() => undefined);
  const file = await client.uploadFile({
    data,
    fileName: part.filename,
    mimeType: uploadMimeType(part.filename),
  });
  const publicFile = { ...file, raw: {} };
  saveFile(publicFile, accountKey());
  return publicFile;
});

app.get("/api/assets", async (req, reply) => {
  const query = AssetsQuery.parse(req.query);
  if (
    !query.pointer.startsWith("file-service://") &&
    !query.pointer.startsWith("sediment://")
  ) {
    return reply.code(400).send({ error: "不支持的资源指针。" });
  }
  if (
    query.pointer.startsWith("file-service://") &&
    !ownsFile(query.pointer.slice("file-service://".length), accountKey())
  ) {
    return reply.code(404).send({ error: "未找到文件。" });
  }
  if (
    query.pointer.startsWith("sediment://") &&
    (!query.upstreamConversationId ||
      !ownsUpstreamConversation(query.upstreamConversationId, accountKey()))
  ) {
    return reply.code(404).send({ error: "未找到会话资源。" });
  }
  const client = new ChatGptBackendClient(await getValidCredentials());
  const url = await client.resolveAssetDownload(
    query.pointer,
    query.upstreamConversationId,
  );
  return reply.redirect(url);
});

function publicEvent(
  event: NormalizedConversationEvent,
): Record<string, unknown> | null {
  if (
    event.displayHidden ||
    event.kind === "raw" ||
    event.kind === "assistant_text" ||
    event.kind === "message"
  )
    return null;
  const { raw: _raw, ...safe } = event as NormalizedConversationEvent & {
    raw?: unknown;
  };
  return safe;
}


app.post("/api/chat", async (req, reply) => {
  const body = ChatBody.parse(req.body);
  if (
    body.attachments.some(
      (attachment) => !ownsFile(attachment.fileId, accountKey()),
    )
  ) {
    return reply
      .code(404)
      .send({ error: "一个或多个附件不属于当前账号。" });
  }
  const controller = new AbortController();
  req.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.socket?.setNoDelay(true);
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const turnstileToken =
      body.turnstileToken ??
      (typeof req.headers["openai-sentinel-turnstile-token"] === "string"
        ? req.headers["openai-sentinel-turnstile-token"]
        : undefined) ??
      (typeof req.headers["x-turnstile-token"] === "string"
        ? req.headers["x-turnstile-token"]
        : undefined);
    const { conversation, result, storedAssistantMessageId } = await runChat({
      ...body,
      turnstileToken,
      signal: controller.signal,
      onDelta: (delta) => send("delta", { delta }),
      onEvent: (event) => {
        const safe = publicEvent(event);
        if (safe) send("event", safe);
      },
    });
    send("done", {
      text: result.text,
      conversationId: conversation.id,
      upstreamConversationId: result.conversationId,
      messageId: result.messageId,
      assistantMessageId: storedAssistantMessageId,
      model: conversation.model,
      init: conversation.init,
    });
  } catch (error) {
    send("error", {
      message:
        error instanceof Error && error.name === "AbortError"
          ? "生成已停止。"
          : String((error as Error)?.message ?? error),
    });
  } finally {
    reply.raw.end();
  }
});

await registerOpenAiRoutes(app);
await registerAssetContentRoute(app);
await registerInsightRoutes(app);
registerDecoderChallengeRoutes(app, () => JSON.stringify([accountKey(), getSessionRevision()]));
registerConversionRoutes(app);

// OpenAPI: generated from the same Zod schemas the routes validate against
// (see openapi-document.ts) rather than a hand-maintained JSON file. `mode:
// "static"` tells @fastify/swagger to serve this document as-is instead of
// trying to introspect Fastify route schemas (most routes here validate
// manually with Zod inside the handler body, not via Fastify's own `schema`
// option, so there'd be nothing for the automatic mode to find).
await app.register(fastifySwagger, {
  mode: "static",
  // zod-openapi's OpenAPIObject type models the OpenAPI spec slightly more
  // strictly than @fastify/swagger's own openapi-types import (e.g. server
  // variable `enum` as string[] only, vs string[] | number[] | boolean[]) -
  // both describe the same real document shape, so this is a type-only cast,
  // not a runtime one.
  specification: { document: buildOpenApiDocument() as any },
});
await app.register(fastifySwaggerUi, {
  routePrefix: "/mirror/api-docs",
  uiConfig: { docExpansion: "list", deepLinking: true },
  theme: {
    title: "Mirror API 接口文档",
    js: [{ filename: "zh-cn.js", content: swaggerUiZhCnScript }],
    css: [{ filename: "zh-cn.css", content: swaggerUiZhCnCss }],
  },
});
const OpenApiQuery = z.object({ format: z.enum(["json", "yaml"]).default("json") });
app.get("/mirror/openapi", async (req, reply) => {
  const { format } = OpenApiQuery.parse(req.query);
  const doc = app.swagger();
  if (format === "yaml") return reply.type("application/yaml").send(toYaml(doc));
  return reply.type("application/json").send(doc);
});

const staticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: "/mirror/",
  wildcard: false,
  decorateReply: true,
});
app.get("/mirror/playground", (_req, reply) => reply.sendFile("index.html"));
app.get("/mirror/inject.css", (_req, reply) =>
  reply.type("text/css").send(injectionCss),
);
app.get("/mirror/inject.js", (_req, reply) =>
  reply.type("application/javascript").send(injectionJs),
);
app.setNotFoundHandler(async (req, reply) => {
  // Every Mirror-owned /api route is registered above. Any remaining route may
  // belong to the official ChatGPT frontend and must be proxied upstream.
  if (req.url.startsWith("/v1/"))
    return reply.code(404).send({ error: "未找到请求的资源。" });
  return proxyChatGpt(req, reply);
});

return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await verifyRequiredEgress();
  await app.listen({ port, host });
  app.log.info(`mirror server listening on http://${host}:${port}`);
} catch (error) {
  // Startup failures (bad config, an incompatible database, unverifiable
  // WARP egress, a port already in use) are classified into one actionable
  // line instead of surfacing as a raw unhandled-rejection stack trace -
  // see preflight.ts for why these four categories specifically.
  console.error(formatStartupFailure(error));
  process.exit(1);
}
// The frontend also opens a raw WebSocket (realtime notifications) straight
// to the upstream host; Fastify itself has no built-in WebSocket support, so
// this proxies the HTTP upgrade through by hand, the same way every other
// request is proxied through proxyChatGpt().
app.server.on("upgrade", (req, socket, head) => {
  void proxyWebSocketUpgrade(req, socket, head).catch((error) => {
    app.log.error({ err: error }, "mirror websocket proxy failed");
    socket.destroy();
  });
});
monitorRequiredEgress((error) => {
  app.log.error(
    { err: error },
    "required WARP egress was lost; stopping Mirror to prevent direct fallback",
  );
  void app.close().finally(() => process.exit(1));
});

}
