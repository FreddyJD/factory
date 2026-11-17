use git_factory_lib::{
    runtime::{self, Factory},
    workspace,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), String> {
    let root = runtime::data_root()?;
    let factory = Arc::new(Factory::new(root.clone()));
    factory.install().await?;
    let worker = factory.auth().await?;
    let methods = worker.get("/provider/auth").await?;
    assert!(methods["github-copilot"].is_array());
    let tools = worker.get("/experimental/tool/ids").await?;
    let tools = tools.as_array().ok_or("Missing tool registry")?;
    for tool in [
        "bash",
        "read",
        "glob",
        "grep",
        "edit",
        "write",
        "task",
        "webfetch",
        "todowrite",
        "skill",
        "apply_patch",
        "question",
    ] {
        assert!(tools.iter().any(|entry| entry == tool), "Missing {tool}");
    }
    println!("Actual OpenCode registry: {}", json!(tools));
    let session = worker
        .post(
            "/session",
            json!({"title":"Factory integration smoke test"}),
        )
        .await?;
    let id = session["id"].as_str().ok_or("No session ID")?;
    assert!(worker
        .get(&format!("/session/{id}/message?limit=100"))
        .await?
        .is_array());
    let source = root.join("mcp-fixture");
    if !source.exists() {
        std::fs::create_dir(&source).map_err(|e| e.to_string())?;
        workspace::initialize_empty(&source)?;
    }
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
    let result = worker.post("/mcp", json!({"name":"factory_smoke","config":{"type":"local","command":[cli,"--mcp","--workspace",source],"environment":{"GIT_FACTORY_DATA_DIR":root},"cwd":worker.directory}})).await?;
    assert_eq!(
        result["factory_smoke"]["status"], "connected",
        "MCP failed: {result}"
    );
    println!("Actual OpenCode MCP connection: {result}");
    drop(worker);
    factory.shutdown().await;
    println!("Runtime HTTP, tools, session, and MCP smoke tests passed without inference.");
    Ok(())
}
