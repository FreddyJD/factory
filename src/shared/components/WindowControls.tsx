import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
export function WindowControls() {
  const [error, setError] = useState("");
  const mac = /Mac/.test(navigator.platform);
  if (!isTauri()) return null;
  function run(action: "minimize" | "toggleMaximize" | "close") {
    void getCurrentWindow()
      [action]()
      .catch((error) => setError(String(error)));
  }
  return (
    <div
      className={`window-controls ${mac ? "mac-controls" : "standard-controls"}`}
      aria-label="Window controls"
    >
      <button
        aria-label="Minimize window"
        title={error || "Minimize"}
        onClick={() => run("minimize")}
      >
        −
      </button>
      <button
        aria-label="Maximize or restore window"
        title={error || "Maximize or restore"}
        onClick={() => run("toggleMaximize")}
      >
        □
      </button>
      <button
        aria-label="Close window"
        title={error || "Close"}
        onClick={() => run("close")}
      >
        ×
      </button>
    </div>
  );
}
