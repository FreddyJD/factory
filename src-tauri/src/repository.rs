use crate::workspace::{self, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    #[serde(default, rename = "githubAccountId")]
    pub github_account_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub path: PathBuf,
    pub branch: String,
    pub head: String,
    pub source: bool,
    pub task_id: Option<String>,
}
pub struct Repositories {
    root: PathBuf,
    projects: Mutex<()>,
    targets: Mutex<HashMap<String, (String, PathBuf, PathBuf)>>,
    config_gate: Mutex<()>,
    storage_error: Option<String>,
}
pub fn store(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Missing parent")?).map_err(|e| e.to_string())?;
    let mut output = atomic_write_file::AtomicWriteFile::open(path).map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    output.commit().map_err(|e| e.to_string())
}

pub async fn file_gate(root: &Path, name: &str, exclusive: bool) -> Result<fs::File> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(name))
        .map_err(|e| e.to_string())?;
    for _ in 0..100 {
        let result = if exclusive {
            fs2::FileExt::try_lock_exclusive(&lock)
        } else {
            fs2::FileExt::try_lock_shared(&lock)
        };
        if result.is_ok() {
            return Ok(lock);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("Repository account configuration is busy; wait for current operations to finish".into())
}

pub async fn command(
    executable: &Path,
    directory: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    seconds: u64,
) -> Result<Vec<u8>> {
    command_index(executable, directory, args, input, seconds, None).await
}
pub async fn command_index(
    executable: &Path,
    directory: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    seconds: u64,
    index: Option<&Path>,
) -> Result<Vec<u8>> {
    command_env(executable, directory, args, input, seconds, index, &[]).await
}
pub async fn command_env(
    executable: &Path,
    directory: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    seconds: u64,
    index: Option<&Path>,
    environment: &[(&str, Option<&str>)],
) -> Result<Vec<u8>> {
    Ok(command_output(
        executable,
        directory,
        args,
        input,
        seconds,
        index,
        environment,
    )
    .await?
    .0)
}
pub async fn command_output(
    executable: &Path,
    directory: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    seconds: u64,
    index: Option<&Path>,
    environment: &[(&str, Option<&str>)],
) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut cmd = Command::new(executable);
    cmd.current_dir(directory)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GH_PAGER", "cat")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_HOST", "github.com")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("CLICOLOR_FORCE", "0")
        .env_remove("FORCE_COLOR")
        .env_remove("GH_FORCE_TTY");
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_PARAMETERS",
    ] {
        cmd.env_remove(key);
    }
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.env("GIT_CONFIG_COUNT", "4")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env(
            "GIT_CONFIG_VALUE_0",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "core.longpaths")
        .env("GIT_CONFIG_VALUE_2", "true")
        .env("GIT_CONFIG_KEY_3", "diff.external")
        .env("GIT_CONFIG_VALUE_3", "");
    for (key, value) in environment {
        match value {
            Some(value) => {
                cmd.env(key, value);
            }
            None => {
                cmd.env_remove(key);
            }
        }
    }
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
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
    let mut child = wrapped
        .spawn()
        .map_err(|e| format!("{} could not start: {e}", executable.display()))?;
    let mut stdout = child.stdout().take().ok_or("Missing output")?;
    let mut stderr = child.stderr().take().ok_or("Missing error output")?;
    let stdin = child.stdin().take();
    let operation = async {
        let write = async {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                stdin.write_all(input).await.map_err(|e| e.to_string())?;
                stdin.shutdown().await.map_err(|e| e.to_string())?;
            }
            Ok::<(), String>(())
        };
        let out = async {
            let mut b = Vec::new();
            (&mut stdout)
                .take(4_000_001)
                .read_to_end(&mut b)
                .await
                .map_err(|e| e.to_string())?;
            if b.len() > 4_000_000 {
                return Err("Command output exceeds 4 MB".into());
            }
            Ok(b)
        };
        let err = async {
            let mut b = Vec::new();
            (&mut stderr)
                .take(100_001)
                .read_to_end(&mut b)
                .await
                .map_err(|e| e.to_string())?;
            if b.len() > 100_000 {
                return Err("Command error output too large".into());
            }
            Ok(b)
        };
        let (_, out, err) = tokio::try_join!(write, out, err)?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "{}: {}",
                executable.file_name().unwrap_or_default().to_string_lossy(),
                String::from_utf8_lossy(&err)
            ));
        }
        Ok((out, err))
    };
    match tokio::time::timeout(Duration::from_secs(seconds), operation).await {
        Ok(result) => {
            if result.is_err() {
                let _ = Box::into_pin(child.kill()).await;
            }
            result
        }
        Err(_) => {
            let _ = Box::into_pin(child.kill()).await;
            Err("Command timed out; inspect state before retrying a write".into())
        }
    }
}
pub async fn git(path: &Path, args: &[&str]) -> Result<String> {
    String::from_utf8(command(Path::new("git"), path, args, None, 20).await?)
        .map_err(|_| "Git returned non-UTF8 metadata".into())
}
pub async fn common(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(
        git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?
        .trim_end_matches(['\r', '\n']),
    )
    .map_err(|e| e.to_string())
}

struct CheckoutMetadata {
    root: PathBuf,
    common_dir: PathBuf,
    git_dir: PathBuf,
}

async fn checkout_metadata(path: &Path) -> Result<CheckoutMetadata> {
    let raw = git(
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
            "--absolute-git-dir",
        ],
    )
    .await?;
    let paths = raw.lines().collect::<Vec<_>>();
    if paths.len() != 3 || paths.iter().any(|p| p.is_empty()) {
        return Err("Git returned ambiguous checkout paths".into());
    }
    Ok(CheckoutMetadata {
        common_dir: dunce::canonicalize(paths[0]).map_err(|e| e.to_string())?,
        root: dunce::canonicalize(paths[1]).map_err(|e| e.to_string())?,
        git_dir: dunce::canonicalize(paths[2]).map_err(|e| e.to_string())?,
    })
}

impl Repositories {
    pub fn new(root: &Path) -> Self {
        let storage_error = match fs::read(root.join("projects.json")) {
            Ok(bytes) => serde_json::from_slice::<Vec<Project>>(&bytes)
                .err()
                .map(|error| format!("Cannot read saved projects: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(error.to_string()),
        };
        Self {
            root: root.into(),
            projects: Mutex::new(()),
            targets: Mutex::new(HashMap::new()),
            config_gate: Mutex::new(()),
            storage_error,
        }
    }
    pub fn storage_error(&self) -> Option<&str> {
        self.storage_error.as_deref()
    }
    pub async fn list(&self) -> Result<Vec<Project>> {
        match fs::read(self.root.join("projects.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Cannot read saved projects: {e}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(error) => Err(error.to_string()),
        }
    }
    pub async fn register(&self, path: &Path) -> Result<Vec<Project>> {
        if let Some(error) = &self.storage_error {
            return Err(error.clone());
        }
        let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
        let mut roots = Vec::new();
        if path.join(".git").exists() {
            roots.push(path);
        } else {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())?.take(1000) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                    && entry.path().join(".git").exists()
                {
                    roots.push(dunce::canonicalize(entry.path()).map_err(|e| e.to_string())?);
                }
            }
        }
        if roots.is_empty() {
            return Err("No Git repository found. Initialize and commit existing files explicitly, or choose an empty folder to initialize.".into());
        }
        let mut discovered = Vec::new();
        for path in roots {
            let top = dunce::canonicalize(
                git(&path, &["rev-parse", "--show-toplevel"])
                    .await?
                    .trim_end_matches(['\r', '\n']),
            )
            .map_err(|e| e.to_string())?;
            if top != path {
                return Err("Choose a repository root".into());
            }
            discovered.push((
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path,
            ));
        }
        let _guard = self.projects.lock().await;
        let _file = file_gate(&self.root, "projects.lock", true).await?;
        let mut projects = self.list().await?;
        for (name, path) in discovered {
            if !projects.iter().any(|p| p.path == path) {
                projects.push(Project {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name,
                    path,
                    github_account_id: None,
                });
            }
        }
        store(&self.root.join("projects.json"), &projects)?;
        Ok(projects)
    }
    pub async fn project(&self, id: &str) -> Result<Project> {
        self.list()
            .await?
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or("Project is not registered".into())
    }
    pub async fn set_github_account(&self, id: &str, account: Option<String>) -> Result<Project> {
        if let Some(error) = &self.storage_error {
            return Err(error.clone());
        }
        let _guard = self.projects.lock().await;
        let _file = file_gate(&self.root, "projects.lock", true).await?;
        let mut projects = self.list().await?;
        let project = projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("Project is not registered")?;
        project.github_account_id = account;
        let project = project.clone();
        store(&self.root.join("projects.json"), &projects)?;
        Ok(project)
    }
    pub async fn inventory(&self, id: &str) -> Result<Value> {
        let project = self.project(id).await?;
        let (identity, raw) = tokio::try_join!(
            common(&project.path),
            git(&project.path, &["worktree", "list", "--porcelain", "-z"])
        )?;
        let data = self.root.clone();
        let tasks = tokio::task::spawn_blocking(move || workspace::tasks(&data))
            .await
            .map_err(|e| e.to_string())??;
        let mut targets = Vec::new();
        for record in raw.split("\0\0") {
            let mut path = None;
            let mut head = String::new();
            let mut branch = String::from("detached HEAD");
            let mut unavailable = false;
            for field in record.split('\0') {
                if let Some(value) = field.strip_prefix("worktree ") {
                    path = dunce::canonicalize(value).ok();
                }
                if let Some(value) = field.strip_prefix("HEAD ") {
                    head = value.into();
                }
                if let Some(value) = field.strip_prefix("branch refs/heads/") {
                    branch = value.into();
                }
                if field == "bare" || field.starts_with("prunable") {
                    unavailable = true;
                }
            }
            let Some(path) = path else {
                continue;
            };
            // Discovery is not authorization; validate only the selected checkout
            // in validated_target instead of spawning Git once per worktree.
            if unavailable || !path.is_dir() {
                continue;
            }
            let mut registry = self.targets.lock().await;
            let existing = registry
                .iter()
                .find(|(_, (owner, p, c))| owner == id && p == &path && c == &identity)
                .map(|(key, _)| key.clone());
            let target = existing.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
            registry.insert(target.clone(), (id.into(), path.clone(), identity.clone()));
            let task_id = tasks
                .iter()
                .find(|task| {
                    task.checkouts
                        .iter()
                        .any(|c| c.path == path && c.source == project.path)
                })
                .map(|t| t.id.clone());
            targets.push(Target {
                id: target,
                path: path.clone(),
                branch,
                head,
                source: path == project.path,
                task_id,
            });
        }
        if !targets.iter().any(|t| t.path == project.path) {
            let mut registry = self.targets.lock().await;
            let existing = registry
                .iter()
                .find(|(_, (owner, p, c))| owner == id && p == &project.path && c == &identity)
                .map(|(key, _)| key.clone());
            let target = existing.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
            registry.insert(
                target.clone(),
                (id.into(), project.path.clone(), identity.clone()),
            );
            targets.push(Target {
                id: target,
                path: project.path.clone(),
                branch: git(&project.path, &["symbolic-ref", "--short", "HEAD"])
                    .await
                    .unwrap_or("detached HEAD".into())
                    .trim()
                    .into(),
                head: git(&project.path, &["rev-parse", "--verify", "HEAD"])
                    .await
                    .unwrap_or_default()
                    .trim()
                    .into(),
                source: true,
                task_id: None,
            });
        }
        targets.sort_by(|a, b| b.source.cmp(&a.source).then(a.branch.cmp(&b.branch)));
        let branches = git(
            &project.path,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .await?
        .lines()
        .map(String::from)
        .collect::<Vec<_>>();
        let remote = git(&project.path, &["config", "--get", "remote.origin.url"])
            .await
            .ok()
            .map(|remote| {
                if let Ok(mut url) = reqwest::Url::parse(&remote) {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.to_string()
                } else {
                    remote
                }
            });
        Ok(json!({"project":project,"targets":targets,"branches":branches,"remote":remote}))
    }
    pub async fn target(&self, project: &str, id: &str) -> Result<PathBuf> {
        Ok(self.validated_target(project, id).await?.root)
    }
    async fn validated_target(&self, project: &str, id: &str) -> Result<CheckoutMetadata> {
        let (owner, path, identity) = self
            .targets
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or("Checkout is stale; refresh worktrees")?;
        if owner != project {
            return Err("Checkout belongs to another project".into());
        }
        let source = self.project(project).await?;
        let metadata = checkout_metadata(&path).await?;
        let source_identity = if source.path == path {
            metadata.common_dir.clone()
        } else {
            common(&source.path).await?
        };
        if source_identity != identity || metadata.common_dir != identity {
            return Err("Repository identity changed; refresh worktrees".into());
        }
        if path != source.path {
            let records = git(&source.path, &["worktree", "list", "--porcelain", "-z"]).await?;
            if !records
                .split('\0')
                .filter_map(|line| line.strip_prefix("worktree "))
                .filter_map(|p| dunce::canonicalize(p).ok())
                .any(|p| p == path)
            {
                return Err("Checkout is no longer registered; refresh worktrees".into());
            }
        }
        if metadata.root != path {
            return Err("Checkout root changed".into());
        }
        Ok(metadata)
    }
    pub async fn browse(&self, project: &str, target: &str, relative: &str) -> Result<Value> {
        let CheckoutMetadata {
            root,
            common_dir: admin,
            git_dir,
        } = self.validated_target(project, target).await?;
        let relative = relative.to_string();
        tokio::task::spawn_blocking(move || {
            let path = root.join(&relative);
            if path.starts_with(&admin) || path.starts_with(&git_dir) {
                return Err("Git administrative paths are not browseable".into());
            }
            let mut result = browse(&root, &relative)?;
            if let Some(entries) = result["entries"].as_array_mut() {
                entries.retain(|entry| {
                    entry["path"].as_str().is_none_or(|relative| {
                        let path = root.join(relative);
                        !path.starts_with(&admin) && !path.starts_with(&git_dir)
                    })
                });
            }
            Ok(result)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub async fn history(&self, project: &str, target: &str) -> Result<Value> {
        let path = self.target(project, target).await?;
        let raw = git(
            &path,
            &[
                "log",
                "-50",
                "--no-show-signature",
                "--no-patch",
                "--format=%H%x00%an%x00%aI%x00%s%x00",
            ],
        )
        .await?;
        let fields: Vec<_> = raw.split('\0').collect();
        Ok(json!(fields
            .chunks(4)
            .filter(|c| c.len() == 4)
            .map(|c| json!({"sha":c[0].trim(),"author":c[1],"date":c[2],"subject":c[3]}))
            .collect::<Vec<_>>()))
    }
    pub async fn mcp_configs(&self, project: &str) -> Result<Value> {
        self.project(project).await?;
        Ok(fs::read(
            self.root
                .join("project-mcp")
                .join(format!("{project}.json")),
        )
        .ok()
        .map(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        .transpose()?
        .unwrap_or(json!({})))
    }
    pub async fn save_mcp(
        &self,
        project: &str,
        name: &str,
        config: Option<Value>,
    ) -> Result<Value> {
        let _guard = self.config_gate.lock().await;
        self.project(project).await?;
        if name.is_empty()
            || name.len() > 24
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err("Server name must be 1-24 letters, numbers or underscores".into());
        }
        let mut current = self.mcp_configs(project).await?;
        if let Some(config) = config {
            if !matches!(config["type"].as_str(), Some("local" | "remote")) {
                return Err("MCP type must be local or remote".into());
            }
            current[name] = config;
        } else {
            current
                .as_object_mut()
                .ok_or("Invalid MCP configuration")?
                .remove(name);
        }
        store(
            &self
                .root
                .join("project-mcp")
                .join(format!("{project}.json")),
            &current,
        )?;
        Ok(current)
    }
}

fn browser_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.contains(['\\', ':', '\0'])
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Expected a relative repository path".into());
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/').filter(|p| !p.is_empty()) {
        let alias = part.trim_end_matches(['.', ' ']).to_ascii_lowercase();
        if alias == ".git" || alias.starts_with("git~") {
            return Err("Git metadata is not browseable".into());
        }
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Symlink previews are disabled".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Reparse-point previews are disabled".into());
            }
        }
    }
    if !dunce::canonicalize(&path)
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("Path escapes checkout".into());
    }
    Ok(path)
}
fn browse(root: &Path, relative: &str) -> Result<Value> {
    let path = browser_path(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.eq_ignore_ascii_case(".git") {
                continue;
            }
            let m = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            let kind = if m.file_type().is_symlink() {
                "symlink"
            } else if m.is_dir() {
                "directory"
            } else if m.is_file() {
                "file"
            } else {
                "unsupported"
            };
            entries.push(json!({"name":name,"path":if relative.is_empty(){name.clone()}else{format!("{relative}/{name}")},"kind":kind,"size":m.len(),"modified":m.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs())}));
            if entries.len() > 2000 {
                return Err(
                    "Directory exceeds 2000 entries; open a smaller directory in your editor"
                        .into(),
                );
            }
        }
        entries.sort_by(|a, b| {
            (a["kind"] != "directory")
                .cmp(&(b["kind"] != "directory"))
                .then(a["name"].as_str().cmp(&b["name"].as_str()))
        });
        let readme = if relative.is_empty() {
            ["README.md", "README", "readme.md"]
                .iter()
                .find_map(|name| {
                    browser_path(root, name)
                        .ok()
                        .filter(|p| p.is_file())
                        .and_then(|p| crate::tools::read_file(&p).ok())
                        .map(|content| json!({"name":name,"content":content}))
                })
        } else {
            None
        };
        Ok(json!({"kind":"directory","path":relative,"entries":entries,"readme":readme}))
    } else if metadata.is_file() {
        let content = crate::tools::read_file(&path);
        Ok(match content {
            Ok(content) => {
                json!({"kind":"file","path":relative,"content":content,"size":metadata.len()})
            }
            Err(reason) => {
                json!({"kind":"unavailable","path":relative,"reason":reason,"size":metadata.len()})
            }
        })
    } else {
        Err("Only directories and regular files can be previewed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn account_selection_is_persisted_per_project_and_old_projects_load() {
        let root = std::env::temp_dir().join(format!("project-accounts-{}", uuid::Uuid::new_v4()));
        store(
            &root.join("projects.json"),
            &json!([
                {"id":"a","name":"personal","path":"/personal"},
                {"id":"b","name":"work","path":"/work"}
            ]),
        )
        .unwrap();
        let projects = Repositories::new(&root);
        let other_instance = Repositories::new(&root);
        assert!(projects
            .project("a")
            .await
            .unwrap()
            .github_account_id
            .is_none());
        projects
            .set_github_account("a", Some("42".into()))
            .await
            .unwrap();
        other_instance
            .set_github_account("b", Some("43".into()))
            .await
            .unwrap();
        let projects = Repositories::new(&root);
        assert_eq!(
            projects
                .project("a")
                .await
                .unwrap()
                .github_account_id
                .as_deref(),
            Some("42")
        );
        assert_eq!(
            projects
                .project("b")
                .await
                .unwrap()
                .github_account_id
                .as_deref(),
            Some("43")
        );
        assert!(projects.set_github_account("missing", None).await.is_err());
        projects.set_github_account("a", None).await.unwrap();
        assert!(Repositories::new(&root)
            .project("a")
            .await
            .unwrap()
            .github_account_id
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn stale_repository_identity_and_cross_project_tokens_are_rejected() {
        let root = std::env::temp_dir().join(format!("browser-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::create_dir(root.join("other")).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        workspace::initialize_empty(&root.join("source")).unwrap();
        workspace::initialize_empty(&root.join("other")).unwrap();
        let browser = Repositories::new(&root.join("data"));
        let project = browser
            .register(&root.join("source"))
            .await
            .unwrap()
            .remove(0);
        let other = browser
            .register(&root.join("other"))
            .await
            .unwrap()
            .remove(1);
        let inv = browser.inventory(&project.id).await.unwrap();
        let id = inv["targets"][0]["id"].as_str().unwrap();
        assert!(browser.browse(&other.id, id, "").await.is_err());
        fs::rename(project.path.join(".git"), project.path.join("old-admin")).unwrap();
        workspace::git(
            &project.path,
            &[
                "init",
                "--separate-git-dir",
                root.join("replacement").to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(browser
            .browse(&project.id, id, "")
            .await
            .unwrap_err()
            .contains("identity changed"));
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn linked_projects_keep_independent_checkout_tokens() {
        let root = std::env::temp_dir().join(format!("browser-tokens-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        workspace::initialize_empty(&root.join("source")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        let browser = Repositories::new(&root.join("data"));
        let a = browser
            .register(&root.join("source"))
            .await
            .unwrap()
            .remove(0);
        let linked = root.join("linked");
        workspace::git(
            &a.path,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        )
        .unwrap();
        let projects = browser.register(&linked).await.unwrap();
        let b = projects.iter().find(|p| p.path == linked).unwrap();
        let first = browser.inventory(&a.id).await.unwrap();
        browser.inventory(&b.id).await.unwrap();
        assert!(browser
            .browse(&a.id, first["targets"][0]["id"].as_str().unwrap(), "")
            .await
            .is_ok());
        workspace::git(
            &a.path,
            &["worktree", "remove", "--force", linked.to_str().unwrap()],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn separate_git_directory_is_hidden() {
        let root = std::env::temp_dir().join(format!("browser-admin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let source = root.join("source");
        workspace::git(
            &source,
            &[
                "init",
                "--separate-git-dir",
                source.join("administration").to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::create_dir(root.join("data")).unwrap();
        let browser = Repositories::new(&root.join("data"));
        let p = browser.register(&source).await.unwrap().remove(0);
        let inventory = browser.inventory(&p.id).await.unwrap();
        let id = inventory["targets"][0]["id"].as_str().unwrap();
        let listing = browser.browse(&p.id, id, "").await.unwrap();
        assert!(!listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "administration"));
        assert!(browser
            .browse(&p.id, id, "administration/config")
            .await
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn browse_registered_worktree_and_live_content() {
        let root = std::env::temp_dir().join(format!("browser-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        workspace::initialize_empty(&root.join("source")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        let browser = Repositories::new(&root.join("data"));
        let project = browser
            .register(&root.join("source"))
            .await
            .unwrap()
            .remove(0);
        let path = root.join("external");
        workspace::git(
            &project.path,
            &["worktree", "add", "-b", "other", path.to_str().unwrap()],
        )
        .unwrap();
        let inv = browser.inventory(&project.id).await.unwrap();
        let targets = inv["targets"].as_array().unwrap();
        assert_eq!(targets.len(), 2);
        let id = targets.iter().find(|t| t["branch"] == "other").unwrap()["id"]
            .as_str()
            .unwrap();
        fs::write(path.join("a.txt"), "one\n\n").unwrap();
        assert_eq!(
            browser.browse(&project.id, id, "a.txt").await.unwrap()["content"],
            "one\n\n"
        );
        fs::write(path.join("a.txt"), "two").unwrap();
        assert_eq!(
            browser.browse(&project.id, id, "a.txt").await.unwrap()["content"],
            "two"
        );
        assert!(browser
            .browse(&project.id, id, "../source/.git/config")
            .await
            .is_err());
        assert!(browser.browse(&project.id, id, ".git").await.is_err());
        workspace::git(
            &project.path,
            &["worktree", "remove", "--force", path.to_str().unwrap()],
        )
        .unwrap();
        assert!(browser.browse(&project.id, id, "").await.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
