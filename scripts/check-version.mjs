import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const version = json("package.json").version;
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use a stable major.minor.patch version");
assert.equal(json("src-tauri/tauri.conf.json").version, version, "Tauri version differs");
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, "Cargo version differs");
assert.equal(json("package-lock.json").version, version, "npm lockfile version differs");
assert.equal(json("package-lock.json").packages[""].version, version, "npm lockfile root version differs");
const lock = readFileSync("src-tauri/Cargo.lock", "utf8");
assert.equal(lock.match(/name = "git-factory"\r?\nversion = "([^"]+)"/)?.[1], version, "Cargo lockfile version differs");
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, "Release tag must match the app version");
}
console.log(`Versions match: ${version}`);
