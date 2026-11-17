import { invoke, isTauri } from "@tauri-apps/api/core";

export interface Repository {
  name: string;
  path: string;
  base: string;
  branch: string;
  dirty: boolean;
  remote: string | null;
}
export interface Workspace {
  path: string;
  repositories: Repository[];
  canInitialize: boolean;
}
export interface Task {
  id: string;
  title: string;
  workspace: string;
  directory: string;
  status: string;
  sessionId: string | null;
  model: string;
  checkouts: { source: string; path: string; base: string; branch: string }[];
}
export interface Permission {
  id: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}
export interface Question {
  id: string;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
}
export interface Part {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: {
    status: string;
    title?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
}
export interface Snapshot {
  error?: string;
  task: Task;
  messages: {
    info: { role: string; id: string; error?: unknown };
    parts: Part[];
  }[];
  permissions: Permission[];
  questions: Question[];
  status: { type: string };
}
export interface ProviderCatalog {
  all: {
    id: string;
    models: Record<
      string,
      { id: string; name: string; capabilities?: { toolcall?: boolean } }
    >;
  }[];
  connected: string[];
}
export interface RuntimeStatus {
  installed: boolean;
  version: string;
  tasks: Task[];
  dataRoot: string;
}

export const desktop = isTauri();
export async function api<T>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!desktop)
    throw new Error(
      "This action needs the desktop app. Run npm run tauri dev.",
    );
  return invoke<T>("factory_api", { action, args });
}

export function models(catalog: ProviderCatalog) {
  return Object.values(
    catalog.all.find((p) => p.id === "github-copilot")?.models ?? {},
  )
    .filter((m) => m.capabilities?.toolcall !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface TranscriptLine {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
}
export function transcript(snapshot: Snapshot | null): TranscriptLine[] {
  if (!snapshot) return [];
  const lines: TranscriptLine[] = [];
  for (const message of snapshot.messages) {
    if (message.info.error)
      lines.push({ kind: "error", text: JSON.stringify(message.info.error) });
    for (const part of message.parts) {
      if (part.type === "text" && part.text)
        lines.push({
          kind: message.info.role === "user" ? "user" : "assistant",
          text: part.text,
        });
      if (part.type === "tool") {
        const state = part.state;
        lines.push({
          kind: "tool",
          text: `${part.tool} / ${state?.status ?? "pending"}\n${state?.title ?? ""}${state?.output ? `\n${state.output}` : ""}${state?.error ? `\n${state.error}` : ""}`,
        });
      }
    }
  }
  return lines;
}
