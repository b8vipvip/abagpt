import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {encoding:"utf8"}).trim().split("\n").filter(p => p !== "SHA256-MANIFEST.json" && existsSync(p)).sort();
const content = JSON.stringify(Object.fromEntries(paths.map(p => [p, createHash("sha256").update(readFileSync(p)).digest("hex")])), null, 2) + "\n";
if (process.argv.includes("--check")) {
  const currentText = readFileSync("SHA256-MANIFEST.json", "utf8");
  if (currentText !== content) {
    const current = JSON.parse(currentText);
    const expected = JSON.parse(content);
    const missing = Object.keys(expected).filter(p => !(p in current));
    const extra = Object.keys(current).filter(p => !(p in expected));
    const mismatched = Object.keys(expected).filter(p => p in current && current[p] !== expected[p]);
    throw new Error(`Manifest is stale; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}; hash mismatches: ${mismatched.join(", ") || "none"}`);
  }
} else writeFileSync("SHA256-MANIFEST.json", content);
