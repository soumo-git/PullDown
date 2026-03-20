use std::io::Read;
use std::time::{Duration, Instant};

use crate::core::errors::{AppError, AppResult};

use super::{
    GithubRelease, FFMPEG_RELEASE_API, HTTP_TIMEOUT_BINARY_SECS, HTTP_TIMEOUT_METADATA_SECS,
    HTTP_USER_AGENT, YT_DLP_RELEASE_API,
};

fn http_client(timeout_secs: u64) -> AppResult<reqwest::blocking::Client> {
    engine_log!(
        "INFO",
        "http_client: building client with timeout={}s",
        timeout_secs
    );
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::Process(err.to_string()))
}

pub(crate) fn fetch_latest_ytdlp_release() -> AppResult<GithubRelease> {
    fetch_latest_release("fetch_latest_ytdlp_release", YT_DLP_RELEASE_API)
}

pub(crate) fn fetch_latest_ffmpeg_release() -> AppResult<GithubRelease> {
    fetch_latest_release("fetch_latest_ffmpeg_release", FFMPEG_RELEASE_API)
}

pub(crate) fn download_binary(url: &str) -> AppResult<Vec<u8>> {
    download_binary_with_progress(url, |_, _| {})
}

pub(crate) fn download_binary_with_progress<F>(url: &str, mut on_progress: F) -> AppResult<Vec<u8>>
where
    F: FnMut(u64, Option<u64>),
{
    const MAX_ATTEMPTS: usize = 2;
    let mut last_err: Option<AppError> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        engine_log!(
            "INFO",
            "download_binary: attempt={}/{} GET {}",
            attempt,
            MAX_ATTEMPTS,
            url
        );

        match download_binary_once_with_progress(url, &mut on_progress) {
            Ok(bytes) => {
                engine_log!(
                    "INFO",
                    "download_binary: completed url={} bytes={}",
                    url,
                    bytes.len()
                );
                return Ok(bytes);
            }
            Err(err) => {
                engine_log!(
                    "ERROR",
                    "download_binary: attempt={}/{} failed url={} err={}",
                    attempt,
                    MAX_ATTEMPTS,
                    url,
                    err.user_message()
                );
                last_err = Some(err);
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        AppError::Process("download_binary failed without specific error".to_string())
    }))
}

pub(crate) fn download_text(url: &str) -> AppResult<String> {
    engine_log!("INFO", "download_text: GET {}", url);
    let client = http_client(HTTP_TIMEOUT_METADATA_SECS)?;
    let response = client
        .get(url)
        .header("User-Agent", HTTP_USER_AGENT)
        .send()
        .map_err(|err| {
            engine_log!(
                "ERROR",
                "download_text: request failed url={} err={}",
                url,
                err
            );
            AppError::Process(err.to_string())
        })?;

    let status = response.status();
    let response = response.error_for_status().map_err(|err| {
        engine_log!(
            "ERROR",
            "download_text: non-success response url={} status={} err={}",
            url,
            status,
            err
        );
        AppError::Process(err.to_string())
    })?;

    response.text().map_err(|err| {
        engine_log!(
            "ERROR",
            "download_text: body decode failed url={} err={}",
            url,
            err
        );
        AppError::Process(err.to_string())
    })
}

fn download_binary_once_with_progress<F>(url: &str, on_progress: &mut F) -> AppResult<Vec<u8>>
where
    F: FnMut(u64, Option<u64>),
{
    let client = http_client(HTTP_TIMEOUT_BINARY_SECS)?;
    let response = client
        .get(url)
        .header("User-Agent", HTTP_USER_AGENT)
        .header("Accept-Encoding", "identity")
        .send()
        .map_err(|err| {
            engine_log!(
                "ERROR",
                "download_binary_once: request failed url={} err={} chain={}",
                url,
                err,
                error_chain(&err)
            );
            AppError::Process(err.to_string())
        })?;

    let status = response.status();
    let mut response = response.error_for_status().map_err(|err| {
        engine_log!(
            "ERROR",
            "download_binary_once: non-success response url={} status={} err={} chain={}",
            url,
            status,
            err,
            error_chain(&err)
        );
        AppError::Process(err.to_string())
    })?;

    let content_length = response.content_length().unwrap_or(0);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<unknown>");
    let content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>");
    let content_length_opt = response.content_length();
    engine_log!(
        "INFO",
        "download_binary_once: response headers url={} content_length={} content_type={} content_encoding={}",
        url,
        content_length,
        content_type,
        content_encoding
    );

    let mut buf = Vec::<u8>::with_capacity(content_length_opt.unwrap_or(0) as usize);
    let mut chunk = [0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let started_at = Instant::now();
    let mut last_progress_emit = Instant::now()
        .checked_sub(Duration::from_millis(500))
        .unwrap_or_else(Instant::now);
    let mut last_speed_log_at = Instant::now();
    let mut last_speed_log_bytes = 0u64;

    on_progress(downloaded, content_length_opt);

    loop {
        let n = response.read(&mut chunk).map_err(|err| {
            engine_log!(
                "ERROR",
                "download_binary_once: streamed read failed url={} downloaded={} err={} chain={}",
                url,
                downloaded,
                err,
                error_chain(&err)
            );
            AppError::Process(err.to_string())
        })?;

        if n == 0 {
            break;
        }

        buf.extend_from_slice(&chunk[..n]);
        downloaded += n as u64;

        let should_emit = last_progress_emit.elapsed() >= Duration::from_millis(250)
            || content_length_opt
                .map(|total| downloaded >= total)
                .unwrap_or(false);
        if should_emit {
            on_progress(downloaded, content_length_opt);
            last_progress_emit = Instant::now();
        }

        if last_speed_log_at.elapsed() >= Duration::from_secs(2) {
            let delta_bytes = downloaded.saturating_sub(last_speed_log_bytes);
            let seconds = last_speed_log_at.elapsed().as_secs_f64().max(0.001);
            let speed_bps = delta_bytes as f64 / seconds;
            engine_log!(
                "INFO",
                "download_binary_once: progress url={} downloaded={} total={} speed_kib_s={:.2}",
                url,
                downloaded,
                content_length_opt.unwrap_or(0),
                speed_bps / 1024.0
            );
            last_speed_log_at = Instant::now();
            last_speed_log_bytes = downloaded;
        }
    }

    on_progress(downloaded, content_length_opt);

    let total_seconds = started_at.elapsed().as_secs_f64().max(0.001);
    let average_speed_bps = downloaded as f64 / total_seconds;
    engine_log!(
        "INFO",
        "download_binary_once: complete url={} downloaded={} elapsed_s={:.2} avg_speed_kib_s={:.2}",
        url,
        downloaded,
        total_seconds,
        average_speed_bps / 1024.0
    );

    Ok(buf)
}

fn fetch_latest_release(label: &str, url: &str) -> AppResult<GithubRelease> {
    engine_log!("INFO", "{}: GET {}", label, url);
    let client = http_client(HTTP_TIMEOUT_METADATA_SECS)?;
    let response = client
        .get(url)
        .header("User-Agent", HTTP_USER_AGENT)
        .send()
        .map_err(|err| {
            engine_log!("ERROR", "{}: request failed: {}", label, err);
            AppError::Process(err.to_string())
        })?;

    let status = response.status();
    engine_log!("INFO", "{}: response status={}", label, status);
    let response = response.error_for_status().map_err(|err| {
        engine_log!("ERROR", "{}: non-success response: {}", label, err);
        AppError::Process(err.to_string())
    })?;

    response.json::<GithubRelease>().map_err(|err| {
        engine_log!("ERROR", "{}: decode failed: {}", label, err);
        AppError::Process(err.to_string())
    })
}

fn error_chain(err: &dyn std::error::Error) -> String {
    let mut chain = Vec::<String>::new();
    let mut current = err.source();
    while let Some(src) = current {
        chain.push(src.to_string());
        current = src.source();
    }
    if chain.is_empty() {
        "<none>".to_string()
    } else {
        chain.join(" | ")
    }
}
