mod app {
    pub mod commands;
}
mod core {
    pub mod domain;
    pub mod errors;
    pub mod events;
}
mod infrastructure {
    pub mod engines;
    pub mod storage;
    pub mod system;
}
mod services {
    pub mod queue;
}

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use core::domain::{AppSettings, EngineInstallProgressEvent};
use core::errors::{AppError, AppResult};
use services::queue::QueueManager;
use tauri::Manager;

pub struct AppState {
    settings: Arc<RwLock<AppSettings>>,
    settings_path: PathBuf,
    engine_install_lock: Mutex<()>,
    pub queue: QueueManager,
}

impl AppState {
    fn new(app: &tauri::AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| AppError::Message(format!("Failed to get app data dir: {err}")))?;
        let settings_path = app_data_dir.join("settings.json");
        let queue_path = app_data_dir.join("queue.json");
        let mut settings = infrastructure::storage::load_or_init_settings(&settings_path)?;
        let before_bootstrap = settings.clone();
        infrastructure::engines::bootstrap_managed_engines(app, &mut settings)?;
        if settings.custom_yt_dlp_path != before_bootstrap.custom_yt_dlp_path
            || settings.custom_ffmpeg_path != before_bootstrap.custom_ffmpeg_path
        {
            infrastructure::storage::save_settings(&settings_path, &settings)?;
        }
        let settings = Arc::new(RwLock::new(settings));
        let queue = QueueManager::new(settings.clone(), queue_path);

        Ok(Self {
            settings,
            settings_path,
            engine_install_lock: Mutex::new(()),
            queue,
        })
    }

    pub fn read_settings(&self) -> AppSettings {
        self.settings
            .read()
            .expect("settings lock poisoned")
            .clone()
    }

    pub fn set_download_dir(&self, download_dir: &str) -> AppResult<AppSettings> {
        let trimmed = download_dir.trim();
        if trimmed.is_empty() {
            return Err(AppError::Message(
                "Download directory cannot be empty".to_string(),
            ));
        }
        {
            let mut settings = self.settings.write().expect("settings lock poisoned");
            settings.download_dir = trimmed.to_string();
            infrastructure::storage::save_settings(&self.settings_path, &settings)?;
        }
        Ok(self.read_settings())
    }

    pub fn pick_download_dir_and_save(&self) -> AppResult<Option<AppSettings>> {
        let current = self.read_settings();
        let selected =
            infrastructure::system::pick_directory(Some(Path::new(&current.download_dir)))?;
        let Some(path) = selected else {
            return Ok(None);
        };
        let updated = self.set_download_dir(&path.to_string_lossy())?;
        Ok(Some(updated))
    }

    pub fn open_in_file_manager(&self, path: Option<&str>) -> AppResult<()> {
        let settings = self.read_settings();
        let candidate = path
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or(&settings.download_dir);
        let target = PathBuf::from(candidate);
        let fallback = PathBuf::from(settings.download_dir);
        infrastructure::system::open_in_file_manager(&target, &fallback)
    }

    pub fn play_media(&self, path: Option<&str>) -> AppResult<()> {
        let settings = self.read_settings();
        let candidate = path
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| AppError::Message("Media path is required".to_string()))?;
        let target = PathBuf::from(candidate);
        infrastructure::system::play_media(&target, settings.custom_ffmpeg_path.as_deref())
    }

    pub fn ensure_engines_available(&self, app: &tauri::AppHandle) -> AppResult<Option<String>> {
        eprintln!("[PullDown][app][INFO] ensure_engines_available: start");
        let _install_guard = self
            .engine_install_lock
            .lock()
            .expect("engine install lock poisoned");

        let mut staged = self.read_settings();
        let result = infrastructure::engines::ensure_managed_engines_available(app, &mut staged)?;
        if result.is_some() {
            let mut settings = self.settings.write().expect("settings lock poisoned");
            *settings = staged;
            infrastructure::storage::save_settings(&self.settings_path, &settings)?;
            eprintln!(
                "[PullDown][app][INFO] ensure_engines_available: settings saved after managed install"
            );
        }
        eprintln!(
            "[PullDown][app][INFO] ensure_engines_available: done install_triggered={}",
            result.is_some()
        );
        Ok(result)
    }

    pub fn install_managed_engines(&self, app: &tauri::AppHandle) -> AppResult<String> {
        eprintln!("[PullDown][app][INFO] install_managed_engines: start");
        let _install_guard = self
            .engine_install_lock
            .lock()
            .expect("engine install lock poisoned");

        let mut staged = self.read_settings();
        let output = infrastructure::engines::install_managed_engines(app, &mut staged)?;
        let mut settings = self.settings.write().expect("settings lock poisoned");
        *settings = staged;
        infrastructure::storage::save_settings(&self.settings_path, &settings)?;
        eprintln!(
            "[PullDown][app][INFO] install_managed_engines: settings saved yt={} ffmpeg={}",
            settings.custom_yt_dlp_path.as_deref().unwrap_or("<none>"),
            settings.custom_ffmpeg_path.as_deref().unwrap_or("<none>")
        );
        eprintln!("[PullDown][app][INFO] install_managed_engines: done");
        Ok(output)
    }

    pub fn install_managed_ytdlp(&self, app: &tauri::AppHandle) -> AppResult<String> {
        eprintln!("[PullDown][app][INFO] install_managed_ytdlp: start");
        let _install_guard = self
            .engine_install_lock
            .lock()
            .expect("engine install lock poisoned");

        let mut staged = self.read_settings();
        let mut emit_progress = |progress: infrastructure::engines::EngineInstallProgress| {
            core::events::emit_engine_install_progress(
                app,
                &EngineInstallProgressEvent {
                    engine: progress.engine.to_string(),
                    stage: progress.stage.to_string(),
                    message: progress.message,
                    progress_percent: progress.progress_percent,
                    bytes_downloaded: progress.bytes_downloaded,
                    bytes_total: progress.bytes_total,
                },
            );
        };
        let output =
            infrastructure::engines::install_managed_ytdlp(app, &mut staged, &mut emit_progress)?;
        let mut settings = self.settings.write().expect("settings lock poisoned");
        *settings = staged;
        infrastructure::storage::save_settings(&self.settings_path, &settings)?;
        eprintln!(
            "[PullDown][app][INFO] install_managed_ytdlp: settings saved yt={}",
            settings.custom_yt_dlp_path.as_deref().unwrap_or("<none>")
        );
        Ok(output)
    }

    pub fn install_managed_ffmpeg(&self, app: &tauri::AppHandle) -> AppResult<String> {
        eprintln!("[PullDown][app][INFO] install_managed_ffmpeg: start");
        let _install_guard = self
            .engine_install_lock
            .lock()
            .expect("engine install lock poisoned");

        let mut staged = self.read_settings();
        let mut emit_progress = |progress: infrastructure::engines::EngineInstallProgress| {
            core::events::emit_engine_install_progress(
                app,
                &EngineInstallProgressEvent {
                    engine: progress.engine.to_string(),
                    stage: progress.stage.to_string(),
                    message: progress.message,
                    progress_percent: progress.progress_percent,
                    bytes_downloaded: progress.bytes_downloaded,
                    bytes_total: progress.bytes_total,
                },
            );
        };
        let output =
            infrastructure::engines::install_managed_ffmpeg(app, &mut staged, &mut emit_progress)?;
        let mut settings = self.settings.write().expect("settings lock poisoned");
        *settings = staged;
        infrastructure::storage::save_settings(&self.settings_path, &settings)?;
        eprintln!(
            "[PullDown][app][INFO] install_managed_ffmpeg: settings saved ffmpeg={}",
            settings.custom_ffmpeg_path.as_deref().unwrap_or("<none>")
        );
        Ok(output)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::new(&app.handle()).map_err(|err| {
                std::io::Error::other(format!(
                    "Failed to initialize app state: {}",
                    err.user_message()
                ))
            })?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app::commands::app_get_health,
            app::commands::settings_get,
            app::commands::settings_set_download_dir,
            app::commands::settings_pick_download_dir,
            app::commands::engines_get_status,
            app::commands::engines_update_yt_dlp,
            app::commands::engines_install_managed,
            app::commands::engines_install_ytdlp,
            app::commands::engines_install_ffmpeg,
            app::commands::app_open_in_file_manager,
            app::commands::app_play_media,
            app::commands::download_validate_url,
            app::commands::download_extract_metadata,
            app::commands::download_extract_formats,
            app::commands::queue_add,
            app::commands::queue_list,
            app::commands::queue_pause,
            app::commands::queue_resume,
            app::commands::queue_cancel,
            app::commands::queue_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
