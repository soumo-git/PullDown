use serde::Deserialize;

const DEFAULT_YT_DLP: &str = "yt-dlp";
const DEFAULT_FFMPEG: &str = "ffmpeg";
const YT_DLP_RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_RELEASE_API: &str = "https://api.github.com/repos/GyanD/codexffmpeg/releases/latest";
const YT_DLP_RELEASE_DOWNLOAD_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const HTTP_USER_AGENT: &str = "PullDown/0.1.0 (engine-updater)";
const HTTP_TIMEOUT_METADATA_SECS: u64 = 20;
const HTTP_TIMEOUT_BINARY_SECS: u64 = 600;
#[cfg(target_os = "windows")]
const FFMPEG_WINDOWS_ZIP_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

#[cfg(target_os = "windows")]
const PLATFORM_DIR: &str = "windows";
#[cfg(target_os = "macos")]
const PLATFORM_DIR: &str = "macos";
#[cfg(all(unix, not(target_os = "macos")))]
const PLATFORM_DIR: &str = "linux";

#[cfg(target_os = "windows")]
const YT_DLP_FILENAME: &str = "yt-dlp.exe";
#[cfg(not(target_os = "windows"))]
const YT_DLP_FILENAME: &str = "yt-dlp";

#[cfg(target_os = "windows")]
const FFMPEG_FILENAME: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const FFMPEG_FILENAME: &str = "ffmpeg";

macro_rules! engine_log {
    ($level:expr, $($arg:tt)*) => {
        eprintln!("[PullDown][engines][{}] {}", $level, format!($($arg)*));
    };
}

#[derive(Debug, Deserialize)]
pub(crate) struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

mod binaries;
mod install;
mod metadata;
mod network;
mod pathing;
mod status;
mod versioning;

pub use install::{
    bootstrap_managed_engines, ensure_managed_engines_available, install_managed_engines,
    install_managed_ffmpeg, install_managed_ytdlp, run_ytdlp_self_update, EngineInstallProgress,
};
pub use metadata::{extract_download_info, validate_url};
pub(crate) use network::{
    download_binary, download_binary_with_progress, download_text, fetch_latest_ffmpeg_release,
    fetch_latest_ytdlp_release,
};
pub(crate) use pathing::{
    candidate_engine_sources, command_available, copy_engine_if_missing, ensure_executable,
    managed_engines_dir,
};
pub use pathing::{
    ensure_directory, resolve_ffmpeg_location_arg, resolve_ffmpeg_path, resolve_yt_dlp_path,
};
pub use status::engines_status;
pub(crate) use versioning::{is_newer_version, normalize_version};
