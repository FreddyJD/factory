import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

const directory = mkdtempSync(join(tmpdir(), "factory-protocol-"));
const workspace = join(directory, "source");
execFileSync("git", ["init", "-b", "main", workspace]);
execFileSync("git", [
  "-C",
  workspace,
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@localhost",
  "commit",
  "--allow-empty",
  "-m",
  "Initial",
]);
const binary = resolve(
  `src-tauri/target/debug/factory-cli${process.platform === "win32" ? ".exe" : ""}`,
);
const child = spawn(binary, ["--mcp", "--workspace", workspace], {
  env: { ...process.env, GIT_FACTORY_DATA_DIR: join(directory, "data") },
});
const exited = new Promise((resolve, reject) => {
  child.on("close", resolve);
  child.on("error", reject);
});
const pending = new Map();
let next = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
child.stderr.pipe(process.stderr);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${method}`)),
      10_000,
    );
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
try {
  const discovery = await request("server/discover", { _meta: meta });
  assert.equal(discovery.result.resultType, "complete");
  const listed = await request("tools/list", { _meta: meta });
  assert.equal(listed.result.tools.length, 3);
  const called = await request("tools/call", {
    _meta: meta,
    name: "factory_workspace",
    arguments: {},
  });
  assert.equal(called.result.isError, false);
  const denied = await request("tools/call", {
    _meta: meta,
    name: "factory_start",
    arguments: { goal: "No", model: "No" },
  });
  assert.equal(denied.result.isError, true);
  const unsupported = await request("server/discover", {
    _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
  });
  assert.equal(unsupported.error.code, -32022);
  const invalid = await request("tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
  });
  assert.equal(invalid.error.code, -32602);
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const legacy = await request("tools/list", {});
  assert.equal(legacy.result.tools.length, 3);
  assert.equal(legacy.result.resultType, undefined);
  console.log(
    "MCP modern/legacy discovery, scope, tool call, execution opt-in, and metadata checks passed.",
  );
} finally {
  child.stdin.end();
  await exited;
  rmSync(directory, { recursive: true, force: true });
}
