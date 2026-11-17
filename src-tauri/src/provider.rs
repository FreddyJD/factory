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
const DEVICE_CLIENT: &str = "Iv1.b507a08c87ecfe98";
struct CopilotToken {
    oauth: String,
    token: String,
    base: String,
    renew: Instant,
}
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

#[derive(Clone)]
pub struct Copilot {
    root: PathBuf,
    client: reqwest::Client,
    device: Arc<Mutex<Option<Device>>>,
    credentials: Arc<Mutex<()>>,
    catalog: Arc<Mutex<(String, Vec<Model>)>>,
    exchange: Arc<Mutex<Option<CopilotToken>>>,
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
            device: Arc::new(Mutex::new(None)),
            credentials: Arc::new(Mutex::new(())),
            catalog: Arc::new(Mutex::new((String::new(), Vec::new()))),
            exchange: Arc::new(Mutex::new(None)),
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
            .or_else(|| Some(DEVICE_CLIENT.into()))
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
                let identity: Value = self
                    .client
                    .get("https://api.github.com/user")
                    .bearer_auth(&credential.access_token)
                    .header("Accept", "application/vnd.github+json")
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|_| "GitHub account verification failed")?
                    .error_for_status()
                    .map_err(|_| "GitHub account verification failed")?
                    .json()
                    .await
                    .map_err(|_| "Invalid GitHub identity response")?;
                if identity["id"].as_u64().is_none() {
                    return Err("GitHub account identity missing".into());
                }
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
                *self.catalog.lock().await = (String::new(), Vec::new());
                self.exchange.lock().await.take();
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
        // Refresh can rotate a single-use token: callers must not cancel save-after-refresh.
        let owner = self.clone();
        tokio::spawn(async move { owner.token_inner().await })
            .await
            .map_err(|_| "Credential refresh task failed")?
    }
    async fn token_inner(&self) -> Result<String> {
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
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<(reqwest::RequestBuilder, String, String)> {
        let oauth = self.token().await?;
        let mut cache = self.exchange.lock().await;
        if !cache
            .as_ref()
            .is_some_and(|c| c.oauth == oauth && Instant::now() < c.renew)
        {
            let started = Instant::now();
            let response = self
                .client
                .get("https://api.github.com/copilot_internal/v2/token")
                .header("Authorization", format!("token {oauth}"))
                .header("Accept", "application/json")
                .header(
                    "Editor-Version",
                    concat!("factory/", env!("CARGO_PKG_VERSION")),
                )
                .header(
                    "Editor-Plugin-Version",
                    concat!("factory/", env!("CARGO_PKG_VERSION")),
                )
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|_| "Copilot token exchange could not connect")?;
            if !response.status().is_success() {
                return Err(format!("Copilot access: HTTP {}. Sign in again or check your subscription and organization policy.",response.status()));
            }
            let value: Value = response
                .json()
                .await
                .map_err(|_| "Invalid Copilot token response")?;
            let base =
                validate_copilot_base(value["endpoints"]["api"].as_str().unwrap_or(COPILOT))?;
            let lifetime = value["expires_at"]
                .as_u64()
                .ok_or("Copilot token expiry missing")?
                .saturating_sub(now());
            if lifetime < 10 {
                return Err("Copilot returned an expired token; check the system clock".into());
            }
            let seconds = value["refresh_in"]
                .as_u64()
                .unwrap_or(lifetime)
                .min(lifetime - lifetime.div_ceil(10).min(120))
                .max(1);
            *cache = Some(CopilotToken {
                oauth,
                token: value["token"]
                    .as_str()
                    .ok_or("Copilot token missing")?
                    .into(),
                base,
                renew: started + Duration::from_secs(seconds),
            });
        }
        let access = cache.as_ref().unwrap();
        Ok((
            self.client
                .request(method, format!("{}{path}", access.base))
                .bearer_auth(&access.token)
                .header("X-GitHub-Api-Version", "2026-01-09")
                .header(
                    "Editor-Version",
                    concat!("factory/", env!("CARGO_PKG_VERSION")),
                )
                .header(
                    "Editor-Plugin-Version",
                    concat!("factory/", env!("CARGO_PKG_VERSION")),
                )
                .header(
                    "Openai-Intent",
                    if path == "/models" {
                        "model-access"
                    } else {
                        "conversation-panel"
                    },
                )
                .header("X-Request-Id", uuid::Uuid::new_v4().to_string()),
            access.oauth.clone(),
            access.token.clone(),
        ))
    }
    pub async fn models(&self) -> Result<Value> {
        let (request, credential, used_token) =
            match self.request(reqwest::Method::GET, "/models").await {
                Ok(request) => request,
                Err(error) if error.starts_with("Sign in") => {
                    return Ok(json!({"all":[],"connected":[],"notice":NOTICE}))
                }
                Err(error) => return Err(error),
            };
        let response = request
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.invalidate(&used_token).await;
        }
        if !response.status().is_success() {
            return Err(format!("Copilot model discovery: HTTP {}. Your OAuth app/account may not be entitled to this undocumented API.",response.status()));
        }
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        let models = parse_models(&value);
        if models.is_empty() {
            return Err("Copilot returned no enabled chat-completions models supporting streaming and tools. Responses/Messages-only models are not supported by this adapter.".into());
        }
        if self.token().await? != credential {
            return Err("GitHub account changed during model discovery; refresh models".into());
        }
        *self.catalog.lock().await = (credential, models.clone());
        let catalog: serde_json::Map<String,Value> = models.into_iter().map(|m|(m.id.clone(),json!({"id":m.id,"name":m.name,"context":m.context,"capabilities":{"toolcall":true}}))).collect();
        Ok(
            json!({"all":[{"id":"github-copilot","models":catalog}],"connected":["github-copilot"],"notice":NOTICE}),
        )
    }
    async fn invalidate(&self, used: &str) {
        let mut cache = self.exchange.lock().await;
        if cache.as_ref().is_some_and(|c| c.token == used) {
            cache.take();
        }
    }
    pub async fn model(&self, id: &str) -> Result<Model> {
        let credential = self.token().await?;
        let stale = {
            let catalog = self.catalog.lock().await;
            catalog.0 != credential || catalog.1.is_empty()
        };
        if stale {
            self.models().await?;
        }
        let catalog = self.catalog.lock().await;
        if catalog.0 != credential {
            return Err("GitHub account changed; refresh model selection".into());
        }
        catalog
            .1
            .iter()
            .find(|model| model.id == id)
            .cloned()
            .ok_or("Select an available Copilot chat model".into())
    }
}

pub fn validate_copilot_base(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid Copilot endpoint")?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !(host == "api.githubcopilot.com" || host.ends_with(".githubcopilot.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
        || url.path() != "/"
    {
        return Err("Untrusted Copilot inference endpoint".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
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
            (m["model_picker_enabled"] == true
                || m["model_picker_category"].is_string()
                || m["policy"]["state"] == "enabled")
                && m["policy"]["state"].as_str().is_none_or(|s| s == "enabled")
                && m.get("supported_endpoints").is_none_or(|e| {
                    e.as_array()
                        .is_some_and(|e| e.iter().any(|e| e == "/chat/completions"))
                })
                && m["capabilities"]["supports"]["streaming"] != false
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
        if self.done {
            return Ok(vec![]);
        }
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
                self.buffer.clear();
                break;
            }
            let value: Value =
                serde_json::from_str(data).map_err(|_| "Malformed provider SSE JSON")?;
            if value.get("error").is_some() {
                return Err("Inference provider returned a stream error".into());
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
            let (request, _credential, used_token) = self
                .request(reqwest::Method::POST, "/chat/completions")
                .await?;
            let request = request
                .header("x-initiator", initiator)
                .header("X-Interaction-Id", uuid::Uuid::new_v4().to_string())
                .json(&json!({"model":model,"messages":messages,"tools":tools,"stream":true}))
                .timeout(Duration::from_secs(300));
            let response = tokio::select! {_ = cancel.cancelled()=>return Err("Cancelled".into()), response=request.send()=>response.map_err(|e|e.to_string())?};
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                self.invalidate(&used_token).await;
            }
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
    #[tokio::test]
    async fn late_auth_failure_cannot_invalidate_a_new_token() {
        let provider = Copilot::new(Path::new("/unused-test"));
        *provider.exchange.lock().await = Some(CopilotToken {
            oauth: "oauth".into(),
            token: "new-token".into(),
            base: COPILOT.into(),
            renew: Instant::now() + Duration::from_secs(60),
        });
        provider.invalidate("old-token").await;
        assert!(provider.exchange.lock().await.is_some());
        provider.invalidate("new-token").await;
        assert!(provider.exchange.lock().await.is_none());
    }
    #[test]
    fn copilot_hosts_are_restricted() {
        for host in [
            "https://api.githubcopilot.com",
            "https://api.enterprise.githubcopilot.com",
        ] {
            assert!(validate_copilot_base(host).is_ok());
        }
        for host in [
            "http://api.githubcopilot.com",
            "https://api.githubcopilot.com.evil.example",
            "https://user:token@api.githubcopilot.com",
            "https://api.githubcopilot.com/path",
        ] {
            assert!(validate_copilot_base(host).is_err());
        }
    }
    #[test]
    fn done_is_terminal_independent_of_chunk_boundaries() {
        let first=b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n";
        let trailing = b"data: not-valid-json\n";
        let mut together = StreamDecoder::default();
        let mut input = first.to_vec();
        input.extend_from_slice(trailing);
        together.push(&input).unwrap();
        assert_eq!(together.finish().unwrap().text, "ok");
        let mut split = StreamDecoder::default();
        split.push(first).unwrap();
        split.push(trailing).unwrap();
        assert_eq!(split.finish().unwrap().text, "ok");
    }
    #[test]
    fn models_accept_optional_streaming_metadata_but_not_responses_only() {
        let value = json!({"data":[{"id":"chat","name":"Chat","policy":{"state":"enabled"},"capabilities":{"supports":{"tool_calls":true}}}]});
        assert_eq!(parse_models(&value).len(), 1);
    }
    #[test]
    fn catalog_excludes_unsupported_endpoints() {
        assert!(parse_models(&json!({"data":[{"id":"x","name":"x","model_picker_enabled":true,"supported_endpoints":["/responses"],"capabilities":{"supports":{"streaming":true,"tool_calls":true}}}]})).is_empty());
    }
}
