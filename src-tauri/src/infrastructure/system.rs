use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::core::errors::{AppError, AppResult};
use crate::infrastructure::process::CommandBackgroundExt;

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

pub fn pick_media_file(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    #[cfg(target_os = "windows")]
    {
        return pick_media_file_windows(initial_dir);
    }

    #[cfg(target_os = "macos")]
    {
        return pick_media_file_macos(initial_dir);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return pick_media_file_linux(initial_dir);
    }

    #[allow(unreachable_code)]
    Err(AppError::Message(
        "File picker is not supported on this platform".to_string(),
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

pub fn play_with_libvlc(
    source: &str,
    is_url: bool,
    preferred_vlc_path: Option<&Path>,
) -> AppResult<Child> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AppError::Message(
            "Playback source cannot be empty".to_string(),
        ));
    }

    let source_arg = if is_url {
        trimmed.to_string()
    } else {
        let target = PathBuf::from(trimmed);
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
        target.to_string_lossy().to_string()
    };

    let mut last_error: Option<String> = None;
    for candidate in vlc_command_candidates(preferred_vlc_path) {
        let mut command = if let Some(path) = candidate.as_ref() {
            Command::new(path)
        } else {
            Command::new("vlc")
        };
        command.for_background_job();

        command
            .arg("--no-video-title-show")
            .arg("--no-qt-privacy-ask")
            .arg("--no-qt-error-dialogs")
            .arg("--qt-start-minimized")
            .arg(&source_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(err) => {
                last_error = Some(format!(
                    "{} ({})",
                    candidate
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|| "vlc".to_string()),
                    err
                ));
            }
        }
    }

    Err(AppError::Process(format!(
        "Unable to start libVLC player. {}",
        last_error.unwrap_or_else(|| "No VLC executable candidate was available".to_string())
    )))
}

pub fn stop_spawned_player(child: Option<&mut Child>) -> AppResult<()> {
    if let Some(process) = child {
        let _ = process.kill();
        let _ = process.wait();
    }
    Ok(())
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

fn vlc_command_candidates(preferred_vlc_path: Option<&Path>) -> Vec<Option<PathBuf>> {
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();

    if let Some(path) = preferred_vlc_path {
        if path.exists() {
            candidates.push(Some(path.to_path_buf()));
        }
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            #[cfg(target_os = "windows")]
            {
                let direct = exe_dir.join("vlc.exe");
                if direct.exists() {
                    candidates.push(Some(direct));
                }
                let nested = exe_dir.join("vlc").join("vlc.exe");
                if nested.exists() {
                    candidates.push(Some(nested));
                }
            }

            #[cfg(target_os = "macos")]
            {
                let macos_bin = exe_dir.join("vlc");
                if macos_bin.exists() {
                    candidates.push(Some(macos_bin));
                }
            }

            #[cfg(all(unix, not(target_os = "macos")))]
            {
                let linux_bin = exe_dir.join("vlc");
                if linux_bin.exists() {
                    candidates.push(Some(linux_bin));
                }
            }
        }
    }

    if let Ok(raw) = env::var("PULLDOWN_VLC_PATH") {
        let path = PathBuf::from(raw.trim());
        if path.exists() {
            candidates.push(Some(path));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(program_files) = env::var("ProgramFiles") {
            let path = PathBuf::from(program_files)
                .join("VideoLAN")
                .join("VLC")
                .join("vlc.exe");
            if path.exists() {
                candidates.push(Some(path));
            }
        }
        if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
            let path = PathBuf::from(program_files_x86)
                .join("VideoLAN")
                .join("VLC")
                .join("vlc.exe");
            if path.exists() {
                candidates.push(Some(path));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let app_bundle = PathBuf::from("/Applications/VLC.app/Contents/MacOS/VLC");
        if app_bundle.exists() {
            candidates.push(Some(app_bundle));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let linux_path = PathBuf::from("/usr/bin/vlc");
        if linux_path.exists() {
            candidates.push(Some(linux_path));
        }
    }

    // Final fallback: resolve through PATH.
    candidates.push(None);
    candidates
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
        .for_background_job()
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
        .for_background_job()
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
    Command::new("explorer")
        .for_background_job()
        .arg(target)
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
        .for_background_job()
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
        .for_background_job()
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
            .for_background_job()
            .arg("/select,")
            .arg(path)
            .status()
            .map_err(|err| AppError::Process(err.to_string()))?
    } else {
        Command::new("explorer")
            .for_background_job()
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
    command.for_background_job();
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
        .for_background_job()
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

fn decode_picker_stdout(bytes: &[u8]) -> String {
    let utf8 = String::from_utf8_lossy(bytes).to_string();
    let mut decoded = if utf8.contains('\u{0}') {
        decode_utf16le(bytes).unwrap_or(utf8)
    } else {
        utf8
    };
    decoded = decoded.replace('\u{feff}', "");
    decoded
        .replace('\u{0}', "")
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_matches('"')
        .to_string()
}

fn decode_utf16le(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 {
        return None;
    }
    let even_len = bytes.len() - (bytes.len() % 2);
    let mut units = Vec::<u16>::with_capacity(even_len / 2);
    for chunk in bytes[..even_len].chunks_exact(2) {
        units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    String::from_utf16(&units).ok()
}

#[cfg(target_os = "windows")]
fn pick_directory_windows(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
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
    command.for_background_job();
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

    let selected = decode_picker_stdout(&output.stdout);
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
        .for_background_job()
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
    zenity.for_background_job();
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

#[cfg(target_os = "windows")]
fn pick_media_file_windows(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = 'Media Files|*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.flv;*.ts;*.mpg;*.mpeg;*.ogv;*.wmv;*.3gp;*.mp3;*.m4a;*.aac;*.wav;*.flac;*.ogg;*.opus;*.wma;*.ac3;*.mp2;*.alac;*.mka;*.aiff;*.aif;*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.tiff;*.tif;*.tga;*.ico;*.jp2;*.avif|All Files|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.Title = 'Select media file'
if ($env:PULLDOWN_INITIAL_DIR -and (Test-Path $env:PULLDOWN_INITIAL_DIR)) {
  $dialog.InitialDirectory = $env:PULLDOWN_INITIAL_DIR
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
"#;

    let mut command = Command::new("powershell");
    command.for_background_job();
    command.args(["-NoProfile", "-STA", "-Command", script]);
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
            "Failed to open media picker".to_string()
        } else {
            stderr
        }));
    }

    let selected = decode_picker_stdout(&output.stdout);
    if selected.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected)))
    }
}

#[cfg(target_os = "macos")]
fn pick_media_file_macos(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let mut script = String::from("set pickedFile to POSIX path of (choose file");
    if let Some(initial) = initial_dir {
        if !initial.as_os_str().is_empty() {
            script.push_str(&format!(
                " default location POSIX file \"{}\"",
                initial.display()
            ));
        }
    }
    script.push_str(")\nreturn pickedFile");

    let output = Command::new("osascript")
        .for_background_job()
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
fn pick_media_file_linux(initial_dir: Option<&Path>) -> AppResult<Option<PathBuf>> {
    let mut zenity = Command::new("zenity");
    zenity.for_background_job();
    zenity.args(["--file-selection", "--title=Select media file"]);
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
            "No supported file picker found (expected zenity)".to_string(),
        )),
    }
}
