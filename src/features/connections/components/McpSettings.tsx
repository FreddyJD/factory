import { useRef, useState } from "react";
import { api, type Task } from "../../../shared/api";
import type { Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { Icon } from "../../../shared/components/Icon";
export function McpSettings({
  project,
  tasks,
}: {
  project?: Project;
  tasks: Task[];
}) {
  const configs = useResource<Record<string, unknown>>(
    project?.id ?? null,
    () => api("project_mcp", { projectId: project!.id }),
  );
  const [name, setName] = useState("");
  const [config, setConfig] = useState(
    '{"type":"local","command":["npx","-y","@modelcontextprotocol/server-filesystem","."]}',
  );
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState("");
  const lock = useRef(false);
  async function mutate(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!project || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api("project_mcp_save", {
        projectId: project.id,
        name,
        config: JSON.parse(config),
      });
      configs.refresh();
      setName("");
    } catch (error) {
      setError(String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-page">
      <div className="section-toolbar">
        <h1>MCP</h1>
        {project && <span className="muted">{project.name}</span>}
      </div>
      <p>
        Project servers connect when a new issue starts. Local servers run with
        your account's permissions.
      </p>
      {!project ? (
        <div className="alert alert-info">Open a project first.</div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-heading">
              <strong>Servers</strong>
            </div>
            {Object.entries(configs.value ?? {}).map(([name, value]) => (
              <div className="mcp-row" key={name}>
                <Icon name="mcp" />
                <div>
                  <strong>{name}</strong>
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                </div>
                <button
                  className="btn btn-default btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${name} from new issues?`))
                      void mutate(async () => {
                        await api("project_mcp_save", {
                          projectId: project.id,
                          name,
                          config: null,
                        });
                        configs.refresh();
                      });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            {configs.value && Object.keys(configs.value).length === 0 && (
              <div className="panel-body muted">No servers configured.</div>
            )}
          </div>
          <div className="panel">
            <div className="panel-heading">Add MCP server</div>
            <div className="panel-body">
              <label>
                Server name
                <input
                  className="form-control"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Configuration
                <textarea
                  className="form-control config-editor"
                  rows={6}
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button
                className="btn btn-success"
                disabled={busy || !name.trim()}
                onClick={() => void save()}
              >
                Trust and save server
              </button>
            </div>
          </div>
          <div className="panel">
            <div className="panel-heading">Connect to an existing issue</div>
            <div className="panel-body">
              <label>
                Issue
                <select value={task} onChange={(e) => setTask(e.target.value)}>
                  <option value="">Select issue</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                {Object.entries(configs.value ?? {}).map(([name, value]) => (
                  <button
                    className="btn btn-default"
                    key={name}
                    disabled={!task || busy}
                    onClick={() => {
                      void mutate(async () => {
                        await api("mcp_add", {
                          taskId: task,
                          name,
                          config: value,
                        });
                        setConnected(`${name} connected`);
                      });
                    }}
                  >
                    Connect {name}
                  </button>
                ))}
              </div>
              {connected && <p className="text-success">{connected}</p>}
            </div>
          </div>
        </>
      )}
      {(error || configs.error) && (
        <div className="alert alert-danger" role="alert">
          {error || configs.error}
        </div>
      )}
    </section>
  );
}
