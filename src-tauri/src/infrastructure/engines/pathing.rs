use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::core::domain::AppSettings;
use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::process::CommandBackgroundExt;

use super::{DEFAULT_FFMPEG, DEFAULT_YT_DLP, PLATFORM_DIR};

pub fn resolve_yt_dlp_path(settings: &AppSettings) -> String {
    settings
        .custom_yt_dlp_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_YT_DLP.to_string())
}

pub fn resolve_ffmpeg_path(settings: &AppSettings) -> String {
    settings
        .custom_ffmpeg_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FFMPEG.to_string())
}

pub fn resolve_ffmpeg_location_arg(settings: &AppSettings) -> Option<String> {
    let ffmpeg = settings.custom_ffmpeg_path.as_ref()?;
    let ffmpeg = ffmpeg.trim();
    if ffmpeg.is_empty() {
        return None;
    }
    let path = PathBuf::from(ffmpeg);
    if path.is_file() {
        return path.parent().map(|p| p.to_string_lossy().to_string());
    }
    Some(path.to_string_lossy().to_string())
}

pub fn ensure_directory(path: &str) -> AppResult<PathBuf> {
    let dir = Path::new(path);
    std::fs::create_dir_all(dir)?;
    Ok(dir.to_path_buf())
}

pub(crate) fn managed_engines_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Message(format!("Failed to resolve app data directory: {err}")))?;
    Ok(app_data_dir.join("engines"))
}

pub(crate) fn command_available(command: &str, args: &[&str]) -> bool {
    match Command::new(command)
        .for_background_job()
        .args(args)
        .output()
    {
        Ok(out) => {
            let ok = out.status.success();
            if !ok {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                engine_log!(
                    "WARN",
                    "command_available: command={} args={:?} status={} stderr={}",
                    command,
                    args,
                    out.status,
                    stderr
                );
            }
            ok
        }
        Err(err) => {
            engine_log!(
                "WARN",
                "command_available: command={} args={:?} spawn_error={}",
                command,
                args,
                err
            );
            false
        }
    }
}

pub(crate) fn candidate_engine_sources(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("engines").join(PLATFORM_DIR));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("engines")
            .join(PLATFORM_DIR),
    );

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("engines").join(PLATFORM_DIR));
    }

    candidates
}

pub(crate) fn copy_engine_if_missing(
    managed_dir: &Path,
    source_dirs: &[PathBuf],
    binary_name: &str,
) -> AppResult<Option<PathBuf>> {
    let destination = managed_dir.join(binary_name);
    if destination.exists() {
        ensure_executable(&destination)?;
        engine_log!(
            "INFO",
            "copy_engine_if_missing: destination already exists {}",
            destination.display()
        );
        return Ok(Some(destination));
    }

    for source_dir in source_dirs {
        let source = source_dir.join(binary_name);
        if source.exists() {
            fs::create_dir_all(managed_dir)?;
            fs::copy(&source, &destination)?;
            ensure_executable(&destination)?;
            engine_log!(
                "INFO",
                "copy_engine_if_missing: copied {} -> {}",
                source.display(),
                destination.display()
            );
            return Ok(Some(destination));
        }
        engine_log!(
            "INFO",
            "copy_engine_if_missing: source not found {}",
            source.display()
        );
    }

    engine_log!(
        "WARN",
        "copy_engine_if_missing: no bundled source found for {}",
        binary_name
    );
    Ok(None)
}

pub(crate) fn ensure_executable(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}
