import { useEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json";
import { UpdateController, updateLabel, type UpdateState } from "./updater";
import {
  api,
  desktop,
  models,
  transcript,
  type ProviderCatalog,
  type RuntimeStatus,
  type Snapshot,
  type Task,
  type Workspace,
  type TranscriptLine,
  type Question,
} from "./api";
import { FactoryCanvas } from "./factory-canvas";

export function App() {
  const [stage, setStage] = useState<
    "welcome" | "runtime" | "github" | "workspace" | "factory"
  >("welcome");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [model, setModel] = useState(
    localStorage.getItem("factory-model") ?? "",
  );
  const [login, setLogin] = useState<{
    instructions: string;
    methodIndex: number;
  } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadedSnapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [goal, setGoal] = useState("");
  const [newGoal, setNewGoal] = useState(false);
  const [tab, setTab] = useState<"activity" | "diff">("activity");
  const [diff, setDiff] = useState("");
  const [diffRevision, setDiffRevision] = useState(0);
  const [taskSearch, setTaskSearch] = useState("");
  const submission = useRef(false);
  const closing = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [integrations, setIntegrations] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpConfig, setMcpConfig] = useState(
    '{"type":"local","command":["npx","-y","@modelcontextprotocol/server-filesystem","."]}',
  );
  const [mcpStatus, setMcpStatus] = useState("");
  const [accessible, setAccessible] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const updater = useRef<UpdateController | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<FactoryCanvas | null>(null);
  const active = tasks.find(
    (t) => t.id === selected && t.workspace === workspace?.path,
  );
  const snapshot =
    loadedSnapshot?.task.id === selected && active ? loadedSnapshot : null;
  const workspaceRef = useRef(workspace?.path);
  workspaceRef.current = workspace?.path;

  async function perform(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
      if (desktop)
        void api<RuntimeStatus>("status")
          .then((state) => setTasks(state.tasks))
          .catch(() => {});
    }
  }

  function applyCatalog(value: ProviderCatalog) {
    setCatalog(value);
    const available = models(value);
    if (!available.some((m) => m.id === model))
      setModel(available[0]?.id ?? "");
  }

  useEffect(() => {
    if (!desktop) return;
    void perform("Restoring your factory", async () => {
      const state = await api<RuntimeStatus>("status");
      setRuntime(state);
      setTasks(state.tasks);
      const path = localStorage.getItem("factory-workspace");
      if (state.installed && path) {
        const ws = await api<Workspace>("workspace", { path });
        setWorkspace(ws);
        const providers = await api<ProviderCatalog>("models");
        applyCatalog(providers);
        if (providers.connected.includes("github-copilot")) setStage("factory");
      }
    });
  }, []);

  useEffect(() => {
    setSelected(null);
    setSnapshot(null);
    setLines([]);
    setDiff("");
    setGoal("");
    setNewGoal(true);
  }, [workspace?.path]);

  useEffect(() => {
    if (!desktop || stage !== "factory") return;
    const timer = window.setInterval(() => {
      void api<RuntimeStatus>("status")
        .then((state) => setTasks(state.tasks))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    if (integrations) dialog.current?.showModal();
    else dialog.current?.close();
  }, [integrations]);

  useEffect(() => {
    setDiff("");
    if (!selected || tab !== "diff") return;
    let disposed = false;
    void api<string>("diff", { taskId: selected })
      .then((value) => {
        if (!disposed) setDiff(value);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [selected, tab, diffRevision]);

  useEffect(() => {
    if (model) localStorage.setItem("factory-model", model);
  }, [model]);

  useEffect(() => {
    if (!desktop || import.meta.env.TAURI_ENV_PLATFORM !== "windows") return;
    const controller = new UpdateController(setUpdate);
    updater.current = controller;
    void controller.check();
    const timer = window.setInterval(
      () => void controller.check(),
      4 * 3600_000,
    );
    return () => {
      clearInterval(timer);
      controller.dispose();
      updater.current = null;
    };
  }, []);

  useEffect(() => {
    if (stage !== "factory" || !canvas.current) return;
    renderer.current = new FactoryCanvas(canvas.current, (id) => {
      setSelected(id);
      setNewGoal(false);
    });
    return () => {
      renderer.current?.destroy();
      renderer.current = null;
    };
  }, [stage]);

  useEffect(() => {
    const visible = tasks.filter(
      (t) =>
        (!workspace || t.workspace === workspace.path) &&
        (filter === "all" || t.status === filter),
    );
    renderer.current?.update({ tasks: visible, selected, lines, tab, diff });
  }, [tasks, workspace, filter, selected, lines, tab, diff, stage]);

  useEffect(() => {
    if (!desktop || !selected || stage !== "factory") {
      setSnapshot(null);
      setLines([]);
      return;
    }
    setSnapshot(null);
    setLines([]);
    let disposed = false;
    let running = false;
    let eventTimer = 0;
    const refresh = async () => {
      if (running || disposed || closing.current === selected) return;
      running = true;
      try {
        const value = await api<Snapshot>("snapshot", { taskId: selected });
        if (!disposed) {
          setSnapshot(value);
          setLines(
            value.error
              ? [...transcript(value), { kind: "error", text: value.error }]
              : transcript(value),
          );
          setTasks((list) =>
            list.map((t) => (t.id === selected ? value.task : t)),
          );
        }
      } catch (error) {
        if (!disposed) setError(String(error));
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const stop = listen<{ taskId: string }>("factory-event", (event) => {
      if (event.payload.taskId === selected && !eventTimer)
        eventTimer = window.setTimeout(() => {
          eventTimer = 0;
          void refresh();
        }, 120);
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(eventTimer);
      void stop.then((unlisten) => unlisten());
    };
  }, [selected, stage]);

  async function chooseFolder() {
    const value = await api<Workspace | null>("pick_folder");
    if (value) {
      setWorkspace(value);
      localStorage.setItem("factory-workspace", value.path);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workspace || !goal.trim() || busy || submission.current) return;
    submission.current = true;
    const submittedGoal = goal;
    const submittedWorkspace = workspace.path;
    await perform(
      selected && !newGoal
        ? "Sending follow-up"
        : "Preparing isolated worktrees",
      async () => {
        if (selected && !newGoal)
          await api("prompt", { taskId: selected, text: goal });
        else {
          const task = await api<Task>("create", {
            path: workspace.path,
            goal,
            model,
          });
          setTasks((list) => [...list, task]);
          if (workspaceRef.current === submittedWorkspace) {
            setSelected(task.id);
            setNewGoal(false);
          }
        }
        setGoal((current) => (current === submittedGoal ? "" : current));
      },
    );
    submission.current = false;
  }

  const connected = catalog?.connected.includes("github-copilot") ?? false;
  const availableModels = catalog ? models(catalog) : [];
  const steps = ["Welcome", "Runtime", "GitHub", "Workspace"];
  const stepIndex = ["welcome", "runtime", "github", "workspace"].indexOf(
    stage,
  );
  const visibleTasks = tasks.filter(
    (t) =>
      (!workspace || t.workspace === workspace.path) &&
      (filter === "all" || t.status === filter),
  );
  const selectableTasks = [
    ...(active ? [active] : []),
    ...visibleTasks
      .filter(
        (t) =>
          t.id !== selected &&
          t.title.toLowerCase().includes(taskSearch.toLowerCase()),
      )
      .slice(0, active ? 99 : 100),
  ];

  return (
    <div
      className={`app-shell ${stage === "factory" ? "factory-shell" : "onboarding-shell"}`}
    >
      <header>
        <div className="wordmark">
          <span className="mark" aria-hidden="true">
            F
          </span>{" "}
          Git Factory
        </div>
        <div className="header-actions">
          {stage === "factory" && (
            <>
              <button className="quiet" onClick={() => setIntegrations(true)}>
                Connections
              </button>
              <button className="quiet" onClick={() => setStage("workspace")}>
                Workspace
              </button>
              <button
                className="primary compact"
                onClick={() => {
                  setNewGoal(true);
                  setGoal("");
                }}
              >
                + New goal
              </button>
            </>
          )}
          <span className="release-label">{version} / LOCAL FIRST</span>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            Close
          </button>
        </div>
      )}
      {stage !== "factory" ? (
        <main className="onboarding">
          <nav className="steps" aria-label="Setup progress">
            {steps.map((step, index) => (
              <span
                key={step}
                aria-current={index === stepIndex ? "step" : undefined}
                className={
                  index === stepIndex
                    ? "current"
                    : index < stepIndex
                      ? "complete"
                      : ""
                }
              >
                {String(index + 1).padStart(2, "0")} {step}
              </span>
            ))}
          </nav>
          {stage === "welcome" && (
            <>
              <div className="eyebrow">LESS SUPERVISION. MORE FORWARD.</div>
              <h1>Hello, world.</h1>
              <p className="intro">
                A place to turn large engineering goals into safe, reviewable
                changes. Your repositories. Your models. A little more
                possibility.
              </p>
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => setStage("runtime")}
              >
                Build your factory <span aria-hidden="true">&rarr;</span>
              </button>
              {!desktop && (
                <p className="fine-print">
                  Browser preview. Run <code>npm run tauri dev</code> for real
                  login, Git worktrees, and code execution.
                </p>
              )}
            </>
          )}
          {stage === "runtime" && (
            <>
              <div className="eyebrow">THE TOOLS, WITHOUT THE REINVENTION</div>
              <h1>A real engine.</h1>
              <p className="intro">
                OpenCode's coding harness, managed by Rust. Its tools, prompts,
                subagents, and compaction run inside each task workspace.
              </p>
              <div className="setup-card">
                <span className="section-index">OPENCODE / 1.19.6</span>
                <p>
                  A pinned, checksum-verified download from the official
                  release. Runtime updates ship deliberately, not behind your
                  back.
                </p>
                <small>
                  MIT licensed. Copyright and license retained. Git must be
                  installed separately.
                </small>
              </div>
              <button
                className="primary"
                disabled={!!busy || !desktop}
                onClick={() =>
                  void perform(
                    "Downloading and verifying OpenCode",
                    async () => {
                      await api("install");
                      setRuntime(await api<RuntimeStatus>("status"));
                      setStage("github");
                    },
                  )
                }
              >
                {busy ||
                  (runtime?.installed
                    ? "Continue with installed runtime"
                    : "Install coding runtime")}
              </button>
            </>
          )}
          {stage === "github" && (
            <>
              <div className="eyebrow">YOUR ACCOUNT. YOUR INFERENCE.</div>
              <h1>Connect GitHub.</h1>
              <p className="intro">
                Authorize OpenCode's GitHub Copilot integration in your browser.
                Credentials stay in Factory's private runtime profile, not in
                your repositories.
              </p>
              <p className="fine-print">
                This connects Copilot inference. It does not grant Git Factory
                repository write access or publish changes. Model availability
                depends on your subscription and organization policy.
              </p>
              {!login ? (
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(
                        "Requesting GitHub device code",
                        async () => {
                          setLogin(await api("login_start"));
                        },
                      )
                    }
                  >
                    {busy || "Sign in with GitHub"}
                  </button>
                  <button
                    className="quiet"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("Checking Copilot connection", async () => {
                        applyCatalog(await api<ProviderCatalog>("models"));
                      })
                    }
                  >
                    Check existing connection
                  </button>
                </div>
              ) : (
                <div className="setup-card device-card">
                  <span className="section-index">
                    GITHUB DEVICE AUTHORIZATION
                  </span>
                  <pre>{login.instructions}</pre>
                  <div className="button-row">
                    <button
                      className="primary compact"
                      onClick={() =>
                        void perform("Opening GitHub", async () => {
                          await api("login_open");
                        })
                      }
                    >
                      Open GitHub
                    </button>
                    <button
                      className="quiet"
                      disabled={!!busy}
                      onClick={() =>
                        void perform(
                          "Waiting for GitHub approval",
                          async () => {
                            applyCatalog(
                              await api<ProviderCatalog>("login_finish", {
                                method: login.methodIndex,
                              }),
                            );
                            setLogin(null);
                          },
                        )
                      }
                    >
                      {busy || "I've authorized it"}
                    </button>
                  </div>
                </div>
              )}
              {connected && (
                <div className="connection-ready">
                  <span className="status-dot" /> Copilot credential connected.
                  The first coding request verifies inference access.
                  <label>
                    Model
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary compact"
                    disabled={!model}
                    onClick={() => setStage("workspace")}
                  >
                    Continue
                  </button>
                </div>
              )}
            </>
          )}
          {stage === "workspace" && (
            <>
              <div className="eyebrow">A HOME FOR THE WORK</div>
              <h1>Open possibilities.</h1>
              <p className="intro">
                Choose a repository, a folder of repositories, or an empty
                folder. Your original files stay where they are. Tasks get their
                own Git worktrees.
              </p>
              <button
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void perform("Discovering repositories", chooseFolder)
                }
              >
                Choose a folder <span aria-hidden="true">&rarr;</span>
              </button>
              {workspace && (
                <div className="setup-card workspace-card">
                  <code>{workspace.path}</code>
                  {workspace.repositories.map((repo) => (
                    <div className="repo" key={repo.path}>
                      <strong>{repo.name}</strong>
                      <span>
                        {repo.branch} / {repo.base.slice(0, 8)}
                        {repo.dirty
                          ? " / uncommitted changes stay untouched"
                          : ""}
                      </span>
                    </div>
                  ))}
                  {!workspace.repositories.length && (
                    <p>
                      {workspace.canInitialize
                        ? "This folder is empty. Initialize Git with an empty first commit? No files will be staged."
                        : "No repositories found. Existing files will not be automatically committed. Initialize and commit them with Git, then choose the folder again."}
                    </p>
                  )}
                  {workspace.canInitialize && (
                    <button
                      className="quiet"
                      onClick={() =>
                        void perform(
                          "Initializing empty repository",
                          async () => {
                            setWorkspace(
                              await api("initialize", { path: workspace.path }),
                            );
                          },
                        )
                      }
                    >
                      Initialize Git in this empty folder
                    </button>
                  )}
                  {workspace.repositories.length > 0 && (
                    <>
                      <p className="fine-print">
                        Tasks start from each repository's current committed
                        HEAD. Dirty and untracked source files are not copied.
                        Worktrees are not a security sandbox; approve shell
                        commands and MCP servers only when trusted.
                      </p>
                      <button
                        className="primary compact"
                        onClick={() => {
                          setStage("factory");
                          setNewGoal(true);
                        }}
                      >
                        Open factory
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {stage !== "welcome" && (
            <button
              className="text-button back"
              disabled={!!busy}
              onClick={() =>
                setStage(
                  (["welcome", "runtime", "github", "workspace"] as const)[
                    Math.max(0, stepIndex - 1)
                  ],
                )
              }
            >
              Back
            </button>
          )}
        </main>
      ) : (
        <main className="factory-main">
          <div className="workspace-bar">
            <div>
              <span className="section-index">WORKSPACE</span>
              <h2>{workspace?.path.split(/[\\/]/).pop() || "Your factory"}</h2>
            </div>
            <div className="filters" aria-label="Filter work">
              {[
                ["all", "All work"],
                ["needs-you", "Needs you"],
                ["review", "Review"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                  {value !== "all" &&
                    ` ${tasks.filter((t) => t.workspace === workspace?.path && t.status === value).length}`}
                </button>
              ))}
            </div>
            <span className="execution-note">LOCAL EXECUTION / 4 SLOTS</span>
          </div>
          <div className="canvas-toolbar">
            <div className="tabs">
              <button
                aria-pressed={tab === "activity"}
                onClick={() => setTab("activity")}
              >
                Activity
              </button>
              <button
                aria-pressed={tab === "diff"}
                onClick={() => {
                  setTab("diff");
                  setDiffRevision((v) => v + 1);
                }}
              >
                Changes
              </button>
            </div>
            {active && (
              <div className="button-row">
                <button
                  className="quiet"
                  onClick={() =>
                    void perform("Opening worktree", async () => {
                      await api("open_worktree", { taskId: selected });
                    })
                  }
                >
                  Open worktree
                </button>
                <button
                  className="quiet"
                  onClick={() =>
                    void perform("Stopping task", async () => {
                      await api("cancel", { taskId: selected });
                    })
                  }
                >
                  Stop
                </button>
                <button
                  className="quiet"
                  onClick={() => {
                    const id = selected;
                    closing.current = id;
                    setSelected(null);
                    void perform("Closing worker; keeping files", async () => {
                      try {
                        await api("close", { taskId: id });
                      } finally {
                        closing.current = null;
                      }
                    });
                  }}
                >
                  Close worker
                </button>
              </div>
            )}
          </div>
          <div className="canvas-region">
            <canvas
              ref={canvas}
              tabIndex={0}
              role="region"
              aria-label="Factory worklist and execution journal. Arrow keys select tasks. Page Up and Page Down scroll the journal."
            />
            <div className="sr-only" aria-live="polite">
              {active
                ? `${active.title}: ${active.status}`
                : "No task selected"}
            </div>
          </div>
          <div className="accessibility-row">
            <label>
              <input
                aria-label="Find a task"
                placeholder="Find a task..."
                value={taskSearch}
                onChange={(e) => setTaskSearch(e.target.value)}
              />
              <select
                aria-label="Select a task"
                value={selected ?? ""}
                onChange={(e) => {
                  setSelected(e.target.value || null);
                  setNewGoal(false);
                }}
              >
                <option value="">Choose task</option>
                {selectableTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title.slice(0, 80)} / {task.status}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="text-button"
              onClick={() => setAccessible((v) => !v)}
            >
              {accessible ? "Close text view" : "Accessible text / copy"}
            </button>
          </div>
          {accessible && (
            <textarea
              className="text-transcript"
              aria-label="Selectable execution journal"
              readOnly
              value={
                tab === "diff"
                  ? diff
                  : lines
                      .map((l) => `${l.kind.toUpperCase()}\n${l.text}`)
                      .join("\n\n")
              }
            />
          )}
          {!!snapshot?.permissions.length && (
            <section className="approval" aria-label="Tool permission requests">
              {snapshot.permissions.map((permission) => (
                <div key={permission.id}>
                  <span className="section-index">
                    NEEDS YOUR APPROVAL / {permission.permission}
                  </span>
                  <pre>{permission.patterns.join("\n")}</pre>
                  <details>
                    <summary>Inspect proposed action and arguments</summary>
                    <pre>{JSON.stringify(permission.metadata, null, 2)}</pre>
                  </details>
                  <div className="button-row">
                    <button
                      className="primary compact"
                      disabled={!!busy}
                      onClick={() =>
                        void perform("Approving once", async () => {
                          await api("permission", {
                            taskId: selected,
                            requestId: permission.id,
                            allow: true,
                          });
                        })
                      }
                    >
                      Allow once
                    </button>
                    <button
                      className="quiet"
                      disabled={!!busy}
                      onClick={() =>
                        void perform("Rejecting tool call", async () => {
                          await api("permission", {
                            taskId: selected,
                            requestId: permission.id,
                            allow: false,
                          });
                        })
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {snapshot?.questions.map((question) => (
            <QuestionForm
              key={question.id}
              request={question}
              disabled={!!busy}
              answer={(answers) =>
                void perform("Answering question", async () => {
                  await api("question", {
                    taskId: selected,
                    requestId: question.id,
                    answers,
                  });
                })
              }
            />
          ))}
          <form className="composer" onSubmit={(event) => void submit(event)}>
            <div className="composer-label">
              <span className="section-index">
                {newGoal || !selected
                  ? "WHAT SHOULD WE BUILD?"
                  : "CONTINUE THIS TASK"}
              </span>
              <select
                aria-label="Copilot model"
                value={selected && !newGoal ? (active?.model ?? model) : model}
                disabled={!!selected && !newGoal}
                title={
                  selected && !newGoal
                    ? "Model is fixed for this task"
                    : "Model for the new task"
                }
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Select a model</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              aria-label={
                newGoal || !selected ? "New goal" : "Follow-up prompt"
              }
              placeholder="Describe the outcome, constraints, and what done looks like..."
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-bottom">
              <small>
                Worktree-local. Edits and shell commands ask first. No automatic
                push.
              </small>
              <button
                className="primary compact"
                disabled={
                  !!busy || !goal.trim() || ((newGoal || !selected) && !model)
                }
              >
                {busy ||
                  (newGoal || !selected
                    ? "Start isolated task"
                    : "Send follow-up")}
              </button>
            </div>
          </form>
        </main>
      )}
      {integrations && (
        <dialog
          ref={dialog}
          onCancel={() => setIntegrations(false)}
          aria-labelledby="connections-title"
          className="connections"
        >
          <div className="dialog-heading">
            <h2 id="connections-title">Connections</h2>
            <button className="quiet" onClick={() => setIntegrations(false)}>
              Close
            </button>
          </div>
          <p>
            Connect trusted MCP tools to the selected task. Local servers start
            in its worktree but have your account's filesystem and network
            privileges.
          </p>
          <label>
            Server name
            <input
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
            />
          </label>
          <label>
            OpenCode MCP configuration
            <textarea
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
              spellCheck={false}
              rows={6}
            />
          </label>
          <button
            className="primary compact"
            disabled={!selected || !mcpName || !!busy}
            onClick={() =>
              void perform("Connecting MCP server", async () => {
                const result = await api("mcp_add", {
                  taskId: selected,
                  name: mcpName,
                  config: JSON.parse(mcpConfig),
                });
                setMcpStatus(JSON.stringify(result, null, 2));
              })
            }
          >
            Trust and connect to task
          </button>
          {!selected && <p>Select a task first.</p>}
          <pre>{mcpStatus}</pre>
          <hr />
          <h3>Connect another editor</h3>
          <p>
            Build <code>factory-cli</code>, prepare a task, open its worktree in
            your ACP editor, and configure:
          </p>
          <pre>{`factory-cli --acp --task ${selected ?? "TASK_ID"}`}</pre>
          <p>Expose this workspace to an MCP client:</p>
          <pre>{`factory-cli --mcp --workspace "${workspace?.path ?? "/repository"}"`}</pre>
          <small>
            The MCP server is read-only unless launched with{" "}
            <code>--allow-execution</code>. ACP uses protocol v1. Factory MCP
            supports 2026-07-28 plus explicit legacy revisions. See
            docs/protocols.md.
          </small>
        </dialog>
      )}
      <footer>
        <div className="update-status" role="status">
          <span className="status-dot" />
          {busy ||
            (desktop
              ? "RUST CORE / OPENCODE HARNESS"
              : "BROWSER PREVIEW / DESKTOP REQUIRED FOR EXECUTION")}
        </div>
        {updater.current &&
          (update.status === "ready" ? (
            <button
              className="text-button"
              disabled={tasks.some(
                (t) => t.status === "working" || t.status === "needs-you",
              )}
              onClick={() => void updater.current?.install()}
            >
              Install {update.version} and restart
            </button>
          ) : (
            <button
              className="text-button"
              onClick={() => void updater.current?.check()}
            >
              {updateLabel(update)}
            </button>
          ))}
      </footer>
    </div>
  );
}

function QuestionForm({
  request,
  answer,
  disabled,
}: {
  request: Question;
  answer: (answers: string[][] | null) => void;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<string[][]>(
    request.questions.map(() => []),
  );
  return (
    <form
      className="approval"
      onSubmit={(e) => {
        e.preventDefault();
        answer(answers);
      }}
    >
      {request.questions.map((question, index) => (
        <fieldset key={index}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label className="question-option" key={option.label}>
              <input
                type={question.multiple ? "checkbox" : "radio"}
                name={`question-${index}`}
                checked={answers[index].includes(option.label)}
                onChange={(e) =>
                  setAnswers((current) =>
                    current.map((a, i) =>
                      i !== index
                        ? a
                        : question.multiple
                          ? e.target.checked
                            ? [...a, option.label]
                            : a.filter((v) => v !== option.label)
                          : [option.label],
                    ),
                  )
                }
              />
              {option.label}
              <small>{option.description}</small>
            </label>
          ))}
          {question.custom !== false && (
            <input
              aria-label="Custom answer"
              placeholder="Or type an answer"
              onChange={(e) =>
                setAnswers((current) =>
                  current.map((a, i) => (i === index ? [e.target.value] : a)),
                )
              }
            />
          )}
        </fieldset>
      ))}
      <div className="button-row">
        <button
          className="primary compact"
          disabled={disabled || answers.some((a) => !a.length)}
        >
          Answer
        </button>
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={() => answer(null)}
        >
          Dismiss
        </button>
      </div>
    </form>
  );
}
