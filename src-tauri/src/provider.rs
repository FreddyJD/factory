use crate::workspace::Result;
use futures_util::{future::BoxFuture, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

const COPILOT: &str = "https://api.githubcopilot.com";
pub const NOTICE: &str = "Experimental direct Copilot HTTP integration. Inference endpoints are undocumented and may be restricted or change. No external agent runtime is used.";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub context: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
#[derive(Clone, Debug, Default)]
pub struct Completion {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub reason: String,
    pub opaque: Option<Value>,
}

pub trait Inference: Send + Sync {
    fn complete<'a>(
        &'a self,
        model: &'a str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        initiator: &'a str,
        cancel: CancellationToken,
        deltas: mpsc::Sender<String>,
    ) -> BoxFuture<'a, Result<Completion>>;
}

#[derive(Serialize, Deserialize)]
struct Credential {
    client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
}
struct Device {
    id: String,
    code: String,
    client_id: String,
    deadline: Instant,
    interval: u64,
}

pub struct Copilot {
    root: PathBuf,
    client: reqwest::Client,
    device: Mutex<Option<Device>>,
    credentials: Mutex<()>,
    catalog: Mutex<Vec<Model>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl Copilot {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .user_agent(concat!("GitFactory/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("HTTP client"),
            device: Mutex::new(None),
            credentials: Mutex::new(()),
            catalog: Mutex::new(Vec::new()),
        }
    }
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(
            "com.freddyjd.gitfactory.copilot",
            &self.root.to_string_lossy(),
        )
        .map_err(|e| format!("OS credential store unavailable: {e}"))
    }
    pub fn configured_client(&self) -> Option<String> {
        std::env::var("GIT_FACTORY_GITHUB_CLIENT_ID")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| std::fs::read_to_string(self.root.join("github-client-id")).ok())
    }
    pub fn configure(&self, id: &str) -> Result<()> {
        if id.len() < 5
            || id.len() > 100
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
        {
            return Err(
                "Enter your registered GitHub OAuth application's client ID (device flow enabled)"
                    .into(),
            );
        }
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("credential.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| "Credential operation is in progress; retry after login/refresh")?;
        std::fs::write(self.root.join("github-client-id"), id).map_err(|e| e.to_string())
    }
    async fn credential_lock(&self) -> Result<std::fs::File> {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("credential.lock"))
            .map_err(|e| e.to_string())?;
        for _ in 0..400 {
            if fs2::FileExt::try_lock_exclusive(&lock).is_ok() {
                return Ok(lock);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Another Factory process is refreshing credentials; retry shortly".into())
    }
    pub async fn login_start(&self) -> Result<Value> {
        let _login_guard = self.credential_lock().await?;
        let client_id = self.configured_client().ok_or("Configure Git Factory's own GitHub OAuth client ID first; enable device flow in that OAuth app")?;
        let value: Value = self
            .client
            .post("https://github.com/login/device/code")
            .header("Accept", "application/json")
            .json(&json!({"client_id":client_id,"scope":"read:user"}))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let code = value["device_code"]
            .as_str()
            .ok_or_else(|| {
                format!(
                    "Device authorization failed: {}",
                    value["error"].as_str().unwrap_or("invalid response")
                )
            })?
            .to_string();
        let url = value["verification_uri"]
            .as_str()
            .ok_or("Missing verification URL")?;
        if url != "https://github.com/login/device" {
            return Err("Unexpected GitHub authorization URL".into());
        }
        let attempt = uuid::Uuid::new_v4().to_string();
        std::fs::write(self.root.join("login-generation"), &attempt).map_err(|e| e.to_string())?;
        let expires = value["expires_in"].as_u64().unwrap_or(900).min(1800);
        *self.device.lock().await = Some(Device {
            id: attempt.clone(),
            code,
            client_id,
            deadline: Instant::now() + Duration::from_secs(expires),
            interval: value["interval"].as_u64().unwrap_or(5).max(5),
        });
        Ok(
            json!({"attemptId":attempt,"url":url,"instructions":format!("Enter code: {}",value["user_code"].as_str().ok_or("Missing user code")?),"expiresIn":expires}),
        )
    }
    pub async fn login_finish(&self, attempt: &str) -> Result<Value> {
        let device = {
            let mut pending = self.device.lock().await;
            if pending.as_ref().map(|d| d.id.as_str()) != Some(attempt) {
                return Err("Login attempt expired or replaced".into());
            }
            pending.take().unwrap()
        };
        let mut interval = device.interval;
        loop {
            if std::fs::read_to_string(self.root.join("login-generation"))
                .ok()
                .as_deref()
                != Some(&device.id)
            {
                return Err("Login replaced by a newer attempt".into());
            }
            if Instant::now() + Duration::from_secs(interval) >= device.deadline {
                return Err("GitHub device code expired; start sign-in again".into());
            }
            tokio::time::sleep(Duration::from_secs(interval)).await;
            let response = self.client.post("https://github.com/login/oauth/access_token").header("Accept","application/json").json(&json!({"client_id":device.client_id,"device_code":device.code,"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})).timeout(Duration::from_secs(30)).send().await.map_err(|e|e.to_string())?;
            let value: Value = response
                .error_for_status()
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            if value["access_token"].is_string() {
                let credential = credential(&value, &device.client_id)?;
                let _guard = self.credentials.lock().await;
                let file_guard = self.credential_lock().await?;
                if std::fs::read_to_string(self.root.join("login-generation"))
                    .ok()
                    .as_deref()
                    != Some(&device.id)
                    || self.configured_client().as_deref() != Some(&device.client_id)
                {
                    return Err("Login configuration changed; sign in again".into());
                }
                self.entry()?
                    .set_password(&serde_json::to_string(&credential).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("Could not save credentials to OS store: {e}"))?;
                drop(file_guard);
                drop(_guard);
                self.catalog.lock().await.clear();
                return self.models().await;
            }
            match value["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => {
                    interval = interval
                        .saturating_add(5)
                        .max(value["interval"].as_u64().unwrap_or(0))
                }
                Some(error) => return Err(format!("GitHub authorization: {error}")),
                None => return Err("Invalid GitHub authorization response".into()),
            }
        }
    }
    async fn token(&self) -> Result<String> {
        let _guard = self.credentials.lock().await;
        let _file_guard = self.credential_lock().await?;
        let data = self
            .entry()?
            .get_password()
            .map_err(|_| "Sign in to GitHub Copilot in onboarding first".to_string())?;
        let mut credential: Credential = serde_json::from_str(&data)
            .map_err(|_| "Stored credential is invalid; sign in again".to_string())?;
        if self.configured_client().as_deref() != Some(&credential.client_id) {
            return Err(
                "GitHub OAuth client changed; sign in again with this Factory identity".into(),
            );
        }
        if credential
            .expires_at
            .is_some_and(|expiry| expiry <= now() + 60)
        {
            let refresh = credential
                .refresh_token
                .as_deref()
                .ok_or("GitHub credential expired; sign in again")?;
            let client = self.configured_client().ok_or("OAuth client ID missing")?;
            let value: Value = self.client.post("https://github.com/login/oauth/access_token").header("Accept","application/json").json(&json!({"client_id":client,"grant_type":"refresh_token","refresh_token":refresh})).timeout(Duration::from_secs(30)).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            credential = self::credential(&value, &credential.client_id)?;
            self.entry()?
                .set_password(&serde_json::to_string(&credential).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        Ok(credential.access_token)
    }
    fn request(&self, method: reqwest::Method, path: &str, token: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{COPILOT}{path}"))
            .bearer_auth(token)
            .header("X-GitHub-Api-Version", "2026-06-01")
            .header("Openai-Intent", "conversation-edits")
    }
    pub async fn models(&self) -> Result<Value> {
        let token = match self.token().await {
            Ok(token) => token,
            Err(error) if error.starts_with("Sign in") => {
                return Ok(json!({"all":[],"connected":[],"notice":NOTICE}))
            }
            Err(error) => return Err(error),
        };
        let response = self
            .request(reqwest::Method::GET, "/models", &token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Copilot model discovery: HTTP {}. Your OAuth app/account may not be entitled to this undocumented API.",response.status()));
        }
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        let models = parse_models(&value);
        if models.is_empty() {
            return Err("Copilot returned no enabled chat-completions models supporting streaming and tools. Responses/Messages-only models are not supported by this adapter.".into());
        }
        *self.catalog.lock().await = models.clone();
        let catalog: serde_json::Map<String,Value> = models.into_iter().map(|m|(m.id.clone(),json!({"id":m.id,"name":m.name,"context":m.context,"capabilities":{"toolcall":true}}))).collect();
        Ok(
            json!({"all":[{"id":"github-copilot","models":catalog}],"connected":["github-copilot"],"notice":NOTICE}),
        )
    }
    pub async fn model(&self, id: &str) -> Result<Model> {
        if self.catalog.lock().await.is_empty() {
            self.models().await?;
        }
        self.catalog
            .lock()
            .await
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or("Select an available Copilot chat model".into())
    }
}

fn credential(value: &Value, client_id: &str) -> Result<Credential> {
    Ok(Credential {
        client_id: client_id.into(),
        access_token: value["access_token"]
            .as_str()
            .ok_or("GitHub credential refresh failed; sign in again")?
            .into(),
        refresh_token: value["refresh_token"].as_str().map(String::from),
        expires_at: value["expires_in"].as_u64().map(|seconds| now() + seconds),
    })
}
pub fn parse_models(value: &Value) -> Vec<Model> {
    value["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["model_picker_enabled"] == true
                && m["policy"]["state"].as_str().is_none_or(|s| s == "enabled")
                && m["supported_endpoints"]
                    .as_array()
                    .is_some_and(|e| e.iter().any(|e| e == "/chat/completions"))
                && m["capabilities"]["supports"]["streaming"] == true
                && m["capabilities"]["supports"]["tool_calls"] == true
        })
        .filter_map(|m| {
            Some(Model {
                id: m["id"].as_str()?.into(),
                name: m["name"].as_str()?.into(),
                context: m["capabilities"]["limits"]["max_prompt_tokens"]
                    .as_u64()
                    .unwrap_or(32_000) as usize,
            })
        })
        .collect()
}

#[derive(Default)]
pub struct StreamDecoder {
    buffer: Vec<u8>,
    text: String,
    calls: BTreeMap<usize, ToolCall>,
    reason: Option<String>,
    opaque: Option<Value>,
    done: bool,
}
impl StreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 4_000_000 {
            return Err("Oversized provider stream frame".into());
        }
        let mut deltas = Vec::new();
        while let Some(index) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=index).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "Invalid UTF-8 provider stream")?
                .trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                self.done = true;
                continue;
            }
            let value: Value =
                serde_json::from_str(data).map_err(|_| "Malformed provider SSE JSON")?;
            if value.get("error").is_some() {
                return Err("Copilot returned an inference stream error".into());
            }
            if let Some(reason) = value["choices"][0]["finish_reason"].as_str() {
                self.reason = Some(reason.into());
            }
            let delta = &value["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                self.text.push_str(text);
                deltas.push(text.into());
            }
            if let Some(opaque) = delta.get("reasoning_opaque") {
                self.opaque = Some(opaque.clone());
            }
            for call in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = call["index"].as_u64().ok_or("Tool call missing index")? as usize;
                if index >= 32 {
                    return Err("Too many tool calls in a response".into());
                }
                let entry = self.calls.entry(index).or_insert(ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
                if let Some(id) = call["id"].as_str() {
                    entry.id.push_str(id);
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    entry.name.push_str(name);
                }
                if let Some(arguments) = call["function"]["arguments"].as_str() {
                    entry.arguments.push_str(arguments);
                }
                if entry.arguments.len() > 1_000_000
                    || entry.name.len() > 128
                    || entry.id.len() > 256
                {
                    return Err("Oversized tool call".into());
                }
            }
            if self.text.len() > 2_000_000 {
                return Err("Provider output exceeded limit".into());
            }
        }
        Ok(deltas)
    }
    pub fn is_done(&self) -> bool {
        self.done
    }
    pub fn finish(self) -> Result<Completion> {
        if !self.done || self.reason.is_none() {
            return Err("Incomplete inference stream; no tools executed".into());
        }
        let mut ids = std::collections::HashSet::new();
        for call in self.calls.values() {
            if call.id.is_empty() || call.name.is_empty() || !ids.insert(&call.id) {
                return Err("Invalid or duplicated tool call ID".into());
            }
            serde_json::from_str::<Value>(&call.arguments)
                .map_err(|_| "Tool arguments are not complete JSON")?;
        }
        if !self.calls.is_empty() && self.reason.as_deref() != Some("tool_calls") {
            return Err("Provider did not finish its tool-call response".into());
        }
        Ok(Completion {
            text: self.text,
            calls: self.calls.into_values().collect(),
            reason: self.reason.unwrap(),
            opaque: self.opaque,
        })
    }
}

impl Inference for Copilot {
    fn complete<'a>(
        &'a self,
        model: &'a str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        initiator: &'a str,
        cancel: CancellationToken,
        deltas: mpsc::Sender<String>,
    ) -> BoxFuture<'a, Result<Completion>> {
        Box::pin(async move {
            let token = self.token().await?;
            let request = self
                .request(reqwest::Method::POST, "/chat/completions", &token)
                .header("x-initiator", initiator)
                .header("X-Interaction-Id", uuid::Uuid::new_v4().to_string())
                .json(&json!({"model":model,"messages":messages,"tools":tools,"stream":true}))
                .timeout(Duration::from_secs(300));
            let response = tokio::select! {_ = cancel.cancelled()=>return Err("Cancelled".into()), response=request.send()=>response.map_err(|e|e.to_string())?};
            if !response.status().is_success() {
                return Err(format!("Copilot inference HTTP {}. Check entitlement, organization policy, quota, and API compatibility. No request was retried.",response.status()));
            }
            let mut stream = response.bytes_stream();
            let mut decoder = StreamDecoder::default();
            loop {
                tokio::select! { biased; _ = cancel.cancelled()=>return Err("Cancelled".into()), chunk=stream.next()=>match chunk { Some(chunk)=>for delta in decoder.push(&chunk.map_err(|e|e.to_string())?)? { let _=deltas.send(delta).await; }, None=>break }}
                if decoder.is_done() {
                    break;
                }
            }
            decoder.finish()
        })
    }
}

pub type Provider = Arc<dyn Inference>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_utf8_and_calls_are_assembled_only_on_complete() {
        let input="data: {\"choices\":[{\"delta\":{\"content\":\"caf\u{e9}\",\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"filePath\\\":\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        let mut decoder = StreamDecoder::default();
        for byte in input.as_bytes() {
            decoder.push(&[*byte]).unwrap();
        }
        let result = decoder.finish().unwrap();
        assert_eq!(result.text, "caf\u{e9}");
        assert_eq!(result.calls[0].arguments, "{\"filePath\":\"a\"}");
    }
    #[test]
    fn partial_stream_is_not_executable() {
        let mut d = StreamDecoder::default();
        d.push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n")
            .unwrap();
        assert!(d.finish().is_err());
    }
    #[test]
    fn catalog_excludes_unsupported_endpoints() {
        assert!(parse_models(&json!({"data":[{"id":"x","name":"x","model_picker_enabled":true,"supported_endpoints":["/responses"],"capabilities":{"supports":{"streaming":true,"tool_calls":true}}}]})).is_empty());
    }
}
