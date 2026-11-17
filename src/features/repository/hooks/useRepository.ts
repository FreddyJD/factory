import { useState } from "react";
import { api } from "../../../shared/api";
import type { Inventory, Project, Browse } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
export function useRepository(project: Project, browseEnabled = true) {
  const inventory = useResource<Inventory>(
    project.id,
    () => api("repository_inventory", { projectId: project.id }),
    3000,
  );
  const [choice, setChoice] = useState("");
  const [path, setPath] = useState("");
  const target = choice
    ? inventory.value?.targets.find((t) => t.id === choice)
    : inventory.value?.targets.find((t) => t.source);
  const key =
    target && browseEnabled
      ? JSON.stringify([project.id, target.id, path])
      : null;
  const listing = useResource<Browse>(
    key,
    () =>
      api("repository_browse", {
        projectId: project.id,
        targetId: target!.id,
        path,
      }),
    2000,
  );
  function choose(id: string) {
    setChoice(id);
    setPath("");
  }
  return { inventory, target, choose, path, setPath, listing };
}
