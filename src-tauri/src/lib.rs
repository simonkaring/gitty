mod askpass;
pub mod editor;

mod clone;
mod clone_dto;
mod commit;
mod conflicts;
mod diff;
mod dto;
mod external;
mod hunk;
mod identity;
mod mutate;
mod operation_dto;
mod operations;
mod process;
mod remote;
mod remote_dto;
mod repository;
mod stash;
mod stream;
mod wsl;

use clone_dto::*;
use dto::*;
use operation_dto::*;
use remote_dto::*;
use repository::Service;
use std::sync::Arc;
use tauri::Manager;

type Shared = Arc<Service>;
#[tauri::command]
async fn repository_clone(
    state: tauri::State<'_, Shared>,
    operation_id: String,
    request: CloneRequest,
    on_progress: tauri::ipc::Channel<CloneProgress>,
) -> Result<RepositoryLocation> {
    with_service(state, move |service| {
        service.clone_repository(&operation_id, request, move |progress| {
            let _ = on_progress.send(progress);
        })
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
) -> Result<CreatedCommit> {
    with_service(state, move |s| {
        s.amend_commit_with_identity(
            &handle,
            &message,
            identity.as_ref(),
            &expected_head,
            expected_head_ref.as_deref(),
            &expected_status_fingerprint,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Arc::new(Service::new(app.path().app_data_dir()?)));
            askpass::init(app.handle().clone())?;
            editor::init(app.handle().clone())?;
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
            backend_info,
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
            repository_stage_hunk,
            repository_unstage_hunk,
            repository_create_commit,
            repository_amend_commit,
            repository_operation_state,
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
