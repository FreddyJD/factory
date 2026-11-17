// Read-only account-aware model discovery. Does not submit an inference request
// or print credentials, raw provider bodies, or the user's model catalog.
#[tokio::main]
async fn main() -> Result<(), String> {
    let root = git_factory_lib::runtime::data_root()?;
    let provider = git_factory_lib::provider::Copilot::new(&root);
    let catalog = provider.models().await?;
    if !catalog["connected"]
        .as_array()
        .is_some_and(|p| p.iter().any(|p| p == "github-copilot"))
    {
        return Err(
            "GitHub is not signed in; complete device authorization in Settings first".into(),
        );
    }
    let count = catalog["all"][0]["models"]
        .as_object()
        .map_or(0, |m| m.len());
    println!("Copilot model discovery succeeded: {count} tool-capable Chat Completions models. No inference request sent.");
    Ok(())
}
