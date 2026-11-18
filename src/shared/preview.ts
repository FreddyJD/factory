// Explicit, read-only development fixture. Never used by production desktop builds.
const project = {
  id: "preview-factory",
  name: "factory",
  path: "/Users/freddydiaz/Desktop/Git Factory",
};
const tasks = [
  {
    id: "a".repeat(32),
    title: "Add health endpoint to the API",
    workspace: project.path,
    directory: "/worktrees/health",
    status: "working",
    sessionId: "native_a",
    model: "gpt-5.6-sol",
    checkouts: [
      {
        source: project.path,
        path: "/worktrees/health",
        base: "f040ca0",
        branch: "factory/health-endpoint",
      },
    ],
  },
  {
    id: "b".repeat(32),
    title: "Handle interrupted agent sessions",
    workspace: project.path,
    directory: "/worktrees/recovery",
    status: "review",
    sessionId: "native_b",
    model: "gpt-5.6-sol",
    checkouts: [
      {
        source: project.path,
        path: "/worktrees/recovery",
        base: "f040ca0",
        branch: "factory/session-recovery",
      },
    ],
  },
];
const readme =
  "# Git Factory\n\nRepository-native development with Rust agents and isolated Git worktrees.\n\n## Development\n\n```sh\nnpm ci\nnpm run tauri dev\n```\n\n## Features\n\n- Native Rust coding tools\n- Git worktree isolation\n- MCP and ACP integrations";
export async function previewApi(
  action: string,
  args: Record<string, unknown>,
) {
  switch (action) {
    case "status":
      return {
        engine: "native-rust",
        githubClientId: null,
        providerNotice: "experimental",
        version: "preview",
        dataRoot: "/data",
        projects: [project],
        tasks,
        issues: tasks.map((task, index) => ({
          taskId: task.id,
          projectId: project.id,
          title: task.title,
          body: index
            ? "Recover stopped sessions without replaying uncertain tool calls."
            : "Add a GET /health endpoint that returns HTTP 200. Add a focused regression test.",
          createdAt: 1794930000,
          nativeEdits: true,
          autoPr: false,
          validation: "cargo test",
          outcome: index ? "completed" : "working",
          stopReason: "",
          publication: null,
        })),
      };
    case "repository_inventory":
      return {
        project,
        remote: "https://github.com/FreddyJD/factory.git",
        branches: [
          "main",
          "factory/health-endpoint",
          "factory/session-recovery",
        ],
        targets: [
          {
            id: "source",
            path: project.path,
            branch: "main",
            head: "f040ca0a1234",
            source: true,
            taskId: null,
          },
          ...tasks.map((task) => ({
            id: task.id,
            path: task.directory,
            branch: task.checkouts[0].branch,
            head: "f040ca0a1234",
            source: false,
            taskId: task.id,
          })),
        ],
      };
    case "repository_browse":
      return args.path === "README.md"
        ? {
            kind: "file",
            path: "README.md",
            content: readme,
            size: readme.length,
          }
        : {
            kind: "directory",
            path: args.path ?? "",
            entries: [
              ...[".github", "docs", "scripts", "src", "src-tauri"].map(
                (name) => ({
                  name,
                  path: name,
                  kind: "directory",
                  size: 0,
                  modified: 1794930000,
                }),
              ),
              ...[
                ".gitattributes",
                ".gitignore",
                "app-icon.svg",
                "index.html",
                "package-lock.json",
                "package.json",
                "README.md",
                "THIRD_PARTY_NOTICES.md",
                "tsconfig.json",
                "vite.config.ts",
              ].map((name) => ({
                name,
                path: name,
                kind: "file",
                size: name.length * 217,
                modified: 1794930000,
              })),
            ],
            readme: { name: "README.md", content: readme },
          };
    case "snapshot":
      return {
        queued: [],
        task: tasks.find((task) => task.id === args.taskId),
        messages: [
          {
            info: { role: "assistant", id: "1" },
            parts: [
              {
                type: "text",
                text: "I found the API route definitions and existing integration tests. I am adding a /health endpoint and a focused regression test.",
              },
              {
                id: "tool1",
                type: "tool",
                tool: "read",
                state: {
                  status: "completed",
                  title: "read",
                  input: { filePath: "api/src/routes.rs", limit: 40 },
                  output:
                    "1: pub fn routes() -> Router {\n2:     Router::new()\n3: }",
                },
              },
            ],
          },
          {
            info: { role: "assistant", id: "2" },
            parts: [
              {
                id: "tool2",
                type: "tool",
                tool: "edit",
                state: {
                  status: "completed",
                  title: "edit",
                  input: {
                    filePath: "api/src/routes.rs",
                    oldString: "Router::new()",
                    newString: 'Router::new().route("/health", get(health))',
                  },
                  output: "Added GET /health with a 200 response.",
                },
              },
            ],
          },
        ],
        permissions: [],
        questions: [],
        status: { type: "busy" },
      };
    case "project_mcp":
      return {
        filesystem: {
          type: "local",
          command: [
            "npx",
            "-y",
            "@modelcontextprotocol/server-filesystem",
            ".",
          ],
        },
      };
    case "models":
      return { all: [], connected: [] };
    case "providers":
      return [];
    case "local_reviews":
      return {
        issues: tasks.slice(1).map((task) => ({
          taskId: task.id,
          projectId: project.id,
          title: task.title,
          outcome: "completed",
          localMerge: null,
        })),
        github: true,
      };
    case "local_preview":
      return {
        taskId: args.taskId,
        title: "Handle interrupted agent sessions",
        branch: "factory/session-recovery",
        sourceRef: "refs/heads/main",
        sourceHead: "f040ca0a1234",
        head: "f040ca0a1234",
        tree: "abc123",
        diff: "diff --git a/src/session.rs b/src/session.rs\n+recover_interrupted_session();",
        mode: "fast-forward",
        validation: "cargo test",
        sourcePath: project.path,
      };
    case "pr_list":
      return [];
    case "repository_history":
      return [
        {
          sha: "f040ca0a1234",
          subject: "Use typed Windows creation flags for native process jobs",
          author: "FreddyJD",
          date: "2026-11-17T17:00:00Z",
        },
      ];
    default:
      throw Error(`Read-only development preview: ${action} is not available`);
  }
}
