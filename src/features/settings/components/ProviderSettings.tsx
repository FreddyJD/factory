import { useRef, useState } from "react";
import { api } from "../../../shared/api";
import { useResource } from "../../../shared/hooks/useResource";
interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  context: number;
  hasKey: boolean;
}
export function ProviderSettings({ onRefresh }: { onRefresh: () => void }) {
  const list = useResource<Endpoint[]>("provider-connections", () =>
    api("providers"),
  );
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [context, setContext] = useState(32000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  function reset() {
    setId(null);
    setName("");
    setBase("https://api.openai.com/v1");
    setModel("");
    setKey("");
    setClearKey(false);
    setContext(32000);
  }
  async function action(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
      list.refresh();
      onRefresh();
    } catch (error) {
      setError(String(error));
    } finally {
      list.refresh();
      onRefresh();
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      <div className="panel-heading">OpenAI-compatible endpoints</div>
      <div className="panel-body">
        {list.value?.map((endpoint) => (
          <div className="provider-row" key={endpoint.id}>
            <div>
              <strong>{endpoint.name}</strong>
              <p className="muted">
                {endpoint.baseUrl} · {endpoint.modelId}
              </p>
            </div>
            <div className="button-row">
              <button
                className="btn btn-default btn-sm"
                disabled={busy}
                onClick={() => {
                  setId(endpoint.id);
                  setName(endpoint.name);
                  setBase(endpoint.baseUrl);
                  setModel(endpoint.modelId);
                  setContext(endpoint.context);
                  setKey("");
                  setClearKey(false);
                }}
              >
                Edit
              </button>
              <button
                className="btn btn-default btn-sm"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await api<{ message: string }>(
                      "provider_check",
                      { id: endpoint.id },
                    );
                    setMessage(result.message);
                  })
                }
              >
                Test connection
              </button>
              <button
                className="btn btn-default btn-sm"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${endpoint.name}? Existing issues using it will stop making new requests.`,
                    )
                  )
                    void action(async () => {
                      await api("provider_remove", { id: endpoint.id });
                      if (id === endpoint.id) reset();
                    });
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api("provider_save", {
                id: id ?? undefined,
                name: name || "OpenAI compatible",
                baseUrl: base,
                modelId: model,
                apiKey: key || undefined,
                clearKey,
                context,
              });
              setMessage(
                "Connection saved. Select this model when creating an issue.",
              );
              reset();
            });
          }}
        >
          <h3>{id ? "Edit endpoint" : "Add endpoint"}</h3>
          <label>
            Connection name
            <input
              className="form-control"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Local model or API provider"
            />
          </label>
          <label>
            API base URL
            <input
              className="form-control"
              disabled={!!id}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              required
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <label>
            API key{" "}
            <span className="muted">
              Optional for local endpoints. Leave blank to keep an existing key.
            </span>
            <input
              type="password"
              autoComplete="off"
              className="form-control"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          {id && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              Remove saved API key
            </label>
          )}
          <label>
            Model ID
            <input
              className="form-control"
              disabled={!!id}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
              placeholder="Exact model ID from your provider"
            />
          </label>
          <label>
            Context tokens
            <input
              type="number"
              min={16384}
              max={1000000}
              className="form-control"
              value={context}
              onChange={(event) => setContext(Number(event.target.value))}
            />
          </label>
          <p className="muted">
            Requires streaming Chat Completions with function/tool calls. HTTPS,
            or HTTP on localhost. Include the API prefix, such as /v1. Keys stay
            in the OS credential store.
          </p>
          <div className="button-row">
            <button
              className="btn btn-success"
              disabled={busy || !base || !model}
            >
              {busy ? "Saving…" : "Save endpoint"}
            </button>
            {id && (
              <button type="button" className="btn btn-default" onClick={reset}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
        {(error || list.error) && (
          <div className="alert alert-danger" role="alert">
            {error || list.error}
          </div>
        )}
        {message && (
          <div className="alert alert-success" role="status">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
