mod commit;
mod diff;
mod dto;
mod process;
mod repository;
mod stream;
mod wsl;

use dto::*;
use repository::Service;
use std::sync::Arc;
use tauri::Manager;

type Shared = Arc<Service>;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_info,
            repository_pick,
            repository_open,
            repository_close,
            repository_recent,
            repository_state,
            repository_history,
            repository_commit,
            repository_status,
            repository_diff_files,
            repository_diff,
            repository_search,
            wsl_distributions,
            wsl_directories
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Gitty");
}

#[cfg(test)]
mod tests;
