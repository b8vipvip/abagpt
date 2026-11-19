import { useState } from "react";
import { localizeUiError } from "./ui-errors.js";

interface Item {
  id: string;
  title: string;
  currentNodeId?: string;
}

interface Node {
  id: string;
  upstreamNodeId: string | null;
  role: string;
  status: string;
}

const NODE_ROLE_LABELS: Record<string, string> = { user: "用户", assistant: "助手" };
const NODE_STATUS_LABELS: Record<string, string> = {
  done: "已完成", finished_successfully: "已完成", streaming: "生成中",
  in_progress: "进行中", pending: "等待中", error: "失败", failed: "失败",
};

interface Branches {
  selected: string;
  parent: string;
  items: Item[];
  nodes: Node[];
}

export function ConversationTools({
  conversationId,
  disabled,
  onSelect,
}: {
  conversationId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [status, setStatus] = useState("");
  const [attachments, setAttachments] = useState(false);
  const [metadata, setMetadata] = useState(false);

  async function read(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (!response.ok)
      throw new Error(
        `历史记录接口返回 HTTP ${response.status}。请刷新后重试。`,
      );
    return response.json();
  }

  async function search() {
    try {
      const result = await read(
        `/api/conversations/search?q=${encodeURIComponent(query)}`,
      );
      setItems(result.items);
      setStatus(`找到 ${result.items.length} 条本地匹配记录（最多 100 条）`);
    } catch (error) {
      setStatus(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function refreshBranches() {
    try {
      setBranches(
        await read(
          `/api/conversations/${encodeURIComponent(conversationId)}/branches`,
        ),
      );
      setStatus("会话分支已加载");
    } catch (error) {
      setStatus(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function branch(messageId: string) {
    try {
      const result = await read(
        `/api/conversations/${encodeURIComponent(conversationId)}/branch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        },
      );
      onSelect(result.id);
      setBranches(null);
      setStatus("已选择此分支；下一轮对话将以该节点为父节点。");
    } catch (error) {
      setStatus(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const base = `/api/conversations/${encodeURIComponent(
    conversationId,
  )}/export?attachments=${attachments}&metadata=${metadata}`;

  return (
    <details className="utility-panel">
      <summary>本地搜索、会话分支与导出</summary>
      <label>
        搜索本地历史记录
        <input
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <button
        disabled={disabled || !query.trim()}
        onClick={() => void search()}
      >
        搜索历史
      </button>
      <p role="status">{status}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button disabled={disabled} onClick={() => onSelect(item.id)}>
              {item.title}
            </button>
          </li>
        ))}
      </ul>
      {conversationId && (
        <>
          <button disabled={disabled} onClick={() => void refreshBranches()}>
            查看会话分支
          </button>
          {branches?.selected === conversationId && (
            <>
              <p>
                下一轮父节点： <code>{branches.parent}</code>
              </p>
              <ul>
                {branches.items.map((item) => (
                  <li key={item.id}>
                    <button
                      disabled={disabled}
                      aria-current={item.id === conversationId}
                      onClick={() => onSelect(item.id)}
                    >
                      {item.title}
                    </button>
                    <code>{item.currentNodeId}</code>
                  </li>
                ))}
              </ul>
              <ol>
                {branches.nodes.map((node) => {
                  const isNextParent = Boolean(
                    branches.parent && node.upstreamNodeId === branches.parent,
                  );
                  return (
                    <li
                      key={node.id}
                      aria-current={isNextParent ? "location" : undefined}
                      style={isNextParent ? { fontWeight: 600 } : undefined}
                    >
                      <span>
                        {NODE_ROLE_LABELS[node.role] ?? "其他角色"} · {NODE_STATUS_LABELS[node.status] ?? "其他状态"}
                      </span>{" "}
                      · <code>{node.upstreamNodeId ?? "无上游节点"}</code>
                      {isNextParent && <strong>（下一轮父节点）</strong>}
                      {node.role === "assistant" && node.upstreamNodeId && (
                        <button
                          disabled={disabled}
                          onClick={() => void branch(node.id)}
                        >
                          从此助手消息继续
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={attachments}
              onChange={(event) => setAttachments(event.target.checked)}
            />
            包含附件引用（不包含文件内容）
          </label>
          <label>
            <input
              type="checkbox"
              checked={metadata}
              onChange={(event) => setMetadata(event.target.checked)}
            />
            包含 ID、模型和消息元数据
          </label>
          <a href={`${base}&format=json`} download>
            导出 JSON
          </a>
          {" · "}
          <a href={`${base}&format=markdown`} download>
            导出 Markdown
          </a>
          <p>
            导出文件包含对话文本。附件引用不包含签名 URL 和原始事件。导出文件仅用于归档，不能用于恢复会话。
          </p>
        </>
      )}
    </details>
  );
}
