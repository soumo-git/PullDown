# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for stable releases.

## [Unreleased]

### Added
- `CHANGELOG.md` for release transparency.
- `CODE_OF_CONDUCT.md` for contributor/community standards.

## [0.1.0-beta.1] - 2026-03-22

### Added
- First Windows NSIS installer pre-release (`PULLDOWN_0.1.0_x64-setup.exe`).
- Managed engine installation/update flow for `yt-dlp` and `ffmpeg`.
- Integrated in-app playback baseline with bundled VLC resources.

### Changed
- Download and playback pipeline hardening for engine-managed workflows.
- Windows background jobs now run without command window flicker.

### Notes
- This is a pre-release focused on validating the core download engine and playback baseline.
- Mainline UX and platform hardening work continues in subsequent iterations.
