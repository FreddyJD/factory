import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Usage: npm run release:version -- 0.1.1");
for (const path of ["package.json", "src-tauri/tauri.conf.json", "package-lock.json"]) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  if (data.packages) data.packages[""].version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
const cargo = "src-tauri/Cargo.toml";
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${version}"`));
const lock = "src-tauri/Cargo.lock";
const lockText = readFileSync(lock, "utf8");
const rootPackage = /(name = "git-factory"\r?\nversion = ")[^"]+"/;
assert.ok(rootPackage.test(lockText), "Root package is missing from Cargo.lock");
writeFileSync(lock, lockText.replace(rootPackage, (_, prefix) => `${prefix}${version}"`));
console.log(`Version set to ${version}. Run npm run check before committing and tagging v${version}.`);
