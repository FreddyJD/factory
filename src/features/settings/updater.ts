import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

async function check() {
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>(
    "check_for_update",
  );
  return metadata ? new Update(metadata) : null;
}

export type UpdateState =
  | { status: "idle" | "checking" | "current" | "downloading" | "installing" }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

// Installation is explicit because Windows exits the app to run its installer.
export class UpdateController {
  private pending: Update | null = null;
  private busy = false;
  private disposed = false;

  constructor(
    private changed: (state: UpdateState) => void,
    private dependencies = { check, relaunch },
  ) {}

  private report(state: UpdateState) {
    if (!this.disposed) this.changed(state);
  }

  async check() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const previous = this.pending;
    if (!previous) this.report({ status: "checking" });
    let update: Update | null = null;
    try {
      update = await this.dependencies.check();
      if (this.disposed) return;
      if (previous && (!update || update.version === previous.version)) return;
      if (!update) {
        this.report({ status: "current" });
        return;
      }
      this.report({ status: "downloading" });
      await update.download(undefined, { timeout: 5 * 60 * 1000 });
      if (this.disposed) return;
      this.pending = update;
      if (previous) await previous.close().catch(() => {});
      this.report({ status: "ready", version: update.version });
    } catch (error) {
      this.report(
        previous
          ? { status: "ready", version: previous.version }
          : { status: "error", message: String(error) },
      );
    } finally {
      if (update && update !== this.pending)
        await update.close().catch(() => {});
      this.busy = false;
    }
  }

  async install() {
    if (this.busy || !this.pending || this.disposed) return;
    this.busy = true;
    const update = this.pending;
    this.pending = null;
    this.report({ status: "installing" });
    try {
      await invoke("factory_api", { action: "prepare_update", args: {} });
      await update.install();
      await this.dependencies.relaunch();
    } catch (error) {
      this.report({ status: "error", message: String(error) });
    } finally {
      await update.close().catch(() => {});
      this.busy = false;
    }
  }

  dispose() {
    this.disposed = true;
    const update = this.pending;
    this.pending = null;
    if (update) void update.close().catch(() => {});
  }
}

export function updateLabel(state: UpdateState) {
  switch (state.status) {
    case "idle":
      return "Automatic updates enabled";
    case "checking":
      return "Checking for updates...";
    case "current":
      return "You're up to date";
    case "downloading":
      return "Downloading update...";
    case "ready":
      return `Version ${state.version} is ready`;
    case "installing":
      return "Installing update...";
    case "error":
      return "Couldn't check or install updates. You can retry.";
  }
}
