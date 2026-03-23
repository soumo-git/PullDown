use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::AppHandle;

use crate::core::domain::{ConverterProgressEvent, ConverterRunRequest, ConverterRunResponse};
use crate::core::errors::{AppError, AppResult};
use crate::core::events;
use crate::infrastructure::process::CommandBackgroundExt;

const MAX_ERROR_LINES: usize = 6;

#[derive(Clone, Copy, Debug)]
enum MediaKind {
    Video,
    Audio,
    Image,
}

impl MediaKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "video" => Some(Self::Video),
            "audio" => Some(Self::Audio),
            "image" => Some(Self::Image),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Image => "image",
        }
    }
}

pub fn run_conversion(
    app: &AppHandle,
    ffmpeg_command: &str,
    request: &ConverterRunRequest,
) -> AppResult<ConverterRunResponse> {
    let task_id = request.task_id.trim();
    if task_id.is_empty() {
        return Err(AppError::Message(
            "Conversion task id is required".to_string(),
        ));
    }

    let source_raw = request.source_path.trim().trim_matches('"');
    let mut source_path = PathBuf::from(source_raw);
    if !source_path.exists() {
        return Err(AppError::Message(format!(
            "Source file does not exist: {}",
            source_path.display()
        )));
    }
    if !source_path.is_file() {
        return Err(AppError::Message(format!(
            "Source path is not a file: {}",
            source_path.display()
        )));
    }
    source_path = source_path.canonicalize().unwrap_or(source_path);

    let media_kind = MediaKind::parse(&request.media_type).ok_or_else(|| {
        AppError::Message(format!(
            "Unsupported media type '{}'. Expected video, audio, or image.",
            request.media_type
        ))
    })?;

    let requested_format = normalize_format(&request.output_format);
    let output_args = output_args_for(media_kind, &requested_format).ok_or_else(|| {
        AppError::Message(format!(
            "Format '{}' is not supported for {} conversion",
            request.output_format,
            media_kind.as_str()
        ))
    })?;

    let output_path = resolve_output_path(
        &source_path,
        request.output_name.as_deref(),
        &requested_format,
    )?;
    let overwrite = request.overwrite.unwrap_or(true);
    if !overwrite && output_path.exists() {
        return Err(AppError::Message(format!(
            "Output file already exists: {}",
            output_path.display()
        )));
    }

    eprintln!(
        "[PullDown][converter][INFO] run_conversion: task_id={} source={} media_type={} format={} output={}",
        task_id,
        source_path.display(),
        media_kind.as_str(),
        requested_format,
        output_path.display()
    );

    events::emit_converter_progress(
        app,
        &ConverterProgressEvent {
            task_id: task_id.to_string(),
            stage: "starting".to_string(),
            message: "Starting conversion...".to_string(),
            progress_percent: Some(0),
            output_path: Some(output_path.to_string_lossy().to_string()),
        },
    );

    let duration_seconds = probe_duration_seconds(ffmpeg_command, &source_path);
    let mut command = Command::new(ffmpeg_command);
    command.for_background_job();
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg(if overwrite { "-y" } else { "-n" })
        .arg("-stats_period")
        .arg("0.2")
        .arg("-progress")
        .arg("pipe:2")
        .arg("-nostats")
        .arg("-i")
        .arg(&source_path);
    for arg in output_args {
        command.arg(arg);
    }
    command
        .arg(&output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| AppError::Process(format!("Failed to start ffmpeg: {err}")))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Process("Failed to capture ffmpeg stderr".to_string()))?;

    let mut last_error_lines = VecDeque::<String>::with_capacity(MAX_ERROR_LINES);
    let mut last_emitted_percent: Option<u8> = None;
    let mut has_running_event = false;
    let mut last_time_seconds: Option<f64> = None;
    let mut last_reported_time_seconds: Option<f64> = None;

    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(v) = trimmed.strip_prefix("out_time_ms=") {
            let parsed = v
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|raw| raw.is_finite() && *raw >= 0.0)
                .map(|raw| raw / 1_000_000.0);
            if parsed.is_some() {
                last_time_seconds = parsed;
            }
        } else if let Some(v) = trimmed.strip_prefix("out_time=") {
            let parsed = parse_hms_seconds(v.trim());
            if parsed.is_some() {
                last_time_seconds = parsed;
            }
        } else if trimmed.starts_with("progress=") {
            // Progress key is consumed via out_time samples and final process status.
        } else if let Some(v) = parse_ffmpeg_status_time(trimmed) {
            last_time_seconds = Some(v);
        } else if !trimmed.contains('=') {
            push_error_line(&mut last_error_lines, trimmed);
        }

        let next_percent = progress_percent(duration_seconds, last_time_seconds);
        let time_advanced = match (last_time_seconds, last_reported_time_seconds) {
            (Some(current), Some(previous)) => current > (previous + 0.2),
            (Some(_), None) => true,
            _ => false,
        };
        let should_emit_running =
            !has_running_event || next_percent != last_emitted_percent || time_advanced;

        if should_emit_running {
            last_emitted_percent = next_percent;
            if time_advanced {
                last_reported_time_seconds = last_time_seconds;
            }
            has_running_event = true;
            let message = last_time_seconds
                .map(|sec| format!("Converting media... {}", format_hms(sec)))
                .unwrap_or_else(|| "Converting media...".to_string());
            events::emit_converter_progress(
                app,
                &ConverterProgressEvent {
                    task_id: task_id.to_string(),
                    stage: "running".to_string(),
                    message,
                    progress_percent: next_percent,
                    output_path: None,
                },
            );
        }
    }

    let status = child
        .wait()
        .map_err(|err| AppError::Process(format!("Failed to wait for ffmpeg: {err}")))?;

    if status.success() && output_path.exists() {
        let result = ConverterRunResponse {
            task_id: task_id.to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            media_type: media_kind.as_str().to_string(),
            output_format: requested_format,
        };
        events::emit_converter_progress(
            app,
            &ConverterProgressEvent {
                task_id: task_id.to_string(),
                stage: "completed".to_string(),
                message: "Conversion completed".to_string(),
                progress_percent: Some(100),
                output_path: Some(result.output_path.clone()),
            },
        );
        return Ok(result);
    }

    let mut message = if last_error_lines.is_empty() {
        format!(
            "ffmpeg exited with status {}",
            status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        )
    } else {
        last_error_lines.into_iter().collect::<Vec<_>>().join(" | ")
    };
    if message.trim().is_empty() {
        message = "Conversion failed".to_string();
    }

    events::emit_converter_progress(
        app,
        &ConverterProgressEvent {
            task_id: task_id.to_string(),
            stage: "failed".to_string(),
            message: message.clone(),
            progress_percent: None,
            output_path: None,
        },
    );
    Err(AppError::Process(message))
}

fn normalize_format(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "jpeg" => "jpg".to_string(),
        "tif" => "tiff".to_string(),
        "mpeg" => "mpg".to_string(),
        "aif" => "aiff".to_string(),
        other => other.to_string(),
    }
}

fn output_args_for(media_kind: MediaKind, format: &str) -> Option<Vec<&'static str>> {
    match media_kind {
        MediaKind::Video => match format {
            "mp4" | "m4v" => Some(vec![
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
            ]),
            "mkv" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf",
                "22", "-c:a", "aac", "-b:a", "192k",
            ]),
            "webm" => Some(vec![
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libvpx-vp9",
                "-crf",
                "31",
                "-b:v",
                "0",
                "-c:a",
                "libopus",
                "-b:a",
                "160k",
            ]),
            "mov" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf",
                "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            ]),
            "avi" => Some(vec![
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "mpeg4",
                "-q:v",
                "4",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "3",
            ]),
            "flv" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "flv", "-c:a", "aac", "-b:a", "128k",
            ]),
            "ts" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf",
                "22", "-c:a", "aac", "-b:a", "192k", "-f", "mpegts",
            ]),
            "mpg" => Some(vec![
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "mpeg2video",
                "-q:v",
                "4",
                "-c:a",
                "mp2",
                "-b:a",
                "192k",
            ]),
            "ogv" => Some(vec![
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libtheora",
                "-q:v",
                "7",
                "-c:a",
                "libvorbis",
                "-q:a",
                "5",
            ]),
            "wmv" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "wmv2", "-b:v", "3000k", "-c:a", "wmav2",
                "-b:a", "160k",
            ]),
            "3gp" => Some(vec![
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "h263", "-c:a", "aac", "-b:a", "128k",
            ]),
            _ => None,
        },
        MediaKind::Audio => match format {
            "mp3" => Some(vec!["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
            "m4a" | "aac" => Some(vec!["-vn", "-c:a", "aac", "-b:a", "192k"]),
            "wav" => Some(vec!["-vn", "-c:a", "pcm_s16le"]),
            "flac" => Some(vec!["-vn", "-c:a", "flac"]),
            "ogg" => Some(vec!["-vn", "-c:a", "libvorbis", "-q:a", "5"]),
            "opus" => Some(vec!["-vn", "-c:a", "libopus", "-b:a", "160k"]),
            "wma" => Some(vec!["-vn", "-c:a", "wmav2", "-b:a", "160k"]),
            "aiff" => Some(vec!["-vn", "-c:a", "pcm_s16be"]),
            "ac3" => Some(vec!["-vn", "-c:a", "ac3", "-b:a", "384k"]),
            "mp2" => Some(vec!["-vn", "-c:a", "mp2", "-b:a", "192k"]),
            "alac" => Some(vec!["-vn", "-c:a", "alac"]),
            "mka" => Some(vec!["-vn", "-c:a", "flac"]),
            _ => None,
        },
        MediaKind::Image => match format {
            "png" => Some(vec!["-frames:v", "1"]),
            "jpg" => Some(vec!["-frames:v", "1", "-q:v", "2"]),
            "webp" => Some(vec!["-frames:v", "1", "-c:v", "libwebp", "-q:v", "80"]),
            "bmp" => Some(vec!["-frames:v", "1"]),
            "tiff" => Some(vec!["-frames:v", "1"]),
            "tga" => Some(vec!["-frames:v", "1"]),
            "gif" => Some(vec![
                "-vf",
                "fps=12,scale='trunc(iw/2)*2:trunc(ih/2)*2':flags=lanczos",
                "-loop",
                "0",
            ]),
            "ico" => Some(vec!["-frames:v", "1"]),
            "jp2" => Some(vec!["-frames:v", "1", "-c:v", "jpeg2000"]),
            "avif" => Some(vec![
                "-frames:v",
                "1",
                "-c:v",
                "libaom-av1",
                "-still-picture",
                "1",
                "-crf",
                "32",
                "-b:v",
                "0",
            ]),
            _ => None,
        },
    }
}

fn progress_percent(duration_seconds: Option<f64>, out_time_seconds: Option<f64>) -> Option<u8> {
    let duration = duration_seconds?;
    let current = out_time_seconds?;
    if duration <= 0.0 || !duration.is_finite() || !current.is_finite() {
        return None;
    }
    let ratio = (current / duration).clamp(0.0, 1.0);
    Some((ratio * 100.0).round() as u8)
}

fn resolve_output_path(
    source: &Path,
    output_name: Option<&str>,
    output_ext: &str,
) -> AppResult<PathBuf> {
    let parent = source.parent().ok_or_else(|| {
        AppError::Message(format!(
            "Unable to resolve output directory from source: {}",
            source.display()
        ))
    })?;

    let default_name = source
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("converted-media");
    let mut base_name = sanitize_output_name(output_name.unwrap_or(default_name));
    if base_name.is_empty() {
        base_name = sanitize_output_name(default_name);
    }
    if base_name.is_empty() {
        base_name = "converted-media".to_string();
    }

    let mut output = parent.join(format!("{base_name}.{output_ext}"));
    if same_file_path(source, &output) {
        output = parent.join(format!("{base_name}-converted.{output_ext}"));
    }
    Ok(output)
}

fn sanitize_output_name(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

fn same_file_path(a: &Path, b: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let left = a.to_string_lossy().to_string();
        let right = b.to_string_lossy().to_string();
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(target_os = "windows"))]
    {
        a == b
    }
}

fn probe_duration_seconds(ffmpeg_command: &str, source: &Path) -> Option<f64> {
    if let Some(duration) = probe_duration_seconds_ffprobe(ffmpeg_command, source) {
        return Some(duration);
    }
    probe_duration_seconds_ffmpeg(ffmpeg_command, source)
}

fn probe_duration_seconds_ffprobe(ffmpeg_command: &str, source: &Path) -> Option<f64> {
    let candidates = ffprobe_candidates(ffmpeg_command);
    for candidate in candidates {
        let output = match Command::new(&candidate)
            .for_background_job()
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(source)
            .output()
        {
            Ok(output) => output,
            Err(_) => continue,
        };

        if !output.status.success() {
            continue;
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let Some(first) = raw.lines().next() else {
            continue;
        };
        let first = first.trim();
        if first.is_empty() {
            continue;
        }
        if let Ok(duration) = first.parse::<f64>() {
            if duration.is_finite() && duration > 0.0 {
                return Some(duration);
            }
        }
    }
    None
}

fn probe_duration_seconds_ffmpeg(ffmpeg_command: &str, source: &Path) -> Option<f64> {
    let output = Command::new(ffmpeg_command)
        .for_background_job()
        .arg("-hide_banner")
        .arg("-i")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stderr);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Duration:") {
            let raw = rest
                .split(',')
                .next()
                .map(str::trim)
                .filter(|v| !v.is_empty())?;
            if let Some(seconds) = parse_hms_seconds(raw) {
                if seconds.is_finite() && seconds > 0.0 {
                    return Some(seconds);
                }
            }
        }
    }
    None
}

fn ffprobe_candidates(ffmpeg_command: &str) -> Vec<String> {
    let mut candidates = Vec::<String>::new();
    let ffmpeg = PathBuf::from(ffmpeg_command);
    #[cfg(target_os = "windows")]
    let ffprobe_name = "ffprobe.exe";
    #[cfg(not(target_os = "windows"))]
    let ffprobe_name = "ffprobe";

    if ffmpeg.is_file() {
        let sibling = ffmpeg.with_file_name(ffprobe_name);
        if sibling.exists() {
            candidates.push(sibling.to_string_lossy().to_string());
        }
    } else if ffmpeg.is_dir() {
        let nested = ffmpeg.join(ffprobe_name);
        if nested.exists() {
            candidates.push(nested.to_string_lossy().to_string());
        }
    }

    candidates.push(ffprobe_name.to_string());
    candidates
}

fn parse_hms_seconds(raw: &str) -> Option<f64> {
    let mut parts = raw.split(':');
    let hours = parts.next()?.trim().parse::<f64>().ok()?;
    let mins = parts.next()?.trim().parse::<f64>().ok()?;
    let secs = parts.next()?.trim().parse::<f64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !hours.is_finite() || !mins.is_finite() || !secs.is_finite() {
        return None;
    }
    Some((hours * 3600.0) + (mins * 60.0) + secs)
}

fn parse_ffmpeg_status_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let raw = &line[(idx + 5)..];
    let token = raw.split_whitespace().next()?.trim();
    parse_hms_seconds(token)
}

fn format_hms(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "00:00:00".to_string();
    }
    let whole = seconds.floor() as u64;
    let hours = whole / 3600;
    let mins = (whole % 3600) / 60;
    let secs = whole % 60;
    format!("{hours:02}:{mins:02}:{secs:02}")
}

fn push_error_line(lines: &mut VecDeque<String>, line: &str) {
    if lines.len() >= MAX_ERROR_LINES {
        lines.pop_front();
    }
    lines.push_back(line.to_string());
}
