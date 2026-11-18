use git_factory_lib::{
    provider::{self, Copilot, Model},
    runtime::{self, Factory},
    tools, workspace,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Scripted(AtomicUsize);
impl provider::Inference for Scripted {
    fn complete<'a>(
        &'a self,
        _: &'a str,
        messages: Vec<Value>,
        _: Vec<Value>,
        _: Option<usize>,
        _: &'a str,
        _: CancellationToken,
        _: mpsc::Sender<String>,
    ) -> futures_util::future::BoxFuture<'a, provider::InferenceResult> {
        Box::pin(async move {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(provider::Completion {
                    calls: vec![provider::ToolCall {
                        id: "mcp-call".into(),
                        name: "mcp_fixture_factory_workspace".into(),
                        arguments: "{}".into(),
                    }],
                    reason: "tool_calls".into(),
                    ..Default::default()
                })
            } else {
                assert!(messages.iter().any(|m| m["role"] == "tool"
                    && m["content"]
                        .as_str()
                        .is_some_and(|s| s.contains("repositories"))));
                Ok(provider::Completion {
                    reason: "stop".into(),
                    ..Default::default()
                })
            }
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let root = runtime::data_root()?;
    let source = root.join("native-mcp-source");
    if !source.exists() {
        std::fs::create_dir(&source).map_err(|e| e.to_string())?;
        workspace::initialize_empty(&source)?;
    }
    let factory = Factory::with_provider(
        root.clone(),
        Arc::new(Copilot::new(&root)),
        Arc::new(Scripted(AtomicUsize::new(0))),
    );
    let task = factory
        .prepare(&source, "Native MCP smoke", "fixture-model")
        .await?;
    let cli = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .and_then(|p| p.parent())
        .ok_or("Missing target directory")?
        .join(if cfg!(windows) {
            "factory-cli.exe"
        } else {
            "factory-cli"
        });
    let status=factory.mcp(&task.id,"fixture",json!({"type":"local","command":[cli,"--mcp","--workspace",source],"environment":{"GIT_FACTORY_DATA_DIR":root}})).await?;
    assert_eq!(status["fixture"]["status"], "connected");
    let session = factory.worker(&task.id).await?;
    let mut events = factory.events.subscribe();
    factory
        .prompt_with_model(
            &task.id,
            "Inspect the workspace",
            Model {
                id: "fixture-model".into(),
                name: "Fixture".into(),
                context: 32_000,
            },
        )
        .await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        while session.busy().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "MCP agent turn did not complete without approval")?;
    let snapshot = factory.snapshot(&task.id).await?;
    assert_eq!(snapshot["task"]["status"], "review", "{snapshot}");
    assert_eq!(snapshot["permissions"], json!([]));
    assert!(snapshot["error"].is_null(), "{snapshot}");
    while let Ok(event) = events.try_recv() {
        assert_ne!(event["event"]["type"], "permission");
    }
    println!("Native agent called the scoped MCP tool and completed without approval.");
    println!(
        "Built-in native tools: {}",
        json!(tools::definitions(false, true)
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>())
    );
    drop(session);
    factory.shutdown().await;
    println!("No OpenCode binary, runtime installer, localhost agent server, OAuth, or inference request was used.");
    Ok(())
}
