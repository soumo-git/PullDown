use serde_json::Value;
use tauri::AppHandle;

use crate::core::domain::{AppSettings, PlayerLiveSource};
use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::engines;
use crate::infrastructure::process::CommandBackgroundExt;

const LIVE_PROGRESSIVE_SELECTOR: &str = "best*[vcodec!=none][acodec!=none]/best";
const BEST_AUDIO_SELECTOR: &str = "bestaudio/best";

macro_rules! player_live_log {
    ($level:expr, $($arg:tt)*) => {
        eprintln!("[PullDown][player-live][{}] {}", $level, format!($($arg)*));
    };
}

pub fn extract_live_source(
    _app: &AppHandle,
    settings: &AppSettings,
    url: &str,
) -> AppResult<PlayerLiveSource> {
    let validation = engines::validate_url(url);
    if !validation.valid {
        return Err(AppError::InvalidUrl);
    }
    let source_url = validation
        .normalized_url
        .unwrap_or_else(|| url.trim().to_string());

    let preview_info = run_ytdlp_info(settings, &source_url, LIVE_PROGRESSIVE_SELECTOR)?;
    let live = preview_info
        .get("is_live")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let preferred_kind = infer_media_kind(&preview_info);
    let selector = if preferred_kind == "audio" {
        BEST_AUDIO_SELECTOR
    } else {
        // Prefer a single muxed stream for maximum compatibility with
        // external/native players such as VLC.
        LIVE_PROGRESSIVE_SELECTOR
    };

    let playback_info = run_ytdlp_info(settings, &source_url, selector)?;
    let title = playback_info
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| preview_info.get("title").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Extracted media")
        .to_string();

    let media_kind = infer_media_kind(&playback_info).to_string();
    let (playback_url, secondary_playback_url) = if media_kind == "audio" {
        let primary = resolve_primary_url(&playback_info).ok_or_else(|| {
            AppError::Process("Unable to resolve a playable audio stream URL".to_string())
        })?;
        (primary, None)
    } else {
        resolve_video_and_audio_urls(&playback_info)?
    };

    let details = Some(format!(
        "mode=mpv-direct skip_prepare=true selector={} secondary_audio={}",
        selector,
        secondary_playback_url.is_some()
    ));

    player_live_log!(
        "INFO",
        "extract_live_source: title={} media_kind={} live={} primary={} secondary={}",
        title,
        media_kind,
        live,
        playback_url,
        secondary_playback_url.as_deref().unwrap_or("<none>")
    );

    Ok(PlayerLiveSource {
        source_url,
        playback_url,
        secondary_playback_url,
        title,
        media_kind,
        live,
        details,
    })
}

fn run_ytdlp_info(settings: &AppSettings, source_url: &str, selector: &str) -> AppResult<Value> {
    let ytdlp = engines::resolve_yt_dlp_path(settings);
    player_live_log!(
        "INFO",
        "run_ytdlp_info: ytdlp={} url={} selector={}",
        ytdlp,
        source_url,
        selector
    );

    let output = std::process::Command::new(&ytdlp)
        .for_background_job()
        .args([
            "--no-warnings",
            "--no-playlist",
            "--dump-single-json",
            "-f",
            selector,
            source_url,
        ])
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("not found") || stderr.contains("No such file") {
            return Err(AppError::MissingEngine(ytdlp));
        }
        return Err(AppError::Process(if stderr.is_empty() {
            "yt-dlp failed while extracting playback metadata".to_string()
        } else {
            stderr
        }));
    }

    if output.stdout.is_empty() {
        return Err(AppError::Process(
            "yt-dlp returned empty metadata while resolving playback URL".to_string(),
        ));
    }

    let info = serde_json::from_slice::<Value>(&output.stdout)?;
    Ok(info)
}

fn resolve_video_and_audio_urls(info: &Value) -> AppResult<(String, Option<String>)> {
    let mut video_url: Option<String> = None;
    let mut audio_url: Option<String> = None;

    if let Some(formats) = info.get("requested_formats").and_then(Value::as_array) {
        for format in formats {
            let Some(url) = value_url(format.get("url")) else {
                continue;
            };
            let vcodec = format
                .get("vcodec")
                .and_then(Value::as_str)
                .unwrap_or("none");
            let acodec = format
                .get("acodec")
                .and_then(Value::as_str)
                .unwrap_or("none");

            if video_url.is_none() && vcodec != "none" {
                video_url = Some(url.clone());
            }
            if audio_url.is_none() && acodec != "none" {
                audio_url = Some(url);
            }
            if video_url.is_some() && audio_url.is_some() {
                break;
            }
        }
    }

    if video_url.is_none() || audio_url.is_none() {
        if let Some(downloads) = info.get("requested_downloads").and_then(Value::as_array) {
            for entry in downloads {
                let Some(url) = value_url(entry.get("url")) else {
                    continue;
                };
                let vcodec = entry
                    .get("vcodec")
                    .and_then(Value::as_str)
                    .unwrap_or("none");
                let acodec = entry
                    .get("acodec")
                    .and_then(Value::as_str)
                    .unwrap_or("none");

                if video_url.is_none() && vcodec != "none" {
                    video_url = Some(url.clone());
                }
                if audio_url.is_none() && acodec != "none" {
                    audio_url = Some(url.clone());
                }

                if video_url.is_none() {
                    video_url = Some(url.clone());
                }
                if audio_url.is_none() {
                    audio_url = Some(url);
                }

                if video_url.is_some() && audio_url.is_some() {
                    break;
                }
            }
        }
    }

    if let (Some(video), Some(audio)) = (video_url.clone(), audio_url.clone()) {
        if video != audio {
            return Ok((video, Some(audio)));
        }
    }

    if let Some(video) = video_url {
        return Ok((video, None));
    }
    if let Some(audio) = audio_url {
        return Ok((audio, None));
    }

    let primary = resolve_primary_url(info)
        .ok_or_else(|| AppError::Process("Unable to resolve a playable video stream URL".to_string()))?;
    Ok((primary, None))
}

fn resolve_primary_url(info: &Value) -> Option<String> {
    if let Some(url) = value_url(info.get("url")) {
        return Some(url);
    }

    if let Some(downloads) = info.get("requested_downloads").and_then(Value::as_array) {
        for entry in downloads {
            if let Some(url) = value_url(entry.get("url")) {
                return Some(url);
            }
        }
    }

    if let Some(formats) = info.get("requested_formats").and_then(Value::as_array) {
        for format in formats {
            if let Some(url) = value_url(format.get("url")) {
                return Some(url);
            }
        }
    }

    None
}

fn value_url(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn infer_media_kind(info: &Value) -> &'static str {
    if let Some(vcodec) = info.get("vcodec").and_then(Value::as_str) {
        if vcodec != "none" {
            return "video";
        }
    }

    if let Some(formats) = info.get("requested_formats").and_then(Value::as_array) {
        if formats.iter().any(|fmt| {
            fmt.get("vcodec")
                .and_then(Value::as_str)
                .map(|value| value != "none")
                .unwrap_or(false)
        }) {
            return "video";
        }
    }

    "audio"
}
