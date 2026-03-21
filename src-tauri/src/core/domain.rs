use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHealthResponse {
    pub ok: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub download_dir: String,
    pub max_concurrent_downloads: usize,
    pub custom_yt_dlp_path: Option<String>,
    pub custom_ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineBinaryStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub resolved_path: Option<String>,
    pub details: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginesStatusResponse {
    pub yt_dlp: EngineBinaryStatus,
    pub ffmpeg: EngineBinaryStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlRequest {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDownloadDirRequest {
    pub download_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathRequest {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLaunchRequest {
    pub source: String,
    pub is_url: Option<bool>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPreparedMedia {
    pub source_path: String,
    pub playback_path: String,
    pub transcoded: bool,
    pub media_kind: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLiveSource {
    pub source_url: String,
    pub playback_url: String,
    pub secondary_playback_url: Option<String>,
    pub title: String,
    pub media_kind: String,
    pub live: bool,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlValidationResponse {
    pub valid: bool,
    pub normalized_url: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub title: String,
    pub url: String,
    pub platform: String,
    pub duration: String,
    pub thumbnail: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryVideoItem {
    pub id: String,
    pub title: String,
    pub path: String,
    pub created_unix_seconds: u64,
    pub size_bytes: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFormatOption {
    pub id: String,
    pub label: String,
    pub res: Option<String>,
    pub codec: String,
    pub audio: Option<String>,
    pub size: String,
    pub ext: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfoResponse {
    pub metadata: VideoMetadata,
    pub formats: Vec<DownloadFormatOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueAddRequest {
    pub url: String,
    pub format_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJobRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadJobStatus {
    Queued,
    Downloading,
    Postprocessing,
    Paused,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub url: String,
    pub title: String,
    pub platform: String,
    pub duration: String,
    pub thumbnail: Option<String>,
    pub color: String,
    pub format_id: String,
    pub res: Option<String>,
    pub codec: String,
    pub audio: Option<String>,
    pub ext: Option<String>,
    pub status: DownloadJobStatus,
    pub progress: u8,
    pub bytes_total: u64,
    pub bytes_down: u64,
    pub speed_bps: u64,
    pub eta_seconds: Option<u64>,
    pub file_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueListResponse {
    pub jobs: Vec<DownloadJob>,
    pub max_concurrent_downloads: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRemovedEvent {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallProgressEvent {
    pub engine: String,
    pub stage: String,
    pub message: String,
    pub progress_percent: Option<u8>,
    pub bytes_downloaded: Option<u64>,
    pub bytes_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanProgressEvent {
    pub scan_id: u64,
    pub scanned_files: u64,
    pub matched_files: u64,
    pub visited_dirs: u64,
    pub roots_done: u32,
    pub roots_total: u32,
    pub paused: bool,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanBatchEvent {
    pub scan_id: u64,
    pub items: Vec<LibraryVideoItem>,
}
