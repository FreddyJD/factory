import type { Project, Tab } from "../../../shared/types";
import { Icon } from "../../../shared/components/Icon";
export function ProjectSidebar({
  projects,
  selected,
  section,
  tab,
  onProject,
  onSection,
  onTab,
  onOpen,
}: {
  projects: Project[];
  selected?: string;
  section: string;
  tab: Tab;
  onProject: (id: string) => void;
  onSection: (s: "repository" | "settings") => void;
  onTab: (t: Tab) => void;
  onOpen: () => void;
}) {
  return (
    <aside className="app-sidebar">
      <nav aria-label="Application">
        <div className="sidebar-heading">
          <span>Projects</span>
          <button
            aria-label="Open project"
            title="Open project"
            onClick={onOpen}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <div key={project.id}>
              <button
                className={`sidebar-link project-link ${selected === project.id && section === "repository" ? "selected" : ""}`}
                title={project.path}
                onClick={() => onProject(project.id)}
              >
                <Icon name="repo" />
                <span>{project.name}</span>
              </button>
              {selected === project.id && (
                <div className="project-subnav">
                  {(
                    [
                      ["code", "Code"],
                      ["issues", "Issues"],
                      ["pulls", "Pull requests"],
                      ["history", "History"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      aria-current={
                        section === "repository" && tab === key
                          ? "page"
                          : undefined
                      }
                      onClick={() => {
                        onProject(project.id);
                        onTab(key);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {!projects.length && (
          <button className="sidebar-link" onClick={onOpen}>
            <Icon name="plus" />
            Open repository
          </button>
        )}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={`sidebar-link ${section === "settings" ? "selected" : ""}`}
          onClick={() => onSection("settings")}
        >
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
}
