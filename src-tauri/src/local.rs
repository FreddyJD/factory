use crate::{
    issues,
    repository::{self, Project},
    workspace::{self, Result, Task},
};
use serde_json::{json, Value};
use std::{fs::OpenOptions, path::Path};

pub async fn lease(path: &Path) -> Result<std::fs::File> {
    let common = repository::common(path).await?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(common.join("factory-integration.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "Another local integration is in progress for this repository")?;
    Ok(file)
}
async fn supported(path: &Path) -> Result<()> {
    for operation in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ] {
        let location = repository::git(path, &["rev-parse", "--git-path", operation]).await?;
        let location = Path::new(location.trim());
        let location = if location.is_absolute() {
            location.to_path_buf()
        } else {
            path.join(location)
        };
        if location.exists() {
            return Err(
                "Finish the existing Git merge/rebase/cherry-pick before local integration".into(),
            );
        }
    }
    if repository::git(path, &["config", "--bool", "core.sparseCheckout"])
        .await
        .is_ok_and(|v| v.trim() == "true")
    {
        return Err("Sparse checkouts require manual integration".into());
    }
    if !repository::git(path, &["ls-files", "--unmerged"])
        .await?
        .is_empty()
    {
        return Err("Resolve unmerged index entries first".into());
    }
    let flags = repository::git(path, &["ls-files", "-v", "-z"]).await?;
    if flags.split('\0').any(|line| {
        line.as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_lowercase() || *c == b'S')
    }) {
        return Err("Assume-unchanged or skip-worktree entries require manual integration".into());
    }
    let files = repository::git(path, &["ls-files", "--stage"]).await?;
    if files.lines().any(|line| line.starts_with("160000 ")) {
        return Err("Submodule repositories require manual local integration".into());
    }
    Ok(())
}
pub async fn preview(root: &Path, project: &Project, id: &str) -> Result<Value> {
    let task = workspace::load_task(root, id)?;
    let issue = issues::load(root, id)?;
    if issue.project_id != project.id
        || task.checkouts.len() != 1
        || task.checkouts[0].source != project.path
    {
        return Err("Issue does not belong to this single repository project".into());
    }
    if issue.outcome != "completed" || !matches!(task.status.as_str(), "review" | "ready") {
        return Err("Only a normally completed, idle issue can merge locally".into());
    }
    if !issue.local_merge.is_null() {
        return Err("Local merge already attempted. Inspect the saved result before attempting further Git changes.".into());
    }
    let checkout = &task.checkouts[0];
    supported(&project.path).await?;
    supported(&checkout.path).await?;
    if repository::common(&project.path).await? != repository::common(&checkout.path).await? {
        return Err("Repository identity changed".into());
    }
    let source_ref = repository::git(&project.path, &["symbolic-ref", "HEAD"])
        .await
        .map_err(|_| "Source checkout is detached; select a local branch first")?
        .trim()
        .to_string();
    if !source_ref.starts_with("refs/heads/") {
        return Err("Target is not a local branch".into());
    }
    let source_head = repository::git(&project.path, &["rev-parse", "--verify", "HEAD"])
        .await?
        .trim()
        .to_string();
    let branch = repository::git(&checkout.path, &["symbolic-ref", "--short", "HEAD"])
        .await?
        .trim()
        .to_string();
    if branch != checkout.branch {
        return Err("Issue worktree branch changed; review manually".into());
    }
    if source_ref == format!("refs/heads/{branch}") {
        return Err("Source and issue branch are the same".into());
    }
    if !issues::hardened_git(
        &project.path,
        &["status", "--porcelain", "--untracked-files=all"],
        20,
    )
    .await?
    .is_empty()
    {
        return Err("Source checkout has staged, unstaged or untracked changes. Commit or move them before merging; factory never stashes or resets your work.".into());
    }
    let head = repository::git(&checkout.path, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    repository::git(&checkout.path,&["merge-base","--is-ancestor",&source_head,&head]).await.map_err(|_|"Source branch advanced independently. This merge is fast-forward only; rebase/merge the issue manually, then review again.")?;
    let (tree, diff) = issues::snapshot_tree(&checkout.path, &source_head).await?;
    if diff.is_empty() {
        return Err("No local changes to merge".into());
    }
    let summary = repository::git(&checkout.path, &["ls-tree", "-r", &tree]).await?;
    if summary.lines().any(|l| l.starts_with("160000 ")) {
        return Err("Candidate adds a submodule; merge manually".into());
    }
    if repository::git(&project.path, &["rev-parse", "HEAD"])
        .await?
        .trim()
        != source_head
        || repository::git(&checkout.path, &["rev-parse", "HEAD"])
            .await?
            .trim()
            != head
    {
        return Err("Git history changed while preparing review; refresh".into());
    }
    Ok(
        json!({"projectId":project.id,"taskId":id,"title":issue.title,"sourcePath":project.path,"sourceRef":source_ref,"sourceHead":source_head,"worktree":checkout.path,"branch":branch,"head":head,"tree":tree,"diff":diff,"mode":"fast-forward","validation":issue.validation}),
    )
}
pub async fn merge(root: &Path, project: &Project, id: &str, expected: &Value) -> Result<Value> {
    let _lease = lease(&project.path).await?;
    let before = preview(root, project, id).await?;
    if &before != expected {
        return Err("Files, branch or source HEAD changed since review; refresh the local diff and confirm again".into());
    }
    let task: Task = workspace::load_task(root, id)?;
    let mut issue = issues::load(root, id)?;
    let tree = before["tree"].as_str().ok_or("Missing candidate tree")?;
    let parent = before["head"].as_str().ok_or("Missing issue HEAD")?;
    if repository::git(&project.path, &["config", "--bool", "commit.gpgsign"])
        .await
        .is_ok_and(|v| v.trim() == "true")
    {
        return Err("Signed-commit policy requires manual local integration".into());
    }
    let candidate = issues::hardened_git(
        &task.directory,
        &[
            "-c",
            "user.name=factory",
            "-c",
            "user.email=factory@localhost",
            "commit-tree",
            tree,
            "-p",
            parent,
            "-m",
            &issue.title,
        ],
        20,
    )
    .await?
    .trim()
    .to_string();
    // Keep a recovery ref before updating any checked-out branch. Never retry a partial write.
    repository::git(
        &project.path,
        &[
            "update-ref",
            &format!("refs/factory/local/{id}"),
            &candidate,
            "",
        ],
    )
    .await?;
    match preview(root, project, id).await {
        Ok(after) if after == before => {}
        other => {
            issue.local_merge = json!({"state":"needs-inspection","candidate":candidate,"recoveryRef":format!("refs/factory/local/{id}"),"error":other.err().unwrap_or("Candidate changed".into())});
            issues::save(root, &issue)?;
            return Err("Candidate changed before merge. Recovery commit retained; inspect before retrying.".into());
        }
    }
    issue.local_merge = json!({"state":"merging","candidate":candidate,"sourceRef":before["sourceRef"],"sourceHead":before["sourceHead"]});
    issues::save(root, &issue)?;
    let result = issues::hardened_git(
        &project.path,
        &[
            "merge",
            "--ff-only",
            "--no-edit",
            "--no-autostash",
            "--no-overwrite-ignore",
            "--no-squash",
            "--no-verify",
            &candidate,
        ],
        30,
    )
    .await;
    match result {
        Ok(_) => {
            if repository::git(&project.path, &["rev-parse", "HEAD"])
                .await?
                .trim()
                != candidate
                || repository::git(&project.path, &["symbolic-ref", "HEAD"])
                    .await?
                    .trim()
                    != before["sourceRef"].as_str().unwrap_or("")
            {
                issue.local_merge = json!({"state":"needs-inspection","candidate":candidate,"error":"Source branch changed during integration"});
                issues::save(root, &issue)?;
                return Err(
                    "Git state changed during integration; inspect source and recovery ref".into(),
                );
            }
            issue.local_merge = json!({"state":"merged","commit":candidate,"target":before["sourceRef"],"at":issues::now()});
            issues::save(root, &issue)?;
            Ok(issue.local_merge)
        }
        Err(error) => {
            issue.local_merge =
                json!({"state":"needs-inspection","candidate":candidate,"error":error});
            issues::save(root, &issue)?;
            Err(format!("Local merge stopped. Source and recovery commit are retained; inspect Git state. {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    async fn fixture() -> (std::path::PathBuf, Project, Task) {
        let root = std::env::temp_dir().join(format!("local-merge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let workspace = workspace::initialize_empty(&root.join("source")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        let task = workspace::create_task(&root.join("data"), &workspace, "Local issue", "fixture")
            .unwrap();
        let project = Project {
            id: "project".into(),
            name: "demo".into(),
            path: workspace.path,
        };
        let mut task = task;
        task.status = "review".into();
        workspace::save_task(&root.join("data"), &task).unwrap();
        issues::save(
            &root.join("data"),
            &issues::Issue {
                task_id: task.id.clone(),
                project_id: project.id.clone(),
                title: "Local change".into(),
                outcome: "completed".into(),
                ..Default::default()
            },
        )
        .unwrap();
        fs::write(task.directory.join("new.txt"), "local content\n").unwrap();
        (root, project, task)
    }
    #[tokio::test]
    async fn merges_without_origin_or_gh_and_keeps_worktree() {
        let (root, p, t) = fixture().await;
        let before = preview(&root.join("data"), &p, &t.id).await.unwrap();
        assert!(before["diff"].as_str().unwrap().contains("+local content"));
        let result = merge(&root.join("data"), &p, &t.id, &before).await.unwrap();
        assert_eq!(result["state"], "merged");
        assert_eq!(
            fs::read_to_string(p.path.join("new.txt")).unwrap(),
            "local content\n"
        );
        assert!(t.directory.exists());
        assert!(repository::git(&p.path, &["status", "--porcelain"])
            .await
            .unwrap()
            .is_empty());
        assert!(merge(&root.join("data"), &p, &t.id, &before).await.is_err());
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn dirty_source_and_stale_content_are_preserved() {
        let (root, p, t) = fixture().await;
        let before = preview(&root.join("data"), &p, &t.id).await.unwrap();
        fs::write(p.path.join("mine.txt"), "keep").unwrap();
        assert!(merge(&root.join("data"), &p, &t.id, &before).await.is_err());
        assert_eq!(fs::read_to_string(p.path.join("mine.txt")).unwrap(), "keep");
        fs::remove_file(p.path.join("mine.txt")).unwrap();
        fs::write(t.directory.join("new.txt"), "changed").unwrap();
        assert!(merge(&root.join("data"), &p, &t.id, &before).await.is_err());
        assert!(!p.path.join("new.txt").exists());
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn ignored_local_files_are_never_overwritten() {
        let (root, p, t) = fixture().await;
        let common = repository::common(&p.path).await.unwrap();
        workspace::git(&t.directory, &["add", "new.txt"]).unwrap();
        workspace::git(
            &t.directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "-m",
                "Track new file",
            ],
        )
        .unwrap();
        fs::write(common.join("info/exclude"), "new.txt\n").unwrap();
        fs::write(p.path.join("new.txt"), "keep ignored data").unwrap();
        let before = preview(&root.join("data"), &p, &t.id).await.unwrap();
        assert!(merge(&root.join("data"), &p, &t.id, &before).await.is_err());
        assert_eq!(
            fs::read_to_string(p.path.join("new.txt")).unwrap(),
            "keep ignored data"
        );
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn squash_branch_configuration_cannot_change_merge_mode() {
        let (root, p, t) = fixture().await;
        workspace::git(&p.path, &["config", "branch.main.mergeOptions", "--squash"]).unwrap();
        let before = preview(&root.join("data"), &p, &t.id).await.unwrap();
        let result = merge(&root.join("data"), &p, &t.id, &before).await.unwrap();
        assert_eq!(
            repository::git(&p.path, &["rev-parse", "HEAD"])
                .await
                .unwrap()
                .trim(),
            result["commit"].as_str().unwrap()
        );
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn target_staging_is_never_changed_when_merge_is_refused() {
        let (root, p, t) = fixture().await;
        let before = preview(&root.join("data"), &p, &t.id).await.unwrap();
        fs::write(p.path.join("mine.txt"), "staged").unwrap();
        workspace::git(&p.path, &["add", "mine.txt"]).unwrap();
        let index_before = repository::git(&p.path, &["write-tree"]).await.unwrap();
        assert!(merge(&root.join("data"), &p, &t.id, &before).await.is_err());
        assert_eq!(
            repository::git(&p.path, &["write-tree"]).await.unwrap(),
            index_before
        );
        assert_eq!(
            fs::read_to_string(p.path.join("mine.txt")).unwrap(),
            "staged"
        );
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn divergent_source_is_not_overwritten() {
        let (root, p, t) = fixture().await;
        workspace::git(
            &p.path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "--allow-empty",
                "-m",
                "source advanced",
            ],
        )
        .unwrap();
        assert!(preview(&root.join("data"), &p, &t.id)
            .await
            .unwrap_err()
            .contains("advanced"));
        workspace::git(
            &p.path,
            &[
                "worktree",
                "remove",
                "--force",
                t.directory.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
