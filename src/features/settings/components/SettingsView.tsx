import { useEffect, useRef, useState } from "react";
import { ProviderSettings } from "./ProviderSettings";
import { version } from "../../../../package.json";
import { api, type ProviderCatalog, type Task } from "../../../shared/api";
import { useResource } from "../../../shared/hooks/useResource";
import { updateLabel } from "../updater";
import type { useAppUpdates } from "../hooks/useAppUpdates";
import type { Project } from "../../../shared/types";
import { McpSettings } from "../../connections/components/McpSettings";
import { Icon } from "../../../shared/components/Icon";
export function SettingsView({
  clientId,
  onRefresh,
  updates,
  project,
  tasks,
}: {
  clientId: string | null;
  onRefresh: () => void;
  updates: ReturnType<typeof useAppUpdates>;
  project?: Project;
  tasks: Task[];
}) {
  const [page, setPage] = useState<"general" | "mcp">("general");
  const [autoPr, setAutoPr] = useState(
    () => localStorage.getItem("factory-auto-pr") !== "false",
  );
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
  const operationGate = useRef(false);
  const [error, setError] = useState("");
  const catalog = useResource<ProviderCatalog>("settings-models", () =>
    api("models"),
  );
  const githubModels = Object.values(
    catalog.value?.all.find((provider) => provider.id === "github-copilot")
      ?.models ?? {},
  );
  const codingModels = githubModels.filter(
    (model) => model.capabilities?.toolcall === true,
  );
  async function action(operation: () => Promise<void>) {
    if (operationGate.current) return;
    operationGate.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      onRefresh();
      catalog.refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      operationGate.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-page">
      <h1>Settings</h1>
      <nav className="settings-tabs" aria-label="Settings">
        <button
          aria-current={page === "general" ? "page" : undefined}
          onClick={() => setPage("general")}
        >
          <Icon name="settings" /> General
        </button>
        <button
          aria-current={page === "mcp" ? "page" : undefined}
          onClick={() => setPage("mcp")}
        >
          <Icon name="mcp" /> MCP
        </button>
      </nav>
      {page === "mcp" ? (
        <McpSettings
          key={project?.id ?? "none"}
          project={project}
          tasks={tasks}
        />
      ) : (
        <>
          <div className="panel">
            <div className="panel-heading">GitHub Copilot</div>
            <div className="panel-body">
              <p>
                Connect your GitHub Copilot subscription with a device code.
              </p>
              <details className="provider-advanced">
                <summary>Advanced GitHub configuration</summary>
                <label>
                  OAuth client ID override
                  <input
                    className="form-control"
                    value={id}
                    onChange={(event) => {
                      touched.current = true;
                      setId(event.target.value);
                    }}
                  />
                </label>
                <p className="muted">
                  The default uses the same public device client identity as
                  Roxy. This is an experimental third-party Copilot integration,
                  not an official factory OAuth application. You can override it
                  with your registered client ID.
                </p>
              </details>
              <div className="button-row">
                <button
                  className="btn btn-success"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      if (touched.current && id.trim())
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
                  ? `${githubModels.length} GitHub models available · ${codingModels.length} support coding tools`
                  : (catalog.error ??
                    (catalog.value?.errors?.join("; ") || "Not connected"))}
              </p>
              {!!githubModels.length && (
                <details className="provider-advanced">
                  <summary>Available models</summary>
                  <ul>
                    {githubModels.map((model) => (
                      <li key={model.id}>
                        {model.name}{" "}
                        <span className="muted">
                          {model.protocol ?? "chat"}
                          {model.capabilities?.toolcall === true
                            ? ""
                            : " · no coding tools advertised"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
          <ProviderSettings onRefresh={onRefresh} />
          <div className="panel">
            <div className="panel-heading">GitHub repositories</div>
            <div className="panel-body">
              <p>
                Pull requests use your installed GitHub CLI account. Git push
                uses your configured Git credentials. These are separate from
                Copilot.
              </p>
              <code>gh auth login</code>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoPr}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    localStorage.setItem("factory-auto-pr", String(checked));
                    setAutoPr(checked);
                  }}
                />
                Automatically create a draft pull request
              </label>
              <p className="muted">
                Applies to new issues in GitHub repositories. On successful
                completion, commit and push the issue's assigned branch and open
                a draft PR using your GitHub CLI account. No separate validation
                command, force-push or merge.
              </p>
            </div>
          </div>
          <div className="panel">
            <div className="panel-heading">Application</div>
            <div className="panel-body">
              <p>factory {version}</p>
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
                          window.confirm(
                            "Stop all runs and install this update?",
                          )
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
        </>
      )}
    </section>
  );
}
