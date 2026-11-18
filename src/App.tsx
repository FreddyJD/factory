import { useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import { api, desktop, preview } from "./shared/api";
import { belongs, type Tab } from "./shared/types";
import { Icon } from "./shared/components/Icon";
import { useProjects } from "./features/projects/hooks/useProjects";
import { ProjectSidebar } from "./features/projects/components/ProjectSidebar";
import { RepositoryPage } from "./features/repository/components/RepositoryPage";
import { SettingsView } from "./features/settings/components/SettingsView";
import { useAppUpdates } from "./features/settings/hooks/useAppUpdates";
import { useFileActivity } from "./features/repository/hooks/useFileActivity";
import { savedVisualization, type Visualization } from "./shared/visualization";

export function App() {
  const [visualization, setVisualization] =
    useState<Visualization>(savedVisualization);
  const [visualizing, setVisualizing] = useState(false);
  const activity = useFileActivity();
  const projects = useProjects();
  const [section, setSection] = useState<"repository" | "settings">(
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
    if (id !== projects.project?.id) {
      setTab("code");
      setVisualizing(false);
    }
    projects.select(id);
    setSection("repository");
  }
  const tasks = projects.status.value?.tasks ?? [];
  const projectTasks = projects.project
    ? tasks.filter((t) => belongs(t, projects.project!))
    : [];
  return (
    <div className="application">
      <header className="global-header">
        <span className="global-breadcrumb">
          <Icon name={section === "settings" ? "settings" : "repo"} />
          {section === "repository"
            ? (projects.project?.name ?? "factory")
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
        {(error || projects.status.error) && (
          <div className="page-alert alert alert-danger" role="alert">
            {error || projects.status.error}
          </div>
        )}
        {section === "repository" ? (
          projects.project ? (
            <RepositoryPage
              key={projects.project.id}
              visualization={visualization}
              factory={visualizing}
              setFactory={setVisualizing}
              project={projects.project}
              activity={activity}
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
            <SettingsView
              clientId={projects.status.value?.githubClientId ?? null}
              visualization={visualization}
              onVisualization={(value) => {
                try {
                  localStorage.setItem("factory-visualization", value);
                  setVisualization(value);
                } catch {
                  setError("Could not save your visualization preference.");
                }
              }}
              onRefresh={projects.status.refresh}
              updates={updates}
              project={projects.project}
              tasks={projectTasks}
            />
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
          <span>{projects.project?.path ?? "factory"}</span>
        </footer>
      </div>
    </div>
  );
}
