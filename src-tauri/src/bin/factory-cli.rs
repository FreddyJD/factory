#[tokio::main]
async fn main() {
    if let Err(error) = git_factory_lib::protocol::cli().await {
        eprintln!("Git Factory: {error}");
        std::process::exit(1);
    }
}
