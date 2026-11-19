import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "mirror-playwright-"));
process.env.MIRROR_DATA_DIR = dataDir;
process.env.MIRROR_WEB_ORIGIN = "http://127.0.0.1:4173";
process.env.HOST = "127.0.0.1";
process.env.PORT = "8787";

const { buildApp } = await import("../../apps/server/dist/index.js");
const app = await buildApp();
await app.listen({ port: 8787, host: "127.0.0.1" });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
