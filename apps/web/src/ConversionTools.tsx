import { useState } from "react";
import type { PlaygroundAttachment } from "./playground-history.js";
import { localizeUiError } from "./ui-errors.js";

type FormatId = "loaf" | "pngspeak" | "gptgif" | "gptgif-v4";

const FORMAT_LABELS: Record<FormatId, string> = {
  loaf: "LoaF（文本归档）",
  pngspeak: "PngSpeak（PNG 图片）",
  gptgif: "gptgif 原版（GIF 动图）",
  "gptgif-v4": "gptgif v4（GIF 动图，自动校准）",
};

const FORMAT_EXTENSIONS: Record<FormatId, string> = {
  loaf: "loaf",
  pngspeak: "pngspk.png",
  gptgif: "gptgif.gif",
  "gptgif-v4": "gptgif-v4.gif",
};

interface Artifact {
  format: FormatId;
  bytes: number;
  /** The encoded artifact's own bytes (a PNG/GIF/loaf-text), for preview/download/attach. */
  dataBase64: string;
  /** The original, pre-encoding payload bytes -- needed to build a fresh decode-prompt via
   * /api/convert/gpt-prompt, which always encodes from raw payload rather than re-wrapping
   * an already-encoded artifact. Absent for artifacts whose source text the server never
   * reveals (e.g. the fortune endpoint's randomly-picked string) -- the prompt button is
   * disabled in that case rather than sending a broken request. */
  sourceDataBase64?: string;
  mime: string;
  extension: string;
  /** Set for image-producing formats (pngspeak/gptgif/gptgif-v4) -- these are genuinely valid images despite hiding data inside. */
  isImage: boolean;
}

/** @internal Skips prompt building when the source payload is unknown to the client. */
export function withPromptSource<T>(sourceDataBase64: string | undefined, build: () => T): T | undefined {
  if (sourceDataBase64 === undefined) return undefined;
  return build();
}

function toBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}
/** Best-effort UTF-8 decode. Returns null for bytes that aren't valid text (e.g. decoding a pngspeak/gptgif artifact's own binary output back through the wrong format) instead of throwing. */
function tryFromBase64(base64: string): string | null {
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const value = json.error;
    const message = typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof value.message === "string"
        ? value.message
        : `HTTP ${res.status}`;
    throw new Error(`${message} (HTTP ${res.status})`);
  }
  return json;
}

export function ConversionTools({
  chatModeActive,
  disabled,
  onInsertText,
  onAttach,
}: {
  chatModeActive: boolean;
  disabled: boolean;
  onInsertText: (text: string) => void;
  onAttach: (attachment: PlaygroundAttachment) => void;
}) {
  const [format, setFormat] = useState<FormatId>("pngspeak");
  const [inputText, setInputText] = useState("一条隐藏在明处的秘密消息。");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [decodeInput, setDecodeInput] = useState("");
  const [decodedResult, setDecodedResult] = useState<{ text: string | null; dataBase64: string; bytes: number } | null>(null);
  const [funResult, setFunResult] = useState<{ label: string; artifact: Artifact } | null>(null);

  // Every mutation that reaches the chat (insert/attach) has to respect the
  // same "don't touch the transcript mid-run" rule as every other Playground
  // control -- `disabled` is running-or-reading-files, `busy` is this panel's
  // own in-flight request.
  const blocked = busy || disabled;

  function normalizeEncodeResult(res: any, sourceDataBase64: string): Artifact {
    if (format === "loaf") {
      return { format, bytes: res.bytes, dataBase64: toBase64(res.loaf), sourceDataBase64, mime: "text/plain", extension: FORMAT_EXTENSIONS[format], isImage: false };
    }
    const mime = format === "pngspeak" ? "image/png" : "image/gif";
    const extension = FORMAT_EXTENSIONS[format];
    return { format, bytes: res.bytes, dataBase64: res.dataBase64, sourceDataBase64, mime, extension, isImage: true };
  }

  async function readFileAsBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function encode(dataBase64: string) {
    setBusy(true);
    setStatus("正在编码…");
    setArtifact(null);
    try {
      const res =
        format === "loaf"
          ? await postJson("/api/convert/loaf/encode", { entries: [{ name: "message.txt", contentBase64: dataBase64 }] })
          : await postJson(`/api/convert/${format}/encode`, { dataBase64 });
      setArtifact(normalizeEncodeResult(res, dataBase64));
      setStatus(`编码完成：${FORMAT_LABELS[format]}，共 ${res.bytes} 字节。`);
    } catch (error) {
      setStatus(localizeUiError(error, "编码失败"));
    } finally {
      setBusy(false);
    }
  }

  async function decode() {
    setBusy(true);
    setStatus("正在解码…");
    setDecodedResult(null);
    try {
      const res =
        format === "loaf"
          ? await (async () => {
              const decoded = await postJson("/api/convert/loaf/decode", { loaf: decodeInput.trim() });
              const first = decoded.entries?.[0];
              if (!first) throw new Error("该 LoaF 归档中没有文件条目。");
              return { dataBase64: first.contentBase64, bytes: first.bytes };
            })()
          : await postJson(`/api/convert/${format}/decode`, { dataBase64: decodeInput.trim() });
      setDecodedResult({ text: tryFromBase64(res.dataBase64), dataBase64: res.dataBase64, bytes: res.bytes });
      setStatus(`解码完成，共 ${res.bytes} 字节。`);
    } catch (error) {
      const failureMessage = localizeUiError(error, "解码失败。");
      setStatus(format === "gptgif" ? `${failureMessage}（gptgif 原版格式没有固定字母表，请参阅下方说明。）` : failureMessage);
    } finally {
      setBusy(false);
    }
  }

  async function runFun(kind: "mystery" | "fortune") {
    setBusy(true);
    setStatus(kind === "mystery" ? "正在随机选择编码格式…" : "正在读取幸运签…");
    try {
      if (kind === "mystery") {
        const sourceText = inputText || "hello";
        const res = await fetch(`/api/convert/mystery?text=${encodeURIComponent(sourceText)}`).then((r) => r.json());
        const mime = res.format === "loaf" ? "text/plain" : res.format === "pngspeak" ? "image/png" : "image/gif";
        setFunResult({
          label: `神秘格式：${res.format} — ${res.surprise}`,
          // The mystery endpoint returns the artifact only, but we know the
          // plaintext we sent it, so a decode-prompt can still be built.
          artifact: {
            format: res.format,
            bytes: res.bytes,
            dataBase64: res.dataBase64,
            sourceDataBase64: toBase64(sourceText),
            mime,
            extension: FORMAT_EXTENSIONS[res.format as FormatId],
            isImage: mime.startsWith("image/"),
          },
        });
      } else {
        const res = await fetch("/api/convert/fortune?format=pngspeak");
        const buffer = await res.arrayBuffer();
        let binary = "";
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        // No sourceDataBase64 here: the fortune text is a server-side random
        // pick that's never sent back to the client, so there's nothing to
        // rebuild a decode-prompt from -- the prompt button stays disabled.
        setFunResult({ label: "你的幸运签藏在一张 PngSpeak PNG 图片中：", artifact: { format: "pngspeak", bytes: buffer.byteLength, dataBase64: btoa(binary), mime: "image/png", extension: FORMAT_EXTENSIONS.pngspeak, isImage: true } });
      }
      setStatus("就绪");
    } catch (error) {
      setStatus(localizeUiError(error, "操作未成功"));
    } finally {
      setBusy(false);
    }
  }

  async function buildChatPrompt(art: Artifact) {
    return withPromptSource(art.sourceDataBase64, async () => {
      setBusy(true);
      setStatus("正在生成对话提示词…");
      try {
        const res = await postJson("/api/convert/gpt-prompt", {
          dataBase64: art.sourceDataBase64,
          format: art.format,
          filename: `message.${art.extension}`,
        });
        onInsertText(res.prompt);
        setStatus("已将提示词插入下方当前对话消息。");
      } catch (error) {
        setStatus(localizeUiError(error, "无法生成提示词"));
      } finally {
        setBusy(false);
      }
    });
  }

  function attach(art: Artifact) {
    onAttach({ name: `mirror-convert.${art.extension}`, mimeType: art.mime, dataUrl: `data:${art.mime};base64,${art.dataBase64}` });
    setStatus("已添加到下方当前对话消息的附件中。");
  }

  const artifactDataUrl = artifact ? `data:${artifact.mime};base64,${artifact.dataBase64}` : null;

  return (
    <div className="conversion-tools">
      <p className="field-hint">
        将文本或文件编码为 Mirror 移植的隐写格式，然后将结果直接放入左侧对话中：可以作为真实附件添加，也可以作为可直接粘贴的解码提示词。
      </p>
      <label>
        <span>格式</span>
        <select value={format} onChange={(event) => { setFormat(event.target.value as FormatId); setArtifact(null); }} disabled={busy}>
          {(Object.keys(FORMAT_LABELS) as FormatId[]).map((id) => (
            <option key={id} value={id}>
              {FORMAT_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>要编码的文本</span>
        <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} disabled={busy} />
      </label>
      <label className="attach-button">
        📎 或选择文件进行编码
        <input
          type="file"
          disabled={busy}
          style={{ display: "none" }}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void encode(await readFileAsBase64(file));
          }}
        />
      </label>
      <div className="conversion-actions">
        <button disabled={busy || !inputText.trim()} onClick={() => void encode(toBase64(inputText))}>
          编码
        </button>
      </div>
      {status && <p role="status">{status}</p>}
      {artifact && artifactDataUrl && (
        <div className="conversion-result">
          {artifact.isImage && (
            <a href={artifactDataUrl} target="_blank" rel="noreferrer">
              <img className="conversion-preview-image" src={artifactDataUrl} alt={`已编码的 ${FORMAT_LABELS[artifact.format]} 文件`} />
            </a>
          )}
          <div className="conversion-result-actions">
            <a href={artifactDataUrl} download={`mirror-convert.${artifact.extension}`}>
              ⬇ 下载
            </a>
            <button disabled={blocked} onClick={() => void buildChatPrompt(artifact)}>
              💬 将解码提示词插入对话
            </button>
            <button disabled={blocked || !chatModeActive} title={!chatModeActive ? "切换到对话模式后才能添加附件" : undefined} onClick={() => attach(artifact)}>
              📎 添加到对话附件
            </button>
          </div>
        </div>
      )}

      <hr />
      <p className="field-hint">一些实用性不高但有趣的小功能：</p>
      <div className="conversion-actions">
        <button disabled={busy} onClick={() => void runFun("mystery")}>
          🎁 神秘编码
        </button>
        <button disabled={busy} onClick={() => void runFun("fortune")}>
          🥠 幸运签
        </button>
      </div>
      {funResult && (
        <div className="conversion-result">
          <p>{funResult.label}</p>
          {funResult.artifact.isImage && <img className="conversion-preview-image" src={`data:${funResult.artifact.mime};base64,${funResult.artifact.dataBase64}`} alt={funResult.label} />}
          <div className="conversion-result-actions">
            <button
              disabled={blocked || funResult.artifact.sourceDataBase64 === undefined}
              title={funResult.artifact.sourceDataBase64 === undefined ? "这条幸运签的原文由服务器随机生成，客户端无法获取，因此不能据此生成解码提示词。" : undefined}
              onClick={() => void buildChatPrompt(funResult.artifact)}
            >
              💬 将解码提示词插入对话
            </button>
            <button disabled={blocked || !chatModeActive} onClick={() => attach(funResult.artifact)}>
              📎 添加到对话附件
            </button>
          </div>
        </div>
      )}

      <hr />
      <label>
        <span>解码（粘贴 Base64 字节；LoaF 格式也可粘贴完整 .loaf 行）</span>
        <textarea value={decodeInput} onChange={(event) => setDecodeInput(event.target.value)} disabled={busy} placeholder="粘贴上方编码结果中的 dataBase64 或 .loaf 文本" />
      </label>
      <div className="conversion-actions">
        <button disabled={busy || !decodeInput.trim()} onClick={() => void decode()}>
          解码
        </button>
      </div>
      {decodedResult && (
        <div className="conversion-result">
          {decodedResult.text !== null ? (
            <pre>{decodedResult.text}</pre>
          ) : (
            <p>已解码出 {decodedResult.bytes} 字节，但内容不是有效的 UTF-8 文本（可能是二进制文件，或选择了错误的格式）。</p>
          )}
          <div className="conversion-result-actions">
            {decodedResult.text !== null && (
              <button disabled={blocked} onClick={() => onInsertText(decodedResult.text!)}>
                💬 将解码文本插入对话
              </button>
            )}
            <a href={`data:application/octet-stream;base64,${decodedResult.dataBase64}`} download="decoded.bin">
              ⬇ 下载解码后的数据
            </a>
          </div>
        </div>
      )}
      <p className="field-hint">
        gptgif 原版格式需要经过校准的簇映射才能自行解码（该格式没有固定字母表）。请直接使用 <code>/api/convert/gptgif/calibrate</code> ，也可以让模型根据上方的解码提示词推导解码方法。
      </p>
    </div>
  );
}
