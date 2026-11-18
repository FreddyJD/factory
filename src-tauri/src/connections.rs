use crate::{
    provider::{Copilot, Inference, Model, StreamDecoder},
    repository,
    workspace::Result,
};
use futures_util::{future::BoxFuture, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model_id: String,
    pub context: usize,
    pub has_key: bool,
    #[serde(default = "default_output")]
    pub output: usize,
    #[serde(default)]
    pub output_parameter: OutputParameter,
}
fn default_output() -> usize {
    4096
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputParameter {
    #[default]
    ProviderDefault,
    MaxTokens,
    MaxCompletionTokens,
}
impl Endpoint {
    fn limits(&self) -> crate::context::Limits {
        let mut limits = crate::context::Limits::window(self.context);
        limits.output = self.output.clamp(1, limits.output);
        limits.input = self.context.saturating_sub(limits.output);
        limits
    }
}
pub struct Providers {
    root: PathBuf,
    pub copilot: Arc<Copilot>,
    client: reqwest::Client,
    gate: Mutex<()>,
}
impl Providers {
    pub fn new(root: &Path, copilot: Arc<Copilot>) -> Self {
        Self {
            root: root.into(),
            copilot,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP client"),
            gate: Mutex::new(()),
        }
    }
    fn key(&self, id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(
            "com.freddyjd.factory.endpoint",
            &format!("{}:{id}", self.root.display()),
        )
        .map_err(|e| format!("OS credential store unavailable: {e}"))
    }
    pub fn list(&self) -> Result<Vec<Endpoint>> {
        match std::fs::read(self.root.join("providers.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(error) => Err(error.to_string()),
        }
    }
    async fn file_gate(&self) -> Result<std::fs::File> {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("providers.lock"))
            .map_err(|e| e.to_string())?;
        for _ in 0..100 {
            if fs2::FileExt::try_lock_exclusive(&lock).is_ok() {
                return Ok(lock);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err("Provider configuration is busy".into())
    }
    pub async fn save(&self, args: &Value) -> Result<Value> {
        let _gate = self.gate.lock().await;
        let _file_gate = self.file_gate().await?;
        let base = base_url(args["baseUrl"].as_str().ok_or("Enter an API base URL")?)?;
        let name = args["name"].as_str().unwrap_or("OpenAI compatible").trim();
        let model = args["modelId"].as_str().unwrap_or("").trim();
        if name.is_empty()
            || name.len() > 100
            || model.is_empty()
            || model.len() > 200
            || model.chars().any(char::is_control)
        {
            return Err("Enter a connection name and model ID".into());
        }
        let mut endpoints = self.list()?;
        let id = if let Some(id) = args["id"].as_str() {
            if !endpoints.iter().any(|e| e.id == id) {
                return Err("Unknown provider connection".into());
            }
            id.to_string()
        } else {
            uuid::Uuid::new_v4().simple().to_string()
        };
        let old = endpoints.iter().find(|e| e.id == id);
        if old.is_some_and(|e| e.base_url != base || e.model_id != model) {
            return Err("Endpoint URL and model are immutable for an existing connection. Add a new connection so retained issues cannot send history to a different destination.".into());
        }
        let supplied = args["apiKey"].as_str().filter(|s| !s.is_empty());
        if supplied.is_some_and(|s| s.len() > 16_000 || s.chars().any(char::is_control)) {
            return Err("Invalid API key".into());
        }
        if supplied.is_some() && args["clearKey"] == true {
            return Err("Supply a new API key or remove the saved key, not both".into());
        }
        let output_parameter = match args.get("outputParameter") {
            Some(value) => {
                serde_json::from_value(value.clone()).map_err(|_| "Invalid output parameter")?
            }
            None => old.map_or(OutputParameter::default(), |e| e.output_parameter),
        };
        let mut has_key = old.is_some_and(|e| e.has_key);
        if let Some(key) = supplied {
            self.key(&id)?
                .set_password(key)
                .map_err(|e| format!("Could not save API key: {e}"))?;
            has_key = true;
        }
        if args["clearKey"] == true {
            match self.key(&id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => return Err(error.to_string()),
            }
            has_key = false;
        }
        let endpoint = Endpoint {
            id: id.clone(),
            name: name.into(),
            base_url: base,
            model_id: model.into(),
            context: args["context"]
                .as_u64()
                .unwrap_or(32_000)
                .clamp(16_384, 1_000_000) as usize,
            has_key,
            output: args["output"]
                .as_u64()
                .map(|n| n.clamp(1, 8192) as usize)
                .unwrap_or_else(|| old.map_or(default_output(), |e| e.output)),
            output_parameter,
        };
        endpoints.retain(|e| e.id != id);
        endpoints.push(endpoint);
        repository::store(&self.root.join("providers.json"), &endpoints)?;
        Ok(json!(endpoints))
    }
    pub async fn remove(&self, id: &str) -> Result<Value> {
        let _gate = self.gate.lock().await;
        let _file_gate = self.file_gate().await?;
        let mut list = self.list()?;
        let removed = list
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or("Unknown provider")?;
        list.retain(|e| e.id != id);
        repository::store(&self.root.join("providers.json"), &list)?;
        if !removed.has_key {
            return Ok(json!(list));
        }
        match self.key(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                return Err(format!(
                    "Connection removed; could not delete its OS credential: {e}"
                ))
            }
        }
        Ok(json!(list))
    }
    fn endpoint(&self, id: &str) -> Result<Endpoint> {
        self.list()?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or("Provider connection no longer exists".into())
    }
    fn request(&self, endpoint: &Endpoint, path: &str) -> Result<reqwest::RequestBuilder> {
        let base = base_url(&endpoint.base_url)?;
        let mut request = self.client.get(format!("{base}/{path}"));
        if endpoint.has_key {
            let key = self
                .key(&endpoint.id)?
                .get_password()
                .map_err(|_| "API key unavailable; re-enter it in Settings")?;
            request = request.bearer_auth(key);
        }
        Ok(request)
    }
    pub async fn check(&self, id: &str) -> Result<Value> {
        let endpoint = self.endpoint(id)?;
        let response = self
            .request(&endpoint, "models")?
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| "Could not connect to endpoint")?;
        if !response.status().is_success() {
            return Err(format!("Model discovery HTTP {}. Manual model configuration can still be used if this endpoint does not expose /models.",response.status()));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Endpoint returned an invalid model catalog")?;
        Ok(
            json!({"models":value["data"],"message":"Endpoint reachable. Model discovery does not verify tool-calling support."}),
        )
    }
    pub async fn models(&self) -> Result<Value> {
        let mut all = Vec::new();
        let mut connected = Vec::new();
        let mut errors = Vec::new();
        for endpoint in self.list()? {
            all.push(json!({"id":endpoint.id,"name":endpoint.name,"models":{endpoint.model_id.clone():{"id":format!("endpoint:{}/{}",endpoint.id,endpoint.model_id),"name":format!("{} / {}",endpoint.name,endpoint.model_id),"capabilities":{"toolcall":true}}}}));
            connected.push(json!(endpoint.id));
        }
        match tokio::time::timeout(
            Duration::from_secs(if all.is_empty() { 45 } else { 5 }),
            self.copilot.models(),
        )
        .await
        .unwrap_or_else(|_| {
            Err(
                "GitHub model discovery timed out; configured endpoint models remain available"
                    .into(),
            )
        }) {
            Ok(value) => {
                all.extend(value["all"].as_array().cloned().unwrap_or_default());
                connected.extend(value["connected"].as_array().cloned().unwrap_or_default());
            }
            Err(error) => errors.push(error),
        }
        Ok(json!({"all":all,"connected":connected,"errors":errors}))
    }
    pub async fn model(&self, selection: &str) -> Result<Model> {
        if let Some((id, model)) = split(selection) {
            let endpoint = self.endpoint(id)?;
            if endpoint.model_id != model {
                return Err("Configured model changed. Create a new issue or restore the original model in Settings.".into());
            }
            return Ok(Model {
                id: selection.into(),
                name: format!("{} / {model}", endpoint.name),
                context: endpoint.context,
            });
        }
        self.copilot.model(selection).await
    }
    pub async fn check_images(&self, selection: &str) -> Result<()> {
        if split(selection).is_some() {
            // Manually configured endpoints do not expose reliable vision metadata.
            // Send multipart input unchanged; provider rejection remains visible.
            self.model(selection).await?;
            Ok(())
        } else {
            self.copilot.check_images(selection).await
        }
    }
}
pub fn split(selection: &str) -> Option<(&str, &str)> {
    selection.strip_prefix("endpoint:")?.split_once('/')
}
pub fn base_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "Enter a complete API base URL, for example https://api.openai.com/v1")?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use HTTPS, or HTTP on localhost only, without credentials, query or fragment".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
impl Inference for Providers {
    fn limits<'a>(&'a self, model: &'a Model) -> BoxFuture<'a, Result<crate::context::Limits>> {
        Box::pin(async move {
            if let Some((id, _)) = split(&model.id) {
                self.model(&model.id).await?;
                Ok(self.endpoint(id)?.limits())
            } else {
                self.copilot.limits(model).await
            }
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
    ) -> BoxFuture<'a, crate::provider::InferenceResult> {
        Box::pin(async move {
            let Some((id, model)) = split(model) else {
                return self
                    .copilot
                    .complete(model, messages, tools, output, initiator, cancel, deltas)
                    .await;
            };
            let endpoint = self.endpoint(id)?;
            if endpoint.model_id != model {
                return Err("Provider model changed; execution stopped".into());
            }
            let base = base_url(&endpoint.base_url)?;
            let output = output
                .unwrap_or(endpoint.limits().output)
                .clamp(1, endpoint.limits().output);
            let mut payload = json!({"model":model,"messages":crate::wire::chat_messages(&messages,false),"stream":true});
            if !tools.is_empty() {
                payload["tools"] = json!(tools);
            }
            match endpoint.output_parameter {
                OutputParameter::ProviderDefault => (),
                OutputParameter::MaxTokens => payload["max_tokens"] = json!(output),
                OutputParameter::MaxCompletionTokens => {
                    payload["max_completion_tokens"] = json!(output)
                }
            }
            let mut request = self
                .client
                .post(format!("{base}/chat/completions"))
                .json(&payload)
                .timeout(Duration::from_secs(300));
            if endpoint.has_key {
                request = request.bearer_auth(
                    self.key(id)?
                        .get_password()
                        .map_err(|_| "API key unavailable; reconnect in Settings")?,
                );
            }
            let response = tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),response=request.send()=>response.map_err(|_|"Inference endpoint could not connect")?};
            if !response.status().is_success() {
                let message = format!(
                    "Inference endpoint HTTP {}. No request was retried.",
                    response.status()
                );
                return Err(crate::provider::inference_error(response, message, cancel).await);
            }
            let mut stream = response.bytes_stream();
            let mut decoder = StreamDecoder::default();
            loop {
                tokio::select! {biased;_ = cancel.cancelled()=>return Err("Cancelled".into()),chunk=stream.next()=>match chunk{Some(chunk)=>{for text in decoder.push(&chunk.map_err(|_|"Inference stream disconnected")?)?{let _=deltas.send(text).await;}},None=>break}}
                if decoder.is_done() {
                    break;
                }
            }
            decoder.finish().map_err(Into::into)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn immutable_destinations_prevent_retained_issue_redirection() {
        let root = std::env::temp_dir().join(format!("providers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let providers = Providers::new(&root, Arc::new(Copilot::new(&root)));
        let list = providers
            .save(&json!({"baseUrl":"http://127.0.0.1:8080/v1","modelId":"model","name":"local"}))
            .await
            .unwrap();
        let id = list[0]["id"].as_str().unwrap();
        assert!(providers.save(&json!({"id":id,"baseUrl":"https://other.example/v1","modelId":"model","apiKey":"must-not-be-saved"})).await.is_err());
        assert!(providers
            .save(&json!({"id":id,"baseUrl":"http://127.0.0.1:8080/v1","modelId":"different"}))
            .await
            .is_err());
        assert_eq!(
            providers
                .model(&format!("endpoint:{id}/model"))
                .await
                .unwrap()
                .id,
            format!("endpoint:{id}/model")
        );
        providers.remove(id).await.unwrap();
        assert!(providers.list().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn native_http_request_preserves_prefix_and_routes_model_without_github() {
        for (parameter, field) in [
            ("provider_default", None),
            ("max_tokens", Some("max_tokens")),
            ("max_completion_tokens", Some("max_completion_tokens")),
        ] {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0; 16384];
                let mut bytes = Vec::new();
                loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..index]);
                        let length = headers
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|n| n.parse::<usize>().ok())
                            })
                            .unwrap();
                        if bytes.len() >= index + 4 + length {
                            assert!(headers.starts_with("POST /gateway/v1/chat/completions "));
                            assert!(!headers.to_lowercase().contains("authorization:"));
                            let body: Value = serde_json::from_slice(&bytes[index + 4..]).unwrap();
                            assert_eq!(body["model"], "provider/model");
                            assert_eq!(body["stream"], true);
                            assert!(body.get("tools").is_none());
                            if let Some(field) = field {
                                assert_eq!(body[field], 512);
                            } else {
                                assert!(body.get("max_tokens").is_none());
                                assert!(body.get("max_completion_tokens").is_none());
                            }
                            break;
                        }
                    }
                }
                let body="data: {\"choices\":[{\"delta\":{\"content\":\"native endpoint\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let root =
                std::env::temp_dir().join(format!("native-provider-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let providers = Providers::new(&root, Arc::new(Copilot::new(&root)));
            let endpoints=providers.save(&json!({"baseUrl":format!("http://{address}/gateway/v1/"),"modelId":"provider/model","output":1024,"outputParameter":parameter})).await.unwrap();
            let selection = format!(
                "endpoint:{}/provider/model",
                endpoints[0]["id"].as_str().unwrap()
            );
            let (tx, mut rx) = mpsc::channel(10);
            let result = providers
                .complete(
                    &selection,
                    vec![json!({"role":"user","content":"test"})],
                    vec![],
                    Some(512),
                    "user",
                    CancellationToken::new(),
                    tx,
                )
                .await
                .unwrap();
            assert_eq!(result.text, "native endpoint");
            assert_eq!(rx.recv().await.unwrap(), "native endpoint");
            server.await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn retained_connections_load_with_compatible_output_defaults() {
        let endpoint: Endpoint = serde_json::from_value(json!({"id":"old","name":"Old","baseUrl":"http://localhost/v1","modelId":"test","context":128000,"hasKey":false})).unwrap();
        assert!(matches!(
            endpoint.output_parameter,
            OutputParameter::ProviderDefault
        ));
        assert_eq!(endpoint.limits().output, 4096);
        assert_eq!(endpoint.limits().input, 123904);
    }

    #[test]
    fn validates_endpoint_boundaries() {
        assert_eq!(
            base_url("http://localhost:11434/v1/").unwrap(),
            "http://localhost:11434/v1"
        );
        for url in [
            "http://example.com/v1",
            "https://user:key@example.com/v1",
            "https://example.com/v1?key=x",
            "file:///x",
        ] {
            assert!(base_url(url).is_err());
        }
        assert_eq!(
            split("endpoint:abc/provider/model"),
            Some(("abc", "provider/model"))
        );
    }
}
