use std::process::Command;

use crate::core::domain::{AppSettings, EngineBinaryStatus, EnginesStatusResponse};

use super::{
    fetch_latest_ytdlp_release, is_newer_version, normalize_version, resolve_ffmpeg_path,
    resolve_yt_dlp_path,
};

pub fn engines_status(settings: &AppSettings) -> EnginesStatusResponse {
    let yt_path = resolve_yt_dlp_path(settings);
    let ffmpeg_path = resolve_ffmpeg_path(settings);
    engine_log!(
        "INFO",
        "engines_status: resolving yt_path={} ffmpeg_path={}",
        yt_path,
        ffmpeg_path
    );

    let yt_managed = settings
        .custom_yt_dlp_path
        .as_ref()
        .map(|custom| custom.trim() == yt_path)
        .unwrap_or(false);
    let ffmpeg_managed = settings
        .custom_ffmpeg_path
        .as_ref()
        .map(|custom| custom.trim() == ffmpeg_path)
        .unwrap_or(false);

    let mut yt = probe_engine("yt-dlp", &yt_path, &["--version"], yt_managed);
    let ffmpeg = probe_engine("ffmpeg", &ffmpeg_path, &["-version"], ffmpeg_managed);
    engine_log!(
        "INFO",
        "engines_status: yt_available={} ffmpeg_available={}",
        yt.available,
        ffmpeg.available
    );

    if yt.available {
        if let Ok(release) = fetch_latest_ytdlp_release() {
            let latest = normalize_version(&release.tag_name);
            let current = yt.version.clone().unwrap_or_default();
            yt.latest_version = Some(latest.clone());
            yt.update_available = is_newer_version(&latest, &current);
            engine_log!(
                "INFO",
                "engines_status: yt current={} latest={} update_available={}",
                current,
                latest,
                yt.update_available
            );
        } else {
            engine_log!(
                "WARN",
                "engines_status: failed to fetch latest yt-dlp release metadata"
            );
        }
    }

    EnginesStatusResponse { yt_dlp: yt, ffmpeg }
}

fn probe_engine(name: &str, command: &str, args: &[&str], managed: bool) -> EngineBinaryStatus {
    let output = Command::new(command).args(args).output();
    match output {
        Ok(out) => {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim().to_string());
                EngineBinaryStatus {
                    name: name.to_string(),
                    available: true,
                    version: line,
                    resolved_path: Some(command.to_string()),
                    details: None,
                    latest_version: None,
                    update_available: false,
                    managed,
                }
            } else {
                EngineBinaryStatus {
                    name: name.to_string(),
                    available: false,
                    version: None,
                    resolved_path: Some(command.to_string()),
                    details: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                    latest_version: None,
                    update_available: false,
                    managed,
                }
            }
        }
        Err(err) => EngineBinaryStatus {
            name: name.to_string(),
            available: false,
            version: None,
            resolved_path: Some(command.to_string()),
            details: Some(err.to_string()),
            latest_version: None,
            update_available: false,
            managed,
        },
    }
}
