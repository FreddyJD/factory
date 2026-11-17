use crate::{
    repository::{self, store},
    tools,
    workspace::{Result, Task},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub task_id: String,
    pub project_id: String,
    pub title: String,
    pub body: String,
    pub created_at: u64,
    pub native_edits: bool,
    pub auto_pr: bool,
    pub validation: String,
    pub target: Value,
    pub outcome: String,
    pub stop_reason: String,
    pub publication: Value,
    #[serde(default)]
    pub local_merge: Value,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn load(root: &Path, id: &str) -> Result<Issue> {
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid issue ID".into());
    }
    serde_json::from_slice(
        &fs::read(root.join("issues").join(format!("{id}.json"))).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
pub fn save(root: &Path, issue: &Issue) -> Result<()> {
    store(
        &root.join("issues").join(format!("{}.json", issue.task_id)),
        issue,
    )
}
pub fn list(root: &Path) -> Result<Vec<Issue>> {
    let dir = root.join("issues");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut list = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            list.push(
                serde_json::from_slice::<Issue>(&fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    list.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(list)
}
pub fn gh_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("GIT_FACTORY_GH_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("Configured GitHub CLI path does not exist".into());
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join(if cfg!(windows) { "gh.exe" } else { "gh" });
        if path.is_file() {
            return Ok(path);
        }
    }
    for path in [
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "C:\\Program Files\\GitHub CLI\\gh.exe",
    ] {
        if Path::new(path).is_file() {
            return Ok(path.into());
        }
    }
    Err(
        "Install GitHub CLI and sign in with gh auth login. Copilot authentication is separate."
            .into(),
    )
}
pub fn github_repo(remote: &str) -> Result<String> {
    let raw = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .ok_or("Only github.com HTTPS/SSH origin remotes are supported")?;
    let name = raw.strip_suffix(".git").unwrap_or(raw);
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
    {
        return Err("Invalid GitHub origin".into());
    }
    Ok(name.into())
}
pub async fn gh(path: &Path, args: &[&str], input: Option<&Value>) -> Result<Value> {
    let mut args = args.to_vec();
    if args.first() == Some(&"api") {
        args.extend(["--hostname", "github.com"]);
    }
    let bytes = input
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|e| e.to_string())?;
    let result = repository::command(&gh_path()?, path, &args, bytes.as_deref(), 90).await?;
    serde_json::from_slice(&result).map_err(|e| format!("Invalid GitHub response: {e}"))
}
pub async fn identity(path: &Path) -> Result<Value> {
    let remote = repository::git(path, &["remote", "get-url", "origin"]).await?;
    let repo = github_repo(remote.trim())?;
    let user = gh(path, &["api", "user"], None).await?;
    let details = gh(
        path,
        &[
            "repo",
            "view",
            &repo,
            "--json",
            "nameWithOwner,defaultBranchRef,viewerPermission",
        ],
        None,
    )
    .await?;
    Ok(
        json!({"repository":repo,"account":user["login"],"defaultBranch":details["defaultBranchRef"]["name"],"permission":details["viewerPermission"]}),
    )
}
pub async fn pulls(path: &Path) -> Result<Value> {
    let remote = match repository::git(path, &["remote", "get-url", "origin"]).await {
        Ok(remote) => remote,
        Err(_) => return Ok(json!([])),
    };
    let repo = match github_repo(remote.trim()) {
        Ok(repo) => repo,
        Err(_) => return Ok(json!([])),
    };
    gh(path,&["pr","list","--repo",&repo,"--limit","100","--state","open","--json","number,title,author,headRefName,headRefOid,baseRefName,isDraft,url,createdAt,reviewDecision"],None).await
}
pub async fn pull(path: &Path, number: u64) -> Result<Value> {
    let remote = repository::git(path, &["remote", "get-url", "origin"]).await?;
    let repo = github_repo(remote.trim())?;
    let number = number.to_string();
    let data=gh(path,&["pr","view",&number,"--repo",&repo,"--json","number,title,body,author,headRefName,headRefOid,baseRefName,isDraft,url,files,reviews,comments,statusCheckRollup"],None).await?;
    let diff = repository::command(
        &gh_path()?,
        path,
        &["pr", "diff", &number, "--repo", &repo],
        None,
        60,
    )
    .await?;
    let current = gh(
        path,
        &["api", &format!("repos/{repo}/pulls/{number}")],
        None,
    )
    .await?;
    if current["head"]["sha"] != data["headRefOid"] {
        return Err("PR head changed while loading the diff; refresh before reviewing".into());
    }
    let user = gh(path, &["api", "user"], None).await?;
    Ok(
        json!({"pull":data,"repository":repo,"account":user["login"],"diff":String::from_utf8_lossy(&diff)}),
    )
}
pub async fn approve(
    path: &Path,
    number: u64,
    head: &str,
    body: &str,
    expected_repo: &str,
    account: &str,
) -> Result<Value> {
    let remote = repository::git(path, &["remote", "get-url", "origin"]).await?;
    let repo = github_repo(remote.trim())?;
    let current = gh(
        path,
        &["api", &format!("repos/{repo}/pulls/{number}")],
        None,
    )
    .await?;
    if repo != expected_repo {
        return Err("Repository origin changed since review".into());
    }
    if current["head"]["sha"] != head {
        return Err("Pull request changed since review. Refresh the diff before approving.".into());
    }
    let user = gh(path, &["api", "user"], None).await?;
    if user["login"] != account {
        return Err("GitHub account changed since review; confirm again".into());
    }
    if user["login"] == current["user"]["login"] {
        return Err(
            "GitHub does not allow approving your own pull request. Request another reviewer."
                .into(),
        );
    }
    gh(
        path,
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{repo}/pulls/{number}/reviews"),
            "--input",
            "-",
        ],
        Some(&json!({"commit_id":head,"event":"APPROVE","body":body})),
    )
    .await
}

pub(crate) async fn hardened_git(path: &Path, args: &[&str], seconds: u64) -> Result<String> {
    index_git(path, args, seconds, None).await
}
async fn index_git(
    path: &Path,
    args: &[&str],
    seconds: u64,
    index: Option<&Path>,
) -> Result<String> {
    let keys = repository::git(path, &["config", "--null", "--name-only", "--list"]).await?;
    let filters = keys
        .split('\0')
        .filter(|key| {
            key.starts_with("filter.")
                && [".process", ".smudge", ".clean"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix))
        })
        .collect::<Vec<_>>()
        .join("\0");
    let mut prefix = vec!["--no-pager".to_string()];
    for key in filters.split('\0').filter(|key| !key.is_empty()) {
        {
            if let Some((driver, _)) = key.rsplit_once('.') {
                if !driver
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                {
                    return Err("Unsupported Git filter name".into());
                }
                for field in ["process", "smudge", "clean"] {
                    prefix.extend(["-c".into(), format!("{driver}.{field}=")]);
                }
                prefix.extend(["-c".into(), format!("{driver}.required=false")]);
            }
        }
    }
    prefix.extend(args.iter().map(|a| a.to_string()));
    String::from_utf8(
        repository::command_index(
            Path::new("git"),
            path,
            &prefix.iter().map(String::as_str).collect::<Vec<_>>(),
            None,
            seconds,
            index,
        )
        .await?,
    )
    .map_err(|e| e.to_string())
}
pub async fn candidate(task: &Task) -> Result<Value> {
    if task.checkouts.len() != 1 {
        return Err("Publish one repository per issue".into());
    }
    let checkout = &task.checkouts[0];
    if repository::git(&checkout.path, &["symbolic-ref", "--short", "HEAD"])
        .await?
        .trim()
        != checkout.branch
    {
        return Err("Issue worktree branch changed; publication refused".into());
    }
    if repository::common(&checkout.path).await? != repository::common(&checkout.source).await? {
        return Err("Worktree repository identity changed".into());
    }
    let remote = repository::git(&checkout.path, &["config", "--get", "remote.origin.url"]).await?;
    let repo = github_repo(remote.trim())?;
    let info = identity(&checkout.path).await?;
    let base = info["defaultBranch"]
        .as_str()
        .ok_or("Missing default branch")?;
    let remote_base = gh(
        &checkout.path,
        &["api", &format!("repos/{repo}/git/ref/heads/{base}")],
        None,
    )
    .await?;
    if remote_base["object"]["sha"] != checkout.base {
        return Err("Issue must start at the current GitHub default-branch commit for automatic publication. Update your source branch before creating a new issue, or publish this branch manually.".into());
    }
    let (tree, diff) = snapshot_tree(&checkout.path, &checkout.base).await?;
    if diff.is_empty() {
        return Err("No changes to publish".into());
    }
    Ok(
        json!({"taskId":task.id,"repository":repo,"account":info["account"],"base":base,"baseOid":checkout.base,"branch":checkout.branch,"head":repository::git(&checkout.path,&["rev-parse","HEAD"]).await?.trim(),"tree":tree,"diff":diff,"added":[]}),
    )
}

pub async fn snapshot_tree(path: &Path, base: &str) -> Result<(String, String)> {
    let index = std::env::temp_dir().join(format!("factory-candidate-{}", uuid::Uuid::new_v4()));
    let result = async {
        index_git(path, &["read-tree", "HEAD"], 20, Some(&index)).await?;
        index_git(path, &["add", "--all", "--", "."], 30, Some(&index)).await?;
        let tree = index_git(path, &["write-tree"], 20, Some(&index)).await?;
        let diff = index_git(
            path,
            &[
                "diff",
                "--cached",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
                base,
                "--",
            ],
            20,
            Some(&index),
        )
        .await?;
        if diff.len() > 2_000_000 {
            return Err("Candidate diff exceeds 2 MB; publish manually".into());
        }
        Ok((tree.trim().to_string(), diff))
    }
    .await;
    let _ = fs::remove_file(index);
    result
}

pub async fn publish(
    root: &Path,
    task: &Task,
    expected: &Value,
    cancel: CancellationToken,
) -> Result<Value> {
    let mut issue = load(root, &task.id)?;
    if issue.outcome != "completed"
        || matches!(
            task.status.as_str(),
            "interrupted" | "stopped" | "failed" | "budget-exhausted"
        )
    {
        return Err("Only a normally completed issue can publish. Stopped, failed and budget-limited runs cannot.".into());
    }
    if !issue.publication.is_null() {
        return Err(
            "Publication already attempted; inspect the recorded result before any retry".into(),
        );
    }
    let before = candidate(task).await?;
    if issue.target["repository"] != before["repository"]
        || issue.target["account"] != before["account"]
        || issue.target["defaultBranch"] != before["base"]
    {
        return Err(
            "GitHub publication target or account changed since issue authorization".into(),
        );
    }
    if &before != expected {
        return Err("Candidate, branch or GitHub account changed; review again".into());
    }
    let path = &task.checkouts[0].path;
    if repository::git(
        path,
        &[
            "config",
            "--get-regexp",
            "^url\\..*\\.(insteadof|pushinsteadof)$",
        ],
    )
    .await
    .is_ok()
    {
        return Err("Git URL rewrites require manual publication".into());
    }
    if repository::git(path, &["config", "--get-all", "remote.origin.pushurl"])
        .await
        .is_ok()
    {
        return Err("Custom push URLs require manual publication".into());
    }
    if issue.validation.trim().is_empty() {
        return Err("Configure a validation command before publishing".into());
    }
    issue.publication = json!({"state":"validating","candidate":before,"command":issue.validation});
    save(root, &issue)?;
    let validation = tools::shell_result(
        task,
        &json!({"command":issue.validation,"timeout":120000}),
        cancel.clone(),
    )
    .await;
    let result=async{
        let output=validation?;
        if cancel.is_cancelled(){return Err("Publication cancelled".into());}
        if !output.success{return Err(format!("Validation failed (exit {:?}): {}",output.code,output.output));}
        let output=output.output;
        if candidate(task).await?!=before{return Err("Validation changed candidate files; inspect changes before publishing".into());}
        issue.publication=json!({"state":"committing","validation":output});save(root,&issue)?;
        let tree=before["tree"].as_str().ok_or("Missing candidate tree")?;
        let parent=before["head"].as_str().ok_or("Missing candidate parent")?;
        if repository::git(path,&["config","--get","commit.gpgsign"]).await.is_ok_and(|v|v.trim()=="true"){return Err("This repository requires signed commits; publish manually until signed commit-tree is configured".into());}
        let head=hardened_git(path,&["commit-tree",tree,"-p",parent,"-m",&issue.title],30).await?;
        let branch=&task.checkouts[0].branch;
        hardened_git(path,&["update-ref",&format!("refs/heads/{branch}"),head.trim(),parent],20).await?;
        hardened_git(path,&["read-tree",tree],20).await?;
        let remote=repository::git(path,&["config","--get","remote.origin.url"]).await?;
        if github_repo(remote.trim())?!=before["repository"].as_str().ok_or("Missing repository")?{return Err("Publication remote changed".into());}
        if cancel.is_cancelled(){return Err("Publication cancelled before push".into());}
        if repository::git(path,&["config","--get-regexp","^url\\..*\\.(insteadof|pushinsteadof)$"]).await.is_ok() || repository::git(path,&["config","--get-all","remote.origin.pushurl"]).await.is_ok(){return Err("Git transport configuration changed during validation; publication refused".into());}
        if repository::git(path,&["remote","get-url","--push","origin"]).await?.trim()!=remote.trim(){return Err("Push destination differs from the authorized origin".into());}
        if identity(path).await?["account"]!=before["account"]{return Err("GitHub account changed before publication".into());}
        issue.publication=json!({"state":"pushing","head":head.trim(),"branch":branch});save(root,&issue)?;
        hardened_git(path,&["push","--no-verify","--no-follow-tags","--recurse-submodules=no",remote.trim(),&format!("{}:refs/heads/{branch}",head.trim())],90).await?;
        let verified=repository::git(path,&["ls-remote",remote.trim(),&format!("refs/heads/{branch}")]).await?;if verified.split_whitespace().next()!=Some(head.trim()){return Err("Remote branch does not match the published commit".into());}
        let body=format!("{}\n\nGit Factory issue `{}`.\n\nValidation: `{}`\n\n```text\n{}\n```",issue.body,issue.task_id,issue.validation,tools::clip(&output,10_000));
        if cancel.is_cancelled(){return Err("Publication cancelled after push; branch retained".into());}
        issue.publication=json!({"state":"creating-pr","head":head.trim(),"branch":branch});save(root,&issue)?;
        let repo=before["repository"].as_str().ok_or("Missing repository")?;let base=before["base"].as_str().ok_or("Missing base branch")?;
        if identity(path).await?["account"]!=before["account"]{return Err("GitHub account changed after push; inspect the retained branch".into());}
        let result=gh(path,&["api","--method","POST",&format!("repos/{repo}/pulls"),"--input","-"],Some(&json!({"title":issue.title,"body":body,"head":branch,"base":base,"draft":true}))).await?;
        Ok(json!({"state":"published","number":result["number"],"url":result["html_url"],"head":head.trim()}))
    }.await;
    match result {
        Ok(publication) => {
            issue.publication = publication.clone();
            save(root, &issue)?;
            Ok(publication)
        }
        Err(error) => {
            issue.publication =
                json!({"state":"failed-or-unknown","error":error,"last":issue.publication});
            save(root, &issue)?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn candidate_includes_untracked_content_without_mutating_the_real_index() {
        let path = std::env::temp_dir().join(format!("candidate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        let path = dunce::canonicalize(path).unwrap();
        let ws = crate::workspace::initialize_empty(&path).unwrap();
        fs::write(path.join("new.rs"), "fn main() {}\n").unwrap();
        let before = repository::git(&path, &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        let (tree, diff) = snapshot_tree(&path, &ws.repositories[0].base)
            .await
            .unwrap();
        assert!(diff.contains("+fn main() {}"));
        assert_eq!(
            repository::git(&path, &["diff", "--cached", "--name-only"])
                .await
                .unwrap(),
            before
        );
        fs::write(path.join("new.rs"), "different\n").unwrap();
        assert_ne!(
            snapshot_tree(&path, &ws.repositories[0].base)
                .await
                .unwrap()
                .0,
            tree
        );
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn github_origin_is_exact() {
        assert_eq!(
            github_repo("git@github.com:owner/repo.git").unwrap(),
            "owner/repo"
        );
        for url in [
            "https://evil/github.com/a/b",
            "https://github.com/a/b/extra",
            "https://user:token@github.com/a/b",
            "file:///repo",
        ] {
            assert!(github_repo(url).is_err());
        }
    }
}
