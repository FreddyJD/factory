import { useEffect, useRef, useState } from "react";
import { version } from "../../../../package.json";
import { api, models, type ProviderCatalog } from "../../../shared/api";
import { useResource } from "../../../shared/hooks/useResource";
import { updateLabel } from "../updater";
import type { useAppUpdates } from "../hooks/useAppUpdates";
export function SettingsView({
  clientId,
  onRefresh,
  updates,
}: {
  clientId: string | null;
  onRefresh: () => void;
  updates: ReturnType<typeof useAppUpdates>;
}) {
  const [id, setId] = useState(clientId ?? "");
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setId(clientId ?? "");
  }, [clientId]);
  const [login, setLogin] = useState<{
    attemptId: string;
    instructions: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const catalog = useResource<ProviderCatalog>("settings-models", () =>
    api("models"),
  );
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      onRefresh();
      catalog.refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-page">
      <h1>Settings</h1>
      <div className="panel">
        <div className="panel-heading">GitHub Copilot</div>
        <div className="panel-body">
          <label>
            GitHub OAuth client ID
            <input
              className="form-control"
              value={id}
              onChange={(e) => {
                touched.current = true;
                setId(e.target.value);
              }}
            />
          </label>
          <p className="muted">
            Use your GitHub OAuth app with device flow enabled. Credentials are
            stored in the OS credential store. Direct Copilot HTTP inference is
            experimental.
          </p>
          <div className="button-row">
            <button
              className="btn btn-success"
              disabled={busy || !id.trim()}
              onClick={() =>
                void action(async () => {
                  await api("configure_github", { clientId: id.trim() });
                  setLogin(await api("login_start"));
                })
              }
            >
              Sign in with GitHub
            </button>
            <button
              className="btn btn-default"
              disabled={busy}
              onClick={catalog.refresh}
            >
              Check connection
            </button>
          </div>
          {login && (
            <div className="device-login">
              <pre>{login.instructions}</pre>
              <div className="button-row">
                <button
                  className="btn btn-default"
                  onClick={() =>
                    void action(async () => {
                      await api("login_open");
                    })
                  }
                >
                  Open GitHub
                </button>
                <button
                  className="btn btn-success"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      try {
                        await api("login_finish", {
                          attemptId: login.attemptId,
                        });
                      } finally {
                        setLogin(null);
                      }
                    })
                  }
                >
                  I've authorized it
                </button>
              </div>
            </div>
          )}
          <p className="muted">
            {catalog.value?.connected.includes("github-copilot")
              ? `${models(catalog.value).length} models available`
              : (catalog.error ?? "Not connected")}
          </p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">GitHub repositories</div>
        <div className="panel-body">
          <p>
            Pull requests use your installed GitHub CLI account. Git push uses
            your configured Git credentials. These are separate from Copilot.
          </p>
          <code>gh auth login</code>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">Application</div>
        <div className="panel-body">
          <p>Git Factory {version}</p>
          {updates.supported ? (
            <div className="button-row">
              <span>{updateLabel(updates.state)}</span>
              <button
                className="btn btn-default"
                onClick={() => void updates.check()}
              >
                Check for updates
              </button>
              {updates.state.status === "ready" && (
                <button
                  className="btn btn-success"
                  onClick={() => {
                    if (
                      window.confirm("Stop all runs and install this update?")
                    )
                      void updates.install();
                  }}
                >
                  Install and restart
                </button>
              )}
            </div>
          ) : (
            <p className="muted">
              Windows releases include signed automatic updates.
            </p>
          )}
        </div>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
