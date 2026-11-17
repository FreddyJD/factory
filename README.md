# Git Factory

A controlled delivery line for software change. Rust-powered desktop application with a small React interface, built with Tauri 2.

**Foundation release:** welcome screen, Windows installer, release automation, and cryptographically verified in-app updates. GitHub sign-in, repository discovery, worktrees, orchestration, and agent execution are not implemented yet.

## Download

Download the Windows x64 `setup.exe` from [the latest release](https://github.com/FreddyJD/factory/releases/latest). The installer is per-user and does not normally require administrator access.

Updater artifacts are signed with a dedicated Tauri key. Windows Authenticode publisher signing is not configured, so Windows SmartScreen may warn about an unknown publisher. Only install artifacts from this repository's releases.

macOS source builds and CI are supported. Public macOS releases are deferred until Apple Developer ID signing and notarization are configured. Apple credentials are needed for trusted distribution, not merely to compile on a GitHub macOS runner.

## Development

Install Node.js 24 LTS, stable Rust (1.90 or later), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Windows requires the MSVC C++ build tools and WebView2; macOS requires Xcode Command Line Tools.

```sh
npm ci
npm run tauri dev
```

Browser-only UI preview: `npm run dev`. The updater is deliberately inactive in the browser.

```sh
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

## Release A Version

Normal pushes to `main` and pull requests run Windows/macOS CI without release secrets. Only stable `vMAJOR.MINOR.PATCH` tags publish Windows releases.

```sh
npm run release:version -- 0.1.1
npm run check
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

The tag must match every version file, point to a commit on `main`, and increase the released version. The release workflow checks and builds the app, creates a draft containing the installer, signature, and `latest.json`, verifies asset completeness, then publishes it as the latest stable release. Failed builds do not advertise an incomplete update. Published versions are never overwritten; ship a higher patch version to correct a release.

## Automatic Updates

Installed desktop clients check GitHub Releases on startup and every four hours, automatically download newer versions, and verify signatures using the embedded public key. Select **Install and restart** to apply an update. Installation is not forced: Windows closes the running app during installation, so explicit approval avoids interrupting future agent work. Offline/check/download/install failures leave the existing app usable and allow retry.

The first install is manual. Source pushes alone do not update installed apps; a successfully published higher version does. No dedicated update server is required for this public repository.

## Signing Configuration

The public updater key is embedded in `src-tauri/tauri.conf.json`. The corresponding private key must be stored as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`, never in Git. For a password-protected key, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Protect the private key and keep an independent secure backup. Do not generate a different key for every release: existing installations trust the original public key. Key rotation requires a planned migration release signed with the old key. Protect `main`, release tags, and access to Actions secrets before opening repository write access broadly.

Updater signing, Windows publisher signing, and Apple signing/notarization are separate mechanisms. Adding macOS distribution later requires macOS bundles and platform entries in the same updater manifest.

## Product Direction

See [the product brief](docs/product.md) for the workspace, worktree, scheduling, and safety model. This repository starts with one desktop application rather than speculative distributed infrastructure.
