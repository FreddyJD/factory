import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tag = process.env.GITHUB_REF_NAME;
assert.ok(tag?.startsWith("v"), "A version tag is required");
const id = process.env.RELEASE_ID;
assert.match(id ?? "", /^\d+$/, "The build must return a release ID");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const release = JSON.parse(gh("api", `repos/FreddyJD/factory/releases/${id}`));
assert.equal(release.tag_name, tag);
assert.equal(release.draft, true, "Only a draft release can be published by this job");
assert.equal(release.prerelease, false);
const manifestAsset = release.assets.find((asset) => asset.name === "latest.json");
assert.ok(manifestAsset, "Missing updater manifest");
const manifest = JSON.parse(gh("api", `repos/FreddyJD/factory/releases/assets/${manifestAsset.id}`, "-H", "Accept: application/octet-stream"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
assert.equal(manifest.version.replace(/^v/, ""), version);
const artifact = release.assets.find((asset) => asset.name.endsWith("-setup.exe"));
assert.ok(artifact?.size > 0, "Missing installer");
const signatureAsset = release.assets.find((asset) => asset.name === `${artifact.name}.sig`);
assert.ok(signatureAsset, "Missing detached signature");
const signature = gh("api", `repos/FreddyJD/factory/releases/assets/${signatureAsset.id}`, "-H", "Accept: application/octet-stream").trim();
for (const target of ["windows-x86_64", "windows-x86_64-nsis"]) {
  const platform = manifest.platforms[target];
  assert.ok(platform, `Missing ${target} update`);
  assert.equal(platform.url, artifact.url, "Manifest must reference the actual release asset API URL");
  assert.equal(platform.url, `https://api.github.com/repos/FreddyJD/factory/releases/assets/${artifact.id}`);
  assert.equal(platform.signature.trim(), signature, "Manifest signature differs from asset");
}
const directory = mkdtempSync(join(tmpdir(), "git-factory-release-"));
try {
  const installerPath = join(directory, "installer.exe");
  const signaturePath = join(directory, "installer.sig");
  const installer = execFileSync("gh", ["api", `repos/FreddyJD/factory/releases/assets/${artifact.id}`, "-H", "Accept: application/octet-stream"], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(installer.length, artifact.size, "Incomplete installer download");
  writeFileSync(installerPath, installer);
  writeFileSync(signaturePath, signature);
  execFileSync("cargo", ["run", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--example", "verify-update", "--", installerPath, signaturePath, version], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(`Release ${tag} has a complete Windows installer, signature, and updater manifest.`);
