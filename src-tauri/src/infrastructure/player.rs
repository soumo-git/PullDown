use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::core::domain::{AppSettings, PlayerPreparedMedia};
use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::engines;

const PLAYER_CACHE_SCHEMA_VERSION: &str = "v2";
const PLAYER_CACHE_DIR: &str = "player-cache";

const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "wav", "ogg", "opus"];
const SUPPORTED_AUDIO_CODECS: &[&str] = &[
    "aac",
    "mp3",
    "opus",
    "vorbis",
    "pcm_s16le",
    "pcm_s24le",
    "pcm_f32le",
];
const SUPPORTED_VIDEO_CONTAINERS: &[&str] = &["mp4", "mov", "m4v"];
const SUPPORTED_VIDEO_CODECS: &[&str] = &["h264", "avc1"];
const SUPPORTED_VIDEO_AUDIO_CODECS: &[&str] = &["aac", "mp3"];

macro_rules! player_log {
    ($level:expr, $($arg:tt)*) => {
        eprintln!("[PullDown][player][{}] {}", $level, format!($($arg)*));
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Video,
    Audio,
}

impl MediaKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }

    fn output_extension(self) -> &'static str {
        match self {
            Self::Video => "mp4",
            Self::Audio => "m4a",
        }
    }
}

#[derive(Debug, Default)]
struct ProbeInfo {
    has_video: bool,
    has_audio: bool,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    format_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    format_name: Option<String>,
}

pub fn prepare_media_for_playback(
    app: &AppHandle,
    settings: &AppSettings,
    source: &Path,
) -> AppResult<PlayerPreparedMedia> {
    if !source.exists() {
        return Err(AppError::Message(format!(
            "Media file does not exist: {}",
            source.display()
        )));
    }
    if !source.is_file() {
        return Err(AppError::Message(format!(
            "Media target is not a file: {}",
            source.display()
        )));
    }

    let ffmpeg_command = engines::resolve_ffmpeg_path(settings);
    let probe = probe_media_info(&ffmpeg_command, source);
    let media_kind = infer_media_kind(source, probe.as_ref());
    let source_path = source.to_string_lossy().to_string();

    if is_supported_for_web_playback(source, media_kind, probe.as_ref()) {
        player_log!(
            "INFO",
            "prepare_media_for_playback: source is web-compatible path={} kind={}",
            source.display(),
            media_kind.as_str()
        );
        return Ok(PlayerPreparedMedia {
            source_path: source_path.clone(),
            playback_path: source_path,
            transcoded: false,
            media_kind: media_kind.as_str().to_string(),
            details: Some("native-compatible".to_string()),
        });
    }

    let cache_dir = player_cache_dir(app)?;
    fs::create_dir_all(&cache_dir)?;
    let target = cached_output_path(&cache_dir, source, media_kind)?;

    if target.exists() {
        player_log!(
            "INFO",
            "prepare_media_for_playback: cache hit source={} cache={}",
            source.display(),
            target.display()
        );
        return Ok(PlayerPreparedMedia {
            source_path,
            playback_path: target.to_string_lossy().to_string(),
            transcoded: true,
            media_kind: media_kind.as_str().to_string(),
            details: Some("cached-transcode".to_string()),
        });
    }

    transcode_to_cache(&ffmpeg_command, source, &target, media_kind)?;
    if !target.exists() {
        return Err(AppError::Process(format!(
            "Transcode completed but output is missing: {}",
            target.display()
        )));
    }

    player_log!(
        "INFO",
        "prepare_media_for_playback: transcoded source={} cache={} kind={}",
        source.display(),
        target.display(),
        media_kind.as_str()
    );

    Ok(PlayerPreparedMedia {
        source_path,
        playback_path: target.to_string_lossy().to_string(),
        transcoded: true,
        media_kind: media_kind.as_str().to_string(),
        details: Some("transcoded-for-webview".to_string()),
    })
}

pub fn debug_probe_media_for_player(settings: &AppSettings, source: &Path) -> AppResult<()> {
    if !source.exists() {
        return Err(AppError::Message(format!(
            "Media file does not exist: {}",
            source.display()
        )));
    }
    if !source.is_file() {
        return Err(AppError::Message(format!(
            "Media target is not a file: {}",
            source.display()
        )));
    }

    let ffmpeg_command = engines::resolve_ffmpeg_path(settings);
    let probe = probe_media_info(&ffmpeg_command, source);
    let media_kind = infer_media_kind(source, probe.as_ref());
    player_log!(
        "INFO",
        "debug_probe_media_for_player: source={} inferred_kind={} ffmpeg={}",
        source.display(),
        media_kind.as_str(),
        ffmpeg_command
    );
    if let Some(info) = probe {
        player_log!(
            "INFO",
            "debug_probe_media_for_player: has_video={} has_audio={} video_codec={:?} audio_codec={:?} format={:?}",
            info.has_video,
            info.has_audio,
            info.video_codec,
            info.audio_codec,
            info.format_name
        );
    } else {
        player_log!(
            "WARN",
            "debug_probe_media_for_player: probe unavailable for source={}",
            source.display()
        );
    }
    Ok(())
}

fn player_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let root = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir());
    let root = root.map_err(|err| {
        AppError::Message(format!("Failed to resolve player cache directory: {err}"))
    })?;
    Ok(root.join(PLAYER_CACHE_DIR))
}

fn cached_output_path(
    cache_dir: &Path,
    source: &Path,
    media_kind: MediaKind,
) -> AppResult<PathBuf> {
    let metadata = fs::metadata(source)?;
    let canonical = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let modified_unix_secs = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_unix_secs.hash(&mut hasher);
    media_kind.as_str().hash(&mut hasher);
    PLAYER_CACHE_SCHEMA_VERSION.hash(&mut hasher);

    let hash = format!("{:x}", hasher.finish());
    Ok(cache_dir.join(format!("{}.{}", hash, media_kind.output_extension())))
}

fn infer_media_kind(source: &Path, probe: Option<&ProbeInfo>) -> MediaKind {
    if let Some(info) = probe {
        if info.has_video {
            return MediaKind::Video;
        }
        if info.has_audio {
            return MediaKind::Audio;
        }
    }

    let ext = lower_extension(source);
    if SUPPORTED_AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        MediaKind::Audio
    } else {
        MediaKind::Video
    }
}

fn is_supported_for_web_playback(
    source: &Path,
    media_kind: MediaKind,
    probe: Option<&ProbeInfo>,
) -> bool {
    let ext = lower_extension(source);
    match media_kind {
        MediaKind::Audio => {
            let extension_supported = SUPPORTED_AUDIO_EXTENSIONS.contains(&ext.as_str());
            let codec_supported = probe
                .and_then(|info| info.audio_codec.as_deref())
                .map(is_supported_audio_codec)
                .unwrap_or(extension_supported);
            extension_supported && codec_supported
        }
        MediaKind::Video => {
            let Some(info) = probe else {
                player_log!(
                    "WARN",
                    "is_supported_for_web_playback: missing probe info for video source={}, forcing transcode",
                    source.display()
                );
                return false;
            };
            let container_supported = probe
                .and_then(|info| info.format_name.as_deref())
                .map(format_is_supported_video_container)
                .unwrap_or(matches!(ext.as_str(), "mp4" | "m4v" | "mov"));
            let video_codec_supported = info
                .video_codec
                .as_deref()
                .map(is_supported_video_codec)
                .unwrap_or(matches!(ext.as_str(), "mp4" | "m4v" | "mov"));
            let audio_codec_supported = info
                .audio_codec
                .as_deref()
                .map(is_supported_video_audio_codec)
                .unwrap_or(true);
            container_supported && video_codec_supported && audio_codec_supported
        }
    }
}

/// Transcode `source` to `target` for web playback.
///
/// Strategy (fastest-first):
///   1. Stream copy — remux without re-encoding (`-c copy`).  Nearly instant
///      for any file size.  Works when the codecs are already H.264/AAC (e.g.
///      most MKV, WebM-with-H264, TS files).  Fails fast if the container
///      rejects the existing tracks.
///   2. Full encode — libx264 + AAC re-encode.  Universally compatible but
///      CPU-intensive.  Used only when copy fails.
fn transcode_to_cache(
    ffmpeg_command: &str,
    source: &Path,
    target: &Path,
    media_kind: MediaKind,
) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    // Stage 1: stream copy (fast remux — works for H.264/AAC in any container)
    if media_kind == MediaKind::Video {
        match run_stream_copy(ffmpeg_command, source, target) {
            Ok(()) => {
                player_log!(
                    "INFO",
                    "transcode_to_cache: stream copy succeeded source={} target={}",
                    source.display(),
                    target.display()
                );
                return Ok(());
            }
            Err(copy_err) => {
                let _ = fs::remove_file(target); // remove partial output
                player_log!(
                    "WARN",
                    "transcode_to_cache: stream copy failed ({}), falling back to full encode \
                     source={} target={}",
                    copy_err,
                    source.display(),
                    target.display()
                );
            }
        }
    }

    // Stage 2: full encode (slow but universally compatible)
    run_full_encode(ffmpeg_command, source, target, media_kind)
}

/// Attempt a codec-copy remux into an MP4 container.
/// Nearly instant regardless of file size; only works when all tracks
/// are already in codecs the MP4 container supports (H.264, AAC, MP3 …).
fn run_stream_copy(ffmpeg_command: &str, source: &Path, target: &Path) -> AppResult<()> {
    player_log!(
        "INFO",
        "transcode_to_cache: trying stream copy command={} source={} target={}",
        ffmpeg_command,
        source.display(),
        target.display()
    );

    let output = Command::new(ffmpeg_command)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::Process(format!("Failed to launch ffmpeg for copy: {e}")))?;

    if output.status.success() {
        // Guard: a zero-byte output means ffmpeg wrote nothing silently.
        let len = target
            .exists()
            .then(|| fs::metadata(target).map(|m| m.len()).unwrap_or(0))
            .unwrap_or(0);
        if len > 0 {
            return Ok(());
        }
        let _ = fs::remove_file(target);
        return Err(AppError::Process(
            "Stream copy produced an empty output file".to_string(),
        ));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Process(format!(
        "stream copy failed (status={}): {}",
        output.status,
        if stderr.is_empty() {
            "no ffmpeg output"
        } else {
            &stderr
        }
    )))
}

/// Full re-encode: libx264 + AAC for video, AAC-only for audio.
/// Compatible with every input codec but CPU-intensive for large files.
fn run_full_encode(
    ffmpeg_command: &str,
    source: &Path,
    target: &Path,
    media_kind: MediaKind,
) -> AppResult<()> {
    player_log!(
        "INFO",
        "transcode_to_cache: full encode command={} source={} target={} kind={}",
        ffmpeg_command,
        source.display(),
        target.display(),
        media_kind.as_str()
    );

    let mut command = Command::new(ffmpeg_command);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source);

    match media_kind {
        MediaKind::Audio => {
            command
                .arg("-vn")
                .arg("-c:a")
                .arg("aac")
                .arg("-b:a")
                .arg("192k");
        }
        MediaKind::Video => {
            command
                .arg("-map")
                .arg("0:v:0")
                .arg("-map")
                .arg("0:a:0?")
                .arg("-c:v")
                .arg("libx264")
                .arg("-preset")
                .arg("veryfast")
                .arg("-crf")
                .arg("22")
                .arg("-pix_fmt")
                .arg("yuv420p")
                .arg("-c:a")
                .arg("aac")
                .arg("-b:a")
                .arg("192k")
                .arg("-movflags")
                .arg("+faststart");
        }
    }

    command.arg(target);

    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            AppError::Process(format!(
                "Failed to start ffmpeg for full encode ({}): {}",
                ffmpeg_command, err
            ))
        })?;

    if !output.status.success() {
        let _ = fs::remove_file(target);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Process(format!(
            "ffmpeg encode failed (status={}): {}",
            output.status,
            if stderr.is_empty() {
                "Unknown ffmpeg error".to_string()
            } else {
                stderr
            }
        )));
    }

    Ok(())
}

fn probe_media_info(ffmpeg_command: &str, source: &Path) -> Option<ProbeInfo> {
    let candidates = ffprobe_candidates(ffmpeg_command);
    for candidate in candidates {
        let output = Command::new(&candidate)
            .arg("-v")
            .arg("error")
            .arg("-print_format")
            .arg("json")
            .arg("-show_streams")
            .arg("-show_format")
            .arg(source)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();

        let Ok(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let parsed: FfprobeOutput = match serde_json::from_slice(&output.stdout) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        let mut info = ProbeInfo {
            format_name: parsed
                .format
                .and_then(|format| format.format_name)
                .map(|value| value.to_ascii_lowercase()),
            ..ProbeInfo::default()
        };
        for stream in parsed.streams {
            let codec_type = stream.codec_type.unwrap_or_default().to_ascii_lowercase();
            let codec_name = stream.codec_name.map(|value| value.to_ascii_lowercase());
            if codec_type == "video" && !info.has_video {
                info.has_video = true;
                info.video_codec = codec_name;
            } else if codec_type == "audio" && !info.has_audio {
                info.has_audio = true;
                info.audio_codec = codec_name;
            }
        }

        player_log!(
            "INFO",
            "probe_media_info: ffprobe={} source={} has_video={} has_audio={} v_codec={:?} a_codec={:?} format={:?}",
            candidate,
            source.display(),
            info.has_video,
            info.has_audio,
            info.video_codec,
            info.audio_codec,
            info.format_name
        );
        return Some(info);
    }

    player_log!(
        "WARN",
        "probe_media_info: ffprobe unavailable or failed for source={}",
        source.display()
    );
    probe_media_info_via_ffmpeg(ffmpeg_command, source)
}

fn ffprobe_candidates(ffmpeg_command: &str) -> Vec<String> {
    let mut candidates = Vec::<String>::new();
    let ffmpeg_path = PathBuf::from(ffmpeg_command);

    #[cfg(target_os = "windows")]
    let ffprobe_name = "ffprobe.exe";
    #[cfg(not(target_os = "windows"))]
    let ffprobe_name = "ffprobe";

    if ffmpeg_path.is_file() {
        let sibling = ffmpeg_path.with_file_name(ffprobe_name);
        candidates.push(sibling.to_string_lossy().to_string());
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push("ffprobe.exe".to_string());
        candidates.push("ffprobe".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidates.push("ffprobe".to_string());
    }

    let mut deduped = Vec::<String>::new();
    for candidate in candidates {
        if candidate.trim().is_empty() {
            continue;
        }
        if deduped.iter().any(|item| item == &candidate) {
            continue;
        }
        deduped.push(candidate);
    }
    deduped
}

fn lower_extension(source: &Path) -> String {
    source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn probe_media_info_via_ffmpeg(ffmpeg_command: &str, source: &Path) -> Option<ProbeInfo> {
    let output = Command::new(ffmpeg_command)
        .arg("-hide_banner")
        .arg("-i")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut info = ProbeInfo::default();

    for line in stderr.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Input #0,") {
            if let Some(pos) = rest.find(", from") {
                let format_name = rest[..pos].trim();
                if !format_name.is_empty() {
                    info.format_name = Some(format_name.to_ascii_lowercase());
                }
            }
            continue;
        }

        if trimmed.contains("Video:") {
            info.has_video = true;
            if info.video_codec.is_none() {
                info.video_codec = parse_ffmpeg_stream_codec(trimmed, "Video:");
            }
            continue;
        }

        if trimmed.contains("Audio:") {
            info.has_audio = true;
            if info.audio_codec.is_none() {
                info.audio_codec = parse_ffmpeg_stream_codec(trimmed, "Audio:");
            }
        }
    }

    if !info.has_video && !info.has_audio {
        player_log!(
            "WARN",
            "probe_media_info_via_ffmpeg: unable to infer streams source={}",
            source.display()
        );
        return None;
    }

    player_log!(
        "INFO",
        "probe_media_info_via_ffmpeg: ffmpeg={} source={} has_video={} has_audio={} v_codec={:?} a_codec={:?} format={:?}",
        ffmpeg_command,
        source.display(),
        info.has_video,
        info.has_audio,
        info.video_codec,
        info.audio_codec,
        info.format_name
    );
    Some(info)
}

fn parse_ffmpeg_stream_codec(line: &str, marker: &str) -> Option<String> {
    let (_, rest) = line.split_once(marker)?;
    let codec = rest.split(',').next()?.trim();
    if codec.is_empty() {
        return None;
    }
    Some(codec.to_ascii_lowercase())
}

fn is_supported_audio_codec(codec: &str) -> bool {
    let normalized = codec.trim().to_ascii_lowercase();
    SUPPORTED_AUDIO_CODECS.contains(&normalized.as_str())
}

fn is_supported_video_codec(codec: &str) -> bool {
    let normalized = codec.trim().to_ascii_lowercase();
    SUPPORTED_VIDEO_CODECS.contains(&normalized.as_str())
}

fn is_supported_video_audio_codec(codec: &str) -> bool {
    let normalized = codec.trim().to_ascii_lowercase();
    SUPPORTED_VIDEO_AUDIO_CODECS.contains(&normalized.as_str())
}

fn format_is_supported_video_container(format_name: &str) -> bool {
    for token in format_name.split(',') {
        let token = token.trim().to_ascii_lowercase();
        if SUPPORTED_VIDEO_CONTAINERS.contains(&token.as_str()) {
            return true;
        }
    }
    false
}
