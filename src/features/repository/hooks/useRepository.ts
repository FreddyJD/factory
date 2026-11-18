import { useEffect, useEffectEvent, useState } from "react";
import { api } from "../../../shared/api";
import type { Inventory, Project, Browse } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import type { FileActivity } from "./useFileActivity";
export function useRepository(
  project: Project,
  browseEnabled = true,
  activity: FileActivity[] = [],
) {
  const inventory = useResource<Inventory>(
    project.id,
    () => api("repository_inventory", { projectId: project.id }),
    browseEnabled ? 30_000 : 0,
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
  const lastWrite = Math.max(
    0,
    ...activity
      .filter(
        (item) => item.checkoutPath === target?.path && item.access === "write",
      )
      .map((item) => item.observedAt),
  );
  const refreshFiles = useEffectEvent(() => listing.refresh());
  useEffect(() => {
    if (!browseEnabled || !lastWrite) return;
    const timer = window.setTimeout(refreshFiles, 120);
    return () => clearTimeout(timer);
  }, [lastWrite, browseEnabled, target?.id]);
  function choose(id: string) {
    setChoice(id);
    setPath("");
  }
  return { inventory, target, choose, path, setPath, listing };
}
