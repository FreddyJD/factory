use git_factory_lib::{
    runtime::{self, Factory},
    tools, workspace,
};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), String> {
    let root = runtime::data_root()?;
    let source = root.join("native-mcp-source");
    if !source.exists() {
        std::fs::create_dir(&source).map_err(|e| e.to_string())?;
        workspace::initialize_empty(&source)?;
    }
    let factory = Factory::new(root.clone());
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
    let connection = session
        .connections
        .lock()
        .await
        .get("fixture")
        .cloned()
        .ok_or("No MCP connection")?;
    let result = connection
        .call(
            "mcp_fixture_factory_workspace",
            json!({}),
            tokio_util::sync::CancellationToken::new(),
        )
        .await?;
    assert!(result.contains("repositories"));
    println!("Native MCP client connected to native Factory MCP server and called a scoped tool.");
    println!(
        "Built-in native tools: {}",
        json!(tools::definitions(false, true)
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>())
    );
    drop(connection);
    drop(session);
    factory.shutdown().await;
    println!("No OpenCode binary, runtime installer, localhost agent server, OAuth, or inference request was used.");
    Ok(())
}
