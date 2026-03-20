use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::core::errors::{AppError, AppResult};

pub fn open_in_file_manager(target: &Path, fallback_dir: &Path) -> AppResult<()> {
    let resolved = resolve_open_target(target, fallback_dir)?;

    #[cfg(target_os = "windows")]
    {
        open_in_file_manager_windows(&resolved)?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        open_in_file_manager_macos(&resolved)?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        open_in_file_manager_linux(&resolved)?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(AppError::Message(
        "Opening file manager is not supported on this platform".to_string(),
    ))
}

pub fn pick_directory(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    #[cfg(target_os = "windows")]
    {
        return pick_directory_windows(initial_dir);
    }

    #[cfg(target_os = "macos")]
    {
        return pick_directory_macos(initial_dir);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return pick_directory_linux(initial_dir);
    }

    #[allow(unreachable_code)]
    Err(AppError::Message(
        "Directory picker is not supported on this platform".to_string(),
    ))
}

pub fn play_media(target: &Path, custom_ffmpeg_path: Option<&str>) -> AppResult<()> {
    if !target.exists() {
        return Err(AppError::Message(format!(
            "Media file does not exist: {}",
            target.display()
        )));
    }
    if !target.is_file() {
        return Err(AppError::Message(format!(
            "Media target is not a file: {}",
            target.display()
        )));
    }

    if let Some(ffplay_path) = resolve_ffplay_path(custom_ffmpeg_path) {
        if ffplay_path.exists() && spawn_ffplay_path(&ffplay_path, target).is_ok() {
            return Ok(());
        }
    }

    if spawn_ffplay_from_path(target).is_ok() {
        return Ok(());
    }

    open_media_with_default_app(target)
}

fn resolve_open_target(target: &Path, fallback_dir: &Path) -> AppResult<PathBuf> {
    if target.exists() {
        return Ok(target.to_path_buf());
    }

    if let Some(parent) = target.parent() {
        if parent.exists() {
            return Ok(parent.to_path_buf());
        }
    }

    if fallback_dir.exists() {
        return Ok(fallback_dir.to_path_buf());
    }

    Err(AppError::Message(format!(
        "Path does not exist: {}",
        target.display()
    )))
}

#[cfg(target_os = "windows")]
const FFPLAY_NAME: &str = "ffplay.exe";
#[cfg(not(target_os = "windows"))]
const FFPLAY_NAME: &str = "ffplay";

fn resolve_ffplay_path(custom_ffmpeg_path: Option<&str>) -> Option<PathBuf> {
    let raw = custom_ffmpeg_path?.trim();
    if raw.is_empty() {
        return None;
    }

    let ffmpeg = PathBuf::from(raw);
    if ffmpeg.is_file() {
        return Some(ffmpeg.with_file_name(FFPLAY_NAME));
    }

    if ffmpeg.is_dir() {
        return Some(ffmpeg.join(FFPLAY_NAME));
    }

    None
}

fn spawn_ffplay_path(ffplay_path: &Path, target: &Path) -> AppResult<()> {
    Command::new(ffplay_path)
        .args(["-autoexit", "-hide_banner", "-loglevel", "error"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Process(err.to_string()))?;
    Ok(())
}

fn spawn_ffplay_from_path(target: &Path) -> AppResult<()> {
    Command::new(FFPLAY_NAME)
        .args(["-autoexit", "-hide_banner", "-loglevel", "error"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Process(err.to_string()))?;
    Ok(())
}

fn open_media_with_default_app(target: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        return open_media_with_default_app_windows(target);
    }

    #[cfg(target_os = "macos")]
    {
        return open_media_with_default_app_macos(target);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return open_media_with_default_app_linux(target);
    }

    #[allow(unreachable_code)]
    Err(AppError::Message(
        "Media playback is not supported on this platform".to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn open_media_with_default_app_windows(target: &Path) -> AppResult<()> {
    let quoted_path = format!("\"{}\"", target.to_string_lossy().replace('"', "\"\""));
    Command::new("cmd")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg(quoted_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Process(err.to_string()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_media_with_default_app_macos(target: &Path) -> AppResult<()> {
    Command::new("open")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Process(err.to_string()))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_media_with_default_app_linux(target: &Path) -> AppResult<()> {
    Command::new("xdg-open")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Process(err.to_string()))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_in_file_manager_windows(path: &Path) -> AppResult<()> {
    let status = if path.is_file() {
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .status()
            .map_err(|err| AppError::Process(err.to_string()))?
    } else {
        Command::new("explorer")
            .arg(path)
            .status()
            .map_err(|err| AppError::Process(err.to_string()))?
    };

    if !status.success() {
        return Err(AppError::Process(
            "Failed to open the file manager".to_string(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_file_manager_macos(path: &Path) -> AppResult<()> {
    let mut command = Command::new("open");
    if path.is_file() {
        command.arg("-R").arg(path);
    } else {
        command.arg(path);
    }
    let status = command
        .status()
        .map_err(|err| AppError::Process(err.to_string()))?;
    if !status.success() {
        return Err(AppError::Process(
            "Failed to open the file manager".to_string(),
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager_linux(path: &Path) -> AppResult<()> {
    let directory = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let status = Command::new("xdg-open")
        .arg(directory)
        .status()
        .map_err(|err| AppError::Process(err.to_string()))?;
    if !status.success() {
        return Err(AppError::Process(
            "Failed to open the file manager".to_string(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn pick_directory_windows(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.ShowNewFolderButton = $true
$dialog.Description = 'Select download folder'
if ($env:PULLDOWN_INITIAL_DIR -and (Test-Path $env:PULLDOWN_INITIAL_DIR)) {
  $dialog.SelectedPath = $env:PULLDOWN_INITIAL_DIR
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
"#;

    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", script]);
    if let Some(initial) = initial_dir {
        if !initial.as_os_str().is_empty() {
            command.env(
                "PULLDOWN_INITIAL_DIR",
                initial.to_string_lossy().to_string(),
            );
        }
    }

    let output = command
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Process(if stderr.is_empty() {
            "Failed to open folder picker".to_string()
        } else {
            stderr
        }));
    }

    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected)))
    }
}

#[cfg(target_os = "macos")]
fn pick_directory_macos(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let mut script = String::from("set chosenFolder to POSIX path of (choose folder");
    if let Some(initial) = initial_dir {
        if !initial.as_os_str().is_empty() {
            script.push_str(&format!(
                " default location POSIX file \"{}\"",
                initial.display()
            ));
        }
    }
    script.push_str(")\nreturn chosenFolder");

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("user canceled") {
            return Ok(None);
        }
        return Err(AppError::Process(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected)))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_directory_linux(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let mut zenity = Command::new("zenity");
    zenity.args(["--file-selection", "--directory"]);
    if let Some(initial) = initial_dir {
        zenity.arg("--filename").arg(initial);
    }
    let output = zenity.output();

    match output {
        Ok(out) if out.status.success() => {
            let selected = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if selected.is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(selected)))
            }
        }
        _ => Err(AppError::Message(
            "No supported folder picker found (expected zenity)".to_string(),
        )),
    }
}
