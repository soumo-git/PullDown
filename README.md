<div align="center">

<img src="src\assets\pulldown.png" width="80" alt="Pulldown icon" />

# **Pulldown**

**Free, open-source video downloader & converter.**

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri-orange)

</div>

Pulldown is a desktop GUI wrapper around [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/). Download videos from YouTube, Vimeo, Twitter, Reddit, and [1000+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) at full quality. Convert any local video or audio file to any format.

> *No subscriptions. No watermarks. No tracking. Full authority over format and quality.*

## Features
 
### ⇓ Downloader
- **Highest quality downloads:** 4K VP9, AV1, H.264, HEVC; video + audio muxed via ffmpeg
- **Format picker:** choose resolution, codec, and audio bitrate per download
- **Download queue:** parallel downloads with pause, resume, cancel
- **In-app browser:** browse platforms and hit "Download This" on any video page
 
### ⇆ Converter
- **Any format ⇆ any format:** mp4, mkv, mov, webm, mp3, flac, opus, gif, and more
- **Quality presets:** High / Balanced / Small File, or fully custom
- **Advanced mode:** live ffmpeg command preview, you see exactly what runs
- **100% local:** files never leave your machine
 
### ⚙ General
- **Replaceable engines:** yt-dlp and ffmpeg are swappable sidecars; update independently from the app
- **Engine update notifications:** you decide when to update, no silent replacements
- **Library view:** browse and play downloaded and converted files
- **Cross-platform:** Windows, macOS, Linux
 
## Supported Formats
 
| Category | Formats |
|---|---|
| Video containers | All video containers |
| Video codecs | All video codecs |
| Audio | All audio formats |
| Image sequences | All image sequence formats |
| Subtitles | All subtitle formats |
 
> ***If ffmpeg supports it, Pulldown can convert it.***

## Tech Stack

| Layer | Tech |
|---|---|
| Shell | Tauri (Rust) |
| Frontend | Vanilla HTML + CSS + JS |
| Engines | yt-dlp + ffmpeg (bundled sidecars) |
| IPC | Tauri commands + events |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Install & Run

```bash
git clone https://github.com/yourusername/pulldown.git
cd pulldown
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

Outputs platform-native installers to `src-tauri/target/release/bundle/`.

## Engine Updates

Pulldown ships with pinned versions of yt-dlp and ffmpeg. When a new version is detected, the app notifies, you choose when to update. No silent background replacements.

To update manually: **Settings → Engine Management → Check for Updates**

## Legal

Pulldown is a GUI tool. It does not host, distribute, or cache any copyrighted content.

Downloading copyrighted material without authorization may violate the Terms of Service of the platform and applicable law. **You are solely responsible for how you use this tool.**

This project is not affiliated with YouTube, Google, or any media platform.

### License

MIT © 2025 — see [LICENSE](LICENSE)

<div align="center">
  <sub>Built with yt-dlp · ffmpeg · Tauri</sub>
</div>