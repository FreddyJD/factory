use crate::{
    tools,
    workspace::{Result, Task},
};
use rmcp::{
    model::{CallToolRequestParams, ProtocolVersion},
    service::RunningService,
    transport::{StreamableHttpClientTransport, TokioChildProcess},
    ClientLifecycleMode, ClientServiceExt, RoleClient,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct Connection {
    service: tokio::sync::Mutex<RunningService<RoleClient, ()>>,
    pub tools: Vec<Value>,
    pub resources: bool,
    routes: HashMap<String, String>,
}
pub type Connections = HashMap<String, Arc<Connection>>;

impl Connection {
    pub async fn connect(task: &Task, name: &str, config: &Value) -> Result<Self> {
        if name.is_empty()
            || name.len() > 24
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err("MCP server names must be 1-24 letters/digits/underscores".into());
        }
        let lifecycle = ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        };
        let service = match config["type"].as_str() {
            Some("local") => {
                let command = config["command"]
                    .as_array()
                    .ok_or("MCP command must be an argv array")?;
                let args: Vec<&str> = command
                    .iter()
                    .map(|v| v.as_str().ok_or("MCP argv must contain strings"))
                    .collect::<std::result::Result<_, _>>()?;
                let executable = args.first().ok_or("MCP command is empty")?;
                let mut cmd = tokio::process::Command::new(executable);
                cmd.args(&args[1..])
                    .current_dir(&task.directory)
                    .env_clear();
                for key in [
                    "PATH",
                    "HOME",
                    "USERPROFILE",
                    "SystemRoot",
                    "SYSTEMROOT",
                    "WINDIR",
                    "COMSPEC",
                    "PATHEXT",
                    "TEMP",
                    "TMP",
                    "TMPDIR",
                    "APPDATA",
                    "LOCALAPPDATA",
                ] {
                    if let Some(value) = std::env::var_os(key) {
                        cmd.env(key, value);
                    }
                }
                if let Some(environment) = config["environment"].as_object() {
                    for (key, value) in environment {
                        cmd.env(
                            key,
                            value
                                .as_str()
                                .ok_or("MCP environment values must be strings")?,
                        );
                    }
                }
                cmd.stderr(Stdio::null()).kill_on_drop(true);
                #[cfg(windows)]
                {
                    cmd.creation_flags(0x08000000);
                }
                let mut wrapped = process_wrap::tokio::CommandWrap::from(cmd);
                #[cfg(unix)]
                {
                    wrapped.wrap(process_wrap::tokio::ProcessGroup::leader());
                }
                #[cfg(windows)]
                {
                    wrapped.wrap(process_wrap::tokio::CreationFlags(
                        windows::Win32::System::Threading::CREATE_NO_WINDOW,
                    ));
                    wrapped.wrap(process_wrap::tokio::KillOnDrop);
                    wrapped.wrap(process_wrap::tokio::JobObject);
                }
                let transport = TokioChildProcess::new(wrapped).map_err(|e| e.to_string())?;
                ().serve_with_lifecycle(transport, lifecycle)
                    .await
                    .map_err(|e| e.to_string())?
            }
            Some("remote") => {
                let url =
                    reqwest::Url::parse(tools::text(config, "url")?).map_err(|e| e.to_string())?;
                if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
                {
                    return Err(
                        "Remote MCP requires an HTTPS URL without embedded credentials".into(),
                    );
                }
                if config.get("headers").is_some() {
                    return Err("Remote MCP custom headers/OAuth are not implemented; use an authenticated trusted local bridge".into());
                }
                let transport = StreamableHttpClientTransport::from_uri(url.to_string());
                ().serve_with_lifecycle(transport, lifecycle)
                    .await
                    .map_err(|e| e.to_string())?
            }
            _ => return Err("MCP type must be local or remote".into()),
        };
        let has_tools = service
            .peer_info()
            .is_some_and(|info| info.capabilities.tools.is_some());
        let catalog = if has_tools {
            tokio::time::timeout(Duration::from_secs(30), service.list_all_tools())
                .await
                .map_err(|_| "MCP tool discovery timed out")?
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if catalog.len() > 200 {
            return Err("MCP server advertises more than 200 tools".into());
        }
        let mut routes = HashMap::new();
        let mut definitions = Vec::new();
        let mut used = HashSet::new();
        for tool in catalog {
            let original = tool.name.to_string();
            let sanitized: String = original
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let exposed = format!("mcp_{name}_{sanitized}");
            if exposed.len() > 64 || !used.insert(exposed.clone()) {
                return Err("MCP tool name is too long or collides after sanitization".into());
            }
            definitions.push(json!({"type":"function","function":{"name":exposed,"description":tool.description.as_deref().unwrap_or("External MCP tool; calls run automatically"),"parameters":tool.input_schema}}));
            routes.insert(exposed, original);
        }
        let resources = service
            .peer_info()
            .is_some_and(|info| info.capabilities.resources.is_some());
        Ok(Self {
            resources,
            service: tokio::sync::Mutex::new(service),
            tools: definitions,
            routes,
        })
    }
    pub async fn resource(
        &self,
        method: &str,
        uri: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<String> {
        if !self.resources {
            return Err("MCP server has no resource capability".into());
        }
        let service = self.service.lock().await;
        let request = async {
            match method {
                "list_mcp_resources" => serde_json::to_value(
                    service
                        .list_all_resources()
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "list_mcp_resource_templates" => serde_json::to_value(
                    service
                        .list_all_resource_templates()
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "read_mcp_resource" => serde_json::to_value(
                    service
                        .read_resource(rmcp::model::ReadResourceRequestParams::new(
                            uri.ok_or("Missing uri")?,
                        ))
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                _ => Err("Unknown MCP resource operation".into()),
            }
        };
        let value = tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),result=tokio::time::timeout(Duration::from_secs(60),request)=>result.map_err(|_|"MCP resource timed out")??};
        Ok(tools::clip(&value.to_string(), tools::OUTPUT_LIMIT))
    }
    pub fn contains(&self, name: &str) -> bool {
        self.routes.contains_key(name)
    }
    pub async fn shutdown(&self) {
        let _ = self
            .service
            .lock()
            .await
            .close_with_timeout(Duration::from_secs(3))
            .await;
    }
    pub async fn call(&self, name: &str, args: Value, cancel: CancellationToken) -> Result<String> {
        if cancel.is_cancelled() {
            return Err("Cancelled".into());
        }
        let original = self.routes.get(name).ok_or("Unknown MCP tool")?;
        let params = CallToolRequestParams::new(original.clone()).with_arguments(
            args.as_object()
                .cloned()
                .ok_or("MCP arguments must be an object")?,
        );
        let service = self.service.lock().await;
        let result = tokio::select! {_ = cancel.cancelled()=>return Err("Cancelled; an external MCP side effect may already have occurred".into()),result=tokio::time::timeout(Duration::from_secs(120),service.call_tool(params))=>result.map_err(|_|"MCP tool timed out; do not blindly retry mutations")?.map_err(|e|e.to_string())?};
        let value = serde_json::to_value(result).map_err(|e| e.to_string())?;
        if value["isError"] == true {
            return Err(tools::clip(&value.to_string(), tools::OUTPUT_LIMIT));
        }
        Ok(tools::clip(&value.to_string(), tools::OUTPUT_LIMIT))
    }
}
