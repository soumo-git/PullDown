use std::process::Command;

use serde_json::Value;
use url::Url;

use crate::core::domain::{
    AppSettings, DownloadFormatOption, DownloadInfoResponse, UrlValidationResponse, VideoMetadata,
};
use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::process::CommandBackgroundExt;

use super::resolve_yt_dlp_path;

pub fn validate_url(url_str: &str) -> UrlValidationResponse {
    let parsed = Url::parse(url_str.trim());
    match parsed {
        Ok(url) => {
            let valid_scheme = matches!(url.scheme(), "http" | "https");
            let has_host = url.host_str().is_some();
            if valid_scheme && has_host {
                UrlValidationResponse {
                    valid: true,
                    normalized_url: Some(url.to_string()),
                    reason: None,
                }
            } else {
                UrlValidationResponse {
                    valid: false,
                    normalized_url: None,
                    reason: Some("Only http(s) URLs with a valid host are supported".to_string()),
                }
            }
        }
        Err(_) => UrlValidationResponse {
            valid: false,
            normalized_url: None,
            reason: Some("Malformed URL".to_string()),
        },
    }
}

pub fn extract_download_info(settings: &AppSettings, url: &str) -> AppResult<DownloadInfoResponse> {
    let validation = validate_url(url);
    if !validation.valid {
        return Err(AppError::InvalidUrl);
    }
    let normalized_url = validation.normalized_url.unwrap_or_else(|| url.to_string());
    let info = run_ytdlp_info(settings, &normalized_url)?;
    let metadata = metadata_from_info(&info, &normalized_url);
    let formats = formats_from_info(&info);
    Ok(DownloadInfoResponse { metadata, formats })
}

fn run_ytdlp_info(settings: &AppSettings, url: &str) -> AppResult<Value> {
    let ytdlp = resolve_yt_dlp_path(settings);
    let output = Command::new(&ytdlp)
        .for_background_job()
        .args(["--no-warnings", "--no-playlist", "--dump-single-json", url])
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("not found") || stderr.contains("No such file") {
            return Err(AppError::MissingEngine(ytdlp));
        }
        return Err(AppError::Process(if stderr.is_empty() {
            "yt-dlp failed while extracting metadata".to_string()
        } else {
            stderr
        }));
    }

    if output.stdout.is_empty() {
        return Err(AppError::Process(
            "yt-dlp returned empty metadata".to_string(),
        ));
    }

    let info = serde_json::from_slice::<Value>(&output.stdout)?;
    Ok(info)
}

fn metadata_from_info(info: &Value, url: &str) -> VideoMetadata {
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Untitled video")
        .trim()
        .to_string();
    let platform = info
        .get("extractor")
        .and_then(Value::as_str)
        .unwrap_or("Web")
        .trim()
        .to_string();
    let duration_secs = info.get("duration").and_then(Value::as_u64).unwrap_or(0);
    let duration = human_duration(duration_secs);
    let thumbnail = info
        .get("thumbnail")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let color = deterministic_color(
        info.get("extractor_key")
            .and_then(Value::as_str)
            .unwrap_or(&platform),
    );

    VideoMetadata {
        title,
        url: url.to_string(),
        platform,
        duration,
        thumbnail,
        color,
    }
}

fn formats_from_info(info: &Value) -> Vec<DownloadFormatOption> {
    let Some(all_formats) = info.get("formats").and_then(Value::as_array) else {
        return fallback_formats();
    };

    let mut heights = all_formats
        .iter()
        .filter_map(|format| {
            let vcodec = format
                .get("vcodec")
                .and_then(Value::as_str)
                .unwrap_or("none");
            if vcodec == "none" {
                return None;
            }
            format
                .get("height")
                .and_then(Value::as_u64)
                .map(|h| h as u16)
        })
        .collect::<Vec<_>>();
    heights.sort_unstable();
    heights.dedup();
    heights.reverse();

    if heights.is_empty() {
        return fallback_formats();
    }

    let mut options = Vec::<DownloadFormatOption>::new();

    for height in heights {
        let res = format!("{height}p");
        options.push(DownloadFormatOption {
            id: format!("stable:va:{height}"),
            label: res.clone(),
            res: Some(res.clone()),
            codec: "h264".to_string(),
            audio: Some("aac".to_string()),
            size: "Auto".to_string(),
            ext: Some("mp4".to_string()),
            kind: Some("video_audio".to_string()),
        });
    }

    for height in options
        .iter()
        .filter_map(|fmt| {
            if fmt.kind.as_deref() == Some("video_audio") {
                fmt.res
                    .as_deref()
                    .and_then(|r| r.strip_suffix('p'))
                    .and_then(|v| v.parse::<u16>().ok())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
    {
        let res = format!("{height}p");
        options.push(DownloadFormatOption {
            id: format!("stable:v:{height}"),
            label: res.clone(),
            res: Some(res),
            codec: "h264".to_string(),
            audio: None,
            size: "Auto".to_string(),
            ext: Some("mp4".to_string()),
            kind: Some("video_only".to_string()),
        });
    }

    options.push(DownloadFormatOption {
        id: "stable:a:best".to_string(),
        label: "Best".to_string(),
        res: None,
        codec: "aac".to_string(),
        audio: Some("aac".to_string()),
        size: "Auto".to_string(),
        ext: Some("m4a".to_string()),
        kind: Some("audio_only".to_string()),
    });

    options
}

fn fallback_formats() -> Vec<DownloadFormatOption> {
    vec![
        DownloadFormatOption {
            id: "stable:va:1080".to_string(),
            label: "1080p".to_string(),
            res: Some("1080p".to_string()),
            codec: "h264".to_string(),
            audio: Some("aac".to_string()),
            size: "Auto".to_string(),
            ext: Some("mp4".to_string()),
            kind: Some("video_audio".to_string()),
        },
        DownloadFormatOption {
            id: "stable:v:1080".to_string(),
            label: "1080p".to_string(),
            res: Some("1080p".to_string()),
            codec: "h264".to_string(),
            audio: None,
            size: "Auto".to_string(),
            ext: Some("mp4".to_string()),
            kind: Some("video_only".to_string()),
        },
        DownloadFormatOption {
            id: "stable:a:best".to_string(),
            label: "Best".to_string(),
            res: None,
            codec: "aac".to_string(),
            audio: Some("aac".to_string()),
            size: "Auto".to_string(),
            ext: Some("m4a".to_string()),
            kind: Some("audio_only".to_string()),
        },
    ]
}

fn human_duration(seconds: u64) -> String {
    if seconds == 0 {
        return "â€”".to_string();
    }
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

fn deterministic_color(seed: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in seed.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let r = ((hash >> 16) & 0x7f) as u8 + 64;
    let g = ((hash >> 8) & 0x7f) as u8 + 64;
    let b = (hash & 0x7f) as u8 + 64;
    format!("#{r:02x}{g:02x}{b:02x}")
}
