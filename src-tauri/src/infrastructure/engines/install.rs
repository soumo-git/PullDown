use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;

use crate::core::domain::AppSettings;
use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::process::CommandBackgroundExt;

use super::binaries::{
    atomic_replace_binary, detect_current_ytdlp_version, detect_ffmpeg_version,
    install_ffmpeg_binary_with_progress, validate_release_checksum,
};
use super::{
    candidate_engine_sources, command_available, copy_engine_if_missing, download_binary,
    download_binary_with_progress, fetch_latest_ytdlp_release, is_newer_version,
    managed_engines_dir, normalize_version, resolve_ffmpeg_path, resolve_yt_dlp_path,
    FFMPEG_FILENAME, YT_DLP_FILENAME,
};

const ENGINE_YT_DLP: &str = "yt-dlp";
const ENGINE_FFMPEG: &str = "ffmpeg";

#[derive(Debug, Clone)]
pub struct EngineInstallProgress {
    pub engine: &'static str,
    pub stage: &'static str,
    pub message: String,
    pub progress_percent: Option<u8>,
    pub bytes_downloaded: Option<u64>,
    pub bytes_total: Option<u64>,
}

pub fn bootstrap_managed_engines(app: &AppHandle, settings: &mut AppSettings) -> AppResult<()> {
    engine_log!("INFO", "bootstrap_managed_engines: start");
    let managed_dir = managed_engines_dir(app)?;
    fs::create_dir_all(&managed_dir)?;
    engine_log!(
        "INFO",
        "bootstrap_managed_engines: managed_dir={}",
        managed_dir.display()
    );

    let source_dirs = candidate_engine_sources(app);
    for dir in &source_dirs {
        engine_log!(
            "INFO",
            "bootstrap_managed_engines: source_candidate={}",
            dir.display()
        );
    }

    if settings
        .custom_yt_dlp_path
        .as_ref()
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        if let Some(path) = copy_engine_if_missing(&managed_dir, &source_dirs, YT_DLP_FILENAME)? {
            settings.custom_yt_dlp_path = Some(path.to_string_lossy().to_string());
            engine_log!(
                "INFO",
                "bootstrap_managed_engines: yt-dlp set to {}",
                path.display()
            );
        }
    }

    if settings
        .custom_ffmpeg_path
        .as_ref()
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        if let Some(path) = copy_engine_if_missing(&managed_dir, &source_dirs, FFMPEG_FILENAME)? {
            settings.custom_ffmpeg_path = Some(path.to_string_lossy().to_string());
            engine_log!(
                "INFO",
                "bootstrap_managed_engines: ffmpeg set to {}",
                path.display()
            );
        }
    }

    engine_log!("INFO", "bootstrap_managed_engines: complete");
    Ok(())
}

pub fn ensure_managed_engines_available(
    app: &AppHandle,
    settings: &mut AppSettings,
) -> AppResult<Option<String>> {
    let yt_path = resolve_yt_dlp_path(settings);
    let ffmpeg_path = resolve_ffmpeg_path(settings);
    engine_log!(
        "INFO",
        "ensure_managed_engines_available: yt_path={} ffmpeg_path={}",
        yt_path,
        ffmpeg_path
    );

    let yt_ready = command_available(&yt_path, &["--version"]);
    let ffmpeg_ready = command_available(&ffmpeg_path, &["-version"]);
    engine_log!(
        "INFO",
        "ensure_managed_engines_available: yt_ready={} ffmpeg_ready={}",
        yt_ready,
        ffmpeg_ready
    );

    if yt_ready && ffmpeg_ready {
        engine_log!(
            "INFO",
            "ensure_managed_engines_available: no install needed"
        );
        return Ok(None);
    }

    engine_log!(
        "WARN",
        "ensure_managed_engines_available: missing engine detected, installing managed engines"
    );
    install_managed_engines(app, settings).map(Some)
}

pub fn install_managed_engines(app: &AppHandle, settings: &mut AppSettings) -> AppResult<String> {
    engine_log!("INFO", "install_managed_engines: start");
    let mut noop = |_| {};
    let yt_line = install_managed_ytdlp(app, settings, &mut noop)?;
    let ffmpeg_line = install_managed_ffmpeg(app, settings, &mut noop)?;
    engine_log!("INFO", "install_managed_engines: complete");
    Ok(format!("{yt_line}\n{ffmpeg_line}"))
}

pub fn install_managed_ytdlp(
    app: &AppHandle,
    settings: &mut AppSettings,
    on_progress: &mut dyn FnMut(EngineInstallProgress),
) -> AppResult<String> {
    let managed_dir = managed_engines_dir(app)?;
    fs::create_dir_all(&managed_dir)?;
    let ytdlp_target = managed_dir.join(YT_DLP_FILENAME);
    engine_log!(
        "INFO",
        "install_managed_ytdlp: managed_dir={} target={}",
        managed_dir.display(),
        ytdlp_target.display()
    );

    let result = install_ytdlp_target(&ytdlp_target, on_progress)?;
    settings.custom_yt_dlp_path = Some(ytdlp_target.to_string_lossy().to_string());
    Ok(result)
}

pub fn install_managed_ffmpeg(
    app: &AppHandle,
    settings: &mut AppSettings,
    on_progress: &mut dyn FnMut(EngineInstallProgress),
) -> AppResult<String> {
    let managed_dir = managed_engines_dir(app)?;
    fs::create_dir_all(&managed_dir)?;
    let ffmpeg_target = managed_dir.join(FFMPEG_FILENAME);
    engine_log!(
        "INFO",
        "install_managed_ffmpeg: managed_dir={} target={}",
        managed_dir.display(),
        ffmpeg_target.display()
    );

    let result = install_ffmpeg_target(&ffmpeg_target, on_progress)?;
    settings.custom_ffmpeg_path = Some(ffmpeg_target.to_string_lossy().to_string());
    Ok(result)
}

pub fn run_ytdlp_self_update(settings: &AppSettings) -> AppResult<String> {
    let ytdlp_command = resolve_yt_dlp_path(settings);
    let ytdlp_path = PathBuf::from(&ytdlp_command);
    if !ytdlp_path.exists() && !ytdlp_path.is_absolute() {
        return run_ytdlp_self_update_via_command(&ytdlp_command);
    }
    if !ytdlp_path.exists() {
        return Err(AppError::MissingEngine(ytdlp_command));
    }

    let release = fetch_latest_ytdlp_release()?;
    let latest_version = normalize_version(&release.tag_name);
    let current_version = detect_current_ytdlp_version(&ytdlp_path)?;
    if !is_newer_version(&latest_version, &current_version) {
        return Ok(format!("yt-dlp is already up to date ({current_version})"));
    }

    let asset_url = release
        .assets
        .iter()
        .find(|asset| asset.name == YT_DLP_FILENAME)
        .map(|asset| asset.browser_download_url.clone())
        .unwrap_or_else(|| {
            format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{YT_DLP_FILENAME}")
        });

    let bytes = download_binary(&asset_url)?;
    validate_release_checksum(&release.tag_name, YT_DLP_FILENAME, &bytes)?;
    atomic_replace_binary(&ytdlp_path, &bytes)?;

    let installed_version = detect_current_ytdlp_version(&ytdlp_path)?;
    Ok(format!(
        "yt-dlp updated: {current_version} -> {installed_version}"
    ))
}

fn run_ytdlp_self_update_via_command(command: &str) -> AppResult<String> {
    let out = Command::new(command)
        .for_background_job()
        .args(["-U"])
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;

    let mut msg = String::new();
    if !out.stdout.is_empty() {
        msg.push_str(String::from_utf8_lossy(&out.stdout).trim());
    }
    if !out.stderr.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(String::from_utf8_lossy(&out.stderr).trim());
    }
    if out.status.success() {
        Ok(msg)
    } else {
        Err(AppError::Process(if msg.is_empty() {
            "yt-dlp update failed".to_string()
        } else {
            msg
        }))
    }
}

fn install_ytdlp_target(
    ytdlp_target: &Path,
    on_progress: &mut dyn FnMut(EngineInstallProgress),
) -> AppResult<String> {
    on_progress(EngineInstallProgress {
        engine: ENGINE_YT_DLP,
        stage: "starting",
        message: "Preparing yt-dlp installation".to_string(),
        progress_percent: Some(0),
        bytes_downloaded: None,
        bytes_total: None,
    });

    if command_available(&ytdlp_target.to_string_lossy(), &["--version"]) {
        let version =
            detect_current_ytdlp_version(ytdlp_target).unwrap_or_else(|_| "unknown".to_string());
        on_progress(EngineInstallProgress {
            engine: ENGINE_YT_DLP,
            stage: "completed",
            message: format!("yt-dlp already installed ({version})"),
            progress_percent: Some(100),
            bytes_downloaded: None,
            bytes_total: None,
        });
        engine_log!(
            "INFO",
            "install_managed_ytdlp: yt-dlp already installed ({version})"
        );
        return Ok(format!("yt-dlp already installed ({version})"));
    }

    let release = fetch_latest_ytdlp_release()?;
    let asset_url = release
        .assets
        .iter()
        .find(|asset| asset.name == YT_DLP_FILENAME)
        .map(|asset| asset.browser_download_url.clone())
        .unwrap_or_else(|| {
            format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{YT_DLP_FILENAME}")
        });

    on_progress(EngineInstallProgress {
        engine: ENGINE_YT_DLP,
        stage: "downloading",
        message: format!("Downloading yt-dlp {}", release.tag_name),
        progress_percent: Some(0),
        bytes_downloaded: Some(0),
        bytes_total: None,
    });

    let bytes = download_binary_with_progress(&asset_url, |bytes_downloaded, bytes_total| {
        on_progress(EngineInstallProgress {
            engine: ENGINE_YT_DLP,
            stage: "downloading",
            message: "Downloading yt-dlp".to_string(),
            progress_percent: progress_percent(bytes_downloaded, bytes_total),
            bytes_downloaded: Some(bytes_downloaded),
            bytes_total,
        });
    })?;

    on_progress(EngineInstallProgress {
        engine: ENGINE_YT_DLP,
        stage: "verifying",
        message: "Verifying yt-dlp checksum".to_string(),
        progress_percent: Some(92),
        bytes_downloaded: None,
        bytes_total: None,
    });
    validate_release_checksum(&release.tag_name, YT_DLP_FILENAME, &bytes)?;

    on_progress(EngineInstallProgress {
        engine: ENGINE_YT_DLP,
        stage: "installing",
        message: "Installing yt-dlp".to_string(),
        progress_percent: Some(96),
        bytes_downloaded: None,
        bytes_total: None,
    });
    atomic_replace_binary(ytdlp_target, &bytes)?;

    let installed_version = detect_current_ytdlp_version(ytdlp_target)?;
    on_progress(EngineInstallProgress {
        engine: ENGINE_YT_DLP,
        stage: "completed",
        message: format!("Installed yt-dlp {installed_version}"),
        progress_percent: Some(100),
        bytes_downloaded: None,
        bytes_total: None,
    });
    engine_log!(
        "INFO",
        "install_managed_ytdlp: installed yt-dlp {} at {}",
        installed_version,
        ytdlp_target.display()
    );

    Ok(format!("Installed yt-dlp {installed_version}"))
}

fn install_ffmpeg_target(
    ffmpeg_target: &Path,
    on_progress: &mut dyn FnMut(EngineInstallProgress),
) -> AppResult<String> {
    on_progress(EngineInstallProgress {
        engine: ENGINE_FFMPEG,
        stage: "starting",
        message: "Preparing ffmpeg installation".to_string(),
        progress_percent: Some(0),
        bytes_downloaded: None,
        bytes_total: None,
    });

    if command_available(&ffmpeg_target.to_string_lossy(), &["-version"]) {
        let version =
            detect_ffmpeg_version(ffmpeg_target).unwrap_or_else(|_| "unknown".to_string());
        on_progress(EngineInstallProgress {
            engine: ENGINE_FFMPEG,
            stage: "completed",
            message: format!("ffmpeg already installed ({version})"),
            progress_percent: Some(100),
            bytes_downloaded: None,
            bytes_total: None,
        });
        engine_log!(
            "INFO",
            "install_managed_ffmpeg: ffmpeg already installed ({version})"
        );
        return Ok(format!("ffmpeg already installed ({version})"));
    }

    on_progress(EngineInstallProgress {
        engine: ENGINE_FFMPEG,
        stage: "downloading",
        message: "Downloading ffmpeg archive".to_string(),
        progress_percent: Some(0),
        bytes_downloaded: Some(0),
        bytes_total: None,
    });

    install_ffmpeg_binary_with_progress(ffmpeg_target, |bytes_downloaded, bytes_total| {
        on_progress(EngineInstallProgress {
            engine: ENGINE_FFMPEG,
            stage: "downloading",
            message: "Downloading ffmpeg archive".to_string(),
            progress_percent: progress_percent(bytes_downloaded, bytes_total),
            bytes_downloaded: Some(bytes_downloaded),
            bytes_total,
        });
    })?;

    let installed_version =
        detect_ffmpeg_version(ffmpeg_target).unwrap_or_else(|_| "unknown".to_string());
    on_progress(EngineInstallProgress {
        engine: ENGINE_FFMPEG,
        stage: "completed",
        message: format!("Installed ffmpeg {installed_version}"),
        progress_percent: Some(100),
        bytes_downloaded: None,
        bytes_total: None,
    });
    engine_log!(
        "INFO",
        "install_managed_ffmpeg: installed ffmpeg {} at {}",
        installed_version,
        ffmpeg_target.display()
    );

    Ok(format!("Installed ffmpeg {installed_version}"))
}

fn progress_percent(bytes_downloaded: u64, bytes_total: Option<u64>) -> Option<u8> {
    let total = bytes_total?;
    if total == 0 {
        return Some(0);
    }

    let ratio = bytes_downloaded as f64 / total as f64;
    let rounded = (ratio * 100.0).round() as i64;
    Some(rounded.clamp(0, 100) as u8)
}
