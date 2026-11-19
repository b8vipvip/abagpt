import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_HOTKEYS, describeHotkey } from "./hotkeys.js";

// Every configurable shortcut in the app. Add a row here (and a matching
// entry in DEFAULT_HOTKEYS) the next time a new hotkey is introduced -
// this panel and the per-account save/reset behavior come for free.
const ACTIONS: Array<{ id: string; label: string }> = [
  { id: "commandPalette", label: "快速搜索并打开会话" },
];

export function HotkeySettings({
  hotkeys,
  disabled,
  onSave,
}: {
  hotkeys: Record<string, string>;
  disabled: boolean;
  onSave: (next: Record<string, string>) => void;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  function captureKey(actionId: string, label: string, event: ReactKeyboardEvent) {
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push("mod");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    parts.push(event.key.toLowerCase());
    const combo = parts.join("+");
    onSave({ ...hotkeys, [actionId]: combo });
    setRecording(null);
    setStatus(`“${label}”已设置为 ${describeHotkey(combo)}`);
  }

  return (
    <details className="utility-panel">
      <summary>键盘快捷键</summary>
      <p role="status">{status}</p>
      <ul>
        {ACTIONS.map((action) => {
          const combo = hotkeys[action.id] ?? DEFAULT_HOTKEYS[action.id];
          const isDefault = combo === DEFAULT_HOTKEYS[action.id];
          return (
            <li key={action.id}>
              <span>{action.label}</span>{" "}
              {recording === action.id ? (
                <input
                  autoFocus
                  readOnly
                  aria-label={`请为“${action.label}”按下快捷键组合`}
                  value="请按下快捷键组合…（按 Esc 取消）"
                  onKeyDown={(event) => captureKey(action.id, action.label, event)}
                  onBlur={() => setRecording(null)}
                />
              ) : (
                <>
                  <code>{describeHotkey(combo)}</code>{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setRecording(action.id)}
                  >
                    修改
                  </button>{" "}
                  {!isDefault && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        const next = { ...hotkeys };
                        delete next[action.id];
                        onSave(next);
                        setStatus(`“${action.label}”已恢复默认设置`);
                      }}
                    >
                      恢复默认
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
