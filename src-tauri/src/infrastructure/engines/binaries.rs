use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::core::errors::{AppError, AppResult};

#[cfg(target_os = "windows")]
use super::FFMPEG_WINDOWS_ZIP_URL;
use super::{
    download_binary_with_progress, download_text, ensure_executable, fetch_latest_ffmpeg_release,
    normalize_version, YT_DLP_RELEASE_DOWNLOAD_BASE,
};

pub(crate) fn detect_current_ytdlp_version(path: &Path) -> AppResult<String> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;
    if !output.status.success() {
        return Err(AppError::Process(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(normalize_version)
        .unwrap_or_else(|| "unknown".to_string());
    Ok(version)
}

pub(crate) fn detect_ffmpeg_version(path: &Path) -> AppResult<String> {
    let output = Command::new(path)
        .arg("-version")
        .output()
        .map_err(|err| AppError::Process(err.to_string()))?;
    if !output.status.success() {
        return Err(AppError::Process(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|entry| !entry.trim().is_empty())
        .map(|entry| entry.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(line)
}

#[cfg(target_os = "windows")]
pub(crate) fn install_ffmpeg_binary_with_progress<F>(
    target: &Path,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(u64, Option<u64>),
{
    let sources = ffmpeg_windows_download_sources();
    let mut last_err: Option<AppError> = None;

    for (index, source_url) in sources.iter().enumerate() {
        engine_log!(
            "INFO",
            "install_ffmpeg_binary: start target={} source[{}/{}]={}",
            target.display(),
            index + 1,
            sources.len(),
            source_url
        );

        match download_binary_with_progress(source_url, &mut on_progress) {
            Ok(archive) => {
                engine_log!(
                    "INFO",
                    "install_ffmpeg_binary: archive downloaded bytes={} source={}",
                    archive.len(),
                    source_url
                );
                let ffmpeg = extract_ffmpeg_from_windows_zip(&archive)?;
                engine_log!(
                    "INFO",
                    "install_ffmpeg_binary: ffmpeg.exe extracted bytes={} source={}",
                    ffmpeg.len(),
                    source_url
                );
                return atomic_replace_ffmpeg_binary(target, &ffmpeg);
            }
            Err(err) => {
                engine_log!(
                    "WARN",
                    "install_ffmpeg_binary: source failed source={} err={}",
                    source_url,
                    err.user_message()
                );
                last_err = Some(err);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        AppError::Process("Failed to download ffmpeg from all configured sources".to_string())
    }))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_ffmpeg_binary_with_progress<F>(
    _target: &Path,
    _on_progress: F,
) -> AppResult<()>
where
    F: FnMut(u64, Option<u64>),
{
    engine_log!(
        "ERROR",
        "install_ffmpeg_binary_with_progress: called on unsupported non-Windows target"
    );
    Err(AppError::Message(
        "Automatic ffmpeg installation is currently implemented for Windows builds only"
            .to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn extract_ffmpeg_from_windows_zip(bytes: &[u8]) -> AppResult<Vec<u8>> {
    use std::io::{Cursor, Read};

    engine_log!(
        "INFO",
        "extract_ffmpeg_from_windows_zip: opening archive bytes={}",
        bytes.len()
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| AppError::Process(format!("Failed to read ffmpeg archive: {err}")))?;
    engine_log!(
        "INFO",
        "extract_ffmpeg_from_windows_zip: entries={}",
        archive.len()
    );

    for idx in 0..archive.len() {
        let mut file = archive
            .by_index(idx)
            .map_err(|err| AppError::Process(format!("Failed to inspect ffmpeg archive: {err}")))?;
        let path = file.name().replace('\\', "/").to_ascii_lowercase();
        if !path.ends_with("/bin/ffmpeg.exe") {
            continue;
        }
        engine_log!(
            "INFO",
            "extract_ffmpeg_from_windows_zip: found ffmpeg entry path={}",
            path
        );

        let mut extracted = Vec::<u8>::new();
        file.read_to_end(&mut extracted)
            .map_err(|err| AppError::Process(format!("Failed to extract ffmpeg.exe: {err}")))?;
        return Ok(extracted);
    }

    Err(AppError::Process(
        "Downloaded ffmpeg archive did not contain ffmpeg.exe".to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn ffmpeg_windows_download_sources() -> Vec<String> {
    let mut sources = Vec::<String>::new();

    match fetch_latest_ffmpeg_release() {
        Ok(release) => {
            if let Some(url) = release
                .assets
                .iter()
                .find(|asset| asset.name.ends_with("essentials_build.zip"))
                .map(|asset| asset.browser_download_url.clone())
            {
                engine_log!(
                    "INFO",
                    "ffmpeg_windows_download_sources: selected github asset {} for tag={}",
                    url,
                    release.tag_name
                );
                sources.push(url);
            } else {
                engine_log!(
                    "WARN",
                    "ffmpeg_windows_download_sources: no essentials zip asset found in github release tag={}",
                    release.tag_name
                );
            }
        }
        Err(err) => {
            engine_log!(
                "WARN",
                "ffmpeg_windows_download_sources: failed to fetch github release metadata: {}",
                err.user_message()
            );
        }
    }

    sources.push(FFMPEG_WINDOWS_ZIP_URL.to_string());
    engine_log!(
        "INFO",
        "ffmpeg_windows_download_sources: fallback source {}",
        FFMPEG_WINDOWS_ZIP_URL
    );
    sources
}

pub(crate) fn validate_release_checksum(
    tag_name: &str,
    asset_name: &str,
    bytes: &[u8],
) -> AppResult<()> {
    let checksum_url = format!("{YT_DLP_RELEASE_DOWNLOAD_BASE}/{tag_name}/SHA2-256SUMS");
    let checksums = match download_text(&checksum_url) {
        Ok(text) => text,
        Err(_) => return Ok(()),
    };

    let Some(expected) = find_checksum_for_asset(&checksums, asset_name) else {
        return Ok(());
    };

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = format!("{:x}", hasher.finalize());
    if digest != expected.to_lowercase() {
        return Err(AppError::Process(
            "Downloaded yt-dlp checksum mismatch".to_string(),
        ));
    }
    Ok(())
}

fn find_checksum_for_asset(content: &str, asset_name: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        if file == asset_name {
            return Some(hash.to_string());
        }
    }
    None
}

pub(crate) fn atomic_replace_binary(target: &Path, content: &[u8]) -> AppResult<()> {
    engine_log!(
        "INFO",
        "atomic_replace_binary: target={} bytes={}",
        target.display(),
        content.len()
    );
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("Engine binary target path is invalid".to_string()))?;
    fs::create_dir_all(parent)?;

    let tmp = target.with_extension("new");
    let backup = target.with_extension("bak");

    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }

    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content)?;
        file.flush()?;
    }
    ensure_executable(&tmp)?;

    let mut moved_original = false;
    if target.exists() {
        fs::rename(target, &backup)?;
        moved_original = true;
    }

    if let Err(err) = fs::rename(&tmp, target) {
        if moved_original && backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Process(format!(
            "Failed to replace yt-dlp binary: {err}"
        )));
    }

    if let Err(err) = detect_current_ytdlp_version(target) {
        let _ = fs::remove_file(target);
        if moved_original && backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(AppError::Process(format!(
            "Installed yt-dlp validation failed: {}",
            err.user_message()
        )));
    }

    if moved_original && backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn atomic_replace_ffmpeg_binary(target: &Path, content: &[u8]) -> AppResult<()> {
    engine_log!(
        "INFO",
        "atomic_replace_ffmpeg_binary: target={} bytes={}",
        target.display(),
        content.len()
    );
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Message("Engine binary target path is invalid".to_string()))?;
    fs::create_dir_all(parent)?;

    let tmp = target.with_extension("new");
    let backup = target.with_extension("bak");

    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }

    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content)?;
        file.flush()?;
    }
    ensure_executable(&tmp)?;

    let mut moved_original = false;
    if target.exists() {
        fs::rename(target, &backup)?;
        moved_original = true;
    }

    if let Err(err) = fs::rename(&tmp, target) {
        if moved_original && backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Process(format!(
            "Failed to replace ffmpeg binary: {err}"
        )));
    }

    if let Err(err) = detect_ffmpeg_version(target) {
        let _ = fs::remove_file(target);
        if moved_original && backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(AppError::Process(format!(
            "Installed ffmpeg validation failed: {}",
            err.user_message()
        )));
    }

    if moved_original && backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}
