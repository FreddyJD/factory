import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

const root = process.env.GIT_FACTORY_DATA_DIR;
assert.ok(
  root,
  "Set a disposable GIT_FACTORY_DATA_DIR with the pinned runtime installed",
);
const workspace = mkdtempSync(join(tmpdir(), "factory-acp-source-"));
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
const task = JSON.parse(
  execFileSync(binary, ["prepare", workspace], {
    encoding: "utf8",
    env: process.env,
  }),
);
const child = spawn(binary, ["--acp", "--task", task.id], { env: process.env });
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
      60_000,
    );
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    // Fragment each frame to exercise persistent readers rather than line-at-once assumptions.
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const middle = Math.floor(line.length / 2);
    child.stdin.write(line.slice(0, middle));
    setTimeout(() => child.stdin.write(line.slice(middle)), 5);
  });
try {
  const initialized = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "factory-test", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, 1);
  assert.equal(initialized.result.agentInfo.name, "git-factory");
  const invalid = await request("session/new", {
    cwd: workspace,
    mcpServers: [],
  });
  assert.equal(invalid.error.code, -32602);
  const created = await request("session/new", {
    cwd: task.directory,
    mcpServers: [],
  });
  assert.ok(created.result.sessionId);
  assert.equal(created.result.configOptions, undefined);
  console.log(
    `Real OpenCode ACP initialization, fragmented frames, source rejection, and owned session passed: ${task.id}`,
  );
} finally {
  child.stdin.end();
  await exited;
  // Retain integration fixture/worktree for inspection, consistent with app ownership policy.
  console.log(`Retained test worktree: ${task.directory}`);
}
