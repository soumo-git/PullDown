use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::domain::{
    AppSettings, DownloadFormatOption, DownloadJob, DownloadJobStatus, QueueListResponse,
    VideoMetadata,
};
use crate::core::errors::{AppError, AppResult};
use crate::core::events;
use crate::infrastructure::engines;
use crate::infrastructure::process::CommandBackgroundExt;

#[derive(Clone)]
pub struct QueueManager {
    inner: Arc<Mutex<QueueState>>,
    settings: Arc<RwLock<AppSettings>>,
    queue_path: PathBuf,
}

#[derive(Default)]
struct QueueState {
    jobs: HashMap<String, DownloadJob>,
    order: VecDeque<String>,
    running_children: HashMap<String, Arc<Mutex<Child>>>,
    next_id: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedQueue {
    jobs: Vec<DownloadJob>,
    order: Vec<String>,
    next_id: u64,
}

#[derive(Debug, Clone)]
pub struct PreparedDownload {
    pub url: String,
    pub metadata: VideoMetadata,
    pub format: DownloadFormatOption,
}

#[derive(Debug, Clone, Copy)]
struct ProgressUpdate {
    downloaded: u64,
    total: Option<u64>,
    speed_bps: Option<u64>,
    eta_seconds: Option<u64>,
    progress_percent: Option<u8>,
}

impl QueueManager {
    pub fn new(settings: Arc<RwLock<AppSettings>>, queue_path: PathBuf) -> Self {
        let restored = load_persisted_queue(&queue_path).unwrap_or_default();
        Self {
            inner: Arc::new(Mutex::new(restored)),
            settings,
            queue_path,
        }
    }

    pub fn list(&self) -> QueueListResponse {
        let settings = self.settings.read().expect("settings lock poisoned");
        let max = settings.max_concurrent_downloads.max(1);
        drop(settings);

        let inner = self.inner.lock().expect("queue lock poisoned");
        let jobs = inner
            .order
            .iter()
            .filter_map(|id| inner.jobs.get(id).cloned())
            .collect::<Vec<_>>();
        QueueListResponse {
            jobs,
            max_concurrent_downloads: max,
        }
    }

    pub fn enqueue(&self, prepared: PreparedDownload, app: &AppHandle) -> AppResult<DownloadJob> {
        let mut inner = self.inner.lock().expect("queue lock poisoned");
        inner.next_id += 1;
        let id = format!("dl-{}", inner.next_id);

        let job = DownloadJob {
            id: id.clone(),
            url: prepared.url,
            title: prepared.metadata.title,
            platform: prepared.metadata.platform,
            duration: prepared.metadata.duration,
            thumbnail: prepared.metadata.thumbnail,
            color: prepared.metadata.color,
            format_id: prepared.format.id,
            res: prepared.format.res,
            codec: prepared.format.codec,
            audio: prepared.format.audio,
            ext: prepared.format.ext,
            status: DownloadJobStatus::Queued,
            progress: 0,
            bytes_total: 0,
            bytes_down: 0,
            speed_bps: 0,
            eta_seconds: None,
            file_path: None,
            error: None,
        };

        inner.order.push_back(id.clone());
        inner.jobs.insert(id, job.clone());
        self.persist_locked_state(&inner);
        drop(inner);

        events::emit_job_updated(app, &job);
        self.schedule(app.clone());
        Ok(job)
    }

    pub fn pause(&self, job_id: &str, app: &AppHandle) -> AppResult<DownloadJob> {
        let child = {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return Err(AppError::Message("Download job not found".to_string()));
            };
            if !matches!(
                job.status,
                DownloadJobStatus::Downloading | DownloadJobStatus::Postprocessing
            ) {
                return Err(AppError::Message(
                    "Only active downloads can be paused".to_string(),
                ));
            }
            job.status = DownloadJobStatus::Paused;
            job.speed_bps = 0;
            let updated = job.clone();
            let child = inner.running_children.remove(job_id);
            self.persist_locked_state(&inner);
            drop(inner);
            events::emit_job_updated(app, &updated);
            child
        };

        if let Some(child) = child {
            kill_child(&child);
        }
        self.schedule(app.clone());
        let inner = self.inner.lock().expect("queue lock poisoned");
        inner
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| AppError::Message("Download job not found".to_string()))
    }

    pub fn resume(&self, job_id: &str, app: &AppHandle) -> AppResult<DownloadJob> {
        let updated = {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            let updated = {
                let Some(job) = inner.jobs.get_mut(job_id) else {
                    return Err(AppError::Message("Download job not found".to_string()));
                };
                if !matches!(
                    job.status,
                    DownloadJobStatus::Paused | DownloadJobStatus::Failed
                ) {
                    return Err(AppError::Message(
                        "Only paused or failed downloads can be resumed".to_string(),
                    ));
                }
                job.status = DownloadJobStatus::Queued;
                job.speed_bps = 0;
                job.error = None;
                job.clone()
            };
            self.persist_locked_state(&inner);
            updated
        };
        events::emit_job_updated(app, &updated);
        self.schedule(app.clone());
        Ok(updated)
    }

    pub fn cancel(&self, job_id: &str, app: &AppHandle) -> AppResult<()> {
        let child = {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            let exists = inner.jobs.remove(job_id).is_some();
            if !exists {
                return Err(AppError::Message("Download job not found".to_string()));
            }
            inner.order.retain(|id| id != job_id);
            self.persist_locked_state(&inner);
            inner.running_children.remove(job_id)
        };

        if let Some(child) = child {
            kill_child(&child);
        }

        events::emit_job_removed(app, job_id);
        self.schedule(app.clone());
        Ok(())
    }

    pub fn remove(&self, job_id: &str, app: &AppHandle) -> AppResult<()> {
        let mut inner = self.inner.lock().expect("queue lock poisoned");
        let Some(job) = inner.jobs.get(job_id) else {
            return Err(AppError::Message("Download job not found".to_string()));
        };
        if matches!(
            job.status,
            DownloadJobStatus::Downloading | DownloadJobStatus::Postprocessing
        ) {
            return Err(AppError::Message(
                "Cannot remove an active download; cancel it first".to_string(),
            ));
        }
        inner.jobs.remove(job_id);
        inner.order.retain(|id| id != job_id);
        self.persist_locked_state(&inner);
        drop(inner);
        events::emit_job_removed(app, job_id);
        Ok(())
    }

    pub fn schedule(&self, app: AppHandle) {
        loop {
            let maybe_job_id = {
                let mut inner = self.inner.lock().expect("queue lock poisoned");
                let running = inner.running_children.len();
                let max = self
                    .settings
                    .read()
                    .expect("settings lock poisoned")
                    .max_concurrent_downloads
                    .max(1);
                if running >= max {
                    None
                } else {
                    let next_id = inner
                        .order
                        .iter()
                        .find(|id| {
                            inner
                                .jobs
                                .get(*id)
                                .map(|job| job.status == DownloadJobStatus::Queued)
                                .unwrap_or(false)
                        })
                        .cloned();
                    if let Some(id) = next_id.clone() {
                        if inner.jobs.contains_key(&id) {
                            let updated = {
                                let job = inner.jobs.get_mut(&id).expect("job must exist");
                                job.status = DownloadJobStatus::Downloading;
                                job.speed_bps = 0;
                                job.error = None;
                                job.clone()
                            };
                            self.persist_locked_state(&inner);
                            events::emit_job_updated(&app, &updated);
                        }
                    }
                    next_id
                }
            };

            let Some(job_id) = maybe_job_id else {
                break;
            };
            self.spawn_worker(job_id, app.clone());
        }
    }

    fn spawn_worker(&self, job_id: String, app: AppHandle) {
        let settings = self
            .settings
            .read()
            .expect("settings lock poisoned")
            .clone();
        let job_snapshot = {
            let inner = self.inner.lock().expect("queue lock poisoned");
            inner.jobs.get(&job_id).cloned()
        };

        let Some(job) = job_snapshot else {
            return;
        };

        let ytdlp = engines::resolve_yt_dlp_path(&settings);
        let output_dir = match engines::ensure_directory(&settings.download_dir) {
            Ok(path) => path,
            Err(err) => {
                self.mark_failed(&job_id, err.user_message(), &app);
                return;
            }
        };
        let plan = build_download_plan(&job);
        if plan.format_selector != job.format_id || !plan.extra_args.is_empty() {
            eprintln!(
                "[PullDown][queue][INFO] spawn_worker: job_id={} selected_format={} effective_format={} merge_ext={:?} profile={}",
                job_id,
                job.format_id,
                plan.format_selector,
                plan.merge_output_ext,
                plan.profile_label
            );
        }

        let mut command = Command::new(&ytdlp);
        command.for_background_job();
        command
            .arg("--newline")
            .arg("--continue")
            .arg("--no-playlist")
            .arg("--progress")
            .arg("--progress-template")
            .arg(
                "download:[pulldown]%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s",
            )
            .arg("-f")
            .arg(&plan.format_selector)
            .arg("-o")
            .arg(
                output_dir
                    .join("%(title)s [%(id)s].%(ext)s")
                    .to_string_lossy()
                    .to_string(),
            );

        if let Some(merge_ext) = plan.merge_output_ext {
            command.arg("--merge-output-format").arg(merge_ext);
        }
        for arg in &plan.extra_args {
            command.arg(arg);
        }

        if let Some(ffmpeg_location) = engines::resolve_ffmpeg_location_arg(&settings) {
            command.arg("--ffmpeg-location").arg(ffmpeg_location);
        }
        command
            .arg(&job.url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.mark_failed(&job_id, err.to_string(), &app);
                return;
            }
        };

        let child_arc = Arc::new(Mutex::new(child));
        {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            inner
                .running_children
                .insert(job_id.clone(), child_arc.clone());
        }

        let queue = self.clone();
        thread::spawn(move || {
            queue.run_worker(job_id, child_arc, app);
        });
    }

    fn run_worker(&self, job_id: String, child: Arc<Mutex<Child>>, app: AppHandle) {
        let (stdout, stderr) = {
            let mut process = child.lock().expect("child lock poisoned");
            (process.stdout.take(), process.stderr.take())
        };

        let (tx, rx) = mpsc::channel::<String>();
        if let Some(stdout) = stdout {
            spawn_stream_reader(stdout, tx.clone());
        }
        if let Some(stderr) = stderr {
            spawn_stream_reader(stderr, tx.clone());
        }
        drop(tx);

        for line in rx {
            self.handle_process_line(&job_id, &line, &app);
        }

        let exit_status = {
            let mut process = child.lock().expect("child lock poisoned");
            process.wait().ok()
        };

        let status_ok = exit_status.map(|s| s.success()).unwrap_or(false);

        let final_job = {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            inner.running_children.remove(&job_id);
            let updated = {
                let Some(job) = inner.jobs.get_mut(&job_id) else {
                    return;
                };

                if job.status == DownloadJobStatus::Paused {
                    job.speed_bps = 0;
                    Some(job.clone())
                } else if status_ok {
                    job.status = DownloadJobStatus::Completed;
                    job.progress = 100;
                    job.speed_bps = 0;
                    job.eta_seconds = Some(0);
                    Some(job.clone())
                } else {
                    job.status = DownloadJobStatus::Failed;
                    job.speed_bps = 0;
                    if job.error.is_none() {
                        job.error = Some("Download process exited with an error".to_string());
                    }
                    Some(job.clone())
                }
            };
            self.persist_locked_state(&inner);
            updated
        };

        if let Some(job) = final_job {
            events::emit_job_updated(&app, &job);
        }
        self.schedule(app);
    }

    fn handle_process_line(&self, job_id: &str, line: &str, app: &AppHandle) {
        if line.contains("[Merger]") || line.contains("Merging formats into") {
            let updated = {
                let mut inner = self.inner.lock().expect("queue lock poisoned");
                let updated = {
                    let Some(job) = inner.jobs.get_mut(job_id) else {
                        return;
                    };
                    if job.status != DownloadJobStatus::Paused {
                        job.status = DownloadJobStatus::Postprocessing;
                    }
                    if let Some(path) = extract_output_path(line) {
                        job.file_path = Some(path);
                    }
                    job.clone()
                };
                self.persist_locked_state(&inner);
                updated
            };
            events::emit_job_updated(app, &updated);
            return;
        }

        if line.contains("Destination:") {
            let path = line
                .split_once("Destination:")
                .map(|(_, tail)| tail.trim().to_string());
            if let Some(path) = path {
                let updated = {
                    let mut inner = self.inner.lock().expect("queue lock poisoned");
                    let updated = {
                        let Some(job) = inner.jobs.get_mut(job_id) else {
                            return;
                        };
                        job.file_path = Some(path);
                        job.clone()
                    };
                    self.persist_locked_state(&inner);
                    updated
                };
                events::emit_job_updated(app, &updated);
            }
            return;
        }

        if let Some(progress) = parse_progress_line(line) {
            let updated = {
                let mut inner = self.inner.lock().expect("queue lock poisoned");
                let Some(job) = inner.jobs.get_mut(job_id) else {
                    return;
                };
                if job.status == DownloadJobStatus::Paused {
                    return;
                }
                job.status = DownloadJobStatus::Downloading;
                job.bytes_down = progress.downloaded;
                if let Some(total) = progress.total {
                    if total > 0 {
                        job.bytes_total = total;
                    }
                }
                job.speed_bps = progress.speed_bps.unwrap_or(0);
                job.eta_seconds = progress.eta_seconds;
                if let Some(pct) = progress.progress_percent {
                    job.progress = pct.min(100);
                } else if job.bytes_total > 0 {
                    let pct = ((job.bytes_down as f64 / job.bytes_total as f64) * 100.0).round();
                    job.progress = pct.clamp(0.0, 100.0) as u8;
                }
                job.clone()
            };
            events::emit_job_updated(app, &updated);
            return;
        }

        if line.starts_with("ERROR:") {
            let updated = {
                let mut inner = self.inner.lock().expect("queue lock poisoned");
                let updated = {
                    let Some(job) = inner.jobs.get_mut(job_id) else {
                        return;
                    };
                    job.error = Some(line.trim().to_string());
                    job.clone()
                };
                self.persist_locked_state(&inner);
                updated
            };
            events::emit_job_updated(app, &updated);
        }
    }

    fn mark_failed(&self, job_id: &str, error_message: String, app: &AppHandle) {
        let updated = {
            let mut inner = self.inner.lock().expect("queue lock poisoned");
            let updated = {
                let Some(job) = inner.jobs.get_mut(job_id) else {
                    return;
                };
                job.status = DownloadJobStatus::Failed;
                job.error = Some(error_message);
                job.speed_bps = 0;
                job.clone()
            };
            self.persist_locked_state(&inner);
            updated
        };
        events::emit_job_updated(app, &updated);
        self.schedule(app.clone());
    }

    fn persist_locked_state(&self, inner: &QueueState) {
        let persisted = PersistedQueue {
            jobs: inner.jobs.values().cloned().collect(),
            order: inner.order.iter().cloned().collect(),
            next_id: inner.next_id,
        };
        if let Some(parent) = self.queue_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&persisted) {
            let _ = fs::write(&self.queue_path, serialized);
        }
    }
}

fn kill_child(child: &Arc<Mutex<Child>>) {
    if let Ok(mut process) = child.lock() {
        let _ = process.kill();
    }
}

fn spawn_stream_reader<R>(stream: R, tx: mpsc::Sender<String>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

fn parse_progress_line(line: &str) -> Option<ProgressUpdate> {
    let marker = "[pulldown]";
    let idx = line.find(marker)?;
    let payload = &line[(idx + marker.len())..];
    let parts = payload.split('|').collect::<Vec<_>>();
    if parts.len() < 5 {
        return None;
    }

    let downloaded = parse_u64(parts[0].trim())?;
    let total = parse_u64(parts[1].trim());
    let speed_bps = parse_speed_bps(parts[2].trim());
    let eta_seconds = parse_u64(parts[3].trim());
    let progress_percent = parse_percent(parts[4].trim());

    Some(ProgressUpdate {
        downloaded,
        total,
        speed_bps,
        eta_seconds,
        progress_percent,
    })
}

fn parse_u64(raw: &str) -> Option<u64> {
    if raw.is_empty() || raw.eq_ignore_ascii_case("NA") {
        return None;
    }
    let normalized = raw.trim();
    if let Ok(v) = normalized.parse::<u64>() {
        return Some(v);
    }
    let float = normalized.parse::<f64>().ok()?;
    if !float.is_finite() || float < 0.0 {
        return None;
    }
    Some(float.round() as u64)
}

fn parse_percent(raw: &str) -> Option<u8> {
    let trimmed = raw.trim().trim_end_matches('%').trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = trimmed.parse::<f64>().ok()?;
    Some(value.clamp(0.0, 100.0).round() as u8)
}

fn parse_speed_bps(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("NA") {
        return None;
    }

    // yt-dlp may emit either plain bytes/sec (e.g. "502144.0") or unit-formatted
    // speeds (e.g. "1.25MiB/s"). Handle both.
    if let Some(numeric) = parse_u64(trimmed) {
        return Some(numeric);
    }

    let cleaned = trimmed.trim_end_matches("/s").trim();
    let cleaned = cleaned.trim_start_matches('~').trim();
    if cleaned.is_empty() {
        return None;
    }

    let split_at = cleaned
        .char_indices()
        .find(|(_, ch)| !matches!(ch, '0'..='9' | '.' | ','))
        .map(|(idx, _)| idx)
        .unwrap_or(cleaned.len());

    let (num_raw, unit_raw) = cleaned.split_at(split_at);
    let num = num_raw.replace(',', "").trim().parse::<f64>().ok()?;
    if !num.is_finite() || num < 0.0 {
        return None;
    }

    let unit = unit_raw.trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "" | "b" | "byte" | "bytes" => 1_f64,
        "k" | "kb" => 1_000_f64,
        "ki" | "kib" => 1_024_f64,
        "m" | "mb" => 1_000_000_f64,
        "mi" | "mib" => 1_048_576_f64,
        "g" | "gb" => 1_000_000_000_f64,
        "gi" | "gib" => 1_073_741_824_f64,
        "t" | "tb" => 1_000_000_000_000_f64,
        "ti" | "tib" => 1_099_511_627_776_f64,
        _ => return None,
    };

    Some((num * multiplier).round() as u64)
}

fn extract_output_path(line: &str) -> Option<String> {
    if let Some((_, tail)) = line.split_once("Merging formats into") {
        let t = tail.trim();
        if let Some(stripped) = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            return Some(stripped.to_string());
        }
        return Some(t.to_string());
    }
    None
}

#[derive(Debug, Clone)]
struct DownloadPlan {
    format_selector: String,
    merge_output_ext: Option<&'static str>,
    extra_args: Vec<String>,
    profile_label: &'static str,
}

#[derive(Debug, Clone, Copy)]
enum StablePresetKind {
    VideoAudio,
    VideoOnly,
    AudioOnly,
}

#[derive(Debug, Clone, Copy)]
struct StablePreset {
    kind: StablePresetKind,
    max_height: Option<u16>,
}

fn build_download_plan(job: &DownloadJob) -> DownloadPlan {
    if let Some(preset) = parse_stable_preset(&job.format_id) {
        return build_stable_download_plan(preset);
    }

    DownloadPlan {
        format_selector: build_effective_format_selector(job),
        merge_output_ext: merge_output_extension_for_job(job),
        extra_args: Vec::new(),
        profile_label: "legacy",
    }
}

fn parse_stable_preset(format_id: &str) -> Option<StablePreset> {
    let mut parts = format_id.split(':');
    if parts.next()? != "stable" {
        return None;
    }

    let kind = parts.next()?;
    let value = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    match kind {
        "va" => Some(StablePreset {
            kind: StablePresetKind::VideoAudio,
            max_height: value.parse::<u16>().ok(),
        }),
        "v" => Some(StablePreset {
            kind: StablePresetKind::VideoOnly,
            max_height: value.parse::<u16>().ok(),
        }),
        "a" => Some(StablePreset {
            kind: StablePresetKind::AudioOnly,
            max_height: None,
        }),
        _ => None,
    }
}

fn build_stable_download_plan(preset: StablePreset) -> DownloadPlan {
    let height_filter = preset
        .max_height
        .map(|h| format!("[height<={h}]"))
        .unwrap_or_default();

    match preset.kind {
        StablePresetKind::VideoAudio => DownloadPlan {
            format_selector: format!(
                "bestvideo{height_filter}[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo{height_filter}[ext=mp4]+bestaudio[ext=m4a]/bestvideo{height_filter}+bestaudio/best{height_filter}/best"
            ),
            merge_output_ext: Some("mp4"),
            extra_args: vec![
                "--recode-video".to_string(),
                "mp4".to_string(),
                "--postprocessor-args".to_string(),
                "ffmpeg:-c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -movflags +faststart"
                    .to_string(),
            ],
            profile_label: "stable-video-audio",
        },
        StablePresetKind::VideoOnly => DownloadPlan {
            format_selector: format!(
                "bestvideo{height_filter}[vcodec^=avc1][ext=mp4]/bestvideo{height_filter}[ext=mp4]/bestvideo{height_filter}/bestvideo"
            ),
            merge_output_ext: Some("mp4"),
            extra_args: vec![
                "--recode-video".to_string(),
                "mp4".to_string(),
                "--postprocessor-args".to_string(),
                "ffmpeg:-c:v libx264 -preset medium -crf 20 -an -movflags +faststart".to_string(),
            ],
            profile_label: "stable-video-only",
        },
        StablePresetKind::AudioOnly => DownloadPlan {
            format_selector: "bestaudio[ext=m4a]/bestaudio".to_string(),
            merge_output_ext: None,
            extra_args: vec![
                "--extract-audio".to_string(),
                "--audio-format".to_string(),
                "m4a".to_string(),
                "--audio-quality".to_string(),
                "0".to_string(),
            ],
            profile_label: "stable-audio-only",
        },
    }
}

fn build_effective_format_selector(job: &DownloadJob) -> String {
    let selected = job.format_id.trim();
    if selected.is_empty() {
        return "bestvideo*+bestaudio/best".to_string();
    }
    let selected_ext = normalized_ext(job.ext.as_deref());

    // If user selected an explicit expression (already merged or with fallback), honor it as-is.
    if selected.contains('+') || selected.contains('/') || selected.contains(',') {
        return selected.to_string();
    }

    // Raw format IDs are often video-only. If metadata says no audio track, auto-merge best audio.
    if job.audio.is_none() {
        return match selected_ext.as_deref() {
            Some("mp4") => {
                format!("{selected}+bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio/best")
            }
            Some("webm") => format!("{selected}+bestaudio[ext=webm]/bestaudio/best"),
            Some(ext) => format!("{selected}+bestaudio[ext={ext}]/bestaudio/best"),
            None => format!("{selected}+bestaudio/best"),
        };
    }

    selected.to_string()
}

fn merge_output_extension_for_job(job: &DownloadJob) -> Option<&'static str> {
    match normalized_ext(job.ext.as_deref()).as_deref() {
        Some("mp4") => Some("mp4"),
        Some("webm") => Some("webm"),
        _ => None,
    }
}

fn normalized_ext(ext: Option<&str>) -> Option<String> {
    let ext = ext?.trim();
    if ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

fn load_persisted_queue(path: &Path) -> Option<QueueState> {
    let raw = fs::read_to_string(path).ok()?;
    let persisted = serde_json::from_str::<PersistedQueue>(&raw).ok()?;

    let mut jobs = HashMap::<String, DownloadJob>::new();
    for mut job in persisted.jobs {
        if matches!(
            job.status,
            DownloadJobStatus::Downloading | DownloadJobStatus::Postprocessing
        ) {
            job.status = DownloadJobStatus::Paused;
            job.speed_bps = 0;
        }
        jobs.insert(job.id.clone(), job);
    }

    let mut order = VecDeque::new();
    for id in persisted.order {
        if jobs.contains_key(&id) {
            order.push_back(id);
        }
    }

    Some(QueueState {
        jobs,
        order,
        running_children: HashMap::new(),
        next_id: persisted.next_id,
    })
}
