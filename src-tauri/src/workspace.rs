use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;

// Bound disk-heavy lifecycle operations even when an async caller is cancelled.
static WORKTREE_IO: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name: String,
    pub path: PathBuf,
    pub base: String,
    pub branch: String,
    pub dirty: bool,
    pub remote: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub path: PathBuf,
    pub repositories: Vec<Repository>,
    pub can_initialize: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub source: PathBuf,
    pub path: PathBuf,
    pub base: String,
    pub branch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub workspace: PathBuf,
    pub directory: PathBuf,
    pub checkouts: Vec<Checkout>,
    pub status: String,
    pub session_id: Option<String>,
    pub model: String,
}

fn git_command(directory: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(directory);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_PARAMETERS",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env(
            "GIT_CONFIG_VALUE_0",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "core.longpaths")
        .env("GIT_CONFIG_VALUE_2", "true");
    command
}

fn git_output(mut command: Command, timeout: Duration) -> Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut wrapped = process_wrap::std::CommandWrap::from(command);
    #[cfg(unix)]
    wrapped.wrap(process_wrap::std::ProcessGroup::leader());
    #[cfg(windows)]
    {
        wrapped.wrap(process_wrap::std::CreationFlags(
            windows::Win32::System::Threading::CREATE_NO_WINDOW,
        ));
        wrapped.wrap(process_wrap::std::JobObject);
    }
    let mut child = wrapped
        .spawn()
        .map_err(|e| format!("Git could not start: {e}"))?;
    let stdout = child.stdout().take().ok_or("Missing Git output")?;
    let stderr = child.stderr().take().ok_or("Missing Git error output")?;
    let (send, receive) = std::sync::mpsc::channel();
    // Drain both pipes concurrently so large Git output cannot deadlock the child.
    for (is_error, mut pipe) in [
        (false, Box::new(stdout) as Box<dyn Read + Send>),
        (true, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let send = send.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|e| e.to_string());
            let _ = send.send((is_error, result));
        });
    }
    drop(send);
    let deadline = Instant::now() + timeout;
    let (mut out, mut err) = (None, None);
    let result = (|| -> Result<Output> {
        loop {
            while let Ok((is_error, bytes)) = receive.try_recv() {
                if is_error {
                    err = Some(bytes?);
                } else {
                    out = Some(bytes?);
                }
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if out.is_some() && err.is_some() {
                    return Ok(Output {
                        status,
                        stdout: out.take().unwrap(),
                        stderr: err.take().unwrap(),
                    });
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "Git timed out; inspect retained worktree state before retrying".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    result
}

fn git_result(mut command: Command, args: &[&str]) -> Result<String> {
    command.args(args);
    let output = git_output(command, Duration::from_secs(120))?;
    if !output.status.success() {
        return Err(format!(
            "Git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

// Only for operations that cannot read/write file content or invoke filters.
fn git_metadata(directory: &Path, args: &[&str]) -> Result<String> {
    git_result(git_command(directory), args)
}

pub fn git(directory: &Path, args: &[&str]) -> Result<String> {
    git_filtered(directory, directory, args)
}

fn git_filtered(directory: &Path, filter_context: &Path, args: &[&str]) -> Result<String> {
    let mut probe = git_command(filter_context);
    probe.args([
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(process|smudge|clean)$",
    ]);
    let filters = git_output(probe, Duration::from_secs(120))?;
    if !filters.status.success() && filters.status.code() != Some(1) {
        return Err(format!(
            "Cannot inspect Git filters: {}",
            String::from_utf8_lossy(&filters.stderr).trim()
        ));
    }
    let mut command = git_command(directory);
    let mut seen = HashSet::new();
    // Disable configured content filters for our Git operations, including globally
    // installed LFS filters. Checkout preserves pointer files rather than running code.
    for key in String::from_utf8_lossy(&filters.stdout)
        .split('\0')
        .filter(|key| !key.is_empty())
    {
        {
            if let Some((driver, _)) = key.rsplit_once('.') {
                if !seen.insert(driver) {
                    continue;
                }
                if !driver
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                {
                    return Err("Unsupported executable Git filter name; review repository configuration first".into());
                }
                for field in ["process", "smudge", "clean"] {
                    command.args(["-c", &format!("{driver}.{field}=")]);
                }
                command.args(["-c", &format!("{driver}.required=false")]);
            }
        }
    }
    git_result(command, args)
}

fn repository(path: &Path) -> Result<Repository> {
    let root = dunce::canonicalize(PathBuf::from(git_metadata(
        path,
        &["rev-parse", "--show-toplevel"],
    )?))
    .map_err(|e| e.to_string())?;
    if root != path {
        return Err("Select the repository root, not a nested source directory".into());
    }
    let base = git_metadata(path, &["rev-parse", "--verify", "HEAD"]).map_err(|_| {
        "Repository needs an initial commit before worktrees can be created".to_string()
    })?;
    let branch = git_metadata(path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_else(|_| "detached HEAD".into());
    let remote = git_metadata(path, &["config", "--get", "remote.origin.url"])
        .ok()
        .map(|value| {
            // Never expose embedded HTTP credentials in the UI/history.
            if let Ok(mut url) = reqwest::Url::parse(&value) {
                let _ = url.set_username("");
                let _ = url.set_password(None);
                url.to_string()
            } else {
                value
            }
        });
    Ok(Repository {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.into(),
        base,
        branch,
        dirty: !git(path, &["status", "--porcelain"])?.is_empty(),
        remote,
    })
}

fn repository_paths(path: &Path) -> Result<(PathBuf, Vec<PathBuf>, bool)> {
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Select a directory".into());
    }
    let mut repositories = Vec::new();
    if path.join(".git").exists() {
        repositories.push(path.clone());
    } else {
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())?.take(1000) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && entry.path().join(".git").exists()
            {
                repositories.push(dunce::canonicalize(entry.path()).map_err(|e| e.to_string())?);
            }
        }
    }
    repositories.sort();
    let can_initialize = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .next()
        .is_none();
    Ok((path, repositories, can_initialize))
}

pub fn discover(path: &Path) -> Result<Workspace> {
    let (path, paths, can_initialize) = repository_paths(path)?;
    let repositories = paths
        .iter()
        .map(|p| repository(p))
        .collect::<Result<Vec<_>>>()?;
    Ok(Workspace {
        path,
        repositories,
        can_initialize,
    })
}

pub fn initialize_empty(path: &Path) -> Result<Workspace> {
    let workspace = discover(path)?;
    if !workspace.can_initialize {
        return Err("Only an empty folder can be initialized here. Commit existing files explicitly with Git first.".into());
    }
    git(&workspace.path, &["init", "-b", "main"])?;
    git(
        &workspace.path,
        &[
            "-c",
            "user.name=Git Factory",
            "-c",
            "user.email=factory@localhost",
            "commit",
            "--allow-empty",
            "-m",
            "Initialize repository",
        ],
    )?;
    discover(&workspace.path)
}

pub fn create_task(root: &Path, workspace: &Workspace, title: &str, model: &str) -> Result<Task> {
    let paths = workspace
        .repositories
        .iter()
        .map(|r| r.path.clone())
        .collect::<Vec<_>>();
    create_from_paths(root, &workspace.path, &paths, title, model)
}

pub fn prepare_task(root: &Path, path: &Path, title: &str, model: &str) -> Result<Task> {
    let (path, repositories, _) = repository_paths(path)?;
    create_from_paths(root, &path, &repositories, title, model)
}

fn create_from_paths(
    root: &Path,
    workspace: &Path,
    repositories: &[PathBuf],
    title: &str,
    model: &str,
) -> Result<Task> {
    let _io = WORKTREE_IO.lock().map_err(|e| e.to_string())?;
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    if repositories.is_empty() {
        return Err("Workspace contains no committed repositories".into());
    }
    if title.trim().is_empty() || title.len() > 100_000 {
        return Err("Provide a goal of 1 to 100,000 bytes".into());
    }
    let id = Uuid::new_v4().simple().to_string();
    let group = root.join("worktrees").join(&id);
    fs::create_dir_all(&group).map_err(|e| e.to_string())?;
    let mut task = Task {
        id: id.clone(),
        title: title.into(),
        workspace: workspace.to_path_buf(),
        directory: group.clone(),
        checkouts: Vec::new(),
        status: "allocating".into(),
        session_id: None,
        model: model.into(),
    };
    save_task(&root, &task)?;
    let result = (|| -> Result<()> {
        for (index, source) in repositories.iter().enumerate() {
            let fresh = dunce::canonicalize(source).map_err(|e| e.to_string())?;
            let probe = git_metadata(
                &fresh,
                &["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"],
            )?;
            let lines = probe.lines().collect::<Vec<_>>();
            if lines.len() != 2
                || dunce::canonicalize(lines[0]).map_err(|e| e.to_string())? != fresh
            {
                return Err(
                    "Select a committed repository root; Git returned ambiguous paths".into(),
                );
            }
            let base = lines[1].to_string();
            let path = group.join(format!(
                "{index}-{}",
                fresh.file_name().unwrap_or_default().to_string_lossy()
            ));
            let branch = format!("factory/{id}-{index}");
            // Journal intent before Git can create a branch or registration.
            task.checkouts.push(Checkout {
                source: fresh.clone(),
                path: path.clone(),
                base: base.clone(),
                branch: branch.clone(),
            });
            save_task(&root, &task)?;
            // No post-checkout hooks or source mutations. Record partial allocations before returning errors.
            git_metadata(
                &fresh,
                &[
                    "worktree",
                    "add",
                    "--no-checkout",
                    "-b",
                    &branch,
                    path.to_str().ok_or("Non-UTF8 path")?,
                    &base,
                ],
            )?;
            if dunce::canonicalize(&path).map_err(|e| e.to_string())? != path {
                return Err("Allocated worktree path changed".into());
            }
            let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
            git(
                &path,
                &[
                    "-c",
                    &format!("checkout.workers={workers}"),
                    "read-tree",
                    "--reset",
                    "-u",
                    "HEAD",
                ],
            )?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        task.status = "allocation-failed".into();
        let recording = save_task(&root, &task).err();
        return Err(format!(
            "{error}. Task {id}: allocated worktrees are retained; inspect its allocation record. Recording error: {recording:?}"
        ));
    }
    if task.checkouts.len() == 1 {
        task.directory = task.checkouts[0].path.clone();
    }
    task.status = "ready".into();
    save_task(&root, &task)?;
    Ok(task)
}

pub fn save_task(root: &Path, task: &Task) -> Result<()> {
    let dir = root.join("tasks");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", task.id));
    let mut output = atomic_write_file::AtomicWriteFile::open(&path).map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec_pretty(task).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    output.commit().map_err(|e| e.to_string())
}

pub fn tasks(root: &Path) -> Result<Vec<Task>> {
    let dir = root.join("tasks");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json")
            && !path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .contains(".error.")
        {
            let task = serde_json::from_slice::<Task>(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            result.push(task);
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

pub fn load_task(root: &Path, id: &str) -> Result<Task> {
    let task = task_record(root, id)?;
    if matches!(
        task.status.as_str(),
        "removing" | "removal-failed" | "removed"
    ) {
        return Err(
            "Task worktrees are removed or need cleanup inspection; execution refused".into(),
        );
    }
    validate_task(root, &task)?;
    Ok(task)
}

pub fn task_record(root: &Path, id: &str) -> Result<Task> {
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid task ID".into());
    }
    let task: Task = serde_json::from_slice(
        &fs::read(root.join("tasks").join(format!("{id}.json"))).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if task.id != id || !task.directory.starts_with(root.join("worktrees")) {
        return Err("Task ownership record is invalid".into());
    }
    Ok(task)
}

fn validate_task(root: &Path, task: &Task) -> Result<()> {
    let id = &task.id;
    if dunce::canonicalize(&task.directory).map_err(|e| e.to_string())? != task.directory {
        return Err("Task directory changed; execution refused".into());
    }
    let expected_directory = if task.checkouts.len() == 1 {
        task.checkouts[0].path.clone()
    } else {
        root.join("worktrees").join(id)
    };
    if task.directory != expected_directory
        && task.status != "allocating"
        && task.status != "allocation-failed"
    {
        return Err("Task directory does not match recorded checkouts".into());
    }
    for checkout in &task.checkouts {
        let source_common = git_metadata(
            &checkout.source,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let checkout_metadata = git_metadata(
            &checkout.path,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
                "--show-toplevel",
            ],
        )?;
        let paths = checkout_metadata.lines().collect::<Vec<_>>();
        if paths.len() != 2 {
            return Err("Ambiguous worktree paths".into());
        }
        if dunce::canonicalize(source_common).map_err(|e| e.to_string())?
            != dunce::canonicalize(paths[0]).map_err(|e| e.to_string())?
        {
            return Err("Owned worktree no longer belongs to its source repository".into());
        }
        let registered =
            git_metadata(&checkout.source, &["worktree", "list", "--porcelain", "-z"])?;
        if !registered
            .split('\0')
            .filter_map(|s| s.strip_prefix("worktree "))
            .filter_map(|p| dunce::canonicalize(p).ok())
            .any(|p| p == checkout.path)
        {
            return Err("Owned worktree is no longer registered".into());
        }
        if dunce::canonicalize(&checkout.path).map_err(|e| e.to_string())? != checkout.path
            || !checkout.path.starts_with(root.join("worktrees").join(id))
        {
            return Err("Worktree path changed; execution refused".into());
        }
        if dunce::canonicalize(paths[1]).map_err(|e| e.to_string())? != checkout.path {
            return Err("Worktree registration changed".into());
        }
    }
    Ok(())
}

pub fn remove_task(root: &Path, id: &str) -> Result<Task> {
    let _io = WORKTREE_IO.lock().map_err(|e| e.to_string())?;
    // Keep ownership across every mutation, including after async cancellation.
    let locks = root.join("locks");
    fs::create_dir_all(&locks).map_err(|e| e.to_string())?;
    // Validate before constructing a path from the caller's ID.
    task_record(root, id)?;
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(locks.join(format!("{id}.lock")))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lease)
        .map_err(|_| "Release the worker first; task is still owned by a Factory process")?;
    let mut task = task_record(root, id)?;
    if task.status == "removed" {
        return Ok(task);
    }
    if matches!(
        task.status.as_str(),
        "removing"
            | "removal-failed"
            | "allocating"
            | "allocation-failed"
            | "working"
            | "needs-you"
            | "publishing"
    ) {
        return Err("Task must be stopped and fully allocated; interrupted removal requires manual inspection".into());
    }
    validate_task(root, &task)?;
    if task.checkouts.is_empty() {
        return Err("No owned worktrees to remove".into());
    }
    // Preflight every checkout before deleting any. Include ignored files: build
    // outputs and local credentials must not be silently discarded by Git.
    for checkout in &task.checkouts {
        if checkout.path.parent() != Some(root.join("worktrees").join(id).as_path())
            || checkout.source == checkout.path
            || !checkout.branch.starts_with(&format!("factory/{id}-"))
            || !fs::symlink_metadata(checkout.path.join(".git")).is_ok_and(|m| m.is_file())
        {
            return Err("Removal is limited to Factory-owned linked worktrees".into());
        }
        if git_metadata(&checkout.path, &["symbolic-ref", "HEAD"])?
            != format!("refs/heads/{}", checkout.branch)
        {
            return Err("Worktree branch changed or HEAD is detached; retain its commits and review manually".into());
        }
        let status = git(
            &checkout.path,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored=matching",
            ],
        )?;
        if !status.is_empty() {
            return Err(format!("Worktree {} has modified, untracked or ignored files; commit or remove them explicitly first", checkout.path.display()));
        }
        let flags = git_metadata(&checkout.path, &["ls-files", "-v", "-z"])?;
        if flags.split('\0').any(|line| {
            line.as_bytes()
                .first()
                .is_some_and(|c| c.is_ascii_lowercase() || *c == b'S')
        }) {
            return Err("Assume-unchanged or skip-worktree entries require manual cleanup".into());
        }
        let files = git_metadata(&checkout.path, &["ls-files", "--stage"])?;
        if files.lines().any(|line| line.starts_with("160000 ")) {
            return Err("Submodule worktrees require manual cleanup".into());
        }
        let admin = git_metadata(&checkout.path, &["rev-parse", "--absolute-git-dir"])?;
        if [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "BISECT_LOG",
            "index.lock",
        ]
        .iter()
        .any(|name| Path::new(&admin).join(name).exists())
        {
            return Err("Finish the worktree's active Git operation before removing it".into());
        }
        let records = git_metadata(&checkout.source, &["worktree", "list", "--porcelain", "-z"])?;
        for record in records.split("\0\0") {
            if record
                .split('\0')
                .filter_map(|s| s.strip_prefix("worktree "))
                .filter_map(|p| dunce::canonicalize(p).ok())
                .any(|p| p == checkout.path)
                && record
                    .split('\0')
                    .any(|s| s == "locked" || s.starts_with("locked "))
            {
                return Err("Unlock the worktree explicitly in Git before removing it".into());
            }
        }
    }
    let journal = root.join("removals").join(format!("{id}.json"));
    let mut progress = serde_json::json!({"taskId":id,"removed":[],"pending":null,"error":null});
    crate::repository::store(&journal, &progress)?;
    task.status = "removing".into();
    save_task(root, &task)?;
    let result = (|| -> Result<()> {
        for checkout in &task.checkouts {
            progress["pending"] = serde_json::json!(checkout.path);
            crate::repository::store(&journal, &progress)?;
            // Target-context filters also apply to Git's internal cleanliness
            // check. No --force, recursive fallback, branch deletion or prune.
            git_filtered(
                &checkout.source,
                &checkout.path,
                &[
                    "worktree",
                    "remove",
                    checkout.path.to_str().ok_or("Non-UTF8 path")?,
                ],
            )?;
            progress["removed"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!(checkout.path));
            progress["pending"] = serde_json::Value::Null;
            crate::repository::store(&journal, &progress)?;
        }
        let group = root.join("worktrees").join(id);
        // Only remove an empty group, never unknown contents left beside checkouts.
        fs::remove_dir(&group).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        progress["error"] = serde_json::json!(error);
        let journal_error = crate::repository::store(&journal, &progress).err();
        task.status = "removal-failed".into();
        let record_error = save_task(root, &task).err();
        return Err(format!(
            "Removal stopped; inspect {} before retrying. {error}. Journal error: {journal_error:?}; task record error: {record_error:?}",
            journal.display()
        ));
    }
    task.status = "removed".into();
    save_task(root, &task)?;
    Ok(task)
}

pub fn diff(task: &Task) -> Result<String> {
    let mut result = String::new();
    for checkout in &task.checkouts {
        result.push_str(&format!(
            "\n--- {} ({}) ---\n",
            checkout.path.display(),
            checkout.branch
        ));
        result.push_str(&git(&checkout.path, &["status", "--short"])?);
        result.push('\n');
        result.push_str(&git(
            &checkout.path,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                &checkout.base,
                "--",
            ],
        )?);
        if result.len() > 2_000_000 {
            return Err("Diff exceeds 2 MB; inspect the worktree in your editor".into());
        }
    }
    Ok(result)
}

pub fn validate_links(root: &Path) -> Result<()> {
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == ".git" {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                let target = dunce::canonicalize(entry.path()).map_err(|_| {
                    format!(
                        "Unresolved symlink {}; review it before execution",
                        entry.path().display()
                    )
                })?;
                if !target.starts_with(&root) {
                    return Err(format!("Symlink {} points outside this task workspace. Review/remove it before execution.",entry.path().display()));
                }
            } else if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_deadline_terminates_the_process_tree() {
        let mut command = if cfg!(windows) {
            Command::new("powershell.exe")
        } else {
            Command::new("/bin/sh")
        };
        if cfg!(windows) {
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
        } else {
            command.args(["-c", "sleep 30"]);
        }
        let start = Instant::now();
        assert!(git_output(command, Duration::from_millis(100))
            .unwrap_err()
            .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }
    fn commit(source: &Path) {
        git(source, &["add", "."]).unwrap();
        git(
            source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "-m",
                "Fixture",
            ],
        )
        .unwrap();
    }
    #[test]
    fn preparation_uses_fresh_head_without_copying_source_dirt() {
        let source = temp();
        let data = temp();
        let stale = initialize_empty(&source).unwrap();
        git_metadata(&source, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(source.join("file.txt"), "committed\n").unwrap();
        commit(&source);
        fs::write(source.join("staged.txt"), "staged\n").unwrap();
        git(&source, &["add", "staged.txt"]).unwrap();
        fs::write(source.join("file.txt"), "dirty\n").unwrap();
        fs::write(source.join("untracked.txt"), "untracked\n").unwrap();
        let index = git_metadata(&source, &["write-tree"]).unwrap();
        let head = git_metadata(&source, &["rev-parse", "HEAD"]).unwrap();
        let task = create_task(&data, &stale, "fresh", "model").unwrap();
        assert_eq!(task.checkouts[0].base, head);
        assert_eq!(
            fs::read_to_string(task.directory.join("file.txt")).unwrap(),
            "committed\n"
        );
        assert!(!task.directory.join("staged.txt").exists());
        assert!(!task.directory.join("untracked.txt").exists());
        assert_eq!(git_metadata(&source, &["write-tree"]).unwrap(), index);
        assert_eq!(git_metadata(&source, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "dirty\n"
        );
        let branch = task.checkouts[0].branch.clone();
        assert_eq!(remove_task(&data, &task.id).unwrap().status, "removed");
        assert!(!task.directory.exists());
        assert!(git_metadata(&source, &["rev-parse", "--verify", &branch]).is_ok());
        assert!(load_task(&data, &task.id).is_err());
        assert_eq!(remove_task(&data, &task.id).unwrap().status, "removed");
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn removal_refuses_dirt_ignored_files_locks_and_ownership_changes() {
        let source = temp();
        let data = temp();
        initialize_empty(&source).unwrap();
        git_metadata(&source, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(source.join(".gitignore"), "cache/\n").unwrap();
        fs::write(source.join("file.txt"), "original\n").unwrap();
        commit(&source);
        let task = prepare_task(&data, &source, "remove", "model").unwrap();
        fs::write(task.directory.join("file.txt"), "changed\n").unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        assert_eq!(
            fs::read_to_string(task.directory.join("file.txt")).unwrap(),
            "changed\n"
        );
        fs::write(task.directory.join("file.txt"), "original\n").unwrap();
        fs::create_dir(task.directory.join("cache")).unwrap();
        fs::write(task.directory.join("cache/private.txt"), "keep").unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        fs::remove_dir_all(task.directory.join("cache")).unwrap();
        git_metadata(&task.directory, &["checkout", "--detach"]).unwrap();
        git(
            &task.directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "--allow-empty",
                "-m",
                "Detached work",
            ],
        )
        .unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        assert!(task.directory.exists());
        git_metadata(&task.directory, &["checkout", &task.checkouts[0].branch]).unwrap();
        git_metadata(
            &task.directory,
            &["update-index", "--assume-unchanged", "file.txt"],
        )
        .unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        git_metadata(
            &task.directory,
            &["update-index", "--no-assume-unchanged", "file.txt"],
        )
        .unwrap();
        git_metadata(
            &source,
            &["worktree", "lock", task.directory.to_str().unwrap()],
        )
        .unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        git_metadata(
            &source,
            &["worktree", "unlock", task.directory.to_str().unwrap()],
        )
        .unwrap();
        let locks = data.join("locks");
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(locks.join(format!("{}.lock", task.id)))
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lease).unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        drop(lease);
        let mut forged = task.clone();
        forged.checkouts[0].path = source.clone();
        forged.directory = source.clone();
        save_task(&data, &forged).unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        assert!(source.join("file.txt").exists());
        save_task(&data, &task).unwrap();
        remove_task(&data, &task.id).unwrap();
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn multi_repository_removal_preflights_every_checkout() {
        let sources = temp();
        let data = temp();
        for name in ["api", "web"] {
            fs::create_dir(sources.join(name)).unwrap();
            initialize_empty(&sources.join(name)).unwrap();
        }
        let task = prepare_task(&data, &sources, "multi", "model").unwrap();
        assert_eq!(task.checkouts.len(), 2);
        let untracked = task.checkouts[1].path.join("keep.txt");
        fs::write(&untracked, "keep").unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        assert!(task.checkouts[0].path.exists());
        fs::remove_file(untracked).unwrap();
        remove_task(&data, &task.id).unwrap();
        assert!(task
            .checkouts
            .iter()
            .all(|c| !c.path.exists() && c.source.exists()));
        fs::remove_dir_all(sources).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn partial_allocation_and_removal_keep_durable_records() {
        let source = temp();
        let data = temp();
        initialize_empty(&source).unwrap();
        let mut workspace = discover(&source).unwrap();
        let mut missing = workspace.repositories[0].clone();
        missing.path = source.join("missing");
        workspace.repositories.push(missing);
        assert!(create_task(&data, &workspace, "partial", "model").is_err());
        let task = tasks(&data).unwrap().remove(0);
        assert_eq!(task.status, "allocation-failed");
        assert_eq!(task.checkouts.len(), 1);
        assert!(task.checkouts[0].path.exists());
        git(
            &source,
            &[
                "worktree",
                "remove",
                task.checkouts[0].path.to_str().unwrap(),
            ],
        )
        .unwrap();
        let task = prepare_task(&data, &source, "remove", "model").unwrap();
        let group = data.join("worktrees").join(&task.id);
        fs::write(group.join("unknown.txt"), "keep").unwrap();
        assert!(remove_task(&data, &task.id).is_err());
        assert_eq!(
            task_record(&data, &task.id).unwrap().status,
            "removal-failed"
        );
        assert_eq!(
            fs::read_to_string(group.join("unknown.txt")).unwrap(),
            "keep"
        );
        let journal: serde_json::Value = serde_json::from_slice(
            &fs::read(data.join("removals").join(format!("{}.json", task.id))).unwrap(),
        )
        .unwrap();
        assert_eq!(journal["removed"][0], task.directory.to_str().unwrap());
        assert!(journal["error"].is_string());
        assert!(remove_task(&data, &task.id).is_err());
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    #[ignore = "manual worktree throughput measurement"]
    fn worktree_lifecycle_timing() {
        let source = temp();
        let data = temp();
        initialize_empty(&source).unwrap();
        for i in 0..2000 {
            let dir = source.join(format!("src/{}", i / 100));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("file-{i}.txt")), "fixture\n".repeat(128)).unwrap();
        }
        commit(&source);
        let start = std::time::Instant::now();
        let task = prepare_task(&data, &source, "timing", "model").unwrap();
        let prepare = start.elapsed();
        let start = std::time::Instant::now();
        remove_task(&data, &task.id).unwrap();
        eprintln!(
            "2000 tracked files: prepare={prepare:?}, safe removal={:?}",
            start.elapsed()
        );
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("factory-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        dunce::canonicalize(&path).unwrap()
    }
    #[test]
    fn changes_stay_in_worktree_and_dirty_source_is_untouched() {
        let source = temp();
        let data = temp();
        let ws = initialize_empty(&source).unwrap();
        fs::write(source.join("dirty.txt"), "original").unwrap();
        let task = create_task(&data, &ws, "test", "model").unwrap();
        fs::write(task.directory.join("new.txt"), "change").unwrap();
        assert!(!source.join("new.txt").exists());
        assert_eq!(
            fs::read_to_string(source.join("dirty.txt")).unwrap(),
            "original"
        );
        assert!(load_task(&data, &task.id).is_ok());
        assert!(load_task(&data, "../../etc").is_err());
        git(
            &source,
            &[
                "worktree",
                "remove",
                "--force",
                task.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn nonempty_initialization_is_rejected() {
        let path = temp();
        fs::write(path.join("keep.txt"), "keep").unwrap();
        assert!(initialize_empty(&path).is_err());
        assert!(!path.join(".git").exists());
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn discovers_multiple_repos_without_parent_git() {
        let path = temp();
        for name in ["api", "web"] {
            fs::create_dir(path.join(name)).unwrap();
            initialize_empty(&path.join(name)).unwrap();
        }
        assert_eq!(discover(&path).unwrap().repositories.len(), 2);
        assert!(!path.join(".git").exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn executable_git_filters_are_disabled_before_checkout() {
        let source = temp();
        initialize_empty(&source).unwrap();
        let result = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args([
                "config",
                "filter.evil.smudge",
                "touch /tmp/never-run-factory-test",
            ])
            .status()
            .unwrap();
        assert!(result.success());
        assert_eq!(discover(&source).unwrap().repositories.len(), 1);
        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn task_records_replace_existing_records_atomically() {
        let source = temp();
        let data = temp();
        let ws = initialize_empty(&source).unwrap();
        let mut task = create_task(&data, &ws, "test", "model").unwrap();
        task.status = "review".into();
        save_task(&data, &task).unwrap();
        assert_eq!(load_task(&data, &task.id).unwrap().status, "review");
        git(
            &source,
            &[
                "worktree",
                "remove",
                "--force",
                task.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn branch_conditional_filters_do_not_execute_during_worktree_checkout() {
        let source = temp();
        let data = temp();
        initialize_empty(&source).unwrap();
        git_metadata(&source, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(source.join(".gitattributes"), "payload.txt filter=evil\n").unwrap();
        fs::write(source.join("payload.txt"), "tracked payload\n").unwrap();
        git(&source, &["add", ".gitattributes", "payload.txt"]).unwrap();
        git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "-m",
                "Track filtered payload",
            ],
        )
        .unwrap();
        let marker = data.join("must-not-execute");
        let include = data.join("conditional.gitconfig");
        fs::write(
            &include,
            format!(
                "[filter \"evil\"]\nsmudge = echo executed > '{}'; cat\nclean = echo executed > '{}'; cat\nrequired = true\n",
                marker.to_string_lossy().replace('\\', "/"),
                marker.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        let output = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args([
                "config",
                "includeIf.onbranch:factory/**.path",
                include.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(output.success());
        let task = create_task(
            &data,
            &discover(&source).unwrap(),
            "Filtered checkout",
            "model",
        )
        .unwrap();
        assert!(
            !marker.exists(),
            "Git smudge filter executed before approval"
        );
        assert_eq!(
            fs::read_to_string(task.directory.join("payload.txt")).unwrap(),
            "tracked payload\n"
        );
        remove_task(&data, &task.id).unwrap();
        assert!(!marker.exists(), "Clean filter executed during removal");
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn escaping_symlinks_are_refused() {
        let source = temp();
        let outside = temp();
        std::os::unix::fs::symlink(&outside, source.join("escape")).unwrap();
        assert!(validate_links(&source).is_err());
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
