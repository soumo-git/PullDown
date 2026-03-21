# PullDown — In-App Player Architecture

## Current State (HTTP Server Approach)

### Flow

```
User pastes YouTube URL
        │
        ▼
  yt-dlp (JSON info)  →  videoUrl + audioUrl  (YouTube CDN)
        │
        ▼
  ffmpeg transcode → growing fMP4 on disk  (cache/player-live-cache/)
        │             writes 0.5s fragments progressively
        │
        ▼
  Local HTTP server (127.0.0.1:PORT)
        │  serves growing file with Range request support
        │  blocks/polls when browser requests bytes not yet written
        │
        ▼
  HTML5 <video src="http://127.0.0.1:PORT/stream/{id}">
        │  Webview2 makes standard HTTP Range requests
        │
        ▼
  User sees video start in ~3–5s
```

### Files Involved

| File | Role |
|---|---|
| [src-tauri/src/infrastructure/player_live.rs](file:///d:/PullDown/src-tauri/src/infrastructure/player_live.rs) | yt-dlp info extraction, ffmpeg spawn, stream registration |
| [src-tauri/src/infrastructure/stream_server.rs](file:///d:/PullDown/src-tauri/src/infrastructure/stream_server.rs) | Local HTTP server, Range request handler, blocking poll |
| [src/scripts/app.js](file:///d:/PullDown/src/scripts/app.js) → [openInAppPlayer()](file:///d:/PullDown/src/scripts/app.js#570-822) | Sets `<video>.src`, handles player controls |
| [src-tauri/tauri.conf.json](file:///d:/PullDown/src-tauri/tauri.conf.json) | CSP: `media-src http://127.0.0.1:*` |

---

## Known Issues (Fundamental Limitations)

### 1. Seek Forward / Backward is Broken

**Symptom**: Clicking the seek bar to jump forward does nothing, or hangs.

**Root cause**:
- ffmpeg starts transcoding from `t=0` and writes frames sequentially to disk.
- After 5 minutes of playback, ffmpeg has written roughly 5 minutes of data.
- If the user seeks to minute 30, the browser sends `Range: bytes=X` for byte offset ~30min worth of data.
- The HTTP server **blocks**, polling the file for those bytes.
- ffmpeg takes ~25 real minutes to reach that offset.
- From the user's perspective: seek hangs indefinitely.

**Not fixable** without either: (a) fully downloading before playing, or (b) using a player that speaks directly to the CDN.

### 2. Pause → Resume Stops at Last Written Chunk

**Symptom**: After pausing, playback resumes but stops shortly after at the same point it was when pausing began (or shortly ahead of it).

**Root cause**:
- On resume, Webview2 sends a new Range request from `currentTime`.
- If the user paused at minute 8 and ffmpeg has only written to minute 8.2, the new request gets served up to minute 8.2 then blocks.
- The stall timeout (30s) eventually closes the connection.
- Browser fires `ended` or stalls indefinitely.

### 3. Duration is Unknown (Infinity)

**Symptom**: The progress bar shows no total duration; timeline scrubbing is disabled.

**Root cause**:
- fMP4 with `empty_moov` correctly signals a live/growing stream → `duration = Infinity`.
- The browser cannot display a finite duration or allow scrubbing to arbitrary positions.
- Only partial fix possible (report file size ÷ bitrate estimate), which is inaccurate.

### 4. Re-encode Quality Loss

- ffmpeg re-encodes video to H.264 (`crf=18 preset=veryfast`).
- Original YouTube streams may be VP9/AV1 at higher quality.
- Transcoding adds 3–5s startup latency plus CPU load.

---

## Root Cause Summary

The HTTP server approach is the **Webview2 adapter** — it gives the browser's `<video>` element the same HTTP Range interface that ExoPlayer uses against YouTube's CDN. But because ffmpeg writes data linearly from `t=0`, the adapter can only serve data that has already been written. This makes seeking to unwritten positions impossible without waiting for real-time.

---

## Migration Plan: libmpv for URL-Based Playback

### New Flow (URL Extraction)

```
User pastes YouTube URL
        │
        ▼
  yt-dlp (JSON info)  →  videoUrl + audioUrl  (YouTube CDN, expires in ~6h)
        │
        ▼
  libmpv.loadfile(videoUrl, { options: { 'audio-file': audioUrl } })
        │  mpv opens HTTP range requests to YouTube CDN directly
        │  Seek = new Range request at that byte offset → instant
        │  Duration = read from stream headers → real value shown
        │  Pause/resume = pause HTTP reads, resume from same offset
        │
        ▼
  mpv renders video into Tauri HWND (transparent overlay behind Webview)
  HTML controls float above: play/pause, seek bar, volume, title
```

### Why This Solves Everything

| Issue | HTTP Server | libmpv |
|---|---|---|
| Seek forward/backward | ❌ Blocks until ffmpeg writes | ✅ Instant CDN range request |
| Pause → resume | ⚠️ Limited to written data | ✅ Perfect |
| Duration shown | ❌ Infinity | ✅ Real duration from stream |
| All formats | ✅ ffmpeg converts | ✅ Native (no conversion) |
| Quality | ⚠️ Re-encoded | ✅ Original codec, lossless |
| Startup latency | ~3–5s (ffmpeg startup) | ~1–2s (stream open) |

### Architecture After Migration

```
openInAppPlayer()
    │
    ├── if extractUrl (YouTube/web URL)
    │       ├── yt-dlp → videoUrl + audioUrl
    │       └── libmpv.loadfile(videoUrl, audioUrl)  ← NEW
    │               Controls: play/pause/seek via libmpv IPC
    │
    └── if mediaPath (local file)
            └── libmpv.loadfile(localPath)  ← ALSO uses mpv (best quality)
                OR existing prepare_media_for_playback path
```

### Files to Add/Change

| File | Change |
|---|---|
| [src-tauri/Cargo.toml](file:///d:/PullDown/src-tauri/Cargo.toml) | Add `tauri-plugin-libmpv` |
| [src-tauri/tauri.conf.json](file:///d:/PullDown/src-tauri/tauri.conf.json) | `transparent: true`, bundle `lib/**` |
| `src-tauri/lib/libmpv-2.dll` | **New** (download from zhongfly builds) |
| `src-tauri/lib/libmpv-wrapper.dll` | **New** (download from nini22P releases) |
| [src/scripts/app.js](file:///d:/PullDown/src/scripts/app.js) | Replace `<video>` for URL sources with mpv commands |
| [src-tauri/src/infrastructure/player_live.rs](file:///d:/PullDown/src-tauri/src/infrastructure/player_live.rs) | Simplified: yt-dlp info only, no ffmpeg |
| [src-tauri/src/infrastructure/stream_server.rs](file:///d:/PullDown/src-tauri/src/infrastructure/stream_server.rs) | **Remove** (no longer needed for URL sources) |
| [src-tauri/src/lib.rs](file:///d:/PullDown/src-tauri/src/lib.rs) | Remove stream_server init |

### What Stays the Same

- Download queue, library scan, settings — untouched
- [app_prepare_media_for_playback](file:///d:/PullDown/src-tauri/src/app/commands.rs#176-193) for local files — can keep or migrate to mpv later
- yt-dlp extraction ([run_ytdlp_info](file:///d:/PullDown/src-tauri/src/infrastructure/player_live.rs#130-173)) — stays, returns URLs for mpv
- UI/CSS — player controls stay as HTML; only `<video>` element replaced with a transparent `<div>` render target

---

## Implementation Progress

- [x] HTTP server approach implemented (deprecated by this migration)
- [ ] Download `libmpv-2.dll` + `libmpv-wrapper.dll` into `src-tauri/lib/`
- [ ] `npm run tauri add libmpv`
- [ ] Configure `transparent: true` + bundle resources
- [ ] Wire mpv init in frontend
- [ ] Replace [openInAppPlayer](file:///d:/PullDown/src/scripts/app.js#570-822) URL path to use mpv
- [ ] Wire player controls (play/pause/seek/volume) to mpv IPC
- [ ] Remove HTTP server + ffmpeg streaming from [player_live.rs](file:///d:/PullDown/src-tauri/src/infrastructure/player_live.rs)
- [ ] Test with 1.5h YouTube video: seek, pause/resume, duration display
