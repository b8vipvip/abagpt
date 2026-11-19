import { ResponsesBody } from "./responses.js";
import { ChallengeBody, ChallengeParams, ChallengeAnswer, ChallengeKitBody } from "./decoder-challenges.js";
import "./zod-openapi-init.js";
import { createDocument, type oas31, type ZodOpenApiPathsObject } from "zod-openapi";
import { z } from "zod";
import { CompletionBody } from "./openai.js";
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

/**
 * This document is generated, not hand-maintained: every schema below - path
 * params, query strings, request bodies, AND response bodies - is a Zod
 * schema modeled directly on the TypeScript types the corresponding route
 * actually produces or validates against (StoredConversation/StoredMessage
 * in store.ts, UploadedFile/ModelDescriptor/GizmoSummary/
 * NormalizedConversationEvent in @mirror/protocol, EgressStatus in
 * egress.ts, and CompletionBody/the request schemas in api-schemas.ts for
 * everything that IS runtime-validated). Whenever one of those shapes
 * changes, this file's schema should change with it in the same commit -
 * there is no separate JSON spec to remember to update by hand. Request-side
 * schemas double as the actual runtime validators (imported straight from
 * api-schemas.ts / openai.ts); response-side schemas here are the response
 * shapes' one authoritative description, since the route handlers build
 * those objects as plain literals with no schema of their own to import.
 */

const ErrorResponse = z
  .object({
    error: z.union([
      z.string(),
      z.object({ message: z.string(), type: z.string() }),
    ]),
  })
  .openapi({ ref: "Error", description: "Mirror 错误处理器返回的错误对象。" });

const OkResponse = z
  .object({ ok: z.boolean() })
  .openapi({ ref: "OkResponse" });

// --- /v1 (OpenAI-compatible) response schemas -----------------------------

const ModelSchema = z
  .object({
    id: z.string().openapi({ example: "gpt-4o" }),
    object: z.literal("model"),
    created: z.number().int(),
    owned_by: z.string(),
  })
  .openapi({
    ref: "Model",
    description:
      "符合 OpenAI 格式的模型条目。Mirror 会同时列出 ChatGPT 实际模型标识（如 gpt-4o、o1 等）以及自定义 GPT／项目的伪模型标识（如 g-<hex>、g-p-<hex>）。详见 COMPATIBILITY.md。",
  });

const ModelsResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(ModelSchema),
  })
  .openapi({ ref: "ModelsResponse" });

const ChatMessageResponse = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.string().nullable(),
  })
  .openapi({ ref: "ChatMessageResponse" });

const CompletionResponseMetadata = z
  .object({
    mirror_tool_events: z.string().optional().openapi({
      description:
        "JSON 字符串化的数组，每次 ChatGPT 内置工具调用对应一个 {name, status} 对象（例如网页浏览、代码解释器沙盒等）。请使用 JSON.parse 解析。",
    }),
    mirror_images: z.string().optional().openapi({
      description:
        "JSON 字符串化的 {url} 对象数组，包含 ChatGPT 在本轮对话中生成的 DALL·E 图片（与 Mirror 未实现的官方 /v1/images/generations 接口不同，详见 COMPATIBILITY.md）。如果有可用预览字节，url 为自包含的图片 data URI；无法生成预览的项目会被省略。",
    }),
  })
  .openapi({
    ref: "CompletionResponseMetadata",
    description:
      "仅用于响应的约定：Mirror 将 ChatGPT 专有、没有官方标准字段可承载的信息放在此处，而不是新增官方 OpenAI 客户端库无法预期的顶层字段。仅在有内容需要报告时返回。详见 COMPATIBILITY.md。",
  });

const CompletionResponse = z
  .object({
    id: z.string(),
    object: z.literal("chat.completion"),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        message: ChatMessageResponse,
        finish_reason: z.literal("stop").openapi({
          description:
            "Mirror 在成功完成时返回 stop，不会根据 token 限制或 stop 字符串截断响应。",
        }),
      }),
    ),
    usage: z.null().openapi({
      description:
        "始终为 null。backend-api 不会提供 token 数量；ChatGPT 按套餐用量窗口计费，而不是按 token 计量，因此没有真实数据可填入此字段。详见 COMPATIBILITY.md。",
    }),
    metadata: CompletionResponseMetadata.optional(),
  })
  .openapi({ ref: "CompletionResponse" });

// --- Shared building blocks, modeled on @mirror/protocol's types.ts -------

/**
 * Mirrors @mirror/protocol's NormalizedConversationEvent discriminated
 * union exactly (packages/protocol/src/types.ts) - the shape the SSE
 * reducer (sse.ts) produces from ChatGPT's raw event stream, and what
 * gets persisted alongside each stored message and surfaced through
 * GET /api/conversations/{id}.
 */
// Each variant gets its own `ref` (rather than staying an anonymous inline
// object) so it's hoisted into components.schemas as a named type -
// generators for statically-typed clients (e.g. Rust's progenitor / OpenAPI
// Generator) turn each ref into a real named struct instead of an anonymous
// one, and it lets buildOpenApiDocument() attach a proper OAS discriminator
// (see below) mapping "kind" values to these exact component names.
const AssistantTextEvent = z
  .object({
    kind: z.literal("assistant_text"),
    messageId: z.string().nullable(),
    delta: z.string().openapi({ description: "仅包含此 SSE 事件新增的文本。" }),
    text: z.string().openapi({ description: "截至目前累积的完整助手文本，包含本次增量。" }),
  })
  .openapi({ ref: "AssistantTextEvent" });

const MessageEvent = z
  .object({
    kind: z.literal("message"),
    messageId: z.string().nullable(),
    role: z.string().nullable(),
    contentType: z.string().nullable(),
    authorName: z.string().nullable(),
    raw: z.record(z.unknown()).openapi({ description: "上游返回的原始消息对象。" }),
  })
  .openapi({ ref: "MessageEvent" });

const ToolEvent = z
  .object({
    kind: z.literal("tool"),
    messageId: z.string().nullable(),
    name: z.string().openapi({ description: "ChatGPT 内置工具名称，例如 web、python、dalle。" }),
    status: z.string().nullable().optional().openapi({ description: "当 backend-api 提供状态时，可能为 \"in_progress\"、\"completed\" 等。" }),
    raw: z.record(z.unknown()).openapi({ description: "上游返回的原始工具调用对象。" }),
  })
  .openapi({
    ref: "ToolEvent",
    description: "一次 ChatGPT 内置工具调用（网页浏览、代码解释器等），详见 COMPATIBILITY.md。",
  });

const CitationEvent = z
  .object({
    kind: z.literal("citation"),
    fileId: z.string().optional(),
    title: z.string().optional(),
    raw: z.unknown().openapi({ description: "上游返回的原始引用对象；具体结构因引用类型而异。" }),
  })
  .openapi({ ref: "CitationEvent" });

const ImageEvent = z
  .object({
    kind: z.literal("image"),
    assetPointer: z.string().openapi({ description: "通过 GET /api/assets?pointer=... 解析资源。" }),
    raw: z.unknown().openapi({ description: "上游返回的原始图片生成对象。" }),
  })
  .openapi({
    ref: "ImageEvent",
    description: "对话中由 DALL·E 生成的图片，详见 COMPATIBILITY.md。",
  });

const FileEvent = z
  .object({
    kind: z.literal("file"),
    assetPointer: z.string().openapi({ description: "通过 GET /api/assets?pointer=... 解析资源。" }),
    title: z.string().optional(),
    raw: z.unknown().openapi({ description: "上游返回的原始文件对象。" }),
  })
  .openapi({ ref: "FileEvent" });

const MarkerEvent = z
  .object({
    kind: z.literal("marker"),
    messageId: z.string().nullable(),
    marker: z.string().optional(),
    event: z.string().optional(),
    raw: z.record(z.unknown()).openapi({ description: "上游返回的原始标记／事件对象。" }),
  })
  .openapi({ ref: "MarkerEvent" });

const StatusEvent = z
  .object({
    kind: z.literal("status"),
    messageId: z.string().nullable(),
    status: z.string(),
  })
  .openapi({ ref: "StatusEvent" });

const RawEvent = z
  .object({
    kind: z.literal("raw"),
    raw: z.unknown().openapi({ description: "无法识别的上游 SSE 数据，保持原样透传，不进行解析。" }),
  })
  .openapi({ ref: "RawEvent" });

/**
 * Mirrors @mirror/protocol's NormalizedConversationEvent discriminated
 * union exactly (packages/protocol/src/types.ts) - the shape the SSE
 * reducer (sse.ts) produces from ChatGPT's raw event stream, and what
 * gets persisted alongside each stored message and surfaced through
 * GET /api/conversations/{id}. 'tool', 'image', and 'file' events are the
 * ones with no official OpenAI Chat Completions equivalent - see
 * COMPATIBILITY.md. buildOpenApiDocument() attaches this union's OAS
 * `discriminator` after zod-openapi builds the document (see below), so
 * generators for statically-typed clients can emit a real tagged enum
 * instead of a plain oneOf.
 */
const NormalizedConversationEvent = z
  .discriminatedUnion("kind", [
    AssistantTextEvent,
    MessageEvent,
    ToolEvent,
    CitationEvent,
    ImageEvent,
    FileEvent,
    MarkerEvent,
    StatusEvent,
    RawEvent,
  ])
  .openapi({ ref: "NormalizedConversationEvent" });

/** Mirrors UploadedFile from @mirror/protocol, minus the `raw` field Mirror strips before returning it publicly. */
const PublicUploadedFile = z
  .object({
    fileId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    useCase: z.enum(["multimodal", "my_files"]).openapi({
      description: "multimodal 表示发送给视觉模型的图片；my_files 表示其他文件（例如代码解释器、检索等用途）。",
    }),
    width: z.number().optional().openapi({ description: "图片上传时提供。" }),
    height: z.number().optional().openapi({ description: "图片上传时提供。" }),
  })
  .openapi({
    ref: "UploadedFile",
    description: "通过 POST /api/files 上传到 ChatGPT 文件服务的文件；返回前已剔除上游原始响应。",
  });

/** Mirrors StoredMessage from store.ts. */
const StoredMessage = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string(),
    upstreamNodeId: z.string().nullable().openapi({ description: "backend-api 消息节点 ID；如果本轮未发送到上游则为 null。" }),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    status: z.string().openapi({ description: "例如 \"finished_successfully\"、\"in_progress\"；该值由 backend-api 原样提供。" }),
    events: z.array(NormalizedConversationEvent),
    attachments: z.array(PublicUploadedFile).optional(),
    createdAt: z.string().datetime().openapi({ description: "ISO 8601 时间戳。" }),
  })
  .openapi({ ref: "StoredMessage", description: "Mirror 会话中存储的一条消息（store.ts）。" });

/**
 * Mirrors StoredConversation from store.ts (which extends
 * ConversationSessionState from @mirror/protocol's types.ts).
 */
const StoredConversation = z
  .object({
    id: z.string().openapi({ description: "Mirror 本地会话 ID（自动生成时为 UUID，也可通过 metadata.conversation_id 传入自定义标识）。" }),
    accountId: z.string(),
    title: z.string(),
    init: z.record(z.unknown()).nullable().openapi({ description: "会话初始化后保存的 backend-api f/conversation/init 原始响应。" }),
    createdAt: z.string().datetime().openapi({ description: "ISO 8601 时间戳。" }),
    updatedAt: z.string().datetime().openapi({ description: "ISO 8601 时间戳。" }),
    isBranch: z.boolean().openapi({ description: "如果此会话通过 POST /api/conversations/{id}/branch 创建，则为 true。" }),
    conversationId: z.string().nullable().openapi({ description: "上游 backend-api 的真实会话 ID；首次发送消息前为 null。" }),
    currentNodeId: z.string().openapi({ description: "下一轮请求中将用作 parent_message_id 的助手节点。" }),
    model: z.string(),
    gizmoId: z.string().nullable().optional().openapi({ description: "当会话固定到自定义 GPT 或项目时提供。" }),
    initialized: z.boolean().optional(),
    private: z.boolean().optional().openapi({ description: "临时／隐身对话：不会写入 chatgpt.com 历史记录，也不会用于模型训练。" }),
  })
  .openapi({ ref: "StoredConversation", description: "Mirror 本地会话记录（store.ts）。" });

/** Mirrors ModelDescriptor from @mirror/protocol, minus the `raw` field GET /api/models strips before returning it. */
const PublicModelDescriptor = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    maxTokens: z.number().optional(),
    capabilities: z.unknown().optional(),
    enabledTools: z.unknown().optional(),
  })
  .openapi({
    ref: "PublicModelDescriptor",
    description: "Mirror 原生模型数据结构（@mirror/protocol 中的 normalizeModels()），已剔除上游原始数据。",
  });

/** Mirrors GizmoSummary from @mirror/protocol, minus the `raw` field GET /api/gpts strips before returning it. */
const PublicGizmoSummary = z
  .object({
    id: z.string().openapi({ description: "自定义 GPT 使用 g-<hex>，项目使用 g-p-<hex>。" }),
    shortUrl: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    iconUrl: z.string().optional(),
    filesCount: z.number().optional(),
  })
  .openapi({
    ref: "PublicGizmoSummary",
    description: "Mirror 原生自定义 GPT／项目数据结构（@mirror/protocol 中的 normalizeGizmos()），已剔除上游原始数据。",
  });

/** Mirrors EgressStatus from egress.ts. */
const EgressStatus = z
  .object({
    mode: z.enum(["direct", "warp"]),
    required: z.boolean().openapi({ description: "此部署是否配置为必须先验证 WARP 出口后才对外提供服务。" }),
    verified: z.boolean(),
    checkedAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
  })
  .openapi({ ref: "EgressStatus", description: "Mirror 最近一次 Cloudflare WARP 出口验证的结果（egress.ts）。" });

/** The shape stored/returned by store.ts's getInstructions(). */
const InstructionMessage = z
  .object({ role: z.string(), content: z.string() })
  .openapi({ ref: "InstructionMessage" });

const nativeApiPaths: ZodOpenApiPathsObject = {
  "/api/health": {
    get: {
      summary: "健康检查",
      tags: ["Mirror 控制接口"],
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean().openapi({ description: "仅当存储正常且已验证所需的 WARP 出口（如果启用）时为 true。" }),
                storage: z.literal("sqlite"),
                configured: z.boolean().openapi({ description: "是否已连接 ChatGPT 会话。" }),
                egress: EgressStatus,
              }),
            },
          },
        },
      },
    },
  },
  "/api/session": {
    get: {
      summary: "检查是否已配置 ChatGPT 会话",
      tags: ["Mirror 控制接口"],
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({
                configured: z.boolean(),
                savedAt: z.string().datetime().nullable().openapi({ description: "会话最近一次保存的 ISO 时间戳；未配置时为 null。" }),
                hasTurnstileToken: z.boolean().openapi({ description: "是否暂存了一个待使用的一次性验证令牌。" }),
              }),
            },
          },
        },
      },
    },
    post: {
      summary: "将 Mirror 连接到 ChatGPT 账号",
      tags: ["Mirror 控制接口"],
      requestBody: { content: { "application/json": { schema: SetSessionBody } } },
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                accountId: z.string().optional().openapi({ description: "上游账号查询成功时返回的 ChatGPT 账号 ID。" }),
                email: z.string().nullable().openapi({ description: "ChatGPT 的 /me 接口返回的账号邮箱；未返回时为 null。" }),
              }),
            },
          },
        },
        "400": {
          description: "会话令牌无效",
          content: { "application/json": { schema: ErrorResponse } },
        },
      },
    },
    delete: {
      summary: "断开当前配置的 ChatGPT 会话",
      tags: ["Mirror 控制接口"],
      responses: { "200": { description: "成功", content: { "application/json": { schema: OkResponse } } } },
    },
  },
  "/api/models": {
    get: {
      summary: "列出模型（Mirror 原生数据结构，字段比 /v1/models 更丰富，但不包含上游原始数据）",
      tags: ["Mirror 控制接口"],
      responses: {
        "200": {
          description: "成功",
          content: { "application/json": { schema: z.array(PublicModelDescriptor) } },
        },
      },
    },
  },
  "/api/gpts": {
    get: {
      summary: "列出当前账号可访问的自定义 GPT 和项目",
      tags: ["Mirror 控制接口"],
      responses: {
        "200": {
          description: "成功",
          content: { "application/json": { schema: z.array(PublicGizmoSummary) } },
        },
      },
    },
  },
  "/api/conversations": {
    get: {
      summary: "分页列出本地已知会话",
      tags: ["Mirror 控制接口"],
      requestParams: { query: ConversationsQuery },
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(StoredConversation),
                total: z.number().int().openapi({ description: "当前账号的会话总数，不受 limit／offset 影响。" }),
                hasMore: z.boolean(),
              }),
            },
          },
        },
      },
    },
    post: {
      summary: "创建一个空白会话",
      tags: ["Mirror 控制接口"],
      requestBody: { content: { "application/json": { schema: NewConversationBody } } },
      responses: {
        "200": { description: "成功", content: { "application/json": { schema: StoredConversation } } },
      },
    },
  },
  "/api/conversations/{id}": {
    get: {
      summary: "获取会话及其消息",
      tags: ["Mirror 控制接口"],
      requestParams: { path: ConversationIdParam },
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({
                conversation: StoredConversation,
                messages: z.array(StoredMessage),
                instructions: z.array(InstructionMessage).openapi({
                  description: "为此会话合并生成的 system／developer 指令，详见 openai.ts 中的 promptFor()。",
                }),
              }),
            },
          },
        },
        "404": { description: "未找到", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
    patch: {
      summary: "更改会话使用的模型",
      tags: ["Mirror 控制接口"],
      requestParams: { path: ConversationIdParam },
      requestBody: { content: { "application/json": { schema: ModelUpdateBody } } },
      responses: {
        "200": { description: "成功", content: { "application/json": { schema: StoredConversation.nullable() } } },
        "404": { description: "未找到", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
    delete: {
      summary: "删除会话",
      tags: ["Mirror 控制接口"],
      requestParams: { path: ConversationIdParam },
      responses: { "200": { description: "成功", content: { "application/json": { schema: OkResponse } } } },
    },
  },
  "/api/conversations/{id}/stop": {
    post: {
      summary: "停止正在进行的生成",
      tags: ["Mirror 控制接口"],
      requestParams: { path: ConversationIdParam },
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean().openapi({ description: "如果此会话当时没有正在进行的生成，则为 false。" }) }),
            },
          },
        },
        "404": { description: "未找到", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/conversations/{id}/branch": {
    post: {
      summary: "从现有消息创建新分支",
      tags: ["Mirror 控制接口"],
      requestParams: { path: ConversationIdParam },
      requestBody: { content: { "application/json": { schema: BranchBody } } },
      responses: {
        "200": {
          description: "成功",
          content: { "application/json": { schema: StoredConversation.nullable() } },
        },
        "400": {
          description: "分支起点无效",
          content: { "application/json": { schema: ErrorResponse } },
        },
        "404": { description: "未找到", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/decoder-challenges": {
    post: {
      summary: "为代理的官方界面生成解码挑战",
      description: "创建临时的会话级答案密钥，有效期为 24 小时，或直到服务重启／会话变更。提示词包含 base64(gzip(artifact)) 和可选格式指南，但绝不包含答案密钥。每分钟最多生成 20 次，同时最多保留 64 个有效挑战。",
      tags: ["Mirror 控制接口"],
      requestBody: { content: { "application/json": { schema: ChallengeBody } } },
      responses: {
        "200": { description: "挑战提示词和可下载产物的元数据", content: { "application/json": { schema: z.object({
          id: z.string().uuid(), format: ChallengeBody.shape.format, label: z.string(), guidance: ChallengeBody.shape.guidance,
          payload: ChallengeBody.shape.payload, filename: z.string(), artifactBytes: z.number().int(), prompt: z.string(), expiresAt: z.number(),
        }) } } },
        "400": { description: "选项无效" }, "429": { description: "已达到生成频率限制或挑战容量上限" },
      },
    },
  },
  "/api/decoder-challenges/kit": {
    post: {
      summary: "将 1 至 4 个挑战包下载为 tar.gz 压缩文件",
      description: "每个挑战包包含编码产物、对应提示词、可选格式指南和操作说明，不包含答案密钥。",
      tags: ["Mirror 控制接口"], requestBody: { content: { "application/json": { schema: ChallengeKitBody } } },
      responses: { "200": { description: "Gzip 压缩的 tar 归档文件", content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } }, "400": { description: "挑战 ID 无效" }, "404": { description: "其中一个挑战已过期或不可用" } },
    },
  },
  "/api/decoder-challenges/{id}/artifact": {
    get: {
      summary: "下载原始编码挑战产物",
      tags: ["Mirror 控制接口"], requestParams: { path: ChallengeParams },
      responses: { "200": { description: "LoaF 文本、PNG 或 GIF 附件", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } }, "404": { description: "挑战已过期或不可用" } },
    },
  },
  "/api/decoder-challenges/{id}/verify": {
    post: {
      summary: "将恢复出的数据字节与挑战答案密钥进行比较",
      tags: ["Mirror 控制接口"], requestParams: { path: ChallengeParams },
      requestBody: { content: { "application/json": { schema: ChallengeAnswer } } },
      responses: {
        "200": { description: "返回完全匹配或按位置比较的结果；不会返回答案字节。", content: { "application/json": { schema: z.object({ verdict: z.enum(["exact", "partial", "mismatch"]), matchingBytes: z.number().int(), expectedBytes: z.number().int(), actualBytes: z.number().int() }) } } },
        "400": { description: "十六进制答案无效" }, "404": { description: "挑战已过期或不可用" },
      },
    },
  },
  "/api/files": {
    post: {
      summary: "上传文件附件（multipart/form-data）",
      tags: ["Mirror 控制接口"],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: z
              .object({
                file: z.string().openapi({
                  type: "string",
                  format: "binary",
                  description: "单个文件字段，由 @fastify/multipart 处理。每个请求只能上传一个文件。",
                }),
              })
              .openapi({ description: "单文件 multipart/form-data 上传。" }),
          },
        },
      },
      responses: {
        "200": { description: "成功", content: { "application/json": { schema: PublicUploadedFile } } },
        "400": { description: "未上传文件", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/asset-content": {
    get: {
      summary: "使用受保护的文件专属链接读取生成文件",
      description: "无需浏览器 Cookie 或 API 密钥。受保护的票据在原始已保存会话保持连接期间，授予对单个输出资源为期 7 天的读取权限。接口会重新解析上游元数据并流式传输文件字节。download=1 时通过 Content-Disposition: attachment 返回真实文件名；否则支持的图片会以内嵌方式显示。无效票据返回 404。调用方不能提交任意 URL 或资源指针。",
      security: [],
      tags: ["Mirror 控制接口"],
      requestParams: { query: z.object({ ticket: z.string(), download: z.literal("1").optional() }) },
      responses: {
        "200": { description: "文件字节，保留原始内容类型，并在 Content-Disposition 中提供文件名。", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        "404": { description: "文件链接已过期、无效，或所属会话已断开。" },
        "502": { description: "无法从上游获取文件。" },
      },
    },
  },
  "/api/assets": {
    get: {
      summary: "将 file-service:// 或 sediment:// 资源指针解析为可下载 URL",
      tags: ["Mirror 控制接口"],
      requestParams: { query: AssetsQuery },
      responses: {
        "302": { description: "重定向到已解析的限时资源 URL。" },
        "400": {
          description: "不支持的资源指针",
          content: { "application/json": { schema: ErrorResponse } },
        },
        "404": {
          description: "未找到，或该资源不属于当前账号。",
          content: { "application/json": { schema: ErrorResponse } },
        },
      },
    },
  },
  "/api/chat": {
    post: {
      summary:
        "Mirror 原生流式聊天接口（text/event-stream），供代理的 ChatGPT 界面和测试台使用",
      description:
        "返回带名称的 SSE 事件流：每个文本块对应 `delta`（{delta: string}）；`event` 对应 NormalizedConversationEvent（仅包含 tool／citation／image／file／marker／status，assistant_text／message／raw 会被过滤，详见 index.ts 中的 publicEvent()）；本轮完成后发送 `done`（最终结果）；生成失败或被停止时发送 `error`（{message}）。",
      tags: ["Mirror 控制接口"],
      requestBody: { content: { "application/json": { schema: ChatBody } } },
      responses: {
        "200": {
          description: "包含 delta／event／done／error 事件的 text/event-stream，详见接口说明。",
          content: { "text/event-stream": { schema: z.string() } },
        },
      },
    },
  },
  "/mirror/openapi": {
    get: {
      summary: "此 OpenAPI 文档",
      tags: ["Mirror 控制接口"],
      requestParams: {
        query: z.object({
          format: z.enum(["json", "yaml"]).default("json").openapi({
            description: "使用 ?format=yaml 可返回 YAML；默认返回 JSON。",
          }),
        }),
      },
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": { schema: z.object({}).passthrough().openapi({ description: "同一份 OpenAPI 3.1 文档，以 JSON 格式返回。" }) },
            "application/yaml": { schema: z.string().openapi({ description: "同一份 OpenAPI 3.1 文档，以 YAML 格式返回。" }) },
          },
        },
      },
    },
  },
};

/**
 * zod-openapi doesn't emit an OAS `discriminator` object for a
 * z.discriminatedUnion() - it only emits `oneOf` with a `const` tag per
 * branch (valid OAS 3.1 / JSON Schema on its own). That's enough for
 * loosely-typed consumers, but a generator producing a real tagged enum
 * for a statically-typed client (e.g. Rust's progenitor or OpenAPI
 * Generator) does a much better job when `discriminator.propertyName` and
 * `discriminator.mapping` are present, so it can pick the right variant by
 * tag instead of trying every branch. This patches that one discriminator
 * in after the fact, mapping each `kind` value to the named component ref
 * that variant was given above (AssistantTextEvent, ToolEvent, ...).
 */
function withDiscriminators(doc: oas31.OpenAPIObject): oas31.OpenAPIObject {
  const target = doc.components?.schemas?.NormalizedConversationEvent as
    | (oas31.SchemaObject & { oneOf?: oas31.ReferenceObject[] })
    | undefined;
  if (!target?.oneOf) return doc;
  const kindToRef: Record<string, string> = {
    assistant_text: "AssistantTextEvent",
    message: "MessageEvent",
    tool: "ToolEvent",
    citation: "CitationEvent",
    image: "ImageEvent",
    file: "FileEvent",
    marker: "MarkerEvent",
    status: "StatusEvent",
    raw: "RawEvent",
  };
  target.oneOf = Object.values(kindToRef).map((ref) => ({ $ref: `#/components/schemas/${ref}` }));
  target.discriminator = {
    propertyName: "kind",
    mapping: Object.fromEntries(
      Object.entries(kindToRef).map(([kind, ref]) => [kind, `#/components/schemas/${ref}`]),
    ),
  };
  return doc;
}

export function buildOpenApiDocument(): oas31.OpenAPIObject {
  return withDiscriminators(createDocument({
    openapi: "3.1.0",
    info: {
      title: "Mirror API",
      version: "0.1.0",
      description:
        "Mirror 基于同一个 ChatGPT 账号提供两组 API：/v1 下的 OpenAI 兼容接口（可供 OpenAI SDK 或其他工具调用），以及 Mirror 自己的 /api 接口（供代理的 ChatGPT 界面和测试台使用）。部署方法见 README.md；/v1 接口与官方 OpenAI API 的具体差异见 COMPATIBILITY.md。本文档（包括请求结构）由服务器实际用于验证请求的 Zod 结构以及路由返回的 TypeScript 类型自动生成，详见 openapi-document.ts。",
    },
    servers: [{ url: "/", description: "当前 Mirror 实例" }],
    security: [{ mirrorApiKey: [] }],
    components: {
      securitySchemes: {
        mirrorApiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "取自 MIRROR_API_KEY 或 MIRROR_API_KEYS 的值。/v1/* 和 /api/* 请求必须提供此密钥；已在浏览器标签页中完成 Mirror 控制面 sessionToken 初始化的请求除外，这类请求改用 HttpOnly mirror_control Cookie 进行身份验证。",
        },
      },
    },
    paths: {
      "/v1/models": {
        get: {
          summary: "列出可用模型",
          description:
            "列出当前账号可用于对话的 ChatGPT 实际模型标识，以及自定义 GPT／项目伪模型标识。",
          tags: ["OpenAI 兼容接口"],
          responses: {
            "200": { description: "成功", content: { "application/json": { schema: ModelsResponse } } },
            "401": {
              description: "缺少或无效的 Mirror API 密钥",
              content: { "application/json": { schema: ErrorResponse } },
            },
          },
        },
      },
      "/v1/responses": {
        post: {
          summary: "创建文本响应",
          description: "仅支持文本的 Responses API 子集，使用 Mirror 会话语义。可通过 metadata.conversation_id 或完整 input 历史继续会话。不支持 previous_response_id、检索、工具或后台模式。接受 max_output_tokens 参数但会忽略；store=false 表示不可恢复的单次请求。",
          tags: ["OpenAI 兼容接口"],
          requestBody: { content: { "application/json": { schema: ResponsesBody } } },
          responses: {
            "200": { description: "返回包含助手 output_text 内容的响应对象，或以 response.completed 结束的命名 Responses SSE 事件（失败时为 response.failed）。usage 为 null。",
              content: { "application/json": { schema: z.object({ id: z.string(), object: z.literal("response"), status: z.literal("completed"), output: z.array(z.object({ type: z.literal("message"), role: z.literal("assistant"), content: z.array(z.object({ type: z.literal("output_text"), text: z.string() }).passthrough()) }).passthrough()), metadata: z.record(z.string()), usage: z.null() }).passthrough() }, "text/event-stream": { schema: z.string() } } },
            "400": { description: "输入无效或不受支持", content: { "application/json": { schema: ErrorResponse } } },
            "401": { description: "缺少或无效的 Mirror API 密钥", content: { "application/json": { schema: ErrorResponse } } },
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "创建聊天补全",
          description:
            "基于 chatgpt.com/backend-api 实现的 OpenAI Chat Completions 兼容接口。与官方 API 的完整兼容性差异请参阅 COMPATIBILITY.md。",
          tags: ["OpenAI 兼容接口"],
          requestBody: {
            content: { "application/json": { schema: CompletionBody } },
          },
          responses: {
            "200": {
              description:
                "成功。stream=true 时返回由 OpenAI 兼容 chat.completion.chunk SSE 事件组成的 text/event-stream，而不是单个 JSON 响应体。",
              content: {
                "application/json": { schema: CompletionResponse },
                "text/event-stream": { schema: z.string() },
              },
            },
            "400": {
              description: "请求字段无效或不受支持",
              content: { "application/json": { schema: ErrorResponse } },
            },
            "401": {
              description: "缺少或无效的 Mirror API 密钥",
              content: { "application/json": { schema: ErrorResponse } },
            },
          },
        },
      },
      ...nativeApiPaths,
    },
  }));
}
