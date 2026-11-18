import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../../shared/api";
import type { Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";

type Account = { id: string; login: string };

export function GitHubRepositorySettings({
  project,
  onRefresh,
}: {
  project?: Project;
  onRefresh: () => void;
}) {
  const accounts = useResource<Account[]>("github-accounts", () =>
    api("github_accounts"),
  );
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const formId = useId();
  useEffect(() => {
    if (notice)
      (
        panel.current?.querySelector<HTMLSelectElement>(
          "select:not(:disabled)",
        ) ?? addButton.current
      )?.focus();
  }, [notice]);
  const [autoPr, setAutoPr] = useState(
    () => localStorage.getItem("factory-auto-pr") !== "false",
  );
  async function action(operation: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setError(String(error));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      ref={panel}
      className="panel"
      aria-label="GitHub repository accounts"
    >
      <div className="panel-heading">GitHub repositories</div>
      <div className="panel-body">
        <p>
          Connect multiple github.com accounts for pull requests and automatic
          pushes. These accounts are separate from GitHub Copilot.
        </p>
        {accounts.loading && !accounts.value && (
          <p role="status">Loading repository accounts...</p>
        )}
        {accounts.value?.map((account) => (
          <div className="provider-row" key={account.id}>
            <div>
              <strong>{account.login}</strong>{" "}
              <span className="muted">github.com</span>
            </div>
            <button
              className="btn btn-default"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Remove ${account.login} from Factory? The token will not be revoked on GitHub.`,
                  )
                )
                  return;
                void action(async () => {
                  await api("github_account_remove", { id: account.id });
                  accounts.refresh();
                  setNotice("GitHub account removed.");
                });
              }}
              aria-label={`Remove GitHub account ${account.login}`}
            >
              Remove
            </button>
          </div>
        ))}
        {accounts.value?.length === 0 && (
          <p className="muted">
            No repository accounts connected. You can still use your GitHub CLI
            default.
          </p>
        )}
        <div className="button-row">
          <button
            ref={addButton}
            aria-expanded={adding}
            aria-controls={formId}
            className="btn btn-default"
            disabled={busy}
            onClick={() => {
              setAdding(!adding);
              setToken("");
            }}
          >
            {adding ? "Cancel adding account" : "Add GitHub account"}
          </button>
          <button
            className="btn btn-default"
            disabled={busy}
            onClick={accounts.refresh}
          >
            Refresh accounts
          </button>
        </div>
        {adding && (
          <form
            id={formId}
            className="provider-advanced"
            onSubmit={(event) => {
              event.preventDefault();
              if (!token.trim()) return;
              const credential = token.trim();
              setToken("");
              void action(async () => {
                await api("github_account_save", { token: credential });
                setAdding(false);
                setNotice(
                  project
                    ? "GitHub account connected. Choose it for this repository below."
                    : "GitHub account connected. Open a project to use it.",
                );
                accounts.refresh();
              });
            }}
          >
            <p>
              Sign in to the account you want to add, then create a fine-grained
              personal access token for the repositories you need. Grant{" "}
              <strong>Contents: Read and write</strong> and{" "}
              <strong>Pull requests: Read and write</strong>. Workflow changes
              also require <strong>Workflows: Read and write</strong>.
              Organization approval or SSO authorization may be required.
            </p>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api("github_token_open");
                })
              }
            >
              Create a GitHub token
            </button>
            <label>
              GitHub personal access token
              <input
                className="form-control"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <p className="muted">
              Verified with GitHub and saved only in your OS credential store.
              Adding the same account replaces its token.
            </p>
            <button
              className="btn btn-success"
              disabled={busy || !token.trim()}
            >
              {busy ? "Connecting..." : "Connect repository account"}
            </button>
          </form>
        )}
        <RepositoryAccount
          key={project?.id ?? "none"}
          project={project}
          accounts={accounts.value ?? []}
          disabled={busy || !!accounts.error || accounts.loading}
          onRefresh={onRefresh}
        />
        <p className="muted">
          A selected account is used for PRs and automatic HTTPS pushes, even
          with an SSH origin. Your origin, Git author, CLI default, and Copilot
          login are unchanged. GitHub CLI must be installed. Existing issues
          retain their authorized account; changing it requires a new issue for
          automatic publication.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={autoPr}
            onChange={(event) => {
              localStorage.setItem(
                "factory-auto-pr",
                String(event.target.checked),
              );
              setAutoPr(event.target.checked);
            }}
          />
          Automatically create a draft pull request
        </label>
        <p className="muted">
          Applies to new issues in GitHub repositories. On successful
          completion, commit and push the issue's assigned branch and open a
          draft PR. No separate validation command, force-push or merge.
        </p>
        {(error || accounts.error) && (
          <div className="alert alert-danger" role="alert">
            {error || accounts.error}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </section>
  );
}

function RepositoryAccount({
  project,
  accounts,
  disabled,
  onRefresh,
}: {
  project?: Project;
  accounts: Account[];
  disabled: boolean;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState(project?.githubAccountId ?? "");
  const [saved, setSaved] = useState(project?.githubAccountId ?? "");
  const incoming = project?.githubAccountId ?? "";
  const [observed, setObserved] = useState(incoming);
  if (observed !== incoming) {
    setObserved(incoming);
    setSaved(incoming);
    if (selected === saved) setSelected(incoming);
  }
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const [error, setError] = useState("");
  if (!project)
    return (
      <p className="muted">Open a project to choose its repository account.</p>
    );
  return (
    <form
      className="provider-advanced"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          gate.current ||
          disabled ||
          selected === saved ||
          (selected && !accounts.some((a) => a.id === selected))
        )
          return;
        gate.current = true;
        setBusy(true);
        setError("");
        void api<Project>("project_github_account", {
          projectId: project.id,
          accountId: selected || null,
        })
          .then((project) => {
            setSaved(project.githubAccountId ?? "");
            onRefresh();
          })
          .catch((error) => setError(String(error)))
          .finally(() => {
            gate.current = false;
            setBusy(false);
          });
      }}
    >
      <label>
        Repository account for {project.name}
        <select
          className="form-control"
          disabled={disabled || busy}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Use GitHub CLI default</option>
          {selected && !accounts.some((a) => a.id === selected) && (
            <option value={selected}>Saved account unavailable</option>
          )}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.login} (github.com)
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-default"
        disabled={
          disabled ||
          busy ||
          selected === saved ||
          !!(selected && !accounts.some((a) => a.id === selected))
        }
      >
        {busy ? "Saving..." : "Save repository account"}
      </button>
      {selected === "" && (
        <p className="muted">
          Uses gh's active account or inherited GH_TOKEN / GITHUB_TOKEN. Pushes
          use your existing Git credentials.
        </p>
      )}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
