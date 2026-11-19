import "./zod-openapi-init.js";
import { z } from "zod";

/**
 * Request-shape schemas for Mirror's native /api/* routes, shared between
 * index.ts (which validates against them at runtime) and
 * openapi-document.ts (which derives the generated OpenAPI document from
 * these same schemas). Splitting them out into their own module - rather
 * than defining them inline in index.ts, or letting openapi-document.ts
 * import them straight from index.ts - avoids a circular import between
 * index.ts and openapi-document.ts (index.ts already imports
 * buildOpenApiDocument from there to serve /mirror/openapi).
 */

export const SetSessionBody = z
  .object({
    sessionToken: z
      .string()
      .min(20, "That doesn't look like a valid session token")
      .openapi({
        description:
          "从 chatgpt.com/api/auth/session 获取的 __Secure-next-auth.session-token Cookie 值。",
      }),
    turnstileToken: z
      .string()
      .optional()
      .openapi({
        description:
          "当 Sentinel 要求验证时，可选提供的 Cloudflare Turnstile 令牌。",
      }),
  })
  .openapi({ ref: "SetSessionBody" });

// Mirror conversation ids are UUIDs when auto-generated, but a caller can
// also name their own via /v1/chat/completions' metadata.conversation_id
// (e.g. an arbitrary slug) - accept any non-empty id here so a
// Playground/API-driven conversation created that way can still be
// browsed, loaded, and managed through these routes.
export const ConversationIdParam = z
  .object({
    id: z.string().min(1).openapi({ description: "Mirror 会话 ID（UUID 或调用方自定义的标识字符串）。" }),
  })
  .openapi({ ref: "ConversationIdParam" });

export const ModelUpdateBody = z
  .object({ model: z.string().min(1) })
  .openapi({ ref: "ModelUpdateBody", description: "更改会话使用的模型。" });

export const BranchBody = z
  .object({
    messageId: z.string().uuid().openapi({ description: "要从中创建分支的消息 ID；该消息必须具有 upstreamNodeId。" }),
    title: z.string().optional(),
  })
  .openapi({ ref: "BranchBody" });

export const NewConversationBody = z
  .object({
    model: z.string().default("auto"),
    gizmoId: z.string().nullable().optional(),
  })
  .openapi({ ref: "NewConversationBody" });

const queryBoolean = z.enum(["true", "false"]).transform((value) => value === "true");
export const ConversationsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    sync: queryBoolean.default("true").openapi({
      description: "读取本地会话镜像前，是否先与 ChatGPT 侧边栏同步当前分页。",
      type: "string",
    }),
    // Restart the incremental sync cursor from the very top instead of
    // resuming where a previous call left off - only worth paying for on an
    // explicit user-initiated refresh (see App.tsx), not on every page load.
    resync: queryBoolean.default("false").openapi({
      description: "是否从头重启增量同步游标，而不是从上次保存的位置继续。",
      type: "string",
    }),
  })
  .openapi({ ref: "ConversationsQuery" });

export const AssetsQuery = z
  .object({
    pointer: z.string().openapi({ description: "file-service:// 或 sediment:// 资源指针。" }),
    upstreamConversationId: z.string().optional().openapi({
      description: "当 pointer 为 sediment:// 指针时必须提供，用于验证源会话的所有权。",
    }),
  })
  .openapi({ ref: "AssetsQuery" });


export const ChatAttachment = z
  .object({
    fileId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    useCase: z.enum(["multimodal", "my_files"]),
    width: z.number().optional(),
    height: z.number().optional(),
    raw: z.record(z.unknown()).default({}),
  })
  .openapi({ ref: "ChatAttachment", description: "通过 POST /api/files 上传的文件。" });

export const ChatBody = z
  .object({
    prompt: z.string().min(1),
    model: z.string().default("auto"),
    conversationId: z.string().uuid().nullable().optional(),
    gizmoId: z.string().nullable().optional(),
    timezone: z.string().optional(),
    timezoneOffsetMin: z.number().optional(),
    attachments: z.array(ChatAttachment).default([]),
    turnstileToken: z.string().optional().openapi({
      description: "当 Sentinel 要求验证时，可选覆盖的 Cloudflare Turnstile 令牌。",
    }),
  })
  .openapi({
    ref: "ChatBody",
    description: "Mirror 原生聊天请求，由代理的 ChatGPT 界面和测试台使用（参见 POST /api/chat）。",
  });

