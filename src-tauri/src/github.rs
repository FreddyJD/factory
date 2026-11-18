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
    #[serde(default)]
    pub source: Source,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Token,
    Gh,
    Gcm,
}

fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 100
        && login.as_bytes()[0].is_ascii_alphanumeric()
        && login
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
}

fn external_account(source: Source, login: &str) -> Option<Account> {
    if !valid_login(login) {
        return None;
    }
    let prefix = if source == Source::Gh { "gh" } else { "gcm" };
    Some(Account {
        id: format!("{prefix}:{}", login.to_ascii_lowercase()),
        login: login.into(),
        source,
    })
}

fn gcm_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GIT_FACTORY_GCM_PATH") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let executable = if cfg!(windows) {
        "git-credential-manager.exe"
    } else {
        "git-credential-manager"
    };
    let mut paths: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join(executable))
        .collect();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".local/gcm").join(executable));
    }
    for (variable, suffix) in [
        ("LOCALAPPDATA", "Programs/Git Credential Manager"),
        ("ProgramFiles", "Git Credential Manager"),
        ("ProgramFiles(x86)", "Git Credential Manager"),
        ("ProgramFiles", "Git/mingw64/bin"),
    ] {
        if let Some(root) = std::env::var_os(variable) {
            paths.push(PathBuf::from(root).join(suffix).join(executable));
        }
    }
    paths.extend(
        [
            "/usr/local/share/gcm-core/git-credential-manager",
            "/usr/local/bin/git-credential-manager",
            "/opt/homebrew/bin/git-credential-manager",
            "C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe",
            "C:\\Program Files\\Git Credential Manager\\git-credential-manager.exe",
        ]
        .map(PathBuf::from),
    );
    paths.into_iter().find(|p| p.is_file())
}

// Credential helpers can return secrets even on failure. Never surface their raw output.
async fn credential_command(
    executable: &Path,
    path: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let (mut output, stderr) = repository::command_output(executable, path, args, input, 20, None, &[
        ("GH_TOKEN", None), ("GITHUB_TOKEN", None), ("GH_DEBUG", None),
        ("GCM_INTERACTIVE", Some("never")), ("GCM_TRACE", Some("0")),
        ("GCM_TRACE_SECRETS", Some("0")), ("GCM_TRACE_MSAUTH", Some("0")),
        ("GIT_TRACE", None), ("GIT_TRACE_CURL", None), ("GIT_CURL_VERBOSE", None),
        ("GIT_TRACE2", Some("0")), ("GIT_TRACE2_EVENT", Some("0")), ("GIT_TRACE2_PERF", Some("0")),
    ]).await.map_err(|_| "Saved GitHub identity is unavailable. Sign in again with its credential manager, then refresh accounts.".to_string())?;
    // GCM 2.x writes account metadata to stdout; 3.x uses its stderr console.
    if args.first() == Some(&"github") && args.get(1) == Some(&"list") {
        output.push(b'\n');
        output.extend(stderr);
    }
    Ok(output)
}

fn cli_accounts() -> Result<Vec<Account>> {
    let config = if let Some(path) = std::env::var_os("GH_CONFIG_DIR") {
        PathBuf::from(path)
    } else if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(path).join("gh")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA").ok_or("Cannot locate GitHub CLI configuration")?)
            .join("GitHub CLI")
    } else {
        directories::BaseDirs::new()
            .ok_or("Cannot locate home directory")?
            .home_dir()
            .join(".config/gh")
    };
    let bytes = match fs::read(config.join("hosts.yml")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read GitHub CLI account metadata".into()),
    };
    let hosts: serde_yaml_ng::Value = serde_yaml_ng::from_slice(&bytes)
        .map_err(|_| "Cannot parse GitHub CLI account metadata")?;
    let host = &hosts["github.com"];
    let mut accounts = vec![];
    if let Some(users) = host["users"].as_mapping() {
        accounts.extend(
            users
                .keys()
                .filter_map(|key| external_account(Source::Gh, key.as_str()?)),
        );
    }
    if let Some(active) = host["user"]
        .as_str()
        .and_then(|login| external_account(Source::Gh, login))
    {
        if !accounts.iter().any(|a| a.id == active.id) {
            accounts.push(active);
        }
    }
    Ok(accounts)
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
    pub async fn available(&self) -> Result<Vec<Account>> {
        let mut accounts = self.list()?;
        let path = &self.root;
        accounts.extend(cli_accounts()?);
        if let Some(gcm) = gcm_path() {
            if let Ok(bytes) = credential_command(
                &gcm,
                path,
                &["github", "list", "--url", "https://github.com"],
                None,
            )
            .await
            {
                for account in String::from_utf8_lossy(&bytes)
                    .lines()
                    .filter_map(|login| external_account(Source::Gcm, login.trim()))
                {
                    if !accounts.iter().any(|a| a.id == account.id) {
                        accounts.push(account);
                    }
                }
            }
        }
        Ok(accounts)
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
            source: Source::Token,
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
    pub async fn resolve(&self, id: Option<&str>) -> Result<Auth> {
        let Some(id) = id else {
            return Ok(Auth {
                account: None,
                token: None,
            });
        };
        if let Some((source, login)) = id.split_once(':') {
            let source = match source {
                "gh" => Source::Gh,
                "gcm" => Source::Gcm,
                _ => return Err("Unknown GitHub identity source".into()),
            };
            external_account(source, login)
                .filter(|a| a.id == id)
                .ok_or("Invalid saved GitHub identity")?;
            let account = self
                .available()
                .await?
                .into_iter()
                .find(|a| a.id == id)
                .ok_or("Saved GitHub identity is unavailable; refresh accounts or sign in again")?;
            let login = account.login.as_str();
            let bytes = match source {
                Source::Gh => {
                    credential_command(
                        &issues::gh_path()?,
                        &self.root,
                        &["auth", "token", "--hostname", "github.com", "--user", login],
                        None,
                    )
                    .await?
                }
                Source::Gcm => {
                    let gcm =
                        gcm_path().ok_or("Install Git Credential Manager to use this identity")?;
                    credential_command(
                        &gcm,
                        &self.root,
                        &["get"],
                        Some(
                            format!("protocol=https\nhost=github.com\nusername={login}\n\n")
                                .as_bytes(),
                        ),
                    )
                    .await?
                }
                Source::Token => unreachable!(),
            };
            let text = String::from_utf8(bytes).map_err(|_| "Invalid saved GitHub credential")?;
            let token = if source == Source::Gcm {
                let fields: Vec<_> = text.lines().filter_map(|l| l.split_once('=')).collect();
                let username = fields
                    .iter()
                    .find(|(k, _)| *k == "username")
                    .map(|(_, v)| *v)
                    .unwrap_or("");
                if !username.eq_ignore_ascii_case(login) {
                    return Err(
                        "Credential manager returned a different identity; sign in again".into(),
                    );
                }
                fields
                    .iter()
                    .find(|(k, _)| *k == "password")
                    .map(|(_, v)| v.to_string())
                    .ok_or("No saved token for this GitHub identity")?
            } else {
                text.trim().to_string()
            };
            if token.is_empty() || token.len() > 2000 || token.chars().any(char::is_control) {
                return Err("Invalid saved GitHub credential".into());
            }
            let auth = Auth {
                account: Some(account),
                token: Some(token),
            };
            // Validate the helper's identity before allowing any repository operation.
            let user = issues::gh(&auth, &self.root, &["api", "user"], None).await?;
            auth.verify(&user)?;
            return Ok(auth);
        }
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
            let matches = if account.source == Source::Token {
                user["id"].as_u64().map(|id| id.to_string()).as_deref() == Some(account.id.as_str())
            } else {
                user["id"].as_u64().is_some()
                    && user["login"]
                        .as_str()
                        .is_some_and(|l| l.eq_ignore_ascii_case(&account.login))
            };
            if !matches {
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

    #[test]
    fn external_identities_are_source_scoped_and_login_verified() {
        let gcm = external_account(Source::Gcm, "FreddyJD").unwrap();
        let gh = external_account(Source::Gh, "FreddyJD").unwrap();
        assert_eq!(gcm.id, "gcm:freddyjd");
        assert_ne!(gcm.id, gh.id);
        for invalid in ["", "user\npassword=secret", "--user", "user:other", "a/b"] {
            assert!(external_account(Source::Gcm, invalid).is_none());
        }
        let auth = Auth {
            account: Some(gcm),
            token: Some("fixture".into()),
        };
        assert!(auth.verify(&json!({"id":42,"login":"freddyjd"})).is_ok());
        assert!(auth
            .verify(&json!({"id":43,"login":"managed_user"}))
            .is_err());
        let old: Account = serde_json::from_value(json!({"id":"42","login":"personal"})).unwrap();
        assert!(old.source == Source::Token);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn saved_helpers_are_discovered_and_selected_without_switching_global_auth() {
        const CHILD: &str = "FACTORY_TEST_SAVED_IDENTITIES";
        if let Some(root) = std::env::var_os(CHILD) {
            let accounts = Accounts::new(Path::new(&root));
            let available = accounts.available().await.unwrap();
            assert_eq!(available.len(), 3);
            assert_eq!(available[0].id, "gh:managed_user");
            assert_eq!(available[1].id, "gh:other_user");
            assert_eq!(available[2].id, "gcm:freddyjd");
            assert!(!serde_json::to_string(&available)
                .unwrap()
                .contains("fixture_secret"));
            let selected = accounts.resolve(Some("gcm:freddyjd")).await.unwrap();
            assert_eq!(selected.token.as_deref(), Some("fixture_secret_personal"));
            assert_eq!(selected.account.unwrap().login, "FreddyJD");
            let selected = accounts.resolve(Some("gh:managed_user")).await.unwrap();
            assert_eq!(selected.token.as_deref(), Some("fixture_secret_managed"));
            assert!(accounts.resolve(Some("gcm:missing")).await.is_err());
            assert!(accounts
                .resolve(Some("gcm:freddyjd\npassword=x"))
                .await
                .is_err());
            fs::write(Path::new(&root).join("wrong-identity"), "").unwrap();
            assert!(accounts.resolve(Some("gcm:freddyjd")).await.is_err());
            fs::write(Path::new(&root).join("list-on-stderr"), "").unwrap();
            let available = accounts.available().await.unwrap();
            assert!(available.iter().any(|a| a.id == "gcm:freddyjd"));
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("saved-identities-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("hosts.yml"), "github.com:\n    user: managed_user\n    users:\n        managed_user:\n        other_user:\nghe.example.com:\n    users:\n        ignored_enterprise:\n").unwrap();
        let gh = root.join("gh");
        let gcm = root.join("gcm");
        fs::write(
            &gh,
            r#"#!/bin/sh
case "$1 $2" in
  'auth token') test "$6" = managed_user || exit 1; printf fixture_secret_managed ;;
  'api user')
    case "$GH_TOKEN" in
      fixture_secret_personal) printf '{"id":42,"login":"FreddyJD"}' ;;
      fixture_secret_managed) printf '{"id":43,"login":"managed_user"}' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        fs::write(&gcm, r#"#!/bin/sh
case "$1" in
  github) if test -f list-on-stderr; then printf 'FreddyJD\n' >&2; else printf 'FreddyJD\n'; fi ;;
  get)
    test "$GCM_INTERACTIVE" = never || exit 1
    input=$(tee /dev/null)
    case "$input" in *'username=FreddyJD'*) ;; *) exit 1 ;; esac
    if test -f wrong-identity; then printf 'username=managed_user\npassword=fixture_secret_managed\n'
    else printf 'username=FreddyJD\npassword=fixture_secret_personal\n'; fi ;;
  *) exit 1 ;;
esac
"#).unwrap();
        for path in [&gh, &gcm] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github::tests::saved_helpers_are_discovered_and_selected_without_switching_global_auth", "--nocapture"])
            .env(CHILD, &root).env("GIT_FACTORY_GH_PATH", &gh).env("GIT_FACTORY_GCM_PATH", &gcm)
            .env("GH_CONFIG_DIR", &root)
            .env("GH_TOKEN", "ambient_managed_token").env("GITHUB_TOKEN", "ambient_other_token")
            .output().await.unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(root).unwrap();
    }

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
                source: Source::Token,
            }),
            token: Some(format!("fixture_token_{id}")),
        }
    }

    #[tokio::test]
    async fn missing_selected_accounts_fail_closed_and_tokens_are_redacted() {
        let root = std::env::temp_dir().join(format!("github-accounts-{}", uuid::Uuid::new_v4()));
        let accounts = Accounts::new(&root);
        assert!(accounts.list().unwrap().is_empty());
        assert!(accounts.resolve(None).await.unwrap().account.is_none());
        assert!(accounts.resolve(Some("42")).await.is_err());
        repository::store(
            &root.join("github-accounts.json"),
            &vec![Account {
                id: "42".into(),
                login: "personal".into(),
                source: Source::Token,
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
