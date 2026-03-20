use tauri::{AppHandle, Emitter};

use crate::core::domain::{DownloadJob, EngineInstallProgressEvent, JobRemovedEvent};

pub const EVENT_JOB_UPDATED: &str = "pulldown://job-updated";
pub const EVENT_JOB_REMOVED: &str = "pulldown://job-removed";
pub const EVENT_ENGINE_INSTALL_PROGRESS: &str = "pulldown://engine-install-progress";

pub fn emit_job_updated(app: &AppHandle, job: &DownloadJob) {
    let _ = app.emit(EVENT_JOB_UPDATED, job.clone());
}

pub fn emit_job_removed(app: &AppHandle, job_id: &str) {
    let payload = JobRemovedEvent {
        job_id: job_id.to_string(),
    };
    let _ = app.emit(EVENT_JOB_REMOVED, payload);
}

pub fn emit_engine_install_progress(app: &AppHandle, event: &EngineInstallProgressEvent) {
    let _ = app.emit(EVENT_ENGINE_INSTALL_PROGRESS, event.clone());
}
