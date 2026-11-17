import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { version } from "../package.json";
import { UpdateController, updateLabel, type UpdateState } from "./updater";

export function App() {
  const [continued, setContinued] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const updater = useRef<UpdateController | null>(null);
  const desktop = isTauri() && import.meta.env.TAURI_ENV_PLATFORM === "windows";
  const updateAvailability = isTauri() ? "Source build / updates available on Windows" : "Browser preview / updates available in the desktop app";

  useEffect(() => {
    if (!desktop) return;
    const controller = new UpdateController(setUpdate);
    updater.current = controller;
    void controller.check();
    const timer = window.setInterval(() => void controller.check(), 4 * 60 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
      controller.dispose();
      updater.current = null;
    };
  }, [desktop]);

  return (
    <div className="app-shell">
      <header>
        <div className="wordmark"><span className="mark" aria-hidden="true">F</span> Git Factory</div>
        <span className="release-label">FOUNDATION / {version}</span>
      </header>
      <main>
        <div className="eyebrow">A LITTLE STRUCTURE. A LOT OF POSSIBILITY.</div>
        <h1>{continued ? "Room for big things." : "Hello, world."}</h1>
        <p className="intro">
          {continued
            ? "One workspace for your repositories. One clear path from a large goal to changes you can trust."
            : "Big ideas. Small, deliberate changes. Welcome to your software factory."}
        </p>
        {continued ? (
          <section className="foundation" aria-labelledby="foundation-title">
            <span className="section-index">01 / THE FOUNDATION</span>
            <h2 id="foundation-title">The delivery line is in place.</h2>
            <p>This first release establishes the desktop app and signed updates. GitHub sign-in, repository workspaces, and agent execution are next. They are not connected yet.</p>
            <button className="text-button" onClick={() => setContinued(false)}>Back to welcome</button>
          </section>
        ) : (
          <button className="primary" onClick={() => setContinued(true)}>
            Continue <span aria-hidden="true">&rarr;</span>
          </button>
        )}
      </main>
      <footer>
        <div className="update-status" role="status" aria-live="polite">
          <span className={`status-dot ${update.status === "error" ? "warning" : ""}`} aria-hidden="true" />
          {desktop ? updateLabel(update) : updateAvailability}
        </div>
        {desktop && (update.status === "ready" ? (
          <button className="text-button" onClick={() => void updater.current?.install()}>
            Install and restart
          </button>
        ) : ["idle", "current", "error"].includes(update.status) ? (
          <button className="text-button" onClick={() => void updater.current?.check()}>
            {update.status === "error" ? "Retry update" : "Check for updates"}
          </button>
        ) : null)}
      </footer>
    </div>
  );
}
