// Explicit live inference smoke: one harmless local echo call and one reply per transport.
// No filesystem, shell, MCP, Git mutation or automatic request retry is involved.
use git_factory_lib::{
    provider::{Copilot, Inference},
    runtime, wire,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), String> {
    let provider = Copilot::new(&runtime::data_root()?);
    let catalog = provider.models().await?;
    let models = catalog["all"][0]["models"]
        .as_object()
        .ok_or("No Copilot models")?;
    for protocol in ["chat", "responses", "messages"] {
        let mut candidates = models
            .values()
            .filter(|m| m["protocol"] == protocol && m["capabilities"]["toolcall"] == true)
            .collect::<Vec<_>>();
        candidates.sort_by_key(|m| {
            let id = m["id"].as_str().unwrap_or("");
            (
                if id.contains("mini") {
                    0
                } else if id.contains("4.1") {
                    1
                } else {
                    2
                },
                id.to_string(),
            )
        });
        let Some(model) = candidates.first().and_then(|m| m["id"].as_str()) else {
            continue;
        };
        let definitions = vec![
            json!({"type":"function","function":{"name":"echo","description":"Return its input text unchanged. Harmless in-memory smoke test.","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}}}),
        ];
        let mut messages = vec![
            json!({"role":"system","content":"Protocol integration test. Call echo exactly once with text native-ok, then after its result reply only native-ok. Do not request any other action."}),
            json!({"role":"user","content":"Perform the harmless echo tool test now."}),
        ];
        let mut saw_tool = false;
        let mut completed = false;
        for round in 0..3 {
            let (tx, mut rx) = mpsc::channel(64);
            let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
            let result = provider
                .complete(
                    model,
                    messages.clone(),
                    definitions.clone(),
                    None,
                    if round == 0 { "user" } else { "agent" },
                    CancellationToken::new(),
                    tx,
                )
                .await;
            drain.abort();
            let completion = result.map_err(|error| format!("{protocol} / {model}: {error}"))?;
            messages.push(wire::assistant(&completion));
            if completion.calls.is_empty() {
                if completion.reason != "stop"
                    || !saw_tool
                    || !completion.text.contains("native-ok")
                {
                    return Err(format!(
                        "{protocol} did not complete the expected tool round trip"
                    ));
                }
                completed = true;
                break;
            }
            for call in completion.calls {
                let args: Value =
                    serde_json::from_str(&call.arguments).map_err(|e| e.to_string())?;
                if call.name != "echo" || args["text"] != "native-ok" {
                    return Err("Smoke tool validation failed; no action executed".into());
                }
                saw_tool = true;
                messages.push(json!({"role":"tool","tool_call_id":call.id,"content":"native-ok"}));
            }
        }
        if !completed {
            return Err(format!("{protocol} smoke exceeded its three-request bound"));
        }
        println!("Verified {protocol} / {model}: native tool call, provider continuation, and final text.");
    }
    Ok(())
}
