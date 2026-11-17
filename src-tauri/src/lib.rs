pub mod protocol;
pub mod runtime;
pub mod workspace;

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, ResourceId, State};
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

#[tauri::command]
async fn factory_api(
    factory: State<'_, Arc<runtime::Factory>>,
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let text = |key: &str| args[key].as_str().ok_or_else(|| format!("Missing {key}"));
    match action.as_str() {
        "status" => Ok(
            json!({"installed":runtime::binary(&factory.root).exists(),"version":runtime::OPENCODE_VERSION,"tasks":factory.summaries().await?,"dataRoot":factory.root}),
        ),
        "prepare_update" => {
            factory.shutdown().await;
            Ok(json!(true))
        }
        "install" => {
            factory.install().await?;
            Ok(json!(true))
        }
        "login_start" => factory.login_start().await,
        "login_open" => {
            open::that("https://github.com/login/device").map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "login_finish" => {
            factory
                .login_finish(args["method"].as_u64().ok_or("Missing OAuth method")? as usize)
                .await
        }
        "models" => factory.models().await,
        "pick_folder" => {
            let folder = rfd::AsyncFileDialog::new()
                .set_title("Open a repository or a folder of repositories")
                .pick_folder()
                .await;
            match folder {
                Some(folder) => Ok(json!(factory.workspace(folder.path())?)),
                None => Ok(Value::Null),
            }
        }
        "workspace" => Ok(json!(factory.workspace(&PathBuf::from(text("path")?))?)),
        "initialize" => Ok(json!(workspace::initialize_empty(&PathBuf::from(text(
            "path"
        )?))?)),
        "create" => Ok(json!(
            factory
                .create(&PathBuf::from(text("path")?), text("goal")?, text("model")?)
                .await?
        )),
        "snapshot" => factory.snapshot(text("taskId")?).await,
        "prompt" => {
            factory.prompt(text("taskId")?, text("text")?).await?;
            Ok(json!(true))
        }
        "cancel" => {
            factory.cancel(text("taskId")?).await?;
            Ok(json!(true))
        }
        "close" => {
            factory.close(text("taskId")?).await?;
            Ok(json!(true))
        }
        "permission" => {
            factory
                .permission(
                    text("taskId")?,
                    text("requestId")?,
                    args["allow"].as_bool().ok_or("Missing approval")?,
                )
                .await
        }
        "question" => {
            factory
                .question(
                    text("taskId")?,
                    text("requestId")?,
                    args.get("answers").cloned().filter(|v| !v.is_null()),
                )
                .await
        }
        "diff" => Ok(json!(workspace::diff(&workspace::load_task(
            &factory.root,
            text("taskId")?
        )?)?)),
        "mcp_add" => {
            factory
                .mcp(text("taskId")?, text("name")?, args["config"].clone())
                .await
        }
        "mcp_status" => factory.worker(text("taskId")?).await?.get("/mcp").await,
        "tools" => {
            factory
                .worker(text("taskId")?)
                .await?
                .get("/experimental/tool/ids")
                .await
        }
        "open_worktree" => {
            let task = workspace::load_task(&factory.root, text("taskId")?)?;
            open::that(&task.directory).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        _ => Err("Unknown Factory operation".into()),
    }
}

pub fn run() {
    let factory = Arc::new(runtime::Factory::new(
        runtime::data_root().expect("could not locate Factory data"),
    ));
    let shutdown = factory.clone();
    tauri::Builder::default()
        .manage(factory.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let mut receiver = factory.events.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match receiver.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("factory-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![check_for_update, factory_api])
        .build(tauri::generate_context!())
        .expect("could not start Git Factory")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                tauri::async_runtime::block_on(shutdown.shutdown());
            }
        });
}
