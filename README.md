# factory

Repository-first development with a native Rust agent harness. Code, Issues, Pull Requests, and History use a compact GitHub-style interface with Bootstrap 3-style controls recreated in CSS. No Bootstrap JavaScript or jQuery dependency.

**MVP:** native Rust agent/tool loop, GitHub Copilot device onboarding, dynamic model selection, repository/multi-repository discovery, explicit empty-folder Git initialization, isolated task worktrees, automatically authorized tool calls and structured questions, inspectable tool journal and diff review, trusted MCP client connections, and separate ACP/MCP stdio CLI interfaces. Signed Windows releases remain enabled.

Issues start bounded local execution immediately. Automatic draft PR publication is enabled by default and configurable in Settings; no automatic merges or OS sandbox. This is not the million-agent distributed scheduler. Use a Copilot subscription or an OpenAI-compatible streaming/tool-calling endpoint. See [harness details and the full tool audit](docs/harness.md) and [protocol setup/limits](docs/protocols.md).

## Download

Download the Windows x64 `setup.exe` from [the latest release](https://github.com/FreddyJD/factory/releases/latest). The installer is per-user and does not normally require administrator access.

Updater artifacts are signed with a dedicated Tauri key. Windows Authenticode publisher signing is not configured, so Windows SmartScreen may warn about an unknown publisher. Only install artifacts from this repository's releases.

macOS source builds and CI are supported. Public macOS releases are deferred until Apple Developer ID signing and notarization are configured. Apple credentials are needed for trusted distribution, not merely to compile on a GitHub macOS runner.

## Development

Install Git, Node.js 24 LTS, stable Rust (1.90 or later), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Windows requires the MSVC C++ build tools and WebView2; macOS requires Xcode Command Line Tools.

```sh
npm ci
npm run tauri dev
```

Browser-only UI preview: `npm run dev`, then open `http://127.0.0.1:1420/?preview=1` for the explicitly labeled read-only fixture. Preview mutations are rejected and it is excluded from production builds. Use Tauri for real repositories.

```sh
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

## First Run

No coding-runtime download or OpenCode executable is needed. In Settings, choose GitHub sign-in or add an OpenAI-compatible base URL, optional API key and exact model ID. GitHub sign-in uses the Roxy-compatible public device-flow client identity by default; an advanced client-ID override and `GIT_FACTORY_GITHUB_CLIENT_ID` remain available. Direct Copilot inference/shared client compatibility is experimental and may be restricted. The native adapter exchanges the GitHub OAuth credential for a short-lived Copilot token and honors its assigned inference host. Existing OpenCode credentials are not imported. App-update signature verification remains enabled.

Start the app and open a repository or a parent folder of repositories. Code opens immediately without requiring inference authentication. Browse source or a registered worktree from the checkout selector; the live filesystem refreshes every two seconds while visible. Configure an inference provider in Settings when ready to create an issue. New issue creates an isolated worktree and starts the native agent. The issue's conversation, expandable tool calls with recorded inputs/results and questions remain in its thread. Code shows four-second activity dots for native file operations in each worktree: blue for reads, listings and search matches; green for successful changes. Parent directories reflect descendant activity, and active worktrees are one click away. Arbitrary shell/MCP side effects and runs in separate CLI processes are not file-attributed. All available tool calls run automatically without approval prompts, including file edits, shell commands, web fetches, child investigations and connected MCP tools/resources. This applies to new and retained tasks in desktop, ACP and MCP execution. Structured questions still wait for answers; draft PR publication follows the Settings preference and local merge still requires confirmation. Credentials stay Rust-side in the OS credential store.

Task worktrees and history survive restarts. Stop cancels a turn; Close worker releases a local slot without removing files. Four task workers may be open simultaneously. New code executes as your user, so only use trusted repositories, commands and MCP servers. Git content filters are disabled for Factory Git operations; LFS files remain pointers.

The icon beside the Code checkout selector opens a 3D worktree visualization. Choose **Factory** or **Kitchen** in **Settings > General > Visualization**; the preference is saved on this device. Native agent tools drive conveyor parcels or dishes and busy chefs. The embedded activity feed shows tools and observed file paths across worktrees; click a worktree name to select it, then use **Open files** to return to its files. Drag to orbit, scroll to zoom, and pause motion without pausing agents. Reduced-motion preferences are respected. Recent transcript history is labeled history and never replayed as fresh activity; delegated investigations appear as a single `task` call, and separate CLI processes do not broadcast live tools to the desktop. The read-only browser preview shows sample history, not live production.

Build the console integration executable with `cargo build --manifest-path src-tauri/Cargo.toml --bin factory-cli`. The Windows installer includes it beside the desktop executable. See [ACP/MCP setup](docs/protocols.md).

## Local Review And Merge

The review page shows GitHub pull requests for repositories with a supported GitHub origin, or local completed issue reviews otherwise, never both. Issue actions follow the same split. Local reviews require no remote or GitHub CLI. Inspect the complete candidate diff, then explicitly confirm **Merge locally**. This commits the reviewed snapshot and fast-forwards the source checkout's currently reviewed local branch without pushing. The source must have no staged, unstaged or untracked changes; ignored-file collisions are preserved. Divergent history, submodules, sparse checkouts, hidden index flags and in-progress Git operations require manual integration. Both source HEAD and candidate content are rechecked. Recovery refs and uncertain outcomes are retained, never silently reset or retried.

The application uses a cooperative repository-wide lease, not an OS lock against editors or other Git processes. Avoid external branch switching during integration. Local merge does not run validation automatically; inspect the issue's test evidence first.

## Inference Providers

OpenAI-compatible connections accept HTTPS base URLs, or HTTP on localhost only. Include the API prefix (`https://api.openai.com/v1`, `http://localhost:11434/v1`). API keys are optional for local servers and stored in macOS Keychain/Windows Credential Manager when supplied. Endpoint/model selection is retained per issue. Changing a destination or model requires a new connection to prevent redirecting retained history. Manual model IDs work without `/models`; the endpoint must implement streaming Chat Completions and function calls. Manual compatible endpoints currently use Chat Completions. Configure the output token reserve separately from the context window and choose the supported output-limit parameter: max_tokens, max_completion_tokens for reasoning models, or provider default to omit it. Provider default preserves compatibility but cannot enforce the reserved output or checkpoint-generation cap. GitHub Copilot additionally supports native Responses and Messages APIs, with account-advertised routing and preserved reasoning/tool continuation. Settings lists the full eligible account catalog and distinguishes coding-tool capability.

## Issues And Pull Requests

Issues are local engineering records, not synchronized GitHub Issues. Existing tasks remain visible as retained issue sessions. Pull Requests lists real GitHub PRs using the repository account selected in Settings, or installed `gh` authentication in CLI-default mode. Inspect their diff and submit approval for the exact reviewed head; the UI invalidates confirmation if the head changes. GitHub does not allow approving your own PR.

Create an issue with just its description; the agent chooses a concise title during its first turn. A description excerpt remains as a provisional title if inference fails or the agent does not rename it. Paste or attach PNG/JPEG images in the description or follow-up composer, preview them, and remove attachments before sending. Image-only messages are supported. Images are stored locally with the conversation and sent to the issue's selected model, never silently dropped or routed to another model. Limits are four images, 2 MiB each, 4 MiB total, and 2048 pixels per side. Retained requests have the same count/byte caps plus a conservative image context allowance; older completed transactions may be represented by a clearly labeled continuation checkpoint. Use an image-capable model: explicitly unsupported Copilot models are blocked; unknown capabilities and manually configured endpoints are tried as selected and any provider rejection is shown. Desktop issue images are supported across Chat Completions, Responses and Messages; ACP/MCP prompt interfaces remain text-only.

Long-running main and child agents automatically use marked inspection excerpts and bounded continuation checkpoints before requests overflow. This shared policy applies to desktop, CLI/ACP, MCP execution, Copilot protocols and custom endpoints. The latest user input stays verbatim; original transcript and action records stay on disk. Checkpoints are lossy generated memory, not a substitute for verifying uncertain outcomes. Only clean structured context rejections permit one smaller-request retry; partial streams and completed actions are never automatically replayed. Summary requests use the selected model and may add inference usage. Oversized mandatory input or tool schemas still require a larger model or narrower input/tools.

New issues in GitHub repositories automatically commit and push only their assigned branch and open one draft PR after successful completion. Repositories without a supported GitHub origin stay local automatically. Disable **Automatically create a draft pull request** under **Settings > General > GitHub repositories** to keep new GitHub-repository issues local, including when GitHub authentication is unavailable. The preference is saved on this device and does not change existing issues. Completed issues can still prepare and confirm a draft PR manually. No separate validation command is configured or run during publication; inspect the agent's test evidence and PR checks. Publication uses a frozen candidate tree including new files, never force-pushes/tags/submodules, and records uncertain outcomes rather than retrying. The GitHub account and destination are checked at issue creation and rechecked at publication. The current starting commit must match the GitHub default branch; signed-commit policies require manual publication. In CLI-default mode, Git push credentials and the GitHub CLI account are separate and must both have access. Live external publication/review has not been exercised by automated tests.

MCP in Settings persists trusted project server configuration; new issues connect it in their worktree. Existing idle issues can attach a saved server explicitly. Configuration including supplied environment values is local plaintext under user-private app data; do not put secrets in project source.

### Multiple GitHub Repository Accounts

Under **Settings > General > GitHub repositories**, add any number of github.com accounts with personal access tokens, then choose and save an account for the selected repository. These credentials are independent of Copilot. Tokens are verified with GitHub and stored in the OS credential store, never in project settings. Adding an existing account updates its token; removing an account requires first changing repositories that use it and does not revoke the token on GitHub.

For fine-grained tokens, select the target repositories and grant **Contents: Read and write** and **Pull requests: Read and write**. Changes to workflows also require **Workflows: Read and write**. Enterprise policies, token approval, SSO authorization and token expiration still apply. GitHub CLI must remain installed for PR commands.

The saved account is used for PR listing, review, publication, and automatic HTTPS pushes (including repositories whose origin uses SSH). Factory does not change the stored origin, Git commit identity, active CLI account or Copilot login. Different repositories can run concurrently with different credentials. **Use GitHub CLI default** preserves existing CLI/environment authentication and Git push credentials. Existing issue authorizations are not transferred to another account; create a new issue if you change the selected account before automatic publication.

## Release A Version

Normal pushes to `main` and pull requests run Windows/macOS CI without release secrets. Only stable `vMAJOR.MINOR.PATCH` tags publish Windows releases.

```sh
npm run release:version -- 0.6.1
npm run check
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Release 0.6.1"
git tag v0.6.1
git push origin main
git push origin v0.6.1
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
