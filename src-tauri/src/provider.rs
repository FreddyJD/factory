use crate::{
    wire::{self, Protocol},
    workspace::Result,
};
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
    pub state: Option<Value>,
}

#[derive(Debug)]
pub enum InferenceError {
    ContextOverflow,
    Other(String),
}
impl std::fmt::Display for InferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ContextOverflow => {
                f.write_str("Provider context window exceeded; no tools executed")
            }
            Self::Other(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for InferenceError {}
impl From<String> for InferenceError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}
impl From<&str> for InferenceError {
    fn from(value: &str) -> Self {
        Self::Other(value.into())
    }
}
pub type InferenceResult = std::result::Result<Completion, InferenceError>;

// Only known structured codes on a rejected HTTP request permit context recovery.
// Never expose error bodies: they may contain credentials or echoed user content.
fn context_error(value: &Value) -> bool {
    [
        value["error"]["code"].as_str(),
        value["error"]["type"].as_str(),
        value["code"].as_str(),
    ]
    .into_iter()
    .flatten()
    .any(|code| {
        matches!(
            code,
            "context_length_exceeded"
                | "context_window_exceeded"
                | "max_prompt_tokens_exceeded"
                | "prompt_too_long"
                | "input_too_long"
        )
    })
}

pub async fn inference_error(
    response: reqwest::Response,
    fallback: String,
    cancel: CancellationToken,
) -> InferenceError {
    if !matches!(response.status().as_u16(), 400 | 413 | 422) {
        return fallback.into();
    }
    let read = async {
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return false;
            };
            if bytes.len() + chunk.len() > 16_384 {
                return false;
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&bytes).is_ok_and(|value| context_error(&value))
    };
    tokio::select! { biased;
        _ = cancel.cancelled() => "Cancelled".into(),
        result = tokio::time::timeout(Duration::from_secs(5), read) => {
            if result.unwrap_or(false) { InferenceError::ContextOverflow } else { fallback.into() }
        }
    }
}

pub trait Inference: Send + Sync {
    fn limits<'a>(&'a self, model: &'a Model) -> BoxFuture<'a, Result<crate::context::Limits>> {
        Box::pin(async move { Ok(crate::context::Limits::window(model.context)) })
    }
    #[allow(clippy::too_many_arguments)]
    fn complete<'a>(
        &'a self,
        model: &'a str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        output: Option<usize>,
        initiator: &'a str,
        cancel: CancellationToken,
        deltas: mpsc::Sender<String>,
    ) -> BoxFuture<'a, InferenceResult>;
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

#[derive(Clone, Debug)]
struct CatalogModel {
    model: Model,
    protocol: Protocol,
    output: usize,
    input: usize,
    tools: bool,
    vision: Option<bool>,
}

#[derive(Clone)]
pub struct Copilot {
    root: PathBuf,
    client: reqwest::Client,
    device: Arc<Mutex<Option<Device>>>,
    credentials: Arc<Mutex<()>>,
    catalog: Arc<Mutex<(String, Vec<CatalogModel>)>>,
    exchange: Arc<Mutex<Option<CopilotToken>>>,
    catalog_gate: Arc<Mutex<()>>,
    catalog_at: Arc<Mutex<Option<Instant>>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Copilot validates the editor integration profile on exchange and inference requests.
// This profile matches Roxy's direct HTTP adapter, including model discovery.
fn editor_request(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .header("Editor-Version", "vscode/1.99.3")
        .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
        .header("Copilot-Integration-Id", "vscode-chat")
        .header("Accept", "application/json")
}

fn response_error(
    stage: &str,
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> String {
    let recovery=match status.as_u16(){
        400|422=>"Copilot rejected the request format or client headers. This does not establish an account-entitlement problem.",
        401=>"The saved authorization was rejected. Reconnect GitHub in Settings.",
        403=>"Copilot denied access. Check your subscription and organization policies.",
        429=>"Copilot is rate limiting requests. Wait before trying again.",
        500..=599=>"Copilot is temporarily unavailable. Try again later.",
        _=>"Copilot could not complete the request. Try checking the connection again.",
    };
    // Provider error bodies can echo credentials or prompts; never expose them.
    let request_id = headers
        .get("x-request-id")
        .or_else(|| headers.get("x-github-request-id"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
        });
    let reference = request_id
        .map(|id| format!(" Request ID: {id}."))
        .unwrap_or_default();
    format!("Copilot {stage}: HTTP {status}. {recovery}{reference}")
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
            catalog_gate: Arc::new(Mutex::new(())),
            catalog_at: Arc::new(Mutex::new(None)),
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
            let response = editor_request(
                self.client
                    .get("https://api.github.com/copilot_internal/v2/token")
                    .header("Authorization", format!("token {oauth}")),
            )
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Copilot token exchange could not connect")?;
            if !response.status().is_success() {
                return Err(response_error(
                    "token exchange",
                    response.status(),
                    response.headers(),
                ));
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
            self.api_request(method, path, access),
            access.oauth.clone(),
            access.token.clone(),
        ))
    }
    fn api_request(
        &self,
        method: reqwest::Method,
        path: &str,
        access: &CopilotToken,
    ) -> reqwest::RequestBuilder {
        editor_request(
            self.client
                .request(method, format!("{}{path}", access.base)),
        )
        .bearer_auth(&access.token)
        .header("Content-Type", "application/json")
        .header("X-GitHub-Api-Version", "2026-01-09")
        .header(
            "Openai-Intent",
            if path == "/models" {
                "model-access"
            } else {
                "conversation-panel"
            },
        )
        .header("X-Request-Id", uuid::Uuid::new_v4().to_string())
    }
    pub async fn models(&self) -> Result<Value> {
        let _gate = self.catalog_gate.lock().await;
        // Clear first so failed/cancelled discovery cannot leave revoked models runnable.
        *self.catalog.lock().await = (String::new(), Vec::new());
        *self.catalog_at.lock().await = None;
        self.discover_models().await
    }
    async fn discover_models(&self) -> Result<Value> {
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
            return Err(response_error(
                "model discovery",
                response.status(),
                response.headers(),
            ));
        }
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        let models = catalog_models(&value);
        if models.is_empty() {
            return Err("Copilot returned no enabled streaming chat models using Chat Completions, Responses or Messages.".into());
        }
        if self.token().await? != credential {
            return Err("GitHub account changed during model discovery; refresh models".into());
        }
        *self.catalog.lock().await = (credential, models.clone());
        *self.catalog_at.lock().await = Some(Instant::now());
        let catalog: serde_json::Map<String,Value> = models.into_iter().map(|entry|{let m=entry.model;(m.id.clone(),json!({"id":m.id,"name":m.name,"context":m.context,"protocol":entry.protocol.label(),"capabilities":{"toolcall":entry.tools,"vision":entry.vision}}))}).collect();
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
    async fn catalog_entry(&self, id: &str) -> Result<CatalogModel> {
        let credential = self.token().await?;
        let stale = {
            let catalog = self.catalog.lock().await;
            catalog.0 != credential || catalog.1.is_empty()
        };
        let expired = self
            .catalog_at
            .lock()
            .await
            .is_none_or(|at| at.elapsed() > Duration::from_secs(60));
        if stale || expired {
            let _gate = self.catalog_gate.lock().await;
            let stale = {
                let catalog = self.catalog.lock().await;
                catalog.0 != credential || catalog.1.is_empty()
            };
            let expired = self
                .catalog_at
                .lock()
                .await
                .is_none_or(|at| at.elapsed() > Duration::from_secs(60));
            if stale || expired {
                *self.catalog.lock().await = (String::new(), Vec::new());
                *self.catalog_at.lock().await = None;
                self.discover_models().await?;
            }
        }
        let catalog = self.catalog.lock().await;
        if catalog.0 != credential {
            return Err("GitHub account changed; refresh model selection".into());
        }
        catalog
            .1
            .iter()
            .find(|entry| entry.model.id == id)
            .cloned()
            .ok_or("Select a model available to your Copilot account".into())
    }
    async fn confirm_catalog(&self, credential: &str, entry: &CatalogModel) -> Result<()> {
        let catalog = self.catalog.lock().await;
        if catalog.0 != credential {
            return Err(
                "Model discovery failed or GitHub account changed; refresh model selection".into(),
            );
        }
        if !catalog.1.iter().any(|current| {
            current.model.id == entry.model.id
                && current.protocol == entry.protocol
                && current.tools == entry.tools
                && current.output == entry.output
                && current.input == entry.input
                && current.vision == entry.vision
        }) {
            return Err("Copilot model capabilities changed; refresh selection".into());
        }
        Ok(())
    }
    pub async fn model(&self, id: &str) -> Result<Model> {
        Ok(self.catalog_entry(id).await?.model)
    }
    pub async fn check_images(&self, id: &str) -> Result<()> {
        if self.catalog_entry(id).await?.vision == Some(false) {
            return Err(
                "The selected model does not support images. Choose an image-capable model.".into(),
            );
        }
        Ok(())
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
fn catalog_models(value: &Value) -> Vec<CatalogModel> {
    let mut ids = std::collections::HashSet::new();
    value["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200)?;
            if m["capabilities"]["type"]
                .as_str()
                .is_some_and(|kind| kind != "chat")
                || m["capabilities"]["supports"]["streaming"] == false
                || m["policy"]["state"]
                    .as_str()
                    .is_some_and(|state| state != "enabled")
            {
                return None;
            }
            if !(m["model_picker_enabled"] == true
                || m["model_picker_category"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                || m["policy"]["state"] == "enabled"
                || m["is_chat_default"] == true)
            {
                return None;
            }
            let protocol = Protocol::select(m)?;
            if !ids.insert(id.to_string()) {
                return None;
            }
            let limits = &m["capabilities"]["limits"];
            let output = limits["max_output_tokens"]
                .as_u64()
                .unwrap_or(8192)
                .clamp(1, 8192) as usize;
            let context = limits["max_context_window_tokens"]
                .as_u64()
                .or_else(|| limits["max_prompt_tokens"].as_u64())
                .unwrap_or(32_000)
                .clamp(1, 2_000_000) as usize;
            let output = if limits["max_context_window_tokens"].is_u64()
                || !limits["max_prompt_tokens"].is_u64()
            {
                output.min((context / 4).max(1))
            } else {
                output
            };
            let input = limits["max_prompt_tokens"]
                .as_u64()
                .map(|n| n.min(2_000_000) as usize)
                .unwrap_or(context.saturating_sub(output))
                .min(if limits["max_context_window_tokens"].is_u64() {
                    context.saturating_sub(output)
                } else {
                    context
                });
            Some(CatalogModel {
                model: Model {
                    id: id.into(),
                    name: m["name"].as_str().unwrap_or(id).into(),
                    context,
                },
                protocol,
                output,
                input,
                tools: m["capabilities"]["supports"]["tool_calls"] == true,
                vision: m["capabilities"]["supports"]["vision"].as_bool(),
            })
        })
        .collect()
}
pub fn parse_models(value: &Value) -> Vec<Model> {
    catalog_models(value)
        .into_iter()
        .map(|entry| entry.model)
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
    pub fn end(&mut self) -> Result<Vec<String>> {
        if self.buffer.is_empty() || self.done {
            return Ok(vec![]);
        }
        self.push(b"\n")
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
            if !serde_json::from_str::<Value>(&call.arguments)
                .map_err(|_| "Tool arguments are not complete JSON")?
                .is_object()
            {
                return Err("Tool arguments must be a JSON object".into());
            }
        }
        if !self.calls.is_empty() && self.reason.as_deref() != Some("tool_calls") {
            return Err("Provider did not finish its tool-call response".into());
        }
        Ok(Completion {
            text: self.text,
            calls: self.calls.into_values().collect(),
            reason: self.reason.unwrap(),
            opaque: self.opaque,
            state: None,
        })
    }
}

impl Inference for Copilot {
    fn limits<'a>(&'a self, model: &'a Model) -> BoxFuture<'a, Result<crate::context::Limits>> {
        Box::pin(async move {
            let entry = self.catalog_entry(&model.id).await?;
            Ok(crate::context::Limits {
                input: entry.input,
                output: entry.output,
            })
        })
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        output: Option<usize>,
        initiator: &'a str,
        cancel: CancellationToken,
        deltas: mpsc::Sender<String>,
    ) -> BoxFuture<'a, InferenceResult> {
        Box::pin(async move {
            let entry = self.catalog_entry(model).await?;
            let catalog_guard = self.catalog_gate.lock().await;
            if !entry.tools && !tools.is_empty() {
                return Err(
                    "This catalog model explicitly does not support coding tool calls".into(),
                );
            }
            let images = crate::images::has_images(&messages);
            if images && entry.vision == Some(false) {
                return Err("The selected model no longer supports images".into());
            }
            let payload = wire::body(
                entry.protocol,
                model,
                &messages,
                &tools,
                output.unwrap_or(entry.output).clamp(1, entry.output),
            )?;
            let (request, credential, used_token) = self
                .request(reqwest::Method::POST, entry.protocol.path())
                .await?;
            self.confirm_catalog(&credential, &entry).await?;
            drop(catalog_guard);
            let mut request = request
                .header("x-initiator", initiator)
                .header("X-Interaction-Id", uuid::Uuid::new_v4().to_string())
                .json(&payload)
                .timeout(Duration::from_secs(300));
            if images {
                request = request.header("Copilot-Vision-Request", "true");
            }
            if matches!(entry.protocol, Protocol::Messages | Protocol::MessagesV1) {
                request = request
                    .header("anthropic-version", "2023-06-01")
                    .header("anthropic-beta", "interleaved-thinking-2025-05-14");
            }
            let response = tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),response=request.send()=>response.map_err(|_|"Copilot inference connection failed")?};
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                self.invalidate(&used_token).await;
            }
            if !response.status().is_success() {
                let message = format!(
                    "{} No inference request was retried.",
                    response_error("inference", response.status(), response.headers())
                );
                return Err(inference_error(response, message, cancel).await);
            }
            read_completion(response, entry.protocol, model, cancel, deltas)
                .await
                .map_err(Into::into)
        })
    }
}

pub async fn read_completion(
    response: reqwest::Response,
    protocol: Protocol,
    model: &str,
    cancel: CancellationToken,
    deltas: mpsc::Sender<String>,
) -> Result<Completion> {
    let mut stream = response.bytes_stream();
    let mut chat = StreamDecoder::default();
    let mut native = wire::Decoder::new(protocol, model);
    loop {
        let chunk = tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),chunk=stream.next()=>chunk};
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|_| "Inference stream disconnected; no tools executed")?;
        let text = if protocol == Protocol::Chat {
            chat.push(&chunk)?
        } else {
            native.push(&chunk)?
        };
        for text in text {
            tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),result=deltas.send(text)=>{let _=result;}}
        }
        if if protocol == Protocol::Chat {
            chat.is_done()
        } else {
            native.done()
        } {
            break;
        }
    }
    let trailing = if protocol == Protocol::Chat {
        chat.end()?
    } else {
        native.end()?
    };
    for text in trailing {
        tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),result=deltas.send(text)=>{let _=result;}}
    }
    if cancel.is_cancelled() {
        return Err("Cancelled".into());
    }
    if protocol == Protocol::Chat {
        chat.finish()
    } else {
        native.finish()
    }
}

pub type Provider = Arc<dyn Inference>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_exchange_and_inference_share_roxy_editor_profile() {
        let provider = Copilot::new(Path::new("/unused-test"));
        let exchange = editor_request(
            provider
                .client
                .get("https://api.github.com/copilot_internal/v2/token")
                .header("Authorization", "token oauth-fixture"),
        )
        .build()
        .unwrap();
        let access = CopilotToken {
            oauth: "oauth-fixture".into(),
            token: "copilot-fixture".into(),
            base: "https://api.enterprise.githubcopilot.com".into(),
            renew: Instant::now() + Duration::from_secs(60),
        };
        let inference = provider
            .api_request(reqwest::Method::POST, "/chat/completions", &access)
            .build()
            .unwrap();
        for request in [&exchange, &inference] {
            assert_eq!(request.headers()["user-agent"], "GitHubCopilotChat/0.26.7");
            assert_eq!(request.headers()["editor-version"], "vscode/1.99.3");
            assert_eq!(
                request.headers()["editor-plugin-version"],
                "copilot-chat/0.26.7"
            );
            assert_eq!(request.headers()["copilot-integration-id"], "vscode-chat");
            assert_eq!(request.headers()["accept"], "application/json");
        }
        assert_eq!(exchange.headers()["authorization"], "token oauth-fixture");
        assert_eq!(
            inference.headers()["authorization"],
            "Bearer copilot-fixture"
        );
        assert_eq!(inference.headers()["openai-intent"], "conversation-panel");
        assert_eq!(
            inference.url().host_str(),
            Some("api.enterprise.githubcopilot.com")
        );
    }

    #[tokio::test]
    async fn model_discovery_sends_required_headers_to_assigned_host() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                received.extend_from_slice(&buffer[..count]);
                assert!(received.len() < 16384);
                if received.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(received).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /models http/1.1\r\n"));
            for header in [
                "user-agent: githubcopilotchat/0.26.7",
                "editor-version: vscode/1.99.3",
                "editor-plugin-version: copilot-chat/0.26.7",
                "copilot-integration-id: vscode-chat",
                "accept: application/json",
                "content-type: application/json",
                "openai-intent: model-access",
                "x-github-api-version: 2026-01-09",
                "authorization: bearer copilot-fixture",
            ] {
                assert!(
                    request.lines().any(|line| line == header),
                    "Missing {header}"
                );
            }
            assert!(!request.contains("oauth-fixture"));
            let body=json!({"data":[{"id":"fixture-chat","name":"Fixture","model_picker_enabled":true,"capabilities":{"type":"chat","supports":{"tool_calls":true}}}]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let provider = Copilot::new(Path::new("/unused-test"));
        let access = CopilotToken {
            oauth: "oauth-fixture".into(),
            token: "copilot-fixture".into(),
            base: format!("http://{address}"),
            renew: Instant::now() + Duration::from_secs(60),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            provider
                .api_request(reqwest::Method::GET, "/models", &access)
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.status().is_success());
        assert_eq!(
            parse_models(&result.json::<Value>().await.unwrap())[0].id,
            "fixture-chat"
        );
        server.await.unwrap();
    }

    #[test]
    fn request_errors_are_not_reported_as_entitlement_failures() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-request-id", "request-123".parse().unwrap());
        let error = response_error(
            "model discovery",
            reqwest::StatusCode::BAD_REQUEST,
            &headers,
        );
        assert!(error.contains("Request ID: request-123"));
        assert!(error.contains("request format or client headers"));
        assert!(!error.contains("may not be entitled"));
        assert!(!error.contains("private provider body"));
        for (status, recovery) in [
            (401, "Reconnect GitHub"),
            (403, "subscription"),
            (429, "rate limiting"),
            (503, "temporarily unavailable"),
        ] {
            assert!(response_error(
                "model discovery",
                reqwest::StatusCode::from_u16(status).unwrap(),
                &headers
            )
            .contains(recovery));
        }
    }

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
    fn catalog_separates_input_output_and_combined_context_limits() {
        for (limits, context, input, output) in [
            (
                json!({"max_prompt_tokens":8192,"max_output_tokens":8192}),
                8192,
                8192,
                8192,
            ),
            (
                json!({"max_prompt_tokens":100_000,"max_output_tokens":4096}),
                100_000,
                100_000,
                4096,
            ),
            (
                json!({"max_context_window_tokens":100_000,"max_output_tokens":4096}),
                100_000,
                95_904,
                4096,
            ),
            (
                json!({"max_context_window_tokens":100_000,"max_prompt_tokens":90_000,"max_output_tokens":4096}),
                100_000,
                90_000,
                4096,
            ),
            (
                json!({"max_context_window_tokens":100_000,"max_prompt_tokens":100_000,"max_output_tokens":4096}),
                100_000,
                95_904,
                4096,
            ),
            (
                json!({"max_context_window_tokens":1024,"max_output_tokens":8192}),
                1024,
                768,
                256,
            ),
        ] {
            let entries = catalog_models(
                &json!({"data":[{"id":"fixture","model_picker_enabled":true,"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":limits}}]}),
            );
            assert_eq!(entries.len(), 1);
            assert_eq!(
                (
                    entries[0].model.context,
                    entries[0].input,
                    entries[0].output
                ),
                (context, input, output)
            );
        }
    }

    #[tokio::test]
    async fn http_context_errors_are_typed_bounded_and_do_not_expose_provider_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, overflow) in [
            (
                400,
                json!({"error":{"code":"context_length_exceeded","message":"SECRET prompt"}})
                    .to_string(),
                true,
            ),
            (
                422,
                json!({"error":{"type":"prompt_too_long","message":"SECRET prompt"}}).to_string(),
                true,
            ),
            (
                400,
                json!({"error":{"code":"invalid_request_error","message":"context window SECRET"}})
                    .to_string(),
                false,
            ),
            (
                401,
                json!({"error":{"code":"context_length_exceeded","message":"SECRET"}}).to_string(),
                false,
            ),
            (
                413,
                format!(
                    "{{\"error\":{{\"code\":\"context_length_exceeded\",\"message\":\"{}\"}}}}",
                    "SECRET".repeat(4000)
                ),
                false,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                let response = format!("HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            let error =
                inference_error(response, "safe fallback".into(), CancellationToken::new()).await;
            assert_eq!(matches!(error, InferenceError::ContextOverflow), overflow);
            assert!(!error.to_string().contains("SECRET"));
            server.await.unwrap();
        }
    }

    #[test]
    fn models_accept_optional_streaming_metadata() {
        let value = json!({"data":[{"id":"chat","name":"Chat","policy":{"state":"enabled"},"capabilities":{"supports":{"tool_calls":true}}}]});
        assert_eq!(parse_models(&value).len(), 1);
    }
    #[tokio::test]
    async fn inference_catalog_validation_waits_for_refresh() {
        let provider = Copilot::new(Path::new("/unused-test"));
        let entry = CatalogModel {
            model: Model {
                id: "fixture".into(),
                name: "Fixture".into(),
                context: 32_000,
            },
            protocol: Protocol::Responses,
            output: 8192,
            input: 24_000,
            tools: true,
            vision: Some(true),
        };
        let gate = provider.catalog_gate.lock().await;
        *provider.catalog.lock().await = (String::new(), vec![]);
        let owner = provider.clone();
        let expected = entry.clone();
        let mut check = tokio::spawn(async move {
            let _gate = owner.catalog_gate.lock().await;
            owner.confirm_catalog("credential", &expected).await
        });
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut check)
            .await
            .is_err());
        *provider.catalog.lock().await = ("credential".into(), vec![entry.clone()]);
        drop(gate);
        assert!(check.await.unwrap().is_ok());
        *provider.catalog.lock().await = (String::new(), vec![]);
        assert!(provider
            .confirm_catalog("credential", &entry)
            .await
            .is_err());
    }
    #[test]
    fn catalog_routes_all_account_coding_families_and_rejects_nonchat_disabled() {
        let mut data = Vec::new();
        for (id, endpoints) in [
            ("chat", json!(["/chat/completions"])),
            ("responses", json!(["/responses"])),
            ("claude", json!(["/v1/messages"])),
            ("messages", json!(["/messages"])),
        ] {
            data.push(json!({"id":id,"name":id,"model_picker_enabled":true,"supported_endpoints":endpoints,"capabilities":{"type":"chat","supports":{"tool_calls":true},"limits":{"max_prompt_tokens":100_000,"max_output_tokens":4096}}}));
        }
        data.push(json!({"id":"disabled","model_picker_enabled":true,"policy":{"state":"disabled"},"capabilities":{"type":"chat","supports":{"tool_calls":true}}}));
        data.push(json!({"id":"embedding","model_picker_enabled":true,"capabilities":{"type":"embeddings"}}));
        data.push(json!({"id":"unknown","model_picker_enabled":true,"supported_endpoints":["/future-protocol"]}));
        let entries = catalog_models(&json!({"data":data}));
        assert_eq!(entries.len(), 4);
        for entry in entries {
            assert!(entry.tools);
            assert_eq!(entry.model.context, 100_000);
            assert_eq!(entry.output, 4096);
            assert_eq!(
                entry.protocol.label(),
                match entry.model.id.as_str() {
                    "chat" => "chat",
                    "responses" => "responses",
                    _ => "messages",
                }
            );
        }
        for value in [Value::Bool(true), Value::Bool(false), Value::Null] {
            let entries = catalog_models(
                &json!({"data":[{"id":"x","model_picker_enabled":true,"capabilities":{"type":"chat","supports":{"tool_calls":value}}}]}),
            );
            assert_eq!(entries[0].tools, value == true);
        }
        assert!(
            catalog_models(&json!({"data":[{"id":"x","model_picker_category":"  "}]})).is_empty()
        );
    }
    #[test]
    fn catalog_includes_responses_only_models() {
        assert_eq!(parse_models(&json!({"data":[{"id":"x","name":"x","model_picker_enabled":true,"supported_endpoints":["/responses"],"capabilities":{"supports":{"streaming":true,"tool_calls":true}}}]})).len(),1);
    }
}
