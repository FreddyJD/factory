import { isTauri } from "@tauri-apps/api/core";

export function isMacDesktop() {
  return isTauri() && /Mac/.test(navigator.platform);
}
