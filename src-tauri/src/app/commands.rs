use tauri::{AppHandle, Manager, State};

use crate::core::domain::{
    AppHealthResponse, AppSettings, DownloadFormatOption, DownloadJob, OpenPathRequest,
    PlayerLaunchRequest, PlayerLiveSource, PlayerPreparedMedia, QueueAddRequest, QueueJobRequest,
    QueueListResponse, SetDownloadDirRequest, UrlRequest, UrlValidationResponse, VideoMetadata,
};
use crate::core::errors::AppError;
use crate::infrastructure::engines;
use crate::infrastructure::media_library;
use crate::services::queue::PreparedDownload;
use crate::AppState;

fn to_error_string(err: AppError) -> String {
    err.user_message()
}

fn join_error_to_string<E: std::fmt::Display>(context: &str, err: E) -> String {
    format!("{context} failed: {err}")
}

#[tauri::command]
pub fn app_get_health() -> AppHealthResponse {
    AppHealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.read_settings())
}

#[tauri::command]
pub fn settings_set_download_dir(
    state: State<'_, AppState>,
    request: SetDownloadDirRequest,
) -> Result<AppSettings, String> {
    state
        .set_download_dir(&request.download_dir)
        .map_err(to_error_string)
}

#[tauri::command]
pub fn settings_pick_download_dir(
    state: State<'_, AppState>,
) -> Result<Option<AppSettings>, String> {
    state.pick_download_dir_and_save().map_err(to_error_string)
}

#[tauri::command]
pub async fn engines_get_status(
    _state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::core::domain::EnginesStatusResponse, String> {
    let app_for_job = app.clone();
    tauri::async_runtime::spawn_blocking(
        move || -> Result<crate::core::domain::EnginesStatusResponse, String> {
            let state = app_for_job.state::<AppState>();
            let settings = state.read_settings();
            Ok(engines::engines_status(&settings))
        },
    )
    .await
    .map_err(|err| join_error_to_string("engines_get_status", err))?
}

#[tauri::command]
pub async fn engines_update_yt_dlp(
    _state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let app_for_job = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = app_for_job.state::<AppState>();
        let settings = state.read_settings();
        engines::run_ytdlp_self_update(&settings).map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("engines_update_yt_dlp", err))?
}

#[tauri::command]
pub async fn engines_install_managed(
    _state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[PullDown][commands][INFO] engines_install_managed: invoked");
    let app_for_job = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = app_for_job.state::<AppState>();
        state
            .install_managed_engines(&app_for_job)
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("engines_install_managed", err))?;
    if result.is_ok() {
        eprintln!("[PullDown][commands][INFO] engines_install_managed: success");
    } else if let Err(err) = &result {
        eprintln!(
            "[PullDown][commands][ERROR] engines_install_managed: {}",
            err
        );
    }
    result
}

#[tauri::command]
pub async fn engines_install_ytdlp(
    _state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[PullDown][commands][INFO] engines_install_ytdlp: invoked");
    let app_for_job = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = app_for_job.state::<AppState>();
        state
            .install_managed_ytdlp(&app_for_job)
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("engines_install_ytdlp", err))?;
    if result.is_ok() {
        eprintln!("[PullDown][commands][INFO] engines_install_ytdlp: success");
    } else if let Err(err) = &result {
        eprintln!("[PullDown][commands][ERROR] engines_install_ytdlp: {}", err);
    }
    result
}

#[tauri::command]
pub async fn engines_install_ffmpeg(
    _state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[PullDown][commands][INFO] engines_install_ffmpeg: invoked");
    let app_for_job = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = app_for_job.state::<AppState>();
        state
            .install_managed_ffmpeg(&app_for_job)
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("engines_install_ffmpeg", err))?;
    if result.is_ok() {
        eprintln!("[PullDown][commands][INFO] engines_install_ffmpeg: success");
    } else if let Err(err) = &result {
        eprintln!(
            "[PullDown][commands][ERROR] engines_install_ffmpeg: {}",
            err
        );
    }
    result
}

#[tauri::command]
pub fn app_open_in_file_manager(
    state: State<'_, AppState>,
    request: OpenPathRequest,
) -> Result<(), String> {
    state
        .open_in_file_manager(request.path.as_deref())
        .map_err(to_error_string)
}

#[tauri::command]
pub fn app_play_media(state: State<'_, AppState>, request: OpenPathRequest) -> Result<(), String> {
    state
        .play_media(request.path.as_deref())
        .map_err(to_error_string)
}

#[tauri::command]
pub fn app_player_play_libvlc(
    state: State<'_, AppState>,
    app: AppHandle,
    request: PlayerLaunchRequest,
) -> Result<(), String> {
    state
        .play_with_libvlc(&app, &request)
        .map_err(to_error_string)
}

#[tauri::command]
pub fn app_player_stop_libvlc(state: State<'_, AppState>) -> Result<(), String> {
    state.stop_libvlc_player().map_err(to_error_string)
}

#[tauri::command]
pub async fn app_prepare_media_for_playback(
    _state: State<'_, AppState>,
    app: AppHandle,
    request: OpenPathRequest,
) -> Result<PlayerPreparedMedia, String> {
    let app_for_job = app.clone();
    let path = request.path;
    tauri::async_runtime::spawn_blocking(move || -> Result<PlayerPreparedMedia, String> {
        let state = app_for_job.state::<AppState>();
        state
            .prepare_media_for_playback(&app_for_job, path.as_deref())
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("app_prepare_media_for_playback", err))?
}

#[tauri::command]
pub async fn app_extract_live_source_for_playback(
    _state: State<'_, AppState>,
    app: AppHandle,
    request: UrlRequest,
) -> Result<PlayerLiveSource, String> {
    let app_for_job = app.clone();
    let url = request.url;
    tauri::async_runtime::spawn_blocking(move || -> Result<PlayerLiveSource, String> {
        let state = app_for_job.state::<AppState>();
        state
            .extract_live_source_for_playback(&app_for_job, &url)
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("app_extract_live_source_for_playback", err))?
}

/// Resolves and verifies a local filesystem path, returning the canonical
/// absolute path with forward-slashes. Used by the frontend to obtain a
/// normalized path for `convertFileSrc()` — critical for paths with Unicode
/// characters, spaces, or OneDrive/UNC prefixes.
#[tauri::command]
pub fn app_resolve_media_path(request: OpenPathRequest) -> Result<String, String> {
    let raw = request
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Path is required".to_string())?;

    let path = std::path::PathBuf::from(raw);
    if !path.exists() {
        return Err(format!("File not found: {raw}"));
    }
    if !path.is_file() {
        return Err(format!("Not a file: {raw}"));
    }

    // canonicalize resolves ../, symlinks, UNC prefixes (\\?\) etc.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());

    // Strip extended-length prefix (\\?\) on Windows — Webview2 does not handle it.
    let s = canonical.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();

    eprintln!("[PullDown][player][INFO] app_resolve_media_path: raw={raw:?} resolved={s:?}");
    Ok(s)
}

#[tauri::command]
pub fn app_debug_probe_media_for_player(
    state: State<'_, AppState>,
    request: OpenPathRequest,
) -> Result<(), String> {
    state
        .debug_probe_media_for_player(request.path.as_deref())
        .map_err(to_error_string)
}

#[tauri::command]
pub fn library_scan_start(app: AppHandle) -> Result<u64, String> {
    Ok(media_library::start_scan(app))
}

#[tauri::command]
pub fn library_scan_pause() -> Result<bool, String> {
    Ok(media_library::pause_scan())
}

#[tauri::command]
pub fn library_scan_resume() -> Result<bool, String> {
    Ok(media_library::resume_scan())
}

#[tauri::command]
pub fn library_scan_stop() -> Result<bool, String> {
    Ok(media_library::stop_scan())
}

#[tauri::command]
pub fn download_validate_url(request: UrlRequest) -> UrlValidationResponse {
    engines::validate_url(&request.url)
}

#[tauri::command]
pub async fn download_extract_metadata(
    _state: State<'_, AppState>,
    app: AppHandle,
    request: UrlRequest,
) -> Result<VideoMetadata, String> {
    let app_for_job = app.clone();
    let url = request.url;
    tauri::async_runtime::spawn_blocking(move || -> Result<VideoMetadata, String> {
        let state = app_for_job.state::<AppState>();
        state
            .ensure_engines_available(&app_for_job)
            .map_err(to_error_string)?;
        let settings = state.read_settings();
        let info = engines::extract_download_info(&settings, &url).map_err(to_error_string)?;
        Ok(info.metadata)
    })
    .await
    .map_err(|err| join_error_to_string("download_extract_metadata", err))?
}

#[tauri::command]
pub async fn download_extract_formats(
    _state: State<'_, AppState>,
    app: AppHandle,
    request: UrlRequest,
) -> Result<Vec<DownloadFormatOption>, String> {
    let app_for_job = app.clone();
    let url = request.url;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<DownloadFormatOption>, String> {
        let state = app_for_job.state::<AppState>();
        state
            .ensure_engines_available(&app_for_job)
            .map_err(to_error_string)?;
        let settings = state.read_settings();
        let info = engines::extract_download_info(&settings, &url).map_err(to_error_string)?;
        Ok(info.formats)
    })
    .await
    .map_err(|err| join_error_to_string("download_extract_formats", err))?
}

#[tauri::command]
pub async fn queue_add(
    _state: State<'_, AppState>,
    app: AppHandle,
    request: QueueAddRequest,
) -> Result<DownloadJob, String> {
    let app_for_job = app.clone();
    let req_url = request.url;
    let req_format_id = request.format_id;
    tauri::async_runtime::spawn_blocking(move || -> Result<DownloadJob, String> {
        let state = app_for_job.state::<AppState>();
        state
            .ensure_engines_available(&app_for_job)
            .map_err(to_error_string)?;
        let settings = state.read_settings();
        let info = engines::extract_download_info(&settings, &req_url).map_err(to_error_string)?;
        let selected_format = pick_format(req_format_id.as_deref(), &info.formats)
            .ok_or_else(|| "No downloadable formats were found for this URL".to_string())?;
        let prepared = PreparedDownload {
            url: info.metadata.url.clone(),
            metadata: info.metadata,
            format: selected_format,
        };
        state
            .queue
            .enqueue(prepared, &app_for_job)
            .map_err(to_error_string)
    })
    .await
    .map_err(|err| join_error_to_string("queue_add", err))?
}

#[tauri::command]
pub fn queue_list(state: State<'_, AppState>) -> QueueListResponse {
    state.queue.list()
}

#[tauri::command]
pub fn queue_pause(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QueueJobRequest,
) -> Result<DownloadJob, String> {
    state
        .queue
        .pause(&request.job_id, &app)
        .map_err(to_error_string)
}

#[tauri::command]
pub fn queue_resume(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QueueJobRequest,
) -> Result<DownloadJob, String> {
    state
        .queue
        .resume(&request.job_id, &app)
        .map_err(to_error_string)
}

#[tauri::command]
pub fn queue_cancel(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QueueJobRequest,
) -> Result<(), String> {
    state
        .queue
        .cancel(&request.job_id, &app)
        .map_err(to_error_string)
}

#[tauri::command]
pub fn queue_remove(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QueueJobRequest,
) -> Result<(), String> {
    state
        .queue
        .remove(&request.job_id, &app)
        .map_err(to_error_string)
}

fn pick_format(
    requested_id: Option<&str>,
    formats: &[DownloadFormatOption],
) -> Option<DownloadFormatOption> {
    if formats.is_empty() {
        return None;
    }
    if let Some(id) = requested_id {
        if let Some(found) = formats.iter().find(|fmt| fmt.id == id) {
            return Some(found.clone());
        }
    }
    Some(formats[0].clone())
}
