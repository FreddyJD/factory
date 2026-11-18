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
  name?: string;
  dataUrl?: string;
  tool?: string;
  state?: {
    status: string;
    title?: string;
    input?: unknown;
    output?: string | null;
    error?: string | null;
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
      {
        id: string;
        name: string;
        protocol?: "chat" | "responses" | "messages";
        capabilities?: { toolcall?: boolean; vision?: boolean | null };
      }
    >;
  }[];
  connected: string[];
  errors?: string[];
}
export interface RuntimeStatus {
  engine: "native-rust";
  githubClientId: string | null;
  providerNotice: string;
  version: string;
  tasks: Task[];
  dataRoot: string;
}

export const preview =
  import.meta.env.DEV &&
  !isTauri() &&
  new URLSearchParams(location.search).get("preview") === "1";
export const desktop = isTauri() || preview;
export async function api<T>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (preview) {
    const { previewApi } = await import("./preview");
    return (await previewApi(action, args)) as T;
  }
  if (!desktop)
    throw new Error(
      "This action needs the desktop app. Run npm run tauri dev.",
    );
  return invoke<T>("factory_api", { action, args });
}

export function models(catalog: ProviderCatalog) {
  return catalog.all
    .flatMap((provider) => Object.values(provider.models))
    .filter((model) => model.capabilities?.toolcall !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type TranscriptLine = {
  id: string;
  text: string;
  image?: { name: string; dataUrl: string };
} & (
  | { kind: "user" | "assistant" | "error" }
  | {
      kind: "tool";
      tool: {
        name: string;
        status: string;
        title?: string;
        input?: unknown;
        output?: string | null;
        error?: string | null;
      };
    }
);
export function transcript(snapshot: Snapshot | null): TranscriptLine[] {
  if (!snapshot) return [];
  const lines: TranscriptLine[] = [];
  for (const message of snapshot.messages) {
    if (message.info.error)
      lines.push({
        id: `${message.info.id}:error`,
        kind: "error",
        text: JSON.stringify(message.info.error),
      });
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.info.id}:${part.id ?? index}`;
      if (part.type === "image" && part.dataUrl)
        lines.push({
          id,
          kind: "user",
          text: `[Image: ${part.name ?? "Attached image"}]`,
          image: { name: part.name ?? "Attached image", dataUrl: part.dataUrl },
        });
      if (part.type === "text" && part.text)
        lines.push({
          id,
          kind: message.info.role === "user" ? "user" : "assistant",
          text: part.text,
        });
      if (part.type === "tool") {
        const state = part.state;
        const name = part.tool ?? "Tool";
        const status = state?.status ?? "pending";
        const sections = [name + " / " + status];
        if (state?.title && state.title !== name) sections.push(state.title);
        if (state?.input !== undefined)
          sections.push("Input\n" + JSON.stringify(state.input, null, 2));
        if (state?.output != null)
          sections.push("Output\n" + (state.output || "(empty output)"));
        if (state?.error != null) sections.push("Error\n" + state.error);
        lines.push({
          id,
          kind: "tool",
          text: sections.join("\n\n"),
          tool: {
            name,
            status,
            title: state?.title,
            input: state?.input,
            output: state?.output,
            error: state?.error,
          },
        });
      }
    }
  }
  return lines;
}
