use serde::{Deserialize, Serialize};
use std::io::Write;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;

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

pub fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let filters = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args([
            "config",
            "--get-regexp",
            "^filter\\..*\\.(process|smudge|clean)$",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let mut command = Command::new("git");
    // Disable configured content filters for our Git operations, including globally
    // installed LFS filters. Checkout preserves pointer files rather than running code.
    for line in String::from_utf8_lossy(&filters.stdout).lines() {
        if let Some(key) = line.split_whitespace().next() {
            if let Some((driver, _)) = key.rsplit_once('.') {
                for field in ["process", "smudge", "clean"] {
                    command.args(["-c", &format!("{driver}.{field}=")]);
                }
                command.args(["-c", &format!("{driver}.required=false")]);
            }
        }
    }
    let output = command
        .arg("-C")
        .arg(directory)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env(
            "GIT_CONFIG_VALUE_0",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "core.longpaths")
        .env("GIT_CONFIG_VALUE_2", "true")
        .output()
        .map_err(|e| format!("Git could not start: {e}"))?;
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

fn repository(path: &Path) -> Result<Repository> {
    let root = PathBuf::from(git(path, &["rev-parse", "--show-toplevel"])?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if root != path {
        return Err("Select the repository root, not a nested source directory".into());
    }
    let base = git(path, &["rev-parse", "--verify", "HEAD"]).map_err(|_| {
        "Repository needs an initial commit before worktrees can be created".to_string()
    })?;
    let branch = git(path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_else(|_| "detached HEAD".into());
    let remote = git(path, &["config", "--get", "remote.origin.url"])
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

pub fn discover(path: &Path) -> Result<Workspace> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Select a directory".into());
    }
    let mut repositories = Vec::new();
    if path.join(".git").exists() {
        repositories.push(repository(&path)?);
    } else {
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())?.take(1000) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && entry.path().join(".git").exists()
            {
                repositories.push(repository(
                    &entry.path().canonicalize().map_err(|e| e.to_string())?,
                )?);
            }
        }
    }
    repositories.sort_by(|a, b| a.name.cmp(&b.name));
    let can_initialize = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .next()
        .is_none();
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
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if workspace.repositories.is_empty() {
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
        workspace: workspace.path.clone(),
        directory: group.clone(),
        checkouts: Vec::new(),
        status: "allocating".into(),
        session_id: None,
        model: model.into(),
    };
    save_task(&root, &task)?;
    for (index, repo) in workspace.repositories.iter().enumerate() {
        let fresh = repository(&repo.path)?;
        let path = group.join(format!("{index}-{}", fresh.name));
        let branch = format!("factory/{id}-{index}");
        // No post-checkout hooks or source mutations. Record partial allocations before returning errors.
        if let Err(error) = git(
            &fresh.path,
            &[
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                &branch,
                path.to_str().ok_or("Non-UTF8 path")?,
                &fresh.base,
            ],
        ) {
            task.status = "allocation-failed".into();
            save_task(&root, &task)?;
            return Err(format!(
                "{error}. Any allocated worktrees have been retained and recorded."
            ));
        }
        task.checkouts.push(Checkout {
            source: fresh.path,
            path: path.canonicalize().map_err(|e| e.to_string())?,
            base: fresh.base,
            branch,
        });
        save_task(&root, &task)?;
        git(&path, &["read-tree", "--reset", "-u", "HEAD"])?;
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
    if task.directory.canonicalize().map_err(|e| e.to_string())? != task.directory {
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
        if checkout.path.canonicalize().map_err(|e| e.to_string())? != checkout.path
            || !checkout.path.starts_with(root.join("worktrees").join(id))
        {
            return Err("Worktree path changed; execution refused".into());
        }
        let base = git(&checkout.path, &["rev-parse", "--show-toplevel"])?;
        if PathBuf::from(base)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != checkout.path
        {
            return Err("Worktree registration changed".into());
        }
    }
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
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == ".git" {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                let target = entry.path().canonicalize().map_err(|_| {
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
    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!("factory-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
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
    #[cfg(unix)]
    #[test]
    fn branch_conditional_filters_do_not_execute_during_worktree_checkout() {
        let source = temp();
        let data = temp();
        initialize_empty(&source).unwrap();
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
                "[filter \"evil\"]\nsmudge = touch '{}'; cat\n",
                marker.display()
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
