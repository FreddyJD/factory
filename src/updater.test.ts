import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn().mockResolvedValue(true),
}));
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateController, type UpdateState } from "./updater";

function fixture() {
  const update = {
    version: "0.2.0",
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies = {
    check: vi.fn().mockResolvedValue(update as unknown as Update),
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
  const states: UpdateState[] = [];
  const controller = new UpdateController(
    (state) => states.push(state),
    dependencies,
  );
  return { update, dependencies, states, controller };
}

describe("signed update lifecycle", () => {
  it("downloads automatically but never installs without a user action", async () => {
    const { controller, update, states } = fixture();
    await controller.check();
    expect(states).toEqual([
      { status: "checking" },
      { status: "downloading" },
      { status: "ready", version: "0.2.0" },
    ]);
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(update.close).not.toHaveBeenCalled();
  });

  it("installs a downloaded update only once and relaunches", async () => {
    const { controller, update, dependencies } = fixture();
    await controller.check();
    await Promise.all([controller.install(), controller.install()]);
    expect(update.install).toHaveBeenCalledOnce();
    expect(dependencies.relaunch).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
  });

  it("does not run concurrent checks", async () => {
    const { controller, dependencies, update } = fixture();
    await Promise.all([controller.check(), controller.check()]);
    expect(dependencies.check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledWith(undefined, {
      timeout: 300_000,
    });
  });

  it("replaces a pending update only after a newer download verifies", async () => {
    const { controller, dependencies, update, states } = fixture();
    await controller.check();
    const newer = {
      ...update,
      version: "0.3.0",
      download: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    dependencies.check.mockResolvedValue(newer as unknown as Update);
    await controller.check();
    expect(newer.download).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ status: "ready", version: "0.3.0" });
  });

  it("reports no update without downloading", async () => {
    const { controller, dependencies, states, update } = fixture();
    dependencies.check.mockResolvedValue(null);
    await controller.check();
    expect(states.at(-1)).toEqual({ status: "current" });
    expect(update.download).not.toHaveBeenCalled();
  });

  it("allows retry after an offline error", async () => {
    const { controller, dependencies, states } = fixture();
    dependencies.check.mockRejectedValueOnce(new Error("Offline"));
    await controller.check();
    expect(states.at(-1)?.status).toBe("error");
    await controller.check();
    expect(states.at(-1)).toEqual({ status: "ready", version: "0.2.0" });
  });

  it("does not install an unverified or failed download", async () => {
    const { controller, states, update } = fixture();
    update.download.mockRejectedValueOnce(new Error("Signature mismatch"));
    await controller.check();
    await controller.install();
    expect(states.at(-1)?.status).toBe("error");
    expect(update.install).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
    await controller.check();
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("does not restart after a failed installation", async () => {
    const { controller, states, update, dependencies } = fixture();
    await controller.check();
    update.install.mockRejectedValueOnce(new Error("Install failed"));
    await controller.install();
    expect(states.at(-1)?.status).toBe("error");
    expect(dependencies.relaunch).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  it("releases pending downloads on disposal", async () => {
    const { controller, update } = fixture();
    await controller.check();
    controller.dispose();
    await controller.install();
    expect(update.close).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("releases an in-flight check after disposal without emitting new states", async () => {
    const { controller, dependencies, update, states } = fixture();
    let resolve!: (update: Update) => void;
    dependencies.check.mockImplementationOnce(
      () =>
        new Promise<Update>((done) => {
          resolve = done;
        }),
    );
    const checking = controller.check();
    controller.dispose();
    resolve(update as unknown as Update);
    await checking;
    expect(states).toEqual([{ status: "checking" }]);
    expect(update.close).toHaveBeenCalledOnce();
    expect(update.download).not.toHaveBeenCalled();
  });
});
