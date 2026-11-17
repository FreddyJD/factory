import { useEffect, useRef, useState } from "react";
import { desktop } from "../../../shared/api";
import { UpdateController, type UpdateState } from "../updater";
export function useAppUpdates() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const controller = useRef<UpdateController | null>(null);
  useEffect(() => {
    if (!desktop || import.meta.env.TAURI_ENV_PLATFORM !== "windows") return;
    const updater = new UpdateController(setState);
    controller.current = updater;
    void updater.check();
    const timer = window.setInterval(() => void updater.check(), 4 * 3600_000);
    return () => {
      clearInterval(timer);
      updater.dispose();
      controller.current = null;
    };
  }, []);
  return {
    state,
    check: () => controller.current?.check(),
    install: () => controller.current?.install(),
    supported: desktop && import.meta.env.TAURI_ENV_PLATFORM === "windows",
  };
}
