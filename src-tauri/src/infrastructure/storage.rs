use std::fs;
use std::path::{Path, PathBuf};

use crate::core::domain::AppSettings;
use crate::core::errors::{AppError, AppResult};

pub fn default_settings() -> AppSettings {
    let default_download_dir = dirs::download_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    AppSettings {
        download_dir: default_download_dir.to_string_lossy().to_string(),
        max_concurrent_downloads: 2,
        custom_yt_dlp_path: None,
        custom_ffmpeg_path: None,
    }
}

pub fn load_or_init_settings(path: &Path) -> AppResult<AppSettings> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if !path.exists() {
        let defaults = default_settings();
        save_settings(path, &defaults)?;
        return Ok(defaults);
    }

    let raw = fs::read_to_string(path)?;
    let mut settings: AppSettings = serde_json::from_str(&raw)?;
    if settings.max_concurrent_downloads == 0 {
        settings.max_concurrent_downloads = 1;
    }
    Ok(settings)
}

pub fn save_settings(path: &Path, settings: &AppSettings) -> AppResult<()> {
    if settings.download_dir.trim().is_empty() {
        return Err(AppError::Message(
            "Download directory cannot be empty".to_string(),
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(settings)?;
    fs::write(path, data)?;
    Ok(())
}
