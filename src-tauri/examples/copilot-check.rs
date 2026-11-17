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
    let mut coding = 0usize;
    let mut protocols = std::collections::BTreeMap::<String, usize>::new();
    for model in catalog["all"][0]["models"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        if model["capabilities"]["toolcall"] == true {
            coding += 1;
        }
        *protocols
            .entry(model["protocol"].as_str().unwrap_or("unknown").into())
            .or_default() += 1;
    }
    println!("Copilot model discovery succeeded: {count} enabled chat models ({coding} coding-capable), protocols: {protocols:?}. No inference request sent.");
    Ok(())
}
