import { useEffect, useState } from "react";
import { api, desktop } from "../../../shared/api";
import type { Project, Status } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
export function useProjects() {
  const status = useResource<Status>(
    desktop ? "factory-status" : null,
    () => api("status"),
    2500,
  );
  const [selected, setSelected] = useState(
    localStorage.getItem("factory-project") ?? "",
  );
  const [opened, setOpened] = useState<Project[] | null>(null);
  const projects = opened ?? status.value?.projects ?? [];
  useEffect(() => {
    if (
      opened &&
      status.value?.projects &&
      opened.every((p) => status.value!.projects.some((s) => s.id === p.id))
    )
      setOpened(null);
  }, [status.value]);
  useEffect(() => {
    if (projects.length && !projects.some((p) => p.id === selected)) {
      setSelected(projects[0].id);
    }
  }, [projects, selected]);
  useEffect(() => {
    if (selected) localStorage.setItem("factory-project", selected);
  }, [selected]);
  async function open() {
    const projects = await api<{
      projects: Project[];
      selected: string;
    } | null>("project_open");
    if (projects) {
      setOpened(projects.projects);
      setSelected(projects.selected);
      status.refresh();
    }
  }
  return {
    projects,
    project: projects.find((p) => p.id === selected),
    select: setSelected,
    open,
    status,
  };
}
