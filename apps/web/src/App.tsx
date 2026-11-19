import { readResponsesStream, responseText } from "./responses-stream.js";
import { ConnectionTools } from "./ConnectionTools.js";
import { ConversationTools } from "./ConversationTools.js";
import { ConversionTools } from "./ConversionTools.js";
import { InlineMediaPreview } from "./InlineMediaPreview.js";
import { CommandPalette } from "./CommandPalette.js";
import { HotkeySettings } from "./HotkeySettings.js";
import { DEFAULT_HOTKEYS, matchesHotkey } from "./hotkeys.js";
import { readCompletionStream } from "./completion-stream.js";
import { localizeUiError } from "./ui-errors.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  editPlaygroundMessage,
  removePlaygroundMessage,
  addPlaygroundAttachment,
  removePlaygroundAttachment,
  type PlaygroundMessage,
  type PlaygroundAttachment,
} from "./playground-history.js";

/** Turns a PlaygroundMessage's text + attachments into the wire shape the OpenAI-compatible
 * endpoints expect: a plain string when there are no attachments (unchanged, back-compat), or
 * a content-part array when there are. Preserve filenames for images too;
 * the server selects their MIME type and upload route from the extension. */
function messageForRequest(message: PlaygroundMessage): { role: string; content: unknown } {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return { role: message.role, content: message.content };
  const parts: unknown[] = [];
  if (message.content.trim()) parts.push({ type: "text", text: message.content });
  for (const attachment of attachments) {
    parts.push({ type: "file", file: { file_data: attachment.dataUrl, filename: attachment.name } });
  }
  return { role: message.role, content: parts };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取文件"));
    reader.readAsDataURL(file);
  });
}

interface ApiModel {
  id: string;
  owned_by?: string;
  mirror?: {supported: boolean};
  name?: string;
}
interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  gizmoId?: string | null;
  updatedAt: string;
}
interface StoredMessageDto {
  role: "user" | "assistant";
  content: string;
}

const FALLBACK_SYSTEM_INSTRUCTIONS = "You are a helpful assistant.";
const DEFAULT_MESSAGES: PlaygroundMessage[] = [
  { role: "system", content: FALLBACK_SYSTEM_INSTRUCTIONS },
  { role: "user", content: "请用一句简短的话打个招呼。" },
];
const STORAGE_KEY_CONVERSATION_ID = "mirror-playground-conversation-id";
const STORAGE_KEY_MESSAGES = "mirror-playground-messages";
const STORAGE_KEY_REMEMBER = "mirror-playground-remember-history";
const CONVERSATIONS_PAGE_SIZE = 50;

function loadSnapshot(): { model: string; pickedModel: string; privateChat: boolean } | null {
  try { return localStorage.getItem(STORAGE_KEY_REMEMBER) === "true" ? JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null") : null; } catch { return null; }
}
function loadStoredConversationId(): string {
  try {
    if (localStorage.getItem(STORAGE_KEY_REMEMBER) !== "true") return "";
    const snapshot = JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null");
    return snapshot?.conversationId ?? "";
  } catch {
    return "";
  }
}
function loadStoredMessages(): PlaygroundMessage[] {
  try {
    if (localStorage.getItem(STORAGE_KEY_REMEMBER) !== "true")
      return DEFAULT_MESSAGES;
    const parsed = JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null")?.messages;
    if (
      Array.isArray(parsed) &&
      parsed.length &&
      parsed.every(
        (item) =>
          item &&
          ["system", "developer", "user", "assistant"].includes(item.role) &&
          typeof item.content === "string",
      )
    )
      return parsed;
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_MESSAGES;
}

export function localizedStatus(status: string): string {
  const labels: Record<string, string> = {
    "Ready": "就绪",
    "Loading…": "加载中…",
    "Loaded": "已加载",
    "Reading files…": "正在读取文件…",
    "Blocked": "已阻止",
    "Running…": "运行中…",
    "Completed": "已完成",
    "Stopped": "已停止",
    "Error": "出错",
  };
  return labels[status] ?? status;
}

export function localizedRole(role: string): string {
  const labels: Record<string, string> = {
    system: "系统",
    developer: "开发者",
    user: "用户",
    assistant: "助手",
  };
  return labels[role] ?? role;
}

function Header() {
  return (
    <header className="platform-header">
      <a className="platform-brand" href="/">
        <span className="openai-mark">◎</span>
        <b>Mirror API</b>
      </a>
      <nav>
        <a href="/">ChatGPT 聊天</a>
        <a className="active" href="/mirror/playground">
          API 测试台
        </a>
        <a href="/v1/models" target="_blank" rel="noreferrer">
          模型
        </a>
        <a href="/mirror/api-docs" target="_blank" rel="noreferrer">
          API 文档
        </a>
        <a href="/mirror/openapi" target="_blank" rel="noreferrer">
          OpenAPI 规范
        </a>
      </nav>
      <div className="environment">本地服务器</div>
    </header>
  );
}

export default function App() {
  const [domain, setDomain] = useState(() => location.origin);
  const [mode, setMode] = useState<"chat" | "responses">("chat");
  const [path, setPath] = useState("/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ApiModel[]>([]);
  const [model, setModel] = useState(() => loadSnapshot()?.model ?? "auto");
  const [modelFreeform, setModelFreeform] = useState(false);
  const [pickedModel, setPickedModel] = useState(() => loadSnapshot()?.pickedModel ?? "");
  const [privateChat, setPrivateChat] = useState(() => loadSnapshot()?.privateChat ?? false);
  const [oneShot, setOneShot] = useState(false);
  // Persisted to localStorage (see effects below) so a page refresh doesn't
  // strand you: the conversation id is exactly what lets you resume an
  // existing upstream conversation, so losing it on refresh defeated the
  // point - every "continue an existing conversation" attempt after a
  // reload silently started a brand-new one instead.
  const [conversationId, setConversationId] = useState<string>(
    loadStoredConversationId,
  );
  const [stream, setStream] = useState(true);
  const [rememberHistory, setRememberHistory] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_REMEMBER) === "true";
    } catch {
      return false;
    }
  });
  const [messages, setMessages] =
    useState<PlaygroundMessage[]>(loadStoredMessages);
  // Account-wide sticky System box default (server-side, not localStorage -
  // see store.ts's getDefaultSystemInstructions): follows the account across
  // browsers/devices instead of one browser's "remember prompt history"
  // toggle. Loaded once; if this browser's initial system message is still
  // the untouched fallback (i.e. not something restored from a local
  // snapshot), it's replaced by the saved account default.
  const defaultSystemInstructionsLoaded = useRef(false);
  useEffect(() => {
    fetch("/api/settings/default-system-instructions")
      .then(async (res) => (res.ok ? res.json() : { content: "" }))
      .then(({ content }: { content?: string }) => {
        if (content) {
          setMessages((current) =>
            current[0]?.role === "system" &&
            current[0].content === FALLBACK_SYSTEM_INSTRUCTIONS
              ? [{ ...current[0], content }, ...current.slice(1)]
              : current,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => { defaultSystemInstructionsLoaded.current = true; });
  }, []);
  // Saving (debounced, and only after the initial load above so the
  // fetched value is never immediately clobbered by the pre-fetch fallback)
  // makes the System box "persist across conversations unless edited": every
  // edit becomes the new account-wide default, in whichever conversation you
  // make it, matching how the box already behaves within one conversation.
  const systemInstructions =
    messages[0]?.role === "system" ? messages[0].content : null;
  useEffect(() => {
    if (systemInstructions === null || !defaultSystemInstructionsLoaded.current) return;
    const timer = setTimeout(() => {
      fetch("/api/settings/default-system-instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: systemInstructions }),
      }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [systemInstructions]);
  const [conversationsList, setConversationsList] = useState<
    ConversationSummary[]
  >([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsLoadingMore, setConversationsLoadingMore] =
    useState(false);
  const [conversationsOffset, setConversationsOffset] = useState(0);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [output, setOutput] = useState("");
  const [raw, setRaw] = useState("");
  // "convert" is a third tab, not a response variant -- it hosts the
  // file-format conversion tools rather than showing (a transform of) the
  // model's own output, but lives in the same tab strip since there's no
  // other natural home for it in this three-column layout.
  const [responseTab, setResponseTab] = useState<"output" | "raw" | "convert">("output");
  const showRaw = responseTab === "raw";
  const setShowRaw = (raw: boolean) => setResponseTab(raw ? "raw" : "output");
  function reportError(error: unknown, fallback: string, preserveOutput = false) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const localizedMessage = localizeUiError(error, fallback);
    setStatus("Error");
    setRaw(rawMessage);
    setOutput(current => preserveOutput && current
      ? `${current}\n\n${localizedMessage}`
      : localizedMessage);
    setResponseTab("output");
  }
  const [running, setRunning] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const readingFilesRef = useRef(false);
  const [status, setStatus] = useState("Ready");
  const [controller, setController] = useState<AbortController | null>(null);
  const endpoint = useMemo(
    () =>
      `${domain.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    [domain, path],
  );
  useEffect(() => {
    try {
      localStorage.removeItem(STORAGE_KEY_CONVERSATION_ID);
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
      localStorage.setItem(STORAGE_KEY_REMEMBER, String(rememberHistory));
      if (rememberHistory && !oneShot && !running) localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId, messages, model, pickedModel, privateChat }));
      else if (!rememberHistory || oneShot) localStorage.removeItem("mirror-playground-snapshot");
    } catch { /* Storage may be unavailable. */ }
  }, [conversationId, messages, model, pickedModel, privateChat, rememberHistory, oneShot, running]);
  const isGizmoModel = /^g-/.test(model);
  const lastMessage = messages.at(-1);
  // Not used to disable the Run button (that turned out to trap people who
  // typed into the freshly-appended row and still saw it stay disabled) -
  // only to show *why* a click was a no-op, via runBlockedReason below.
  const runBlockedReason =
    readingFiles
      ? "请等待所选文件读取完成。"
      : mode === "responses" && messages.some(message => message.attachments?.length)
      ? "文件附件仅支持对话模式。请切换到对话模式后发送文件。"
      : !lastMessage || lastMessage.role !== "user"
      ? "最后一条消息必须来自用户。"
      : !lastMessage.content.trim() && !lastMessage.attachments?.length
        ? "请先在最后一条用户消息中输入内容，再运行请求。"
        : null;
  const canRun = runBlockedReason === null;

  useEffect(() => {
    fetch(`${domain.replace(/\/$/, "")}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} })
      .then(async (res) => { if (!res.ok) throw new Error(`模型列表获取失败： ${res.status}`); return res.json(); })
      .then((body) => {
        if (Array.isArray(body.data)) setModels(body.data);
      })
      .catch(() => undefined);
  }, [domain, apiKey]);

  // sync is always sent - the server only pulls however many more upstream
  // pages are needed to cover this request's window, resuming from a
  // persisted cursor (see index.ts), so it's cheap on every call rather
  // than something to gate behind a special "first load only" flag. resync
  // is the expensive one: it restarts that cursor from the top, so it's
  // reserved for an explicit user-initiated refresh.
  async function fetchConversationsPage(offset: number, resync: boolean) {
    const params = new URLSearchParams({
      limit: String(CONVERSATIONS_PAGE_SIZE),
      offset: String(offset),
      sync: "true",
      resync: String(resync),
    });
    const res = await fetch(`${location.origin}/api/conversations?${params}`);
    const body = await res.json();
    return {
      items: Array.isArray(body.items) ? (body.items as ConversationSummary[]) : [],
      hasMore: Boolean(body.hasMore),
    };
  }
  // Used on mount, after every completed run (a run can create/reorder a
  // conversation), and by the explicit Refresh button (resync=true there -
  // see the button below).
  async function refreshConversations(resync = false) {
    setConversationsLoading(true);
    try {
      const { items, hasMore } = await fetchConversationsPage(0, resync);
      setConversationsList(items);
      setConversationsOffset(items.length);
      setConversationsHasMore(hasMore);
    } catch {
      /* best-effort - the picker just stays empty/stale */
    } finally {
      setConversationsLoading(false);
    }
  }
  const loadingMoreRef = useRef(false);
  async function loadMoreConversations() {
    if (loadingMoreRef.current || !conversationsHasMore) return;
    loadingMoreRef.current = true;
    setConversationsLoadingMore(true);
    try {
      const { items, hasMore } = await fetchConversationsPage(
        conversationsOffset,
        false,
      );
      setConversationsList((current) => [...current, ...items]);
      setConversationsOffset((current) => current + items.length);
      setConversationsHasMore(hasMore);
    } catch {
      /* best-effort - scrolling again will just retry */
    } finally {
      loadingMoreRef.current = false;
      setConversationsLoadingMore(false);
    }
  }
  useEffect(() => {
    void refreshConversations();
  }, []);

  async function loadConversation(id: string) {
    if (!id || readingFilesRef.current) return;
    setStatus("Loading…");
    try {
      const res = await fetch(
        `${location.origin}/api/conversations/${encodeURIComponent(id)}`,
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const body = await res.json();
      const loaded: StoredMessageDto[] = Array.isArray(body.messages)
        ? body.messages
        : [];
      // The stored history only ever has user/assistant turns (see
      // store.ts) - a leading system/developer message isn't tracked as a
      // "message" server-side, so keep whatever the editor currently has
      // (or fall back to the default) rather than dropping it.
      const savedInstructions = Array.isArray(body.instructions) ? body.instructions : [];
      setMessages([
        ...savedInstructions,
        ...loaded.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: "" },
      ]);
      setConversationId(body.conversation?.id ?? id);
      setPickedModel(body.conversation?.gizmoId ? body.conversation.model : "");
      if (body.conversation?.gizmoId) setModel(body.conversation.gizmoId);
      else if (body.conversation?.model && body.conversation.model !== "auto")
        setModel(body.conversation.model);
      if (typeof body.conversation?.private === "boolean")
        setPrivateChat(body.conversation.private);
      setStatus("Loaded");
    } catch (error) {
      reportError(error, "加载会话失败，请检查会话状态后重试。");
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Per-account keyboard shortcut overrides - defaults apply until/unless
  // the settings panel below (HotkeySettings) saves an override for an
  // action. Fetched once; edited combos are saved back immediately (see
  // saveHotkeys), same "no separate save step" flow as the rest of the
  // Playground's settings.
  const [hotkeys, setHotkeysState] = useState<Record<string, string>>(DEFAULT_HOTKEYS);
  useEffect(() => {
    fetch("/api/settings/hotkeys")
      .then(async (res) => (res.ok ? res.json() : { hotkeys: {} }))
      .then(({ hotkeys: saved }: { hotkeys?: Record<string, string> }) => {
        if (saved && typeof saved === "object")
          setHotkeysState((current) => ({ ...current, ...saved }));
      })
      .catch(() => undefined);
  }, []);
  function saveHotkeys(next: Record<string, string>) {
    setHotkeysState({ ...DEFAULT_HOTKEYS, ...next });
    fetch("/api/settings/hotkeys", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hotkeys: next }),
    }).catch(() => undefined);
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesHotkey(event, hotkeys.commandPalette)) {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      } else if (event.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  function updateMessage(
    index: number,
    key: keyof PlaygroundMessage,
    value: string,
  ) {
    if (runningRef.current || readingFilesRef.current) return;
    const mutation = editPlaygroundMessage(
      messages,
      index,
      key,
      value,
      Boolean(conversationId.trim()),
    );
    setMessages(mutation.messages);
  }
  function removeMessage(index: number) {
    if (runningRef.current || readingFilesRef.current) return;
    const mutation = removePlaygroundMessage(
      messages,
      index,
      Boolean(conversationId.trim()),
    );
    setMessages(mutation.messages);
  }
  async function addAttachments(index: number, files: File[]) {
    if (runningRef.current || readingFilesRef.current || !files.length) return;
    readingFilesRef.current = true;
    setReadingFiles(true);
    setStatus("Reading files…");
    try {
      // Commit the entire selection together. Separate async updates based on
      // the captured messages array overwrite each other's files.
      const attachments: PlaygroundAttachment[] = await Promise.all(files.map(async file => ({
        name: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
        dataUrl: await readFileAsDataUrl(file),
      })));
      setMessages(current => attachments.reduce((updated, attachment) =>
        addPlaygroundAttachment(updated, index, attachment, Boolean(conversationId.trim())).messages,
        current,
      ));
      setStatus("Ready");
    } catch (error) {
      reportError(error, "读取文件失败，请检查文件后重试。");
    } finally {
      readingFilesRef.current = false;
      setReadingFiles(false);
    }
  }
  function removeAttachment(index: number, attachmentIndex: number) {
    if (runningRef.current || readingFilesRef.current) return;
    const mutation = removePlaygroundAttachment(
      messages,
      index,
      attachmentIndex,
      Boolean(conversationId.trim()),
    );
    setMessages(mutation.messages);
  }
  // Both of these feed the ConversionTools panel: they land the result in the
  // draft user message the same way typing/attaching there directly would,
  // appending a fresh user row first if the last message isn't already one
  // (e.g. right after a completed run left the last message as the assistant
  // reply). Guarded the same way every other chat mutation is -- a mid-run
  // insert would otherwise land after run()'s own trailing setMessages and
  // scramble turn order.
  function insertTextIntoChat(text: string) {
    if (runningRef.current || readingFilesRef.current) return;
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === "user") {
        const content = last.content ? `${last.content}\n\n${text}` : text;
        return [...current.slice(0, -1), { ...last, content }];
      }
      return [...current, { role: "user", content: text }];
    });
  }
  function attachToChat(attachment: PlaygroundAttachment) {
    if (runningRef.current || readingFilesRef.current) return;
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === "user") {
        return [...current.slice(0, -1), { ...last, attachments: [...(last.attachments ?? []), attachment] }];
      }
      return [...current, { role: "user", content: "", attachments: [attachment] }];
    });
  }

  const runningRef = useRef(false);
  async function run() {
    // Belt-and-suspenders against a double-fire (rapid double-click, a stray
    // repeated key event, etc) beating React's state-driven button swap:
    // that used to race two overlapping requests for the same conversation
    // and could leave a sibling reply logged upstream with no user message
    // of its own attached to it.
    if (runningRef.current || readingFilesRef.current) return;
    if (!canRun) {
      setStatus("Blocked");
      setRaw(runBlockedReason!);
      setShowRaw(true);
      return;
    }
    runningRef.current = true;
    const abort = new AbortController();
    setController(abort);
    setRunning(true);
    setOutput("");
    setRaw("");
    setStatus("Running…");
    try {
      const metadata: Record<string, string> = {};
      if (privateChat) metadata.private = "true";
      if (isGizmoModel && pickedModel.trim())
        metadata.mirror_model = pickedModel.trim();
      if (conversationId.trim())
        metadata.conversation_id = conversationId.trim();
      const response = await fetch(endpoint, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          ...(mode === "responses"
            ? { input: messages.map(messageForRequest) }
            : { messages: messages.map(messageForRequest) }),
          stream,
          store: !oneShot,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        }),
      });
      if (!response.ok)
        throw new Error(`${response.status} ${await response.text()}`);
      const returnedConversationId = response.headers.get(
        "x-mirror-conversation-id",
      );
      let nextConversationId = returnedConversationId;
      let finalText = "";
      if (!stream) {
        const body = await response.json();
        setRaw(JSON.stringify(body, null, 2));
        if (mode === "responses") {
          finalText = responseText(body);
          nextConversationId = body.metadata?.conversation_id ?? nextConversationId;
        } else {
          if (typeof body.choices?.[0]?.message?.content !== "string") throw new Error("不支持的补全响应：未返回助手内容。");
          finalText = body.choices[0].message.content;
        }
        setOutput(finalText);
      } else if (response.body) {
        finalText = await (mode === "responses" ? readResponsesStream : readCompletionStream)(response.body, setOutput, setRaw, id => { nextConversationId = id; });
      } else {
        throw new Error("响应不包含流式数据");
      }
      // Keep the exact reply in the visible transcript. The conversation id
      // identifies the upstream thread, while the message prefix lets the
      // server verify that the client has not silently diverged from it.
      if (nextConversationId && !oneShot) setConversationId(nextConversationId);
      if (!oneShot) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: finalText },
          { role: "user", content: "" },
        ]);
      }
      setStatus("Completed");
      if (!oneShot) void refreshConversations();
    } catch (error) {
      if ((error as Error).name === "AbortError") setStatus("Stopped");
      else {
        reportError(error, "请求失败，请检查服务器地址、API 密钥和 ChatGPT 会话后重试。", true);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setController(null);
    }
  }

  function selectMode(next: "chat" | "responses") {
    if (runningRef.current || readingFilesRef.current || next === mode) return;
    setMode(next);
    setPath(next === "responses" ? "/v1/responses" : "/v1/chat/completions");
    setOutput(""); setRaw(""); setShowRaw(false); setStatus("Ready");
  }

  return (
    <div className="playground-app">
      <CommandPalette
        open={commandPaletteOpen}
        disabled={running || readingFiles}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(id) => void loadConversation(id)}
      />
      <Header />
      <aside className="playground-sidebar">
        <div className="side-title">API 测试台</div>
        <button className={`side-item ${mode === "chat" ? "active" : ""}`} aria-pressed={mode === "chat"} disabled={running || readingFiles} onClick={() => selectMode("chat")}>
          <span>☷</span> 对话
        </button>
        <button className={`side-item ${mode === "responses" ? "active" : ""}`} aria-pressed={mode === "responses"} disabled={running || readingFiles} onClick={() => selectMode("responses")}>
          <span>◇</span> Responses API（响应接口）
        </button>
        <div className="side-section">Mirror 服务</div>
        <a className="side-item" href="/">
          <span>↗</span> 打开 ChatGPT
        </a>
        <a
          className="side-item"
          href="/api/health"
          target="_blank"
          rel="noreferrer"
        >
          <span>♥</span> 服务状态
        </a>
        <div className="server-card">
          <b>兼容接口</b>
          <p>
            在浏览器中直接测试 Mirror 或其他兼容 OpenAI API 的服务器。
          </p>
        </div>
      </aside>
      <main className="workbench">
        <div className="workbench-head">
          <div>
            <h1>{mode === "responses" ? "Responses API（响应接口）" : "对话"}</h1>
            <p>{mode === "responses" ? "通过 Responses API 测试文本输入和流式输出。" : "测试兼容 OpenAI 的聊天补全接口。"}</p>
            {mode === "responses" && <p>Mirror 支持文本消息和会话 ID；暂不支持工具调用、previous_response_id 和响应检索。</p>}
          </div>
          <div className="run-actions">
            <span role="status" aria-live="polite" className={`run-status ${status.toLowerCase()}`}>
              {localizedStatus(status)}
            </span>
            {running ? (
              <button
                className="stop-button"
                onClick={() => controller?.abort()}
              >
                停止
              </button>
            ) : (
              <button
                className="run-button"
                disabled={readingFiles}
                title={runBlockedReason ?? undefined}
                onClick={() => void run()}
              >
                运行请求 <span>⌘ ↵</span>
              </button>
            )}
          </div>
        </div>
        <div className="connection-bar">
          <label>
            <span>服务器地址</span>
            <input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
          </label>
          <label>
            <span>接口路径</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label>
            <span>API 密钥（Bearer）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="如果使用浏览器身份验证，可留空"
            />
          </label>
        </div>
        <div className="columns">
          <section className="prompt-panel">
            <div className="panel-title">
              <b>消息</b>
              <button
                disabled={running || readingFiles || Boolean(lastMessage?.attachments?.length)}
                title={lastMessage?.attachments?.length ? "请先发送或移除已附加的文件，再添加新消息。" : undefined}
                onClick={() =>
                  setMessages((current) => [
                    ...current,
                    { role: "user", content: "" },
                  ])
                }
              >
                ＋ 添加消息
              </button>
            </div>
            <div className="messages-editor">
              <p className="field-hint">在对话模式下，可将文件附加到最后一条用户消息。运行请求时会一并发送文件。</p>
              {messages.map((message, index) => (
                <div className="message-editor" key={index}>
                  <div className="message-toolbar">
                    <select
                      aria-label={`第 ${index + 1} 条消息的角色`}
                      disabled={running || readingFiles || message.role === "assistant" || Boolean(message.attachments?.length)}
                      value={message.role}
                      onChange={(event) =>
                        updateMessage(index, "role", event.target.value)
                      }
                    >
                      <option value="system">系统</option>
                      <option value="developer">开发者</option>
                      <option value="user">用户</option>
                      <option value="assistant">助手</option>
                    </select>
                    <button
                      aria-label={
                        message.role === "assistant"
                          ? "助手消息不可删除"
                          : "删除消息"
                      }
                      disabled={running || readingFiles || message.role === "assistant"}
                      onClick={() => removeMessage(index)}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    aria-label={`第 ${index + 1} 条${localizedRole(message.role)}消息内容`}
                    readOnly={running || readingFiles || message.role === "assistant"}
                    aria-readonly={running || readingFiles || message.role === "assistant"}
                    title={
                      message.role === "assistant"
                        ? "助手消息为只读内容，你可以选中并复制文本。"
                        : undefined
                    }
                    value={message.content}
                    onChange={(event) =>
                      updateMessage(index, "content", event.target.value)
                    }
                  />
                  <InlineMediaPreview text={message.content} />
                  {message.role === "user" && (
                    <div className="message-attachments">
                      {mode === "chat" && index === messages.length - 1 && (
                      <label className="attach-button">
                        📎 添加附件
                        <input
                          type="file"
                          multiple
                          disabled={running || readingFiles}
                          style={{ display: "none" }}
                          onChange={(event) => {
                            const files = event.target.files;
                            if (files) void addAttachments(index, Array.from(files));
                            event.target.value = "";
                          }}
                        />
                      </label>
                      )}
                      {(message.attachments ?? []).map((attachment, attachmentIndex) => (
                        <span className="attachment-chip" key={attachmentIndex}>
                          {attachment.name}
                          <button
                            aria-label={`移除附件 ${attachment.name}`}
                            disabled={running || readingFiles}
                            onClick={() => removeAttachment(index, attachmentIndex)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {message.role === "user" && index === messages.length - 1 && (
                    // A second Run/Stop control right under the newest prompt,
                    // so a long conversation never requires scrolling back up
                    // to the top-right corner just to send the next message.
                    // Same handlers as the button up top; only the
                    // accessible name differs (deliberately not starting
                    // with "Run") so existing tests/queries that target the
                    // one-and-only top Run button by role+name are unaffected.
                    <div className="inline-run-row">
                      {running ? (
                        <button
                          type="button"
                          className="stop-button"
                          aria-label="停止（与上方的停止按钮相同）"
                          onClick={() => controller?.abort()}
                        >
                          停止
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="run-button"
                          aria-label="发送此消息（与上方的运行请求按钮相同）"
                          disabled={readingFiles}
                          title={runBlockedReason ?? undefined}
                          onClick={() => void run()}
                        >
                          运行请求 <span>⌘ ↵</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="response-panel">
            <div className="response-tabs">
              <button
                className={responseTab === "output" ? "active" : ""}
                onClick={() => setResponseTab("output")}
              >
                输出
              </button>
              <button
                className={responseTab === "raw" ? "active" : ""}
                onClick={() => setResponseTab("raw")}
              >
                原始响应
              </button>
              <button
                className={responseTab === "convert" ? "active" : ""}
                onClick={() => setResponseTab("convert")}
              >
                转换工具
              </button>
            </div>
            {responseTab === "convert" ? (
              <div className="output convert-tab">
                <ConversionTools
                  chatModeActive={mode === "chat"}
                  disabled={running || readingFiles}
                  onInsertText={insertTextIntoChat}
                  onAttach={attachToChat}
                />
              </div>
            ) : (
              <div
                role="region" aria-label="响应输出" tabIndex={0} aria-busy={running}
                className={`output ${(showRaw ? raw : output) ? "" : "empty"}`}
              >
                {(showRaw ? raw : output) ||
                  "运行请求后，模型响应将在此处显示。"}
                {/* Text mode only (not raw JSON): the raw tab is meant to show the
                    literal wire response, not a rendering of it. */}
                {responseTab === "output" && output && <InlineMediaPreview text={output} />}
              </div>
            )}
          </section>
          <aside className="settings-panel">
            <h2>配置</h2>
            <label>
              <span>模型</span>
              <div className="model-picker-row">
                {modelFreeform ? (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="官方模型 ID、g-… GPT ID 或 g-p-… 项目 ID"
                  />
                ) : (
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="auto">自动（auto）</option>
                    {models.map((item) => (
                      <option value={item.id} key={item.id} disabled={item.mirror?.supported === false}>
                        {item.owned_by === "chatgpt-gizmo"
                          ? `GPT：${item.name ?? item.id}`
                          : item.owned_by === "chatgpt-project"
                            ? `项目：${item.name ?? item.id}`
                            : `${item.id}${item.mirror?.supported === false ? "（不支持）" : ""}`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="model-mode-toggle"
                  onClick={() => setModelFreeform((current) => !current)}
                >
                  {modelFreeform ? "使用列表选择" : "手动输入"}
                </button>
              </div>
            </label>
            {isGizmoModel && (
              <label>
                <span>此 GPT／项目使用的模型</span>
                <input
                  value={pickedModel}
                  onChange={(event) => setPickedModel(event.target.value)}
                  placeholder="例如 gpt-5-6，或其他 g-… / g-p-… ID（实验性）"
                />
              </label>
            )}
            <label className="switch-line">
              <span>流式输出</span>
              <input
                type="checkbox"
                checked={stream}
                onChange={(event) => setStream(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>私密对话</span>
              <input
                type="checkbox"
                checked={privateChat}
                onChange={(event) => setPrivateChat(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>单次请求（临时，不保留记录）</span>
              <input
                type="checkbox"
                checked={oneShot}
                onChange={(event) => setOneShot(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>在此设备记住提示词历史</span>
              <input
                type="checkbox"
                checked={rememberHistory}
                onChange={(event) => setRememberHistory(event.target.checked)}
              />
            </label>
            <label>
              <span>会话 ID</span>
              <div className="model-picker-row">
                <input
                  disabled={running || readingFiles}
                  value={conversationId}
                  onChange={(event) => setConversationId(event.target.value)}
                  placeholder="自动生成（首次响应后填入）"
                />
                <button
                  type="button"
                  className="model-mode-toggle"
                  disabled={running || readingFiles}
                  onClick={() => {
                    setConversationId("");
                    setMessages((current) => [
                      {
                        role: "system",
                        // Keep whatever the box currently holds (the sticky
                        // account-wide default, or a same-session edit) -
                        // "New" clears the conversation, not the default.
                        content:
                          current[0]?.role === "system"
                            ? current[0].content
                            : FALLBACK_SYSTEM_INSTRUCTIONS,
                      },
                      { role: "user", content: "" },
                    ]);
                  }}
                >
                  新建
                </button>
              </div>
            </label>
            <label>
              <div className="conversation-list-head">
                <span>
                  加载会话
                  {conversationsLoading ? "（正在刷新…）" : ""}
                </span>
                <button
                  type="button"
                  className="model-mode-toggle"
                  onClick={() => void refreshConversations(true)}
                >
                  刷新
                </button>
              </div>
              <div
                className="conversation-list"
                onScroll={(event) => {
                  const el = event.currentTarget;
                  // Trigger the next page a bit before the user actually
                  // hits bottom, so the fetch has time to land before they
                  // run out of already-rendered rows to scroll through.
                  if (
                    el.scrollTop + el.clientHeight >=
                    el.scrollHeight - 64
                  ) {
                    void loadMoreConversations();
                  }
                }}
              >
                {conversationsList.length === 0 ? (
                  <div className="conversation-list-empty">
                    {conversationsLoading
? "加载中…"
: "暂无会话"}
                  </div>
                ) : (
                  conversationsList.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      disabled={running || readingFiles}
                      className={`conversation-list-item${
                        item.id === conversationId ? " active" : ""
                      }`}
                      onClick={() => void loadConversation(item.id)}
                    >
                      <span className="conversation-list-title">
                        {item.title || "未命名会话"}
                      </span>
                      <span className="conversation-list-meta">
                        {new Date(item.updatedAt).toLocaleString("zh-CN")}
                      </span>
                    </button>
                  ))
                )}
                {conversationsLoadingMore && (
                  <div className="conversation-list-loading">
                    正在加载更多…
                  </div>
                )}
              </div>
              <p className="field-hint">
                加载会话会将历史记录复制到下方编辑器。修改已提交的用户消息会删除依赖该消息的后续轮次；助手回复为只读。运行请求时，会基于修改后的历史记录继续当前测试台会话。
              </p>
            </label>
            <ConversationTools conversationId={conversationId} disabled={running || readingFiles} onSelect={id => void loadConversation(id)} />
            <HotkeySettings hotkeys={hotkeys} disabled={running || readingFiles} onSave={saveHotkeys} />
            <ConnectionTools domain={domain} apiKey={apiKey} generationSucceeded={status === "Completed"} />
            <div className="request-preview">
              <span>请求地址</span>
              <code>{endpoint}</code>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
