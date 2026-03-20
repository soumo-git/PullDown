# Pulldown Implementation Plan (Status Updated)

## Status Legend
1. `[x]` Completed
2. `[~]` Partially completed
3. `[ ]` Not started

## Goal
Build Pulldown into a production-ready desktop app that:
1. Downloads videos/audio via `yt-dlp`.
2. Converts local media via `ffmpeg`.
3. Shows reliable real-time progress in the existing UI.
4. Ships as a cross-platform Tauri app (Windows/macOS/Linux).

## Current Progress Snapshot (as of 2026-03-20)
1. Rust backend moved to layered folders:
   1. `src-tauri/src/app`
   2. `src-tauri/src/core`
   3. `src-tauri/src/infrastructure`
   4. `src-tauri/src/services`
2. Real Tauri IPC command surface for downloader flow is implemented.
3. Real `yt-dlp` download queue with progress parsing/events is implemented.
4. Frontend simulation path was replaced by real IPC/events.
5. Queue persistence and settings persistence are implemented.
6. "Open in file manager" and settings download-folder picker are implemented via backend system commands.
7. Managed engine bootstrap is implemented (`yt-dlp`/`ffmpeg` copied from bundled resources into app data when available).
8. Missing-engine onboarding is implemented in Settings (`Install Engines` flow).
9. Auto-install-on-demand is implemented for downloader entry points (`queue_add`, format/metadata extraction).
10. Managed `yt-dlp` updater now uses release metadata + checksum check + atomic replace + rollback.

## Target Architecture
Backend module boundaries:
1. `app/commands.rs` for Tauri IPC handlers.
2. `core/domain.rs` for typed models.
3. `core/errors.rs` and `core/events.rs` for shared error/event contracts.
4. `infrastructure/engines.rs` and `infrastructure/storage.rs` for external process/storage concerns.
5. `services/queue.rs` for queue scheduler and job lifecycle.

Frontend boundaries:
1. `state.js` remains source of truth for UI state.
2. Tauri bridge lives in `tauriApi.js`.
3. UI components consume state/events and avoid backend logic.

## Phase Plan

## Phase 1 - Backend Foundation + IPC Contract
### Status: `[x]`

### Tasks
1. `[x]` Refactor `src-tauri/src/lib.rs` to register modular command handlers.
2. `[x]` Add initial commands:
   1. `[x]` `app_get_health`
   2. `[x]` `settings_get`
   3. `[x]` `settings_set_download_dir`
   4. `[x]` `engines_get_status`
   5. `[x]` `settings_pick_download_dir`
   6. `[x]` `app_open_in_file_manager`
   7. `[x]` `engines_install_managed`
3. `[x]` Add typed request/response structs in domain layer.
4. `[x]` Add structured error type and command error mapping.
5. `[x]` Add persistent settings storage (download dir, concurrency, paths).

### Acceptance
1. `[x]` `cargo check` passes.
2. `[~]` Manual runtime validation for all settings screens still pending.

## Phase 2 - Engine Discovery + Update System
### Status: `[~]`

### Tasks
1. `[~]` Implement engine path resolution strategy.
   1. `[x]` Bundled sidecar path resolution (resource/cargo/cwd candidates).
   2. `[x]` Managed app-data engine path (`.../app_data/engines`).
   3. `[x]` User-configured custom path.
   4. `[x]` System `PATH` fallback.
2. `[x]` Implement version detection by executing each engine with version flags.
3. `[~]` Implement update check endpoint (release metadata + current version comparison).
   1. `[x]` `yt-dlp` latest release check + current version comparison.
   2. `[ ]` `ffmpeg` latest release check.
4. `[~]` Implement update flow.
   1. `[x]` Managed `yt-dlp` update via release download.
   2. `[~]` Fallback `yt-dlp -U` still exists for non-managed/path-based installs.
   3. `[~]` Checksum verification is implemented when upstream checksum file is available.
   4. `[x]` Atomic replace owned by app.
   5. `[x]` Rollback on failure owned by app.
   6. `[ ]` `ffmpeg` updater (replace flow) is not implemented yet.
5. `[~]` Implement engine installation UX.
   1. `[x]` Settings prompt/button for missing engines.
   2. `[x]` One-click install into app data.
   3. `[x]` Auto-install on first real downloader action when engines are missing.
   4. `[~]` Auto-install is full for Windows; macOS/Linux download/extract flow still pending.
6. `[ ]` Emit update/install progress events to UI.

### Acceptance
1. `[x]` `engines_get_status` returns version/availability.
2. `[~]` Safe updater guarantees are implemented for managed `yt-dlp`; `ffmpeg` updater path is pending.
3. `[~]` Non-technical onboarding is implemented on Windows; cross-platform parity still pending.

## Phase 3 - URL Intake + Metadata + Format Picker
### Status: `[x]`

### Tasks
1. `[x]` Add URL validation command.
2. `[x]` Add metadata extraction command via `yt-dlp`.
3. `[x]` Add format extraction command with normalized options.
4. `[x]` Update frontend add flow:
   1. `[x]` Validate URL.
   2. `[x]` Fetch formats from backend.
   3. `[x]` Open format picker with real options.
   4. `[x]` Enqueue selected format.
5. `[x]` Remove demo seed flow from runtime path.

### Acceptance
1. `[x]` Invalid URLs are rejected with user-safe errors.
2. `[~]` Broad site-by-site validation matrix still pending.

## Phase 4 - Download Queue Engine (Core)
### Status: `[~]`

### Tasks
1. `[x]` Implement queue manager with configurable max parallel jobs.
2. `[~]` Implement job states.
   1. `[x]` `queued`, `downloading`, `postprocessing`, `paused`, `completed`, `failed`.
   2. `[~]` `canceled` command exists, but currently removes job immediately instead of durable canceled state.
3. `[x]` Spawn and monitor `yt-dlp` process per job.
4. `[x]` Parse progress output and emit normalized progress events.
5. `[x]` Implement commands:
   1. `[x]` `queue_add`
   2. `[x]` `queue_pause`
   3. `[x]` `queue_resume`
   4. `[x]` `queue_cancel`
   5. `[x]` `queue_remove`
6. `[x]` Persist queue state for crash/restart recovery.
7. `[x]` Queue entry path ensures engines are available (auto-installs when missing).

### Acceptance
1. `[~]` Concurrency and lifecycle are implemented; full stress/reliability testing pending.
2. `[x]` Restart restores persisted queue state (active jobs restored as paused/queue-safe state).

## Phase 5 - Converter Pipeline
### Status: `[ ]`
1. `[ ]` Not started.

## Phase 6 - Library + Player Integration
### Status: `[ ]`
1. `[ ]` Not started.

## Phase 7 - Browse View Integration
### Status: `[ ]`
1. `[ ]` Not started.

## Phase 8 - Hardening + Packaging
### Status: `[ ]`
1. `[ ]` Not started.

## Implementation Order (Focus)
1. Finish remaining Phase 2 cross-platform gaps (`ffmpeg` updater + macOS/Linux install flow + progress events).
2. Finish Phase 4 gaps and harden downloader reliability.
3. Then proceed to Phases 5 to 8.

## Next Action (Recommended)
Execute a focused downloader hardening sprint:
1. Implement macOS/Linux managed engine install flow to match Windows onboarding.
2. Implement managed `ffmpeg` update flow (with atomic replace and rollback).
3. Add update/install progress events from backend to UI.
4. Add canceled-state persistence behavior decision (keep vs remove).
5. Add retry/backoff + timeout handling for `yt-dlp` jobs.
6. Run real URL matrix tests and record pass/fail for top target platforms.
