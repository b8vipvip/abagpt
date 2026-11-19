import { useState } from "react";
import { localizeUiError } from "./ui-errors.js";

export function ConnectionTools({ domain, apiKey, generationSucceeded }: { domain: string; apiKey: string; generationSucceeded: boolean }) {
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [status, setStatus] = useState("尚未测试");
  const [busy, setBusy] = useState(false);
  async function testConnection() {
    setBusy(true);
    setStatus("正在检查 API 和本地诊断信息…");
    try {
      const health = await fetch("/api/diagnostics");
      if (!health.ok) throw new Error(`诊断接口返回 HTTP ${health.status}`);
      setDiagnostics(await health.json());
      const models = await fetch(`${domain.replace(/\/$/, "")}/v1/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
      if (!models.ok) throw new Error(`模型列表接口返回 HTTP ${models.status}。请检查 API 密钥、WARP 和已保存的会话。`);
      const body = await models.json();
      if (!Array.isArray(body.data)) throw new Error("模型列表接口返回了不受支持的数据格式。");
      setStatus(`模型列表获取成功（${body.data.length} 个模型）。${apiKey ? "已提供 API 密钥（Bearer）。" : "已使用浏览器身份验证；尚未测试客户端 API 密钥。"}`);
    } catch (error) { setStatus(localizeUiError(error, "连接测试失败")); }
    finally { setBusy(false); }
  }
  const snippet = 'from openai import OpenAI\nclient = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="YOUR_MIRROR_KEY")';
  return <details className="utility-panel">
    <summary>连接诊断与客户端配置</summary>
    <button disabled={busy} onClick={() => void testConnection()}>测试连接</button>
    <p role="status">{status}</p>
    <p>请求生成状态：{generationSucceeded ? "本次测试台会话已成功完成" : "尚未验证；请点击“运行请求”发送一条测试消息"}。</p>
    {diagnostics !== null && <><pre>{JSON.stringify(diagnostics, null, 2)}</pre><a href="/api/diagnostics" download="mirror-diagnostics.json">导出本地诊断信息</a></>}
    <p>诊断信息描述当前 Mirror 实例的状态；模型列表检查会测试所选服务器地址。</p>
    <pre tabIndex={0}>{snippet}</pre>
    <button onClick={() => void navigator.clipboard.writeText(snippet).then(() => setStatus("客户端配置代码已复制"), () => setStatus("请选中并复制上方的配置代码"))}>复制配置代码</button>
    <p>cm 客户端使用服务器根地址： <code>CM_BASE_URL=http://127.0.0.1:8799</code>。ChatGPTBox 使用兼容 OpenAI 的服务提供方、Mirror 模型 ID，以及以 <code>/v1/chat/completions</code> 结尾的完整接口地址。</p>
  </details>;
}
