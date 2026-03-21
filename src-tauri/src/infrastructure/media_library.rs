use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use tauri::AppHandle;

use crate::core::domain::{LibraryScanBatchEvent, LibraryScanProgressEvent, LibraryVideoItem};
use crate::core::events;

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "3gp", "mpeg", "mpg", "m2ts", "vob",
    "mxf", "ogv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "alac", "aiff", "aif",
    "mka", "amr", "ac3", "dts", "ape", "m4b",
];

const BATCH_SIZE: usize = 120;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

static SCAN_RUNNING: AtomicBool = AtomicBool::new(false);
static SCAN_PAUSED: AtomicBool = AtomicBool::new(false);
static SCAN_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);
static CURRENT_SCAN_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct ScanCounters {
    scanned_files: u64,
    matched_files: u64,
    visited_dirs: u64,
    roots_done: u32,
    roots_total: u32,
}

pub fn start_scan(app: AppHandle) -> u64 {
    if SCAN_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return CURRENT_SCAN_ID.load(Ordering::SeqCst);
    }

    SCAN_PAUSED.store(false, Ordering::SeqCst);
    SCAN_STOP_REQUESTED.store(false, Ordering::SeqCst);

    let scan_id = NEXT_SCAN_ID.fetch_add(1, Ordering::SeqCst);
    CURRENT_SCAN_ID.store(scan_id, Ordering::SeqCst);

    thread::spawn(move || {
        run_scan(scan_id, &app);
        SCAN_PAUSED.store(false, Ordering::SeqCst);
        SCAN_STOP_REQUESTED.store(false, Ordering::SeqCst);
        SCAN_RUNNING.store(false, Ordering::SeqCst);
    });

    scan_id
}

pub fn pause_scan() -> bool {
    if !SCAN_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    SCAN_PAUSED.store(true, Ordering::SeqCst);
    true
}

pub fn resume_scan() -> bool {
    if !SCAN_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    SCAN_PAUSED.store(false, Ordering::SeqCst);
    true
}

pub fn stop_scan() -> bool {
    if !SCAN_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    SCAN_STOP_REQUESTED.store(true, Ordering::SeqCst);
    SCAN_PAUSED.store(false, Ordering::SeqCst);
    true
}

fn run_scan(scan_id: u64, app: &AppHandle) {
    let roots = scan_roots();
    let mut counters = ScanCounters {
        roots_total: roots.len() as u32,
        ..ScanCounters::default()
    };
    let mut batch = Vec::<LibraryVideoItem>::with_capacity(BATCH_SIZE);
    let mut last_progress_emit = Instant::now() - PROGRESS_INTERVAL;

    emit_progress(app, scan_id, &counters, false, false, None);

    for root in roots {
        if sync_control_state(app, scan_id, &counters, &mut last_progress_emit) {
            flush_batch(app, scan_id, &mut batch);
            emit_progress(
                app,
                scan_id,
                &counters,
                false,
                true,
                Some("Stopped by user".to_string()),
            );
            return;
        }

        let continue_scan = scan_root(
            &root,
            &mut counters,
            &mut batch,
            app,
            scan_id,
            &mut last_progress_emit,
        );
        if !continue_scan {
            flush_batch(app, scan_id, &mut batch);
            emit_progress(
                app,
                scan_id,
                &counters,
                false,
                true,
                Some("Stopped by user".to_string()),
            );
            return;
        }

        counters.roots_done = counters.roots_done.saturating_add(1);
        emit_progress(app, scan_id, &counters, false, false, None);
    }

    flush_batch(app, scan_id, &mut batch);
    emit_progress(app, scan_id, &counters, false, true, None);
}

fn scan_root(
    root: &Path,
    counters: &mut ScanCounters,
    batch: &mut Vec<LibraryVideoItem>,
    app: &AppHandle,
    scan_id: u64,
    last_progress_emit: &mut Instant,
) -> bool {
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if sync_control_state(app, scan_id, counters, last_progress_emit) {
            return false;
        }

        counters.visited_dirs = counters.visited_dirs.saturating_add(1);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            if sync_control_state(app, scan_id, counters, last_progress_emit) {
                return false;
            }

            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };

            if file_type.is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                if should_skip_dir(&path) {
                    continue;
                }
                stack.push(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            counters.scanned_files = counters.scanned_files.saturating_add(1);
            if !is_media_file(&path) {
                maybe_emit_progress(app, scan_id, counters, last_progress_emit);
                continue;
            }

            if let Some(item) = build_item(&path) {
                counters.matched_files = counters.matched_files.saturating_add(1);
                batch.push(item);
                if batch.len() >= BATCH_SIZE {
                    flush_batch(app, scan_id, batch);
                }
            }

            maybe_emit_progress(app, scan_id, counters, last_progress_emit);
        }
    }

    true
}

fn sync_control_state(
    app: &AppHandle,
    scan_id: u64,
    counters: &ScanCounters,
    last_progress_emit: &mut Instant,
) -> bool {
    if SCAN_STOP_REQUESTED.load(Ordering::SeqCst) {
        return true;
    }

    let mut emitted_pause_progress = false;
    while SCAN_PAUSED.load(Ordering::SeqCst) {
        if SCAN_STOP_REQUESTED.load(Ordering::SeqCst) {
            return true;
        }
        if !emitted_pause_progress || last_progress_emit.elapsed() >= PROGRESS_INTERVAL {
            emit_progress(app, scan_id, counters, true, false, None);
            *last_progress_emit = Instant::now();
            emitted_pause_progress = true;
        }
        thread::sleep(Duration::from_millis(120));
    }

    if emitted_pause_progress {
        emit_progress(app, scan_id, counters, false, false, None);
        *last_progress_emit = Instant::now();
    }

    false
}

fn maybe_emit_progress(
    app: &AppHandle,
    scan_id: u64,
    counters: &ScanCounters,
    last_progress_emit: &mut Instant,
) {
    if last_progress_emit.elapsed() >= PROGRESS_INTERVAL || counters.scanned_files % 1000 == 0 {
        emit_progress(app, scan_id, counters, false, false, None);
        *last_progress_emit = Instant::now();
    }
}

fn flush_batch(app: &AppHandle, scan_id: u64, batch: &mut Vec<LibraryVideoItem>) {
    if batch.is_empty() {
        return;
    }

    batch.sort_by(|a, b| {
        b.created_unix_seconds
            .cmp(&a.created_unix_seconds)
            .then_with(|| a.path.cmp(&b.path))
    });

    let payload = LibraryScanBatchEvent {
        scan_id,
        items: std::mem::take(batch),
    };
    events::emit_library_scan_batch(app, &payload);
}

fn emit_progress(
    app: &AppHandle,
    scan_id: u64,
    counters: &ScanCounters,
    paused: bool,
    done: bool,
    error: Option<String>,
) {
    let event = LibraryScanProgressEvent {
        scan_id,
        scanned_files: counters.scanned_files,
        matched_files: counters.matched_files,
        visited_dirs: counters.visited_dirs,
        roots_done: counters.roots_done,
        roots_total: counters.roots_total,
        paused,
        done,
        error,
    };
    events::emit_library_scan_progress(app, &event);
}

fn build_item(path: &Path) -> Option<LibraryVideoItem> {
    let metadata = fs::metadata(path).ok()?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.trim().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let absolute = path.to_string_lossy().to_string();
    let created_unix_seconds = file_created_or_modified_unix_seconds(&metadata).unwrap_or(0);
    let size_bytes = metadata.len();

    Some(LibraryVideoItem {
        id: stable_id_for_path(&absolute),
        title,
        path: absolute,
        created_unix_seconds,
        size_bytes,
        extension,
    })
}

fn is_media_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    let ext = ext.trim().to_ascii_lowercase();
    MEDIA_EXTENSIONS.contains(&ext.as_str())
}

fn stable_id_for_path(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("media-{:x}", hasher.finish())
}

fn file_created_or_modified_unix_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

#[cfg(target_os = "windows")]
fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::<PathBuf>::new();
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", char::from(letter)));
        if root.exists() && root.is_dir() {
            roots.push(root);
        }
    }
    roots
}

#[cfg(not(target_os = "windows"))]
fn scan_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(target_os = "windows")]
fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let lower = name.trim().to_ascii_lowercase();

    if lower.starts_with('.') {
        return true;
    }

    matches!(
        lower.as_str(),
        "$recycle.bin"
            | "system volume information"
            | "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "appdata"
            | "node_modules"
            | "target"
            | ".git"
            | ".cargo"
            | ".rustup"
            | "venv"
            | ".venv"
            | "npm-cache"
    )
}

#[cfg(not(target_os = "windows"))]
fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let lower = name.trim().to_ascii_lowercase();

    if lower.starts_with('.') {
        return true;
    }

    matches!(
        lower.as_str(),
        "proc"
            | "sys"
            | "dev"
            | "run"
            | "tmp"
            | "var"
            | "node_modules"
            | "target"
            | "venv"
            | ".venv"
            | ".cache"
    )
}
