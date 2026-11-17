import { useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import { api, desktop, preview } from "./shared/api";
import { belongs, type Tab } from "./shared/types";
import { Icon } from "./shared/components/Icon";
import { useProjects } from "./features/projects/hooks/useProjects";
import { ProjectSidebar } from "./features/projects/components/ProjectSidebar";
import { RepositoryPage } from "./features/repository/components/RepositoryPage";
import { McpSettings } from "./features/connections/components/McpSettings";
import { SettingsView } from "./features/settings/components/SettingsView";
import { useAppUpdates } from "./features/settings/hooks/useAppUpdates";

export function App() {
  const projects = useProjects();
  const [section, setSection] = useState<"repository" | "mcp" | "settings">(
    "repository",
  );
  const [tab, setTab] = useState<Tab>("code");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const openLock = useRef(false);
  const updates = useAppUpdates();
  useEffect(() => {
    const legacy = localStorage.getItem("factory-workspace");
    if (desktop && legacy && projects.status.value && !projects.projects.length)
      void api("project_register", { path: legacy })
        .then(projects.status.refresh)
        .catch(() => {});
  }, [projects.status.value?.projects.length]);
  async function open() {
    if (openLock.current) return;
    openLock.current = true;
    setOpening(true);
    setError("");
    try {
      await projects.open();
      setSection("repository");
      setTab("code");
    } catch (error) {
      setError(String(error));
    } finally {
      openLock.current = false;
      setOpening(false);
    }
  }
  function choose(id: string) {
    if (id !== projects.project?.id) setTab("code");
    projects.select(id);
    setSection("repository");
  }
  const tasks = projects.status.value?.tasks ?? [];
  const projectTasks = projects.project
    ? tasks.filter((t) => belongs(t, projects.project!))
    : [];
  return (
    <div className="application">
      <ProjectSidebar
        projects={projects.projects}
        selected={projects.project?.id}
        section={section}
        tab={tab}
        onProject={choose}
        onSection={setSection}
        onTab={setTab}
        onOpen={() => void open()}
      />
      <div className="app-content">
        <header className="global-header">
          <span className="global-breadcrumb">
            <Icon
              name={
                section === "mcp"
                  ? "mcp"
                  : section === "settings"
                    ? "settings"
                    : "repo"
              }
            />
            {section === "repository"
              ? (projects.project?.name ?? "Projects")
              : section === "mcp"
                ? "MCP"
                : "Settings"}
          </span>
          <div className="global-actions">
            <span className="muted">{version}</span>
            {preview ? (
              <span className="label">Read-only preview</span>
            ) : (
              !desktop && <span className="label">Browser preview</span>
            )}
            <button
              className="btn btn-default btn-sm"
              disabled={opening}
              onClick={() => void open()}
            >
              <Icon name="plus" />
              {opening ? "Opening…" : "Open project"}
            </button>
          </div>
        </header>
        {(error || projects.status.error) && (
          <div className="page-alert alert alert-danger" role="alert">
            {error || projects.status.error}
          </div>
        )}
        {section === "repository" ? (
          projects.project ? (
            <RepositoryPage
              key={projects.project.id}
              project={projects.project}
              tasks={projectTasks}
              issues={projects.status.value?.issues ?? []}
              tab={tab}
              setTab={setTab}
              refresh={projects.status.refresh}
              onSettings={() => setSection("settings")}
            />
          ) : (
            <main className="empty-repository">
              <Icon name="repo" size={36} />
              <h1>Open a repository</h1>
              <button
                className="btn btn-success"
                disabled={opening}
                onClick={() => void open()}
              >
                Open project
              </button>
              {!desktop && (
                <p className="muted">
                  Run <code>npm run tauri dev</code> to browse your
                  repositories.
                </p>
              )}
            </main>
          )
        ) : (
          <main className="utility-content">
            {section === "mcp" ? (
              <McpSettings
                key={projects.project?.id ?? "none"}
                project={projects.project}
                tasks={projectTasks}
              />
            ) : (
              <SettingsView
                clientId={projects.status.value?.githubClientId ?? null}
                onRefresh={projects.status.refresh}
                updates={updates}
              />
            )}
          </main>
        )}
        <footer className="app-footer">
          <span>
            <i className="connection-dot" />{" "}
            {
              tasks.filter((t) =>
                ["working", "needs-you", "publishing"].includes(t.status),
              ).length
            }{" "}
            active runs
          </span>
          <span>{projects.project?.path ?? "Git Factory"}</span>
        </footer>
      </div>
    </div>
  );
}
