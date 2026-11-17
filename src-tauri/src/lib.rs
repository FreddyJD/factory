use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, ResourceId};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    raw_json: serde_json::Value,
}

#[tauri::command]
async fn check_for_update(webview: tauri::Webview) -> Result<Option<UpdateMetadata>, String> {
    let builder = webview.updater_builder().timeout(Duration::from_secs(20));
    // Keep windows/resources alive if installer launch fails. Updater 2.14.1
    // otherwise cleans up before ShellExecuteW; successful launches exit directly.
    #[cfg(windows)]
    let builder = builder.on_before_exit(|| {});
    let update = builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let current_version = update.current_version.clone();
        let version = update.version.clone();
        let raw_json = update.raw_json.clone();
        UpdateMetadata {
            rid: webview.resources_table().add(update),
            current_version,
            version,
            raw_json,
        }
    }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![check_for_update])
        .run(tauri::generate_context!())
        .expect("could not start Git Factory");
}
