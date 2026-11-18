use crate::{issues, repository, workspace::Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::RwLock;

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub login: String,
}

pub struct Accounts {
    root: PathBuf,
    pub gate: RwLock<()>,
}

// Secrets stay in the OS credential store and operation-scoped child environments.
pub struct Auth {
    pub account: Option<Account>,
    token: Option<String>,
}

impl Accounts {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            gate: RwLock::new(()),
        }
    }
    pub fn list(&self) -> Result<Vec<Account>> {
        match fs::read(self.root.join("github-accounts.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Cannot read saved GitHub accounts".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err("Cannot read saved GitHub accounts".into()),
        }
    }
    pub async fn file_gate(&self, exclusive: bool) -> Result<fs::File> {
        repository::file_gate(&self.root, "github-accounts.lock", exclusive).await
    }
    fn entry(&self, id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(
            "com.freddyjd.gitfactory.repositories",
            &format!("{}:{id}", self.root.display()),
        )
        .map_err(|_| "OS credential store unavailable".into())
    }
    pub async fn save(&self, token: &str) -> Result<Vec<Account>> {
        if token.is_empty()
            || token.len() > 500
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err("Enter a GitHub personal access token".into());
        }
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not initialize GitHub connection")?
            .get("https://api.github.com/user")
            .header(
                "User-Agent",
                concat!("GitFactory/", env!("CARGO_PKG_VERSION")),
            )
            .header("Accept", "application/vnd.github+json")
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not verify GitHub account; check your connection")?;
        if !response.status().is_success() {
            return Err(format!(
                "GitHub account verification: HTTP {}. Check the token and enterprise policies.",
                response.status().as_u16()
            ));
        }
        let identity: Value = response
            .json()
            .await
            .map_err(|_| "Invalid GitHub identity response")?;
        let account = Account {
            id: identity["id"]
                .as_u64()
                .ok_or("Missing GitHub account ID")?
                .to_string(),
            login: identity["login"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing GitHub login")?
                .into(),
        };
        let _guard = self.gate.write().await;
        let _file = self.file_gate(true).await?;
        let mut accounts = self.list()?;
        self.entry(&account.id)?
            .set_password(token)
            .map_err(|_| "Could not save GitHub token to the OS credential store")?;
        accounts.retain(|a| a.id != account.id);
        accounts.push(account);
        accounts.sort_by(|a, b| a.login.cmp(&b.login));
        repository::store(&self.root.join("github-accounts.json"), &accounts)?;
        Ok(accounts)
    }
    // Caller holds the write gate and checks repository references before removal.
    pub fn remove(&self, id: &str) -> Result<Vec<Account>> {
        let mut accounts = self.list()?;
        if !accounts.iter().any(|a| a.id == id) {
            return Err("GitHub account is not connected".into());
        }
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                return Err("Could not remove GitHub token from the OS credential store".into())
            }
        }
        accounts.retain(|a| a.id != id);
        repository::store(&self.root.join("github-accounts.json"), &accounts)?;
        Ok(accounts)
    }
    pub fn resolve(&self, id: Option<&str>) -> Result<Auth> {
        let Some(id) = id else {
            return Ok(Auth {
                account: None,
                token: None,
            });
        };
        let account = self
            .list()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Selected GitHub account is unavailable; choose an account in Settings")?;
        let token = self
            .entry(id)?
            .get_password()
            .map_err(|_| "Reconnect the selected GitHub account in Settings")?;
        Ok(Auth {
            account: Some(account),
            token: Some(token),
        })
    }
}

impl Auth {
    pub fn verify(&self, user: &Value) -> Result<()> {
        if let Some(account) = &self.account {
            if user["id"].as_u64().map(|id| id.to_string()).as_deref() != Some(account.id.as_str())
            {
                return Err(
                    "GitHub token belongs to a different account; reconnect in Settings".into(),
                );
            }
        }
        Ok(())
    }
    pub fn transport(&self, remote: &str) -> Result<String> {
        if self.token.is_some() {
            Ok(format!(
                "https://github.com/{}.git",
                issues::github_repo(remote)?
            ))
        } else {
            Ok(remote.into())
        }
    }
    pub async fn command(
        &self,
        executable: &Path,
        path: &Path,
        args: &[&str],
        input: Option<&[u8]>,
        seconds: u64,
        transport: Option<&str>,
    ) -> Result<Vec<u8>> {
        let mut environment = vec![
            ("GH_DEBUG", None),
            ("GIT_TRACE", None),
            ("GIT_TRACE_CURL", None),
            ("GIT_CURL_VERBOSE", None),
            ("GIT_TRACE_PACKET", None),
            ("GIT_TRACE2", Some("0")),
            ("GIT_TRACE2_EVENT", Some("0")),
            ("GIT_TRACE2_PERF", Some("0")),
            ("GIT_TRACE2_ENV_VARS", None),
            ("GIT_TRACE2_CONFIG_PARAMS", None),
        ];
        let header;
        let header_key;
        if let Some(token) = self.token.as_deref() {
            environment.extend([("GH_TOKEN", Some(token)), ("GITHUB_TOKEN", None)]);
            if let Some(url) = transport {
                header = format!(
                    "Authorization: Basic {}",
                    STANDARD.encode(format!("x-access-token:{token}"))
                );
                header_key = format!("http.{url}.extraHeader");
                environment.extend([
                    ("GIT_CONFIG_COUNT", Some("9")),
                    ("GIT_CONFIG_KEY_4", Some("credential.helper")),
                    ("GIT_CONFIG_VALUE_4", Some("")),
                    ("GIT_CONFIG_KEY_5", Some("http.extraHeader")),
                    ("GIT_CONFIG_VALUE_5", Some("")),
                    ("GIT_CONFIG_KEY_6", Some(header_key.as_str())),
                    ("GIT_CONFIG_VALUE_6", Some("")),
                    ("GIT_CONFIG_KEY_7", Some(header_key.as_str())),
                    ("GIT_CONFIG_VALUE_7", Some(header.as_str())),
                    ("GIT_CONFIG_KEY_8", Some("http.followRedirects")),
                    ("GIT_CONFIG_VALUE_8", Some("false")),
                ]);
            }
        }
        repository::command_env(executable, path, args, input, seconds, None, &environment)
            .await
            .map_err(|error| self.redact(&error))
    }
    fn redact(&self, error: &str) -> String {
        match &self.token {
            Some(token) => error.replace(token, "[redacted]").replace(
                &STANDARD.encode(format!("x-access-token:{token}")),
                "[redacted]",
            ),
            None => error.into(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn separate_instances_share_read_leases_and_serialize_configuration_writes() {
        let root = std::env::temp_dir().join(format!("github-locks-{}", uuid::Uuid::new_v4()));
        let a = Accounts::new(&root);
        let b = Accounts::new(&root);
        let first = a.file_gate(false).await.unwrap();
        let second = b.file_gate(false).await.unwrap();
        let mut writer = Box::pin(b.file_gate(true));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut writer)
                .await
                .is_err()
        );
        drop(first);
        drop(second);
        let exclusive = writer.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), a.file_gate(false))
                .await
                .is_err()
        );
        drop(exclusive);
        let lease = a.file_gate(false).await.unwrap();
        drop(lease);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn inherited_trace_and_git_parameters_cannot_expose_or_override_credentials() {
        const CHILD: &str = "FACTORY_TEST_ACCOUNT_ENV_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = PathBuf::from(root);
            let selected = auth("42");
            let output = selected
                .command(
                    Path::new("git"),
                    &root,
                    &[
                        "config",
                        "--get-urlmatch",
                        "http.followRedirects",
                        "https://github.com/owner/repo.git",
                    ],
                    None,
                    5,
                    Some("https://github.com/owner/repo.git"),
                )
                .await
                .unwrap();
            assert_eq!(String::from_utf8(output).unwrap().trim(), "false");
            assert!(!root.join("trace.json").exists());
            return;
        }
        let root = std::env::temp_dir().join(format!("github-env-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        crate::workspace::initialize_empty(&root).unwrap();
        let sink = root.join("trace.json");
        repository::git(
            &root,
            &["config", "trace2.eventTarget", sink.to_str().unwrap()],
        )
        .await
        .unwrap();
        repository::git(&root, &["config", "trace2.envVars", "GH_TOKEN"])
            .await
            .unwrap();
        repository::git(
            &root,
            &["config", "trace2.configParams", "http.*.extraHeader"],
        )
        .await
        .unwrap();
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github::tests::inherited_trace_and_git_parameters_cannot_expose_or_override_credentials", "--nocapture"])
            .env(CHILD, &root)
            .env("GIT_TRACE2_EVENT", &sink).env("GIT_TRACE2_ENV_VARS", "GH_TOKEN")
            .env("GIT_CONFIG_PARAMETERS", "'http.followRedirects=true' 'credential.helper=ambient-helper'")
            .output().await.unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!sink.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn auth(id: &str) -> Auth {
        Auth {
            account: Some(Account {
                id: id.into(),
                login: format!("account-{id}"),
            }),
            token: Some(format!("fixture_token_{id}")),
        }
    }

    #[test]
    fn missing_selected_accounts_fail_closed_and_tokens_are_redacted() {
        let root = std::env::temp_dir().join(format!("github-accounts-{}", uuid::Uuid::new_v4()));
        let accounts = Accounts::new(&root);
        assert!(accounts.list().unwrap().is_empty());
        assert!(accounts.resolve(None).unwrap().account.is_none());
        assert!(accounts.resolve(Some("42")).is_err());
        repository::store(
            &root.join("github-accounts.json"),
            &vec![Account {
                id: "42".into(),
                login: "personal".into(),
            }],
        )
        .unwrap();
        assert_eq!(accounts.list().unwrap()[0].login, "personal");
        let selected = auth("42");
        assert!(selected.verify(&json!({"id":42})).is_ok());
        assert!(selected.verify(&json!({"id":43})).is_err());
        assert!(selected.verify(&json!({"login":"account-42"})).is_err());
        assert_eq!(
            selected.transport("git@github.com:owner/repo.git").unwrap(),
            "https://github.com/owner/repo.git"
        );
        assert!(selected
            .transport("https://evil.example/owner/repo")
            .is_err());
        let raw = format!(
            "fixture_token_42 {}",
            STANDARD.encode("x-access-token:fixture_token_42")
        );
        assert_eq!(selected.redact(&raw), "[redacted] [redacted]");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_commands_use_only_their_selected_credentials_and_redact_errors() {
        let path = std::env::temp_dir();
        let a = auth("1");
        let b = auth("2");
        let args = [
            "-c",
            "printf '%s' \"$GH_TOKEN\"; test -z \"$GITHUB_TOKEN$GH_DEBUG$GIT_TRACE_CURL\"",
        ];
        let (first, second) = tokio::join!(
            a.command(Path::new("/bin/sh"), &path, &args, None, 5, None),
            b.command(Path::new("/bin/sh"), &path, &args, None, 5, None)
        );
        assert_eq!(first.unwrap(), b"fixture_token_1");
        assert_eq!(second.unwrap(), b"fixture_token_2");
        let error = a
            .command(
                Path::new("/bin/sh"),
                &path,
                &["-c", "printf '%s' \"$GH_TOKEN\" >&2; exit 1"],
                None,
                5,
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("[redacted]"));
        assert!(!error.contains("fixture_token"));
    }

    #[tokio::test]
    async fn git_transport_overrides_helpers_headers_and_redirects_without_persisting_secrets() {
        let root = std::env::temp_dir().join(format!("github-transport-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        crate::workspace::initialize_empty(&root).unwrap();
        let url = "https://github.com/owner/repo.git";
        repository::git(
            &root,
            &["config", "http.extraHeader", "Authorization: ambient"],
        )
        .await
        .unwrap();
        repository::git(
            &root,
            &[
                "config",
                &format!("http.{url}.extraHeader"),
                "Authorization: other-account",
            ],
        )
        .await
        .unwrap();
        repository::git(&root, &["config", "credential.helper", "ambient-helper"])
            .await
            .unwrap();
        let selected = auth("42");
        let headers = selected
            .command(
                Path::new("git"),
                &root,
                &["config", "--get-urlmatch", "http.extraHeader", url],
                None,
                5,
                Some(url),
            )
            .await
            .unwrap();
        let values = String::from_utf8(headers).unwrap();
        assert_eq!(
            values.trim(),
            format!(
                "Authorization: Basic {}",
                STANDARD.encode("x-access-token:fixture_token_42")
            )
        );
        let helpers = selected
            .command(
                Path::new("git"),
                &root,
                &["config", "--get-all", "credential.helper"],
                None,
                5,
                Some(url),
            )
            .await
            .unwrap();
        assert!(String::from_utf8(helpers).unwrap().ends_with("\n\n"));
        let redirects = selected
            .command(
                Path::new("git"),
                &root,
                &["config", "--get-urlmatch", "http.followRedirects", url],
                None,
                5,
                Some(url),
            )
            .await
            .unwrap();
        assert_eq!(String::from_utf8(redirects).unwrap().trim(), "false");
        assert!(!fs::read_to_string(root.join(".git/config"))
            .unwrap()
            .contains("fixture_token"));
        fs::remove_dir_all(root).unwrap();
    }
}
