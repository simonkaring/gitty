mod askpass;
pub mod editor;

mod clone;
mod clone_dto;
mod commit;
mod conflicts;
mod credentials;
mod diff;
mod dto;
mod external;
mod hunk;
mod identity;
#[cfg(target_os = "linux")]
mod linux;
mod mutate;
mod operation_dto;
mod operations;
mod process;
mod provider_accounts;
mod provider_oauth;
mod provider_pr;
mod remote;
mod remote_dto;
mod repository;
mod stash;
mod stream;
mod worktree_files;
mod wsl;

use clone_dto::*;
use dto::*;
use operation_dto::*;
use remote_dto::*;
use repository::Service;
use std::sync::Arc;
use tauri::{Emitter, Manager};

type Shared = Arc<Service>;
type Accounts = Arc<provider_accounts::AccountStore>;

#[tauri::command]
async fn list_provider_accounts(
    state: tauri::State<'_, Accounts>,
) -> Result<Vec<provider_accounts::ProviderAccount>> {
    let accounts = state.inner().clone();
    blocking(move || accounts.list()).await
}

#[tauri::command]
async fn provider_connect_token(
    state: tauri::State<'_, Accounts>,
    provider: provider_accounts::Provider,
    username: String,
    token: String,
) -> Result<provider_accounts::ProviderAccount> {
    let accounts = state.inner().clone();
    blocking(move || accounts.connect_token(provider, username, token)).await
}

#[tauri::command]
async fn provider_disconnect(state: tauri::State<'_, Accounts>, id: String) -> Result<()> {
    let accounts = state.inner().clone();
    blocking(move || accounts.disconnect(&id)).await
}

#[tauri::command]
async fn provider_oauth_start(
    state: tauri::State<'_, Arc<provider_oauth::OAuth>>,
    provider: provider_accounts::Provider,
) -> Result<provider_oauth::DeviceAuthorization> {
    let oauth = state.inner().clone();
    blocking(move || oauth.start(provider)).await
}

#[tauri::command]
async fn provider_oauth_poll(
    state: tauri::State<'_, Arc<provider_oauth::OAuth>>,
    accounts: tauri::State<'_, Accounts>,
    id: String,
) -> Result<provider_oauth::PollResult> {
    let oauth = state.inner().clone();
    let accounts = accounts.inner().clone();
    blocking(move || oauth.poll(&accounts, &id)).await
}

#[tauri::command]
async fn provider_oauth_cancel(
    state: tauri::State<'_, Arc<provider_oauth::OAuth>>,
    id: String,
) -> Result<()> {
    let oauth = state.inner().clone();
    blocking(move || oauth.cancel(&id)).await
}

#[tauri::command]
async fn provider_pull_requests(
    state: tauri::State<'_, Shared>,
    accounts: tauri::State<'_, Accounts>,
    handle: String,
    remote: String,
    account_id: String,
) -> Result<Vec<provider_pr::ProviderPullRequest>> {
    let accounts = accounts.inner().clone();
    with_service(state, move |s| {
        s.provider_pull_requests(&accounts, &handle, &remote, &account_id)
    })
    .await
}

#[tauri::command]
async fn provider_create_pull_request(
    state: tauri::State<'_, Shared>,
    accounts: tauri::State<'_, Accounts>,
    handle: String,
    remote: String,
    account_id: String,
    request: provider_pr::CreatePullRequest,
) -> Result<provider_pr::ProviderPullRequest> {
    let accounts = accounts.inner().clone();
    with_service(state, move |s| {
        s.provider_create_pull_request(&accounts, &handle, &remote, &account_id, request)
    })
    .await
}
#[tauri::command]
async fn repository_clone(
    state: tauri::State<'_, Shared>,
    askpass: tauri::State<'_, Arc<askpass::AskpassRegistry>>,
    operation_id: String,
    request: CloneRequest,
    on_progress: tauri::ipc::Channel<CloneProgress>,
) -> Result<RepositoryLocation> {
    let askpass = askpass.inner().clone();
    with_service(state, move |service| {
        service.clone_repository_with_askpass(
            &operation_id,
            request,
            move |progress| {
                let _ = on_progress.send(progress);
            },
            Some(&askpass),
        )
    })
    .await
}
#[tauri::command]
async fn repository_cancel_clone(
    state: tauri::State<'_, Shared>,
    operation_id: String,
) -> Result<()> {
    with_service(state, move |service| service.cancel_clone(&operation_id)).await
}
#[tauri::command]
async fn repository_sync_info(state: tauri::State<'_, Shared>, handle: String) -> Result<SyncInfo> {
    with_service(state, move |s| s.repo(&handle)?.sync_info()).await
}
#[tauri::command]
async fn repository_remote_action(
    state: tauri::State<'_, Shared>,
    registry: tauri::State<'_, Arc<crate::askpass::AskpassRegistry>>,
    handle: String,
    action: RemoteAction,
) -> Result<ActionOutput> {
    let registry = Some(registry.inner().clone());
    with_service(state, move |s| {
        s.remote_action(&handle, action, registry.as_deref())
    })
    .await
}
#[tauri::command]
async fn repository_stashes(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<Vec<StashEntry>> {
    with_service(state, move |s| s.repo(&handle)?.stashes()).await
}
#[tauri::command]
async fn repository_stash_action(
    state: tauri::State<'_, Shared>,
    handle: String,
    action: StashAction,
) -> Result<ActionOutput> {
    with_service(state, move |s| s.stash_action(&handle, action)).await
}
#[tauri::command]
async fn repository_operation_state(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<OperationState> {
    with_service(state, move |s| s.repo(&handle)?.operation_state()).await
}
#[tauri::command]
async fn repository_snapshot(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<RepositorySnapshot> {
    with_service(state, move |s| s.repo(&handle)?.snapshot()).await
}
#[tauri::command]
async fn repository_branch_relation(
    state: tauri::State<'_, Shared>,
    handle: String,
    first: String,
    second: String,
) -> Result<(usize, usize)> {
    with_service(state, move |s| {
        s.repo(&handle)?.branch_relation(&first, &second)
    })
    .await
}
#[tauri::command]
async fn repository_run_operation(
    state: tauri::State<'_, Shared>,
    editor: tauri::State<'_, Arc<crate::editor::EditorRegistry>>,
    handle: String,
    request: OperationRequest,
) -> Result<OperationResult> {
    let editor = editor.inner().clone();
    with_service(state, move |s| {
        s.run_operation(&handle, request, Some(&editor))
    })
    .await
}
#[tauri::command]
async fn repository_conflict_file(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
) -> Result<ConflictFile> {
    with_service(state, move |s| s.repo(&handle)?.conflict_file(&path)).await
}
#[tauri::command]
async fn repository_resolve_conflict(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
    fingerprint: String,
    resolution: ConflictResolution,
) -> Result<()> {
    with_service(state, move |s| {
        s.resolve_conflict(&handle, &path, &fingerprint, resolution)
    })
    .await
}
#[tauri::command]
async fn repository_remotes(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<Vec<RemoteInfo>> {
    with_service(state, move |s| s.repo(&handle)?.remotes()).await
}
#[tauri::command]
async fn open_external_url(url: String) -> Result<()> {
    blocking(move || external::open_url(&url)).await
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || process::request(f))
        .await
        .map_err(|e| Error::new("worker", e.to_string()))?
}
async fn with_service<T: Send + 'static>(
    state: tauri::State<'_, Shared>,
    f: impl FnOnce(&Service) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = state.inner().clone();
    blocking(move || f(&state)).await
}
#[tauri::command]
async fn repository_pick() -> Result<Option<String>> {
    let selection = rfd::AsyncFileDialog::new()
        .set_title("Open Git repository")
        .pick_folder()
        .await;
    selection
        .map(|f| {
            f.path()
                .to_str()
                .map(String::from)
                .ok_or_else(|| Error::new("unsupportedEncoding", "Selected path is not UTF-8"))
        })
        .transpose()
}
#[tauri::command]
async fn repository_pick_clone_parent() -> Result<Option<String>> {
    let selection = rfd::AsyncFileDialog::new()
        .set_title("Choose clone destination folder")
        .pick_folder()
        .await;
    selection
        .map(|f| {
            f.path()
                .to_str()
                .map(String::from)
                .ok_or_else(|| Error::new("unsupportedEncoding", "Selected path is not UTF-8"))
        })
        .transpose()
}
#[tauri::command]
async fn repository_open(
    state: tauri::State<'_, Shared>,
    location: RepositoryLocation,
) -> Result<RepositoryState> {
    with_service(state, move |s| s.open(location)).await
}
#[tauri::command]
async fn repository_close(state: tauri::State<'_, Shared>, handle: String) -> Result<()> {
    with_service(state, move |s| s.close(&handle)).await
}
#[tauri::command]
async fn repository_recent(state: tauri::State<'_, Shared>) -> Result<Vec<RepositoryLocation>> {
    with_service(state, |s| s.recent()).await
}
#[tauri::command]
async fn repository_state(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<RepositoryState> {
    with_service(state, move |s| s.repo(&handle)?.state()).await
}
#[tauri::command]
async fn repository_git_identity(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<RepositoryGitIdentity> {
    with_service(state, move |s| s.repo(&handle)?.git_identity()).await
}
#[tauri::command]
async fn repository_set_git_identity(
    state: tauri::State<'_, Shared>,
    handle: String,
    identity: CommitIdentity,
    expected_local: GitIdentityValues,
) -> Result<RepositoryGitIdentity> {
    with_service(state, move |s| {
        s.set_git_identity(&handle, &identity, &expected_local)
    })
    .await
}
#[tauri::command]
async fn repository_history(
    state: tauri::State<'_, Shared>,
    handle: String,
    cursor: Option<String>,
    limit: usize,
    query: HistoryQuery,
) -> Result<HistoryPage> {
    with_service(state, move |s| {
        s.repo(&handle)?.history(cursor, limit, query)
    })
    .await
}
#[tauri::command]
async fn repository_commit(
    state: tauri::State<'_, Shared>,
    handle: String,
    oid: String,
) -> Result<CommitDetail> {
    with_service(state, move |s| s.repo(&handle)?.commit(&oid)).await
}
#[tauri::command]
async fn repository_status(
    state: tauri::State<'_, Shared>,
    handle: String,
) -> Result<RepositoryStatus> {
    with_service(state, move |s| s.repo(&handle)?.status()).await
}
#[tauri::command]
async fn repository_diff_files(
    state: tauri::State<'_, Shared>,
    handle: String,
    spec: DiffSpec,
) -> Result<Vec<DiffFile>> {
    with_service(state, move |s| s.repo(&handle)?.diff_files(&spec)).await
}
#[tauri::command]
async fn repository_diff(
    state: tauri::State<'_, Shared>,
    handle: String,
    spec: DiffSpec,
    path: String,
) -> Result<FileDiff> {
    with_service(state, move |s| s.repo(&handle)?.diff(&spec, &path)).await
}
/// Stages exactly the named files. Paths are always explicit; an empty list is an
/// error, never "everything".
#[tauri::command]
async fn repository_stage(
    state: tauri::State<'_, Shared>,
    handle: String,
    paths: Vec<String>,
) -> Result<()> {
    with_service(state, move |s| s.stage(&handle, &paths)).await
}
/// Discards unstaged changes for exactly the named files: tracked files are restored
/// from the index and untracked files are deleted, which cannot be undone. Staged-only
/// paths are refused, and `expected_status_fingerprint` must match the current status.
#[tauri::command]
async fn repository_discard(
    state: tauri::State<'_, Shared>,
    handle: String,
    paths: Vec<String>,
    expected_status_fingerprint: String,
) -> Result<()> {
    with_service(state, move |s| {
        s.discard(&handle, &paths, &expected_status_fingerprint)
    })
    .await
}
/// Opens one working-tree file in its default application. Regular, non-executable
/// documents inside the worktree only.
#[tauri::command]
async fn repository_open_path(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
) -> Result<()> {
    with_service(state, move |s| s.open_path(&handle, &path)).await
}
/// Shows one working-tree file in the platform file manager.
#[tauri::command]
async fn repository_reveal_path(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
) -> Result<()> {
    with_service(state, move |s| s.reveal_path(&handle, &path)).await
}
/// Adds an anchored line for one untracked file to the root `.gitignore`.
#[tauri::command]
async fn repository_ignore_path(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
) -> Result<()> {
    with_service(state, move |s| s.ignore_path(&handle, &path)).await
}
/// Unstages exactly the named files. The working tree is never modified.
#[tauri::command]
async fn repository_unstage(
    state: tauri::State<'_, Shared>,
    handle: String,
    paths: Vec<String>,
) -> Result<()> {
    with_service(state, move |s| s.unstage(&handle, &paths)).await
}
/// Applies one complete backend-generated hunk to the index.
#[tauri::command]
async fn repository_stage_hunk(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
    hunk_index: usize,
    fingerprint: String,
    line_indices: Option<Vec<usize>>,
) -> Result<()> {
    with_service(state, move |s| {
        s.stage_hunk(&handle, &path, hunk_index, &fingerprint, line_indices)
    })
    .await
}
#[tauri::command]
async fn repository_unstage_hunk(
    state: tauri::State<'_, Shared>,
    handle: String,
    path: String,
    hunk_index: usize,
    fingerprint: String,
    line_indices: Option<Vec<usize>>,
) -> Result<()> {
    with_service(state, move |s| {
        s.unstage_hunk(&handle, &path, hunk_index, &fingerprint, line_indices)
    })
    .await
}
/// Commits the staged index with the configured identity, hooks and signing.
#[tauri::command]
async fn repository_create_commit(
    state: tauri::State<'_, Shared>,
    handle: String,
    message: String,
    identity: Option<CommitIdentity>,
) -> Result<CreatedCommit> {
    with_service(state, move |s| {
        s.create_commit_with_identity(&handle, &message, identity.as_ref())
    })
    .await
}
#[tauri::command]
async fn repository_amend_commit(
    state: tauri::State<'_, Shared>,
    handle: String,
    message: String,
    identity: Option<CommitIdentity>,
    expected_head: String,
    expected_head_ref: Option<String>,
    expected_status_fingerprint: String,
    message_only: Option<bool>,
    require_unpushed: Option<bool>,
) -> Result<CreatedCommit> {
    let options = mutate::AmendOptions {
        message_only: message_only.unwrap_or(false),
        require_unpushed: require_unpushed.unwrap_or(false),
    };
    with_service(state, move |s| {
        s.amend_commit_with_identity(
            &handle,
            &message,
            identity.as_ref(),
            &expected_head,
            expected_head_ref.as_deref(),
            &expected_status_fingerprint,
            options,
        )
    })
    .await
}
#[tauri::command]
async fn repository_search(
    state: tauri::State<'_, Shared>,
    handle: String,
    query: SearchQuery,
) -> Result<SearchResult> {
    with_service(state, move |s| s.repo(&handle)?.search(query)).await
}
#[tauri::command]
async fn wsl_distributions() -> Result<Vec<WslDistribution>> {
    blocking(wsl::distributions).await
}
#[tauri::command]
async fn wsl_directories(distribution: String, path: String) -> Result<Vec<DirectoryEntry>> {
    blocking(move || wsl::directories(&distribution, &path)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo {
    platform: &'static str,
    mode: &'static str,
    native_git_available: bool,
    wsl_available: bool,
}
#[tauri::command]
async fn backend_info() -> Result<BackendInfo> {
    blocking(|| {
        let mut c = std::process::Command::new("git");
        c.arg("--version");
        Ok(BackendInfo {
            platform: std::env::consts::OS,
            mode: "native",
            native_git_available: process::run(c).is_ok_and(|o| o.success),
            wsl_available: cfg!(windows) && wsl::distributions().is_ok(),
        })
    })
    .await
}
#[tauri::command]
fn app_start_dragging(window: tauri::WebviewWindow) -> Result<()> {
    window
        .start_dragging()
        .map_err(|e| Error::new("window", e.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "windows")]
            for (_, window) in app.webview_windows() {
                window.set_decorations(false)?;
            }
            credentials::init(app.path().resource_dir()?);
            app.manage(Arc::new(provider_oauth::OAuth::default()));
            app.manage(Arc::new(provider_accounts::AccountStore::new(
                app.path().app_data_dir()?.join("provider-accounts.json"),
            )));
            app.manage(Arc::new(Service::new(app.path().app_data_dir()?)));
            let handle = app.handle().clone();
            process::set_git_log(move |log| {
                let _ = handle.emit("git_command", log);
            });
            askpass::init(app.handle().clone())?;
            editor::init(app.handle().clone())?;
            #[cfg(target_os = "linux")]
            {
                for (_, window) in app.webview_windows() {
                    linux::configure_linux_window(&window);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.state::<Shared>().cancel_all_clones();
                if let Some(askpass) = window.try_state::<Arc<askpass::AskpassRegistry>>() {
                    askpass.cancel_all();
                }
                if let Some(editor) = window.try_state::<Arc<editor::EditorRegistry>>() {
                    editor.cancel_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_start_dragging,
            backend_info,
            list_provider_accounts,
            provider_connect_token,
            provider_oauth_start,
            provider_oauth_poll,
            provider_oauth_cancel,
            provider_disconnect,
            provider_pull_requests,
            provider_create_pull_request,
            repository_clone,
            repository_cancel_clone,
            repository_pick,
            repository_pick_clone_parent,
            repository_open,
            repository_close,
            repository_recent,
            repository_state,
            repository_git_identity,
            repository_set_git_identity,
            repository_history,
            repository_commit,
            repository_status,
            repository_diff_files,
            repository_diff,
            repository_search,
            repository_stage,
            repository_unstage,
            repository_discard,
            repository_open_path,
            repository_reveal_path,
            repository_ignore_path,
            repository_stage_hunk,
            repository_unstage_hunk,
            repository_create_commit,
            repository_amend_commit,
            repository_operation_state,
            repository_snapshot,
            repository_branch_relation,
            repository_run_operation,
            repository_conflict_file,
            repository_resolve_conflict,
            repository_remotes,
            repository_sync_info,
            repository_remote_action,
            repository_stashes,
            repository_stash_action,
            open_external_url,
            askpass::repository_provide_password,
            editor::editor_reply,
            wsl_distributions,
            wsl_directories
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Gitty");
}

#[cfg(test)]
mod hunk_tests;
#[cfg(test)]
mod operation_tests;
#[cfg(test)]
mod remote_tests;
#[cfg(test)]
mod tests;
#[cfg(all(test, windows))]
mod wsl_tests;
