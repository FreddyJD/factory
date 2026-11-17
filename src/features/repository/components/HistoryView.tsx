import { api } from "../../../shared/api";
import type { Checkout, Commit, Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { Icon } from "../../../shared/components/Icon";
export function HistoryView({
  project,
  target,
}: {
  project: Project;
  target?: Checkout;
}) {
  const history = useResource<Commit[]>(
    target ? `${project.id}:${target.id}` : null,
    () =>
      api("repository_history", {
        projectId: project.id,
        targetId: target!.id,
      }),
    5000,
  );
  return (
    <section>
      <div className="section-toolbar">
        <h2>Commits</h2>
        <button className="btn btn-default" onClick={history.refresh}>
          Refresh
        </button>
      </div>
      {history.error && (
        <div className="alert alert-danger">{history.error}</div>
      )}
      {!target && (
        <div className="alert alert-warning">Select an available checkout.</div>
      )}
      <div className="panel commit-list">
        {history.value?.map((commit) => (
          <div key={commit.sha} className="commit-row">
            <Icon name="history" />
            <div>
              <strong>{commit.subject}</strong>
              <p className="muted">
                {commit.author} committed on{" "}
                {new Date(commit.date).toLocaleString()}
              </p>
            </div>
            <code>{commit.sha.slice(0, 7)}</code>
          </div>
        ))}
        {target && !history.value && !history.error && (
          <div className="loading-row">Loading commits…</div>
        )}
      </div>
    </section>
  );
}
