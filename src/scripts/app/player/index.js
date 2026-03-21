/**
 * player/index.js - Native player runtime and interactions.
 * Active backend: libVLC launcher.
 */

import { navigateTo } from '../../router.js';
import { state, stateEmitter } from '../../state.js';
import { invokeCommand, isTauriEnvironment, listenEvent } from '../../tauriApi.js';

const PLAYER_ICON_PLAY = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
  <path d="M8 6l10 6-10 6V6z" fill="currentColor"/>
</svg>`;
const PLAYER_ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
  <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor"/>
  <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor"/>
</svg>`;
const PLAYER_ICON_VOLUME = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
  <path d="M4 10h4l5-4v12l-5-4H4v-4z" fill="currentColor"/>
  <path d="M16 9a4.5 4.5 0 010 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;
const PLAYER_ICON_MUTED = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
  <path d="M4 10h4l5-4v12l-5-4H4v-4z" fill="currentColor"/>
  <path d="M16 9l4 6M20 9l-4 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'alac', 'aiff', 'aif', 'mka', 'amr',
  'ac3', 'dts', 'ape', 'm4b',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'ogv', 'ts',
  'm2ts', 'mts', 'vob', 'rmvb', 'f4v',
]);

let playerCurrentPath = '';
const PLAYER_BACKEND = 'libvlc';
const MPV_WINDOW_LABEL = 'main';
const MPV_MIN_VIEWPORT_PIXELS = 24;
const MPV_VIEWPORT_EPSILON = 0.0001;
const MPV_OBSERVED_PROPERTIES = {
  pause: 'flag',
  'time-pos': 'double',
  duration: 'double',
  volume: 'double',
  mute: 'flag',
  aid: 'int64',
  vid: 'int64',
  ao: 'string',
  vo: 'string',
  'audio-codec-name': 'string',
  'video-codec': 'string',
  path: 'string',
  'media-title': 'string',
  filename: 'string',
};

const mpvState = {
  initialized: false,
  eventUnlisten: null,
  active: false,
  currentTitle: '',
  currentSource: '',
  duration: null,
  timePos: null,
  paused: false,
  ended: false,
  volume: 100,
  muted: false,
  controlsBound: false,
  seekDragging: false,
  seekHoverSeconds: null,
  viewportRaf: 0,
  viewportBound: false,
  debugSnapshotTimer: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function playerDebugInfo(message, details) {
  if (details === undefined) {
    console.info(`[PullDown][player-debug][${nowIso()}] ${message}`);
    return;
  }
  console.info(`[PullDown][player-debug][${nowIso()}] ${message}`, details);
}

function playerDebugWarn(message, details) {
  if (details === undefined) {
    console.warn(`[PullDown][player-debug][${nowIso()}] ${message}`);
    return;
  }
  console.warn(`[PullDown][player-debug][${nowIso()}] ${message}`, details);
}

function summarizeSourceForLog(source) {
  const text = String(source || '').trim();
  if (!text) return '<empty>';
  if (/^https?:/i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.origin}${url.pathname} (query=${url.search.length} chars)`;
    } catch (_) {
      return `${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
    }
  }
  return `${text.slice(0, 160)}${text.length > 160 ? '...' : ''}`;
}

export function initPlayerView() {
  const openFolderBtn = document.getElementById('player-open-folder');
  const clearBtn = document.getElementById('player-clear');

  stateEmitter.on('player:open', (payload) => {
    void openInAppPlayer(payload);
  });
  stateEmitter.on('view:change', (view) => {
    if (view !== 'player') {
      pausePlayerPlayback();
      return;
    }
    if (mpvState.active) {
      scheduleMpvViewportSync();
      syncPlayerControlsUi();
      updateMpvStatusLabel();
    }
  });

  openFolderBtn?.addEventListener('click', async () => {
    if (!playerCurrentPath) return;
    try {
      await invokeCommand('app_open_in_file_manager', {
        request: { path: playerCurrentPath },
      });
    } catch (err) {
      console.error('[PullDown] Failed to open player media folder:', err);
    }
  });

  clearBtn?.addEventListener('click', () => {
    clearPlayerView();
  });

  initPlayerDropZone();
  initPlayerControls();
  clearPlayerView();
}

function pausePlayerPlayback() {
  if (PLAYER_BACKEND === 'libvlc') {
    void stopLibVlcPlayback();
    return;
  }
  void pauseMpvPlayback();
}

function clearPlayerView() {
  const video = document.getElementById('player-video');
  const audio = document.getElementById('player-audio');
  const empty = document.getElementById('player-empty');
  const title = document.getElementById('player-title');
  const path = document.getElementById('player-path');
  const openFolderBtn = document.getElementById('player-open-folder');
  const clearBtn = document.getElementById('player-clear');
  const status = document.getElementById('status-active-label');

  if (PLAYER_BACKEND === 'libvlc') {
    void stopLibVlcPlayback();
  } else {
    void stopMpvPlayback();
  }
  if (video) video.style.display = 'none';
  if (audio) audio.style.display = 'none';
  if (empty) empty.style.display = 'flex';
  if (title) title.textContent = 'Nothing playing';
  if (path) path.textContent = 'Select a downloaded file to play in PullDown.';
  if (openFolderBtn) openFolderBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  playerCurrentPath = '';
  resetPlayerControlsUi();
  if (state.activeView === 'player' && status) {
    status.textContent = 'Player ready';
  }
}

function initPlayerDropZone() {
  const playerView = document.getElementById('view-player');
  const playerShell = playerView?.querySelector('.player-shell');
  if (!playerView || !playerShell) return;

  let dragDepth = 0;
  const setDropActive = (active) => {
    playerShell.classList.toggle('player-shell--drop-target', active);
  };
  const clearDropState = () => {
    dragDepth = 0;
    setDropActive(false);
  };

  const onDragEnter = (event) => {
    if (state.activeView !== 'player') return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    setDropActive(true);
    const status = document.getElementById('status-active-label');
    if (status) status.textContent = 'Drop a link or local media file to play';
  };

  const onDragOver = (event) => {
    if (state.activeView !== 'player') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setDropActive(true);
  };

  const onDragLeave = (event) => {
    if (state.activeView !== 'player') return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setDropActive(false);
    }
  };

  const onDrop = (event) => {
    if (state.activeView !== 'player') return;
    event.preventDefault();
    event.stopPropagation();
    clearDropState();

    const payload = payloadFromPlayerDrop(event.dataTransfer);
    if (!payload) {
      const status = document.getElementById('status-active-label');
      if (status) status.textContent = 'Unsupported drop. Use a URL or audio/video file.';
      return;
    }

    stateEmitter.emit('player:open', payload);
  };

  playerShell.addEventListener('dragenter', onDragEnter);
  playerShell.addEventListener('dragover', onDragOver);
  playerShell.addEventListener('dragleave', onDragLeave);
  playerShell.addEventListener('drop', onDrop);
  playerView.addEventListener('dragenter', onDragEnter);
  playerView.addEventListener('dragover', onDragOver);
  playerView.addEventListener('dragleave', onDragLeave);
  playerView.addEventListener('drop', onDrop);
  stateEmitter.on('view:change', () => {
    clearDropState();
  });
}

function payloadFromPlayerDrop(dataTransfer) {
  const filePayload = payloadFromDroppedMediaFile(dataTransfer?.files);
  if (filePayload) {
    return filePayload;
  }
  const uriPayload = payloadFromDroppedUriEntries(dataTransfer);
  if (uriPayload) {
    return uriPayload;
  }
  const droppedUrl = extractDroppedWebUrl(dataTransfer);
  if (droppedUrl) {
    return { extractUrl: droppedUrl };
  }
  return null;
}

function payloadFromDroppedMediaFile(filesLike) {
  if (!filesLike || !Number.isFinite(filesLike.length) || filesLike.length <= 0) {
    return null;
  }
  const files = Array.from(filesLike);
  const mediaFile = files.find(isSupportedDroppedMediaFile);
  if (!mediaFile) {
    return null;
  }

  const title = String(mediaFile.name || 'Dropped media').trim() || 'Dropped media';
  const mediaKind = isDroppedAudioFile(mediaFile) ? 'audio' : 'video';
  const absolutePath = resolveDroppedFilePath(mediaFile);
  if (absolutePath) {
    return {
      path: absolutePath,
      title,
      mediaKind,
    };
  }
  return null;
}

function resolveDroppedFilePath(file) {
  const candidates = [file?.path, file?.webkitRelativePath, file?.name]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith('file://')) {
      try {
        const parsed = new URL(candidate);
        const pathname = decodeURIComponent(parsed.pathname || '').replace(/\//g, '\\');
        const trimmed = pathname.replace(/^\\+/, '');
        if (/^[A-Za-z]:\\/.test(trimmed)) return trimmed;
      } catch (_) {
        // fallthrough
      }
    }
    if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\')) {
      return candidate;
    }
    if (candidate.startsWith('/')) {
      const unixToWindows = candidate.replace(/\//g, '\\');
      if (/^\\[A-Za-z]:\\/.test(unixToWindows)) {
        return unixToWindows.slice(1);
      }
      return candidate;
    }
  }
  return '';
}

function extensionFromPathLike(value) {
  const text = String(value || '').trim().toLowerCase();
  const dot = text.lastIndexOf('.');
  if (dot < 0) return '';
  return text.slice(dot + 1);
}

function titleFromPath(path) {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const tail = normalized.split('/').pop() || '';
  return tail.replace(/\\.[^/.]+$/, '').trim();
}

function normalizeMpvSource(source) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  if (/^(https?:|asset:|file:)/i.test(raw)) {
    return raw;
  }

  if (raw.startsWith('\\\\')) {
    const unc = raw.replace(/^\\\\/, '').replace(/\\/g, '/');
    return `file://${encodeURI(unc)}`;
  }

  const normalized = raw.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }
  return raw;
}


function isSupportedDroppedMediaFile(file) {
  const mime = String(file?.type || '').trim().toLowerCase();
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    return true;
  }
  const ext = extensionFromPathLike(file?.name || file?.path || '');
  return AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function isDroppedAudioFile(file) {
  const mime = String(file?.type || '').trim().toLowerCase();
  if (mime.startsWith('audio/')) return true;
  if (mime.startsWith('video/')) return false;
  const ext = extensionFromPathLike(file?.name || file?.path || '');
  return AUDIO_EXTENSIONS.has(ext);
}

function normalizeDroppedUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function payloadFromDroppedUriEntries(dataTransfer) {
  if (!dataTransfer) return null;
  const entries = String(dataTransfer.getData('text/uri-list') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const entry of entries) {
    const localPath = pathFromFileUri(entry);
    if (localPath) {
      const ext = extensionFromPathLike(localPath);
      if (!AUDIO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) continue;
      return {
        path: localPath,
        title: titleFromPath(localPath),
        mediaKind: AUDIO_EXTENSIONS.has(ext) ? 'audio' : 'video',
      };
    }
    const remote = normalizeDroppedUrl(entry);
    if (remote) {
      return { extractUrl: remote };
    }
  }

  return null;
}

function pathFromFileUri(value) {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('file://')) return '';
  try {
    const parsed = new URL(raw);
    const decoded = decodeURIComponent(parsed.pathname || '');
    // Windows file URI: /C:/path...
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1).replace(/\//g, '\\');
    }
    // UNC: file://server/share/path
    if (parsed.host) {
      return `\\\\${parsed.host}${decoded.replace(/\//g, '\\')}`;
    }
    return decoded;
  } catch (_) {
    return '';
  }
}

function extractDroppedWebUrl(dataTransfer) {
  if (!dataTransfer) return '';

  const plainText = String(dataTransfer.getData('text/plain') || '');
  for (const token of plainText.split(/\s+/)) {
    const normalized = normalizeDroppedUrl(token);
    if (normalized) return normalized;
  }

  return '';
}

function getPlayerControlElements() {
  return {
    play: document.getElementById('player-control-play'),
    seek: document.getElementById('player-control-seek'),
    current: document.getElementById('player-control-current'),
    duration: document.getElementById('player-control-duration'),
    mute: document.getElementById('player-control-mute'),
    volume: document.getElementById('player-control-volume'),
  };
}

function setPlayerControlIcons() {
  const { play, mute } = getPlayerControlElements();
  if (play) {
    play.innerHTML = mpvState.paused ? PLAYER_ICON_PLAY : PLAYER_ICON_PAUSE;
    play.title = mpvState.paused ? 'Play' : 'Pause';
    play.setAttribute('aria-label', mpvState.paused ? 'Play' : 'Pause');
  }
  if (mute) {
    mute.innerHTML = mpvState.muted ? PLAYER_ICON_MUTED : PLAYER_ICON_VOLUME;
    mute.title = mpvState.muted ? 'Unmute' : 'Mute';
    mute.setAttribute('aria-label', mpvState.muted ? 'Unmute' : 'Mute');
  }
}

function setPlayerControlsEnabled(enabled) {
  const controls = getPlayerControlElements();
  const disabled = !enabled;
  if (controls.play) controls.play.disabled = disabled;
  if (controls.seek) controls.seek.disabled = disabled;
  if (controls.mute) controls.mute.disabled = disabled;
  if (controls.volume) controls.volume.disabled = disabled;
}

function syncPlayerControlsUi() {
  const controls = getPlayerControlElements();
  setPlayerControlIcons();

  const duration = Number(mpvState.duration);
  const timePos = Number(mpvState.timePos);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const hasTime = Number.isFinite(timePos) && timePos >= 0;

  if (controls.current) {
    if (mpvState.seekDragging && Number.isFinite(mpvState.seekHoverSeconds)) {
      controls.current.textContent = formatClock(mpvState.seekHoverSeconds);
    } else {
      controls.current.textContent = formatClock(hasTime ? timePos : 0);
    }
  }
  if (controls.duration) {
    controls.duration.textContent = hasDuration ? formatClock(duration) : '--:--';
  }
  if (controls.seek && !mpvState.seekDragging) {
    if (hasDuration && hasTime) {
      const ratio = Math.max(0, Math.min(1, timePos / duration));
      controls.seek.value = String(Math.round(ratio * 1000));
    } else {
      controls.seek.value = '0';
    }
  }
  if (controls.volume) {
    const volumeValue = Number.isFinite(mpvState.volume)
      ? Math.max(0, Math.min(100, Math.round(mpvState.volume)))
      : 100;
    controls.volume.value = String(volumeValue);
  }
}

function resetPlayerControlsUi() {
  mpvState.timePos = null;
  mpvState.duration = null;
  mpvState.paused = true;
  mpvState.ended = false;
  mpvState.volume = 100;
  mpvState.muted = false;
  mpvState.seekDragging = false;
  mpvState.seekHoverSeconds = null;
  setPlayerControlsEnabled(false);
  syncPlayerControlsUi();
}

function initPlayerControls() {
  if (mpvState.controlsBound) return;
  mpvState.controlsBound = true;

  const controls = getPlayerControlElements();
  if (!controls.play || !controls.seek || !controls.mute || !controls.volume) {
    return;
  }

  controls.play.addEventListener('click', async () => {
    if (!mpvState.initialized) return;
    try {
      if (mpvState.ended) {
        await invokePluginCommand('plugin:libmpv|command', {
          name: 'seek',
          args: [0, 'absolute', 'exact'],
          windowLabel: MPV_WINDOW_LABEL,
        });
        mpvState.ended = false;
      }
      const nextPause = !mpvState.paused;
      await invokePluginCommand('plugin:libmpv|set_property', {
        name: 'pause',
        value: nextPause,
        windowLabel: MPV_WINDOW_LABEL,
      });
      mpvState.paused = nextPause;
      syncPlayerControlsUi();
      updateMpvStatusLabel();
    } catch (err) {
      console.error('[PullDown] player: failed to toggle pause via mpv', err);
    }
  });

  controls.seek.addEventListener('input', () => {
    if (!mpvState.active) return;
    const duration = Number(mpvState.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    mpvState.seekDragging = true;
    const sliderValue = Number(controls.seek.value);
    const ratio = Math.max(0, Math.min(1, sliderValue / 1000));
    mpvState.seekHoverSeconds = duration * ratio;
    syncPlayerControlsUi();
  });

  controls.seek.addEventListener('change', async () => {
    if (!mpvState.active) return;
    const duration = Number(mpvState.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;

    const sliderValue = Number(controls.seek.value);
    const ratio = Math.max(0, Math.min(1, sliderValue / 1000));
    const targetSeconds = duration * ratio;
    mpvState.seekDragging = false;
    mpvState.seekHoverSeconds = null;
    try {
      await invokePluginCommand('plugin:libmpv|command', {
        name: 'seek',
        args: [targetSeconds, 'absolute', 'exact'],
        windowLabel: MPV_WINDOW_LABEL,
      });
      mpvState.timePos = targetSeconds;
      syncPlayerControlsUi();
      updateMpvStatusLabel();
    } catch (err) {
      console.error('[PullDown] player: seek failed via mpv', err);
    }
  });

  controls.seek.addEventListener('blur', () => {
    if (!mpvState.seekDragging) return;
    mpvState.seekDragging = false;
    mpvState.seekHoverSeconds = null;
    syncPlayerControlsUi();
  });

  controls.volume.addEventListener('input', async () => {
    if (!mpvState.initialized) return;
    const raw = Number(controls.volume.value);
    const nextVolume = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
    mpvState.volume = nextVolume;
    const shouldMute = nextVolume <= 0;
    try {
      await invokePluginCommand('plugin:libmpv|set_property', {
        name: 'volume',
        value: nextVolume,
        windowLabel: MPV_WINDOW_LABEL,
      });
      if (mpvState.muted !== shouldMute) {
        await invokePluginCommand('plugin:libmpv|set_property', {
          name: 'mute',
          value: shouldMute,
          windowLabel: MPV_WINDOW_LABEL,
        });
        mpvState.muted = shouldMute;
      }
      syncPlayerControlsUi();
    } catch (err) {
      console.error('[PullDown] player: volume change failed via mpv', err);
    }
  });

  controls.mute.addEventListener('click', async () => {
    if (!mpvState.initialized) return;
    const nextMuted = !mpvState.muted;
    try {
      await invokePluginCommand('plugin:libmpv|set_property', {
        name: 'mute',
        value: nextMuted,
        windowLabel: MPV_WINDOW_LABEL,
      });
      mpvState.muted = nextMuted;
      syncPlayerControlsUi();
    } catch (err) {
      console.error('[PullDown] player: mute toggle failed via mpv', err);
    }
  });

  resetPlayerControlsUi();
}

function formatClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const whole = Math.floor(value);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function invokePluginCommand(commandName, payload = {}) {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error('Tauri runtime is not available.');
  }
  if (commandName === 'plugin:libmpv|init') {
    playerDebugInfo('invoke init', payload?.mpvConfig?.initialOptions || {});
  } else if (commandName === 'plugin:libmpv|destroy') {
    playerDebugInfo('invoke destroy', { windowLabel: payload?.windowLabel || MPV_WINDOW_LABEL });
  } else if (commandName === 'plugin:libmpv|command') {
    const name = String(payload?.name || '').trim();
    if (name === 'loadfile') {
      const args = Array.isArray(payload?.args) ? payload.args : [];
      const primary = summarizeSourceForLog(args[0]);
      const extra = args.slice(1);
      playerDebugInfo('invoke loadfile', { primary, extra });
    } else if (name === 'seek' || name === 'stop') {
      playerDebugInfo(`invoke command ${name}`, payload?.args || []);
    }
  } else if (commandName === 'plugin:libmpv|set_property') {
    const name = String(payload?.name || '').trim();
    if (
      name === 'pause'
      || name === 'mute'
      || name === 'volume'
      || name === 'aid'
      || name === 'vid'
      || name.startsWith('video-margin-ratio-')
    ) {
      playerDebugInfo(`invoke set_property ${name}`, payload?.value);
    }
  } else if (commandName === 'plugin:libmpv|set_video_margin_ratio') {
    playerDebugInfo('invoke set_video_margin_ratio', payload?.ratio || {});
  }
  return tauri.core.invoke(commandName, payload);
}

function setMpvShellVisualState(active) {
  const playerView = document.getElementById('view-player');
  const playerShell = playerView?.querySelector('.player-shell');
  if (playerShell) {
    playerShell.classList.toggle('player-shell--mpv-active', active);
    const style = window.getComputedStyle(playerShell);
    playerDebugInfo(`setMpvShellVisualState active=${active}`, {
      pointerEvents: style.pointerEvents,
      background: style.backgroundColor,
    });
  }
  document.body?.classList.toggle('mpv-active', active);
}

function updateMpvStatusLabel() {
  const status = document.getElementById('status-active-label');
  if (!status || !mpvState.active || state.activeView !== 'player') return;
  const title = mpvState.currentTitle || 'media';
  const prefix = mpvState.paused ? 'Paused' : 'Playing';
  if (Number.isFinite(mpvState.timePos) && Number.isFinite(mpvState.duration) && mpvState.duration > 0) {
    status.textContent = `${prefix} ${title} (${formatClock(mpvState.timePos)} / ${formatClock(mpvState.duration)})`;
    return;
  }
  status.textContent = `${prefix} ${title}`;
}

async function setMpvViewportToPlayerShell() {
  if (!mpvState.initialized || !mpvState.active) return;
  const playerView = document.getElementById('view-player');
  const playerShell = playerView?.querySelector('.player-shell');
  if (!playerShell) return;

  const rect = playerShell.getBoundingClientRect();
  if (
    rect.width < MPV_MIN_VIEWPORT_PIXELS
    || rect.height < MPV_MIN_VIEWPORT_PIXELS
  ) {
    playerDebugWarn('viewport skipped due tiny shell rect', {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
    window.setTimeout(() => {
      scheduleMpvViewportSync();
    }, 80);
    return;
  }

  const width = Math.max(document.documentElement?.clientWidth || window.innerWidth || 0, 1);
  const height = Math.max(document.documentElement?.clientHeight || window.innerHeight || 0, 1);

  let left = Math.min(Math.max(rect.left / width, 0), 1);
  let right = Math.min(Math.max((width - rect.right) / width, 0), 1);
  let top = Math.min(Math.max(rect.top / height, 0), 1);
  let bottom = Math.min(Math.max((height - rect.bottom) / height, 0), 1);

  if (left + right >= 1) {
    right = Math.max(0, (1 - MPV_VIEWPORT_EPSILON) - left);
  }
  if (top + bottom >= 1) {
    bottom = Math.max(0, (1 - MPV_VIEWPORT_EPSILON) - top);
  }

  try {
    await invokePluginCommand('plugin:libmpv|set_video_margin_ratio', {
      ratio: { left, right, top, bottom },
      windowLabel: MPV_WINDOW_LABEL,
    });
    playerDebugInfo('viewport applied', {
      shellRect: {
        left: Number(rect.left.toFixed(2)),
        top: Number(rect.top.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
      windowSize: { width, height },
      ratio: {
        left: Number(left.toFixed(6)),
        right: Number(right.toFixed(6)),
        top: Number(top.toFixed(6)),
        bottom: Number(bottom.toFixed(6)),
      },
    });
  } catch (err) {
    console.warn('[PullDown] player: failed to set mpv viewport margins', err);
  }
}

function scheduleMpvViewportSync() {
  if (!mpvState.active || state.activeView !== 'player') return;
  if (mpvState.viewportRaf) return;
  mpvState.viewportRaf = window.requestAnimationFrame(() => {
    mpvState.viewportRaf = 0;
    void setMpvViewportToPlayerShell();
  });
}

function queueViewportStabilizationSync() {
  [0, 80, 220, 500, 900].forEach((delayMs) => {
    window.setTimeout(() => {
      scheduleMpvViewportSync();
    }, delayMs);
  });
}

function bindMpvViewportSync() {
  if (mpvState.viewportBound) return;
  mpvState.viewportBound = true;

  const onLayoutChange = () => {
    scheduleMpvViewportSync();
  };
  window.addEventListener('resize', onLayoutChange, { passive: true });
  window.addEventListener('scroll', onLayoutChange, { passive: true });
  const main = document.getElementById('main-content');
  main?.addEventListener('scroll', onLayoutChange, { passive: true });
  stateEmitter.on('view:change', onLayoutChange);
}

function handleMpvEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const eventName = String(payload.event || payload.eventName || payload.type || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (eventName && eventName !== 'property-change') {
    playerDebugInfo(`event ${eventName}`, payload);
  }

  if (eventName === 'property-change') {
    const nestedProperty = payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;
    const propertyName = String(
      payload.name
      || payload.property
      || payload.propertyName
      || nestedProperty?.name
      || '',
    )
      .trim()
      .toLowerCase();
    const value = Object.prototype.hasOwnProperty.call(payload, 'data') && !nestedProperty
      ? payload.data
      : (nestedProperty?.data ?? payload.value);
    if (propertyName === 'time-pos') {
      const next = Number(value);
      mpvState.timePos = Number.isFinite(next) ? next : null;
      if (Number.isFinite(mpvState.timePos) && Number.isFinite(mpvState.duration)) {
        if (mpvState.timePos < mpvState.duration - 0.5) {
          mpvState.ended = false;
        }
      }
      syncPlayerControlsUi();
      updateMpvStatusLabel();
      return;
    }
    if (propertyName === 'duration') {
      const next = Number(value);
      mpvState.duration = Number.isFinite(next) ? next : null;
      syncPlayerControlsUi();
      updateMpvStatusLabel();
      return;
    }
    if (propertyName === 'pause') {
      mpvState.paused = Boolean(value);
      playerDebugInfo('property pause', { value: mpvState.paused });
      syncPlayerControlsUi();
      updateMpvStatusLabel();
      return;
    }
    if (propertyName === 'volume') {
      const next = Number(value);
      mpvState.volume = Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : mpvState.volume;
      playerDebugInfo('property volume', { value: mpvState.volume });
      syncPlayerControlsUi();
      return;
    }
    if (propertyName === 'mute') {
      mpvState.muted = Boolean(value);
      playerDebugInfo('property mute', { value: mpvState.muted });
      syncPlayerControlsUi();
      return;
    }
    if (
      propertyName === 'aid'
      || propertyName === 'vid'
      || propertyName === 'ao'
      || propertyName === 'vo'
      || propertyName === 'audio-codec-name'
      || propertyName === 'video-codec'
      || propertyName === 'path'
    ) {
      playerDebugInfo(`property ${propertyName}`, { value });
      return;
    }
    if (propertyName === 'media-title' || propertyName === 'filename') {
      const next = typeof value === 'string' ? value.trim() : '';
      if (next) {
        mpvState.currentTitle = next;
      }
      syncPlayerControlsUi();
      updateMpvStatusLabel();
      return;
    }
    return;
  }

  if (eventName === 'file-loaded') {
    mpvState.ended = false;
    clearPlayerLoading();
    setMpvShellVisualState(true);
    setPlayerControlsEnabled(true);
    syncPlayerControlsUi();
    queueViewportStabilizationSync();
    updateMpvStatusLabel();
    if (mpvState.debugSnapshotTimer) {
      window.clearTimeout(mpvState.debugSnapshotTimer);
      mpvState.debugSnapshotTimer = 0;
    }
    void logMpvTrackSnapshot('file-loaded');
    mpvState.debugSnapshotTimer = window.setTimeout(() => {
      mpvState.debugSnapshotTimer = 0;
      void logMpvTrackSnapshot('file-loaded+1500ms');
    }, 1500);
    return;
  }

  if (eventName === 'playback-restart') {
    mpvState.ended = false;
    mpvState.paused = false;
    syncPlayerControlsUi();
    queueViewportStabilizationSync();
    updateMpvStatusLabel();
    return;
  }

  if (eventName === 'end-file') {
    const reasonValue = payload.reason ?? payload.data?.reason;
    const reason = typeof reasonValue === 'string' ? reasonValue.trim().toLowerCase() : 'unknown';
    if (reason === 'stop') {
      mpvState.active = false;
      mpvState.timePos = null;
      mpvState.duration = null;
      mpvState.paused = true;
      mpvState.ended = false;
      setPlayerControlsEnabled(false);
      syncPlayerControlsUi();
      setMpvShellVisualState(false);
      return;
    }
    playerDebugInfo('event end-file (natural/error)', payload);
    mpvState.ended = true;
    mpvState.paused = true;
    if (Number.isFinite(mpvState.duration) && mpvState.duration > 0) {
      mpvState.timePos = mpvState.duration;
    }
    syncPlayerControlsUi();
    const status = document.getElementById('status-active-label');
    if (status && state.activeView === 'player') {
      status.textContent = 'Playback completed';
    }
    return;
  }
}

async function ensureMpvEventListener() {
  if (mpvState.eventUnlisten) return;
  try {
    mpvState.eventUnlisten = await listenEvent(`mpv-event-${MPV_WINDOW_LABEL}`, handleMpvEvent);
    playerDebugInfo(`event listener attached: mpv-event-${MPV_WINDOW_LABEL}`);
  } catch (err) {
    console.warn('[PullDown] player: failed to subscribe to mpv events', err);
  }
}

async function destroyMpvInstance() {
  if (!mpvState.initialized) return;
  playerDebugInfo('destroyMpvInstance: start');
  try {
    await invokePluginCommand('plugin:libmpv|destroy', {
      windowLabel: MPV_WINDOW_LABEL,
    });
    playerDebugInfo('destroyMpvInstance: success');
  } catch (err) {
    console.warn('[PullDown] player: failed to destroy mpv instance', err);
  } finally {
    mpvState.initialized = false;
  }
}

async function logMpvTrackSnapshot(contextLabel) {
  if (!mpvState.initialized) return;
  const readProp = async (name, format) => {
    try {
      const value = await invokePluginCommand('plugin:libmpv|get_property', {
        name,
        format,
        windowLabel: MPV_WINDOW_LABEL,
      });
      return value;
    } catch (err) {
      return `<error: ${err?.message || String(err)}>`;
    }
  };
  try {
    const [
      aid,
      vid,
      mute,
      volume,
      pause,
      ao,
      vo,
      audioCodec,
      videoCodec,
      path,
      timePos,
      duration,
    ] = await Promise.all([
      readProp('aid', 'int64'),
      readProp('vid', 'int64'),
      readProp('mute', 'flag'),
      readProp('volume', 'double'),
      readProp('pause', 'flag'),
      readProp('ao', 'string'),
      readProp('vo', 'string'),
      readProp('audio-codec-name', 'string'),
      readProp('video-codec', 'string'),
      readProp('path', 'string'),
      readProp('time-pos', 'double'),
      readProp('duration', 'double'),
    ]);
    console.info(
      `[PullDown] player: mpv snapshot (${contextLabel})`,
      {
        aid,
        vid,
        mute,
        volume,
        pause,
        ao,
        vo,
        audioCodec,
        videoCodec,
        path,
        timePos,
        duration,
      },
    );
  } catch (err) {
    console.warn('[PullDown] player: failed to read mpv track snapshot', err);
  }
}

async function ensureMpvInitialized() {
  if (!isTauriEnvironment()) {
    throw new Error('Tauri runtime is not available.');
  }
  if (mpvState.initialized) return;
  playerDebugInfo('ensureMpvInitialized: start');

  const mpvConfig = {
    initialOptions: {
      vo: 'gpu-next',
      hwdec: 'auto-safe',
      'keep-open': 'yes',
      'force-window': 'yes',
      osc: 'yes',
      'input-cursor': 'yes',
      'input-default-bindings': 'yes',
      'input-vo-keyboard': 'yes',
      'cursor-autohide': '1000',
      mute: 'no',
      volume: '100',
      terminal: 'no',
      'msg-level': 'all=warn',
    },
    observedProperties: MPV_OBSERVED_PROPERTIES,
  };

  try {
    await invokePluginCommand('plugin:libmpv|init', {
      mpvConfig,
      windowLabel: MPV_WINDOW_LABEL,
    });
    playerDebugInfo('ensureMpvInitialized: init success');
  } catch (err) {
    const message = String(err || '').toLowerCase();
    if (!message.includes('already')) {
      throw err;
    }
    playerDebugWarn('ensureMpvInitialized: init returned already-initialized');
  }

  mpvState.initialized = true;
  bindMpvViewportSync();
  await ensureMpvEventListener();
  playerDebugInfo('ensureMpvInitialized: complete');
}

async function loadMpvSource(primaryUrl, secondaryUrl) {
  if (!primaryUrl) {
    throw new Error('Primary playback URL is required for mpv.');
  }

  if (secondaryUrl) {
    playerDebugInfo('loadMpvSource: with external audio', {
      primary: summarizeSourceForLog(primaryUrl),
      secondary: summarizeSourceForLog(secondaryUrl),
    });
    try {
      await invokePluginCommand('plugin:libmpv|command', {
        name: 'loadfile',
        args: [primaryUrl, 'replace', -1, `audio-file=${secondaryUrl}`],
        windowLabel: MPV_WINDOW_LABEL,
      });
      playerDebugInfo('loadMpvSource: loadfile success (with external audio)');
      return;
    } catch (err) {
      console.warn('[PullDown] player: mpv loadfile with audio-file failed, falling back', err);
    }
  }

  playerDebugInfo('loadMpvSource: direct source', {
    primary: summarizeSourceForLog(primaryUrl),
  });
  await invokePluginCommand('plugin:libmpv|command', {
    name: 'loadfile',
    args: [primaryUrl, 'replace'],
    windowLabel: MPV_WINDOW_LABEL,
  });
  playerDebugInfo('loadMpvSource: loadfile success (direct)');
}

async function playInMpv({
  title,
  sourceUrl,
  secondarySourceUrl,
}) {
  playerDebugInfo('playInMpv: start', {
    title: String(title || '').trim(),
    source: summarizeSourceForLog(sourceUrl),
    secondary: summarizeSourceForLog(secondarySourceUrl),
  });
  // Reset instance before each playback start so stale per-session options
  // (for example external audio bindings from previous sources) do not leak.
  if (mpvState.initialized) {
    await destroyMpvInstance();
  }
  await ensureMpvInitialized();
  await loadMpvSource(sourceUrl, secondarySourceUrl);
  const setBestEffort = async (name, value) => {
    try {
      await invokePluginCommand('plugin:libmpv|set_property', {
        name,
        value,
        windowLabel: MPV_WINDOW_LABEL,
      });
    } catch (err) {
      console.warn(`[PullDown] player: failed to set mpv property ${name}`, err);
    }
  };
  await setBestEffort('aid', 'auto');
  await setBestEffort('vid', 'auto');
  await setBestEffort('mute', false);
  await setBestEffort('volume', 100);
  await invokePluginCommand('plugin:libmpv|set_property', {
    name: 'pause',
    value: false,
    windowLabel: MPV_WINDOW_LABEL,
  });
  playerDebugInfo('playInMpv: pause=false sent');

  mpvState.active = true;
  mpvState.currentTitle = String(title || 'Now playing').trim() || 'Now playing';
  mpvState.currentSource = sourceUrl;
  mpvState.timePos = null;
  mpvState.duration = null;
  mpvState.paused = false;
  mpvState.ended = false;
  mpvState.seekDragging = false;
  mpvState.seekHoverSeconds = null;
  setMpvShellVisualState(true);
  setPlayerControlsEnabled(true);
  syncPlayerControlsUi();
  scheduleMpvViewportSync();
  queueViewportStabilizationSync();

  try {
    const [volumeValue, muteValue] = await Promise.all([
      invokePluginCommand('plugin:libmpv|get_property', {
        name: 'volume',
        format: 'double',
        windowLabel: MPV_WINDOW_LABEL,
      }),
      invokePluginCommand('plugin:libmpv|get_property', {
        name: 'mute',
        format: 'flag',
        windowLabel: MPV_WINDOW_LABEL,
      }),
    ]);
    const normalizedVolume = Number(volumeValue);
    if (Number.isFinite(normalizedVolume)) {
      mpvState.volume = Math.max(0, Math.min(100, normalizedVolume));
    }
    mpvState.muted = Boolean(muteValue);
    syncPlayerControlsUi();
  } catch (_) {
    // property probing is best-effort
  }
  await logMpvTrackSnapshot('playback-start');
}

async function pauseMpvPlayback() {
  if (!mpvState.initialized || !mpvState.active) return;
  try {
    await invokePluginCommand('plugin:libmpv|set_property', {
      name: 'pause',
      value: true,
      windowLabel: MPV_WINDOW_LABEL,
    });
    mpvState.paused = true;
    syncPlayerControlsUi();
    updateMpvStatusLabel();
  } catch (err) {
    console.warn('[PullDown] player: failed to pause mpv playback', err);
  }
}

async function stopMpvPlayback() {
  if (mpvState.viewportRaf) {
    window.cancelAnimationFrame(mpvState.viewportRaf);
    mpvState.viewportRaf = 0;
  }
  if (!mpvState.initialized) {
    mpvState.active = false;
    mpvState.currentTitle = '';
    mpvState.currentSource = '';
    setMpvShellVisualState(false);
    return;
  }

  try {
    await invokePluginCommand('plugin:libmpv|command', {
      name: 'stop',
      args: [],
      windowLabel: MPV_WINDOW_LABEL,
    });
  } catch (err) {
    console.warn('[PullDown] player: failed to stop mpv playback', err);
  }

  mpvState.active = false;
  mpvState.currentTitle = '';
  mpvState.currentSource = '';
  mpvState.timePos = null;
  mpvState.duration = null;
  mpvState.paused = true;
  mpvState.ended = false;
  mpvState.seekDragging = false;
  mpvState.seekHoverSeconds = null;
  setPlayerControlsEnabled(false);
  syncPlayerControlsUi();
  setMpvShellVisualState(false);
}

async function playInLibVlc({ title, sourceUrl, isUrl }) {
  if (!isTauriEnvironment()) {
    throw new Error('Tauri runtime is not available.');
  }
  if (!sourceUrl) {
    throw new Error('Playback source is missing.');
  }
  await invokeCommand('app_player_play_libvlc', {
    request: {
      source: sourceUrl,
      isUrl,
      title: title || null,
    },
  });
  setMpvShellVisualState(false);
  mpvState.active = true;
  mpvState.currentTitle = String(title || 'Now playing').trim() || 'Now playing';
  mpvState.currentSource = sourceUrl;
  mpvState.paused = false;
}

async function stopLibVlcPlayback() {
  if (!isTauriEnvironment()) return;
  try {
    await invokeCommand('app_player_stop_libvlc');
  } catch (_) {
    // ignore stop errors for idempotent UI clear path
  }
  mpvState.active = false;
  mpvState.currentTitle = '';
  mpvState.currentSource = '';
  mpvState.paused = true;
}

/**
 * Opens a local file or extracted link in the active native player backend.
 */
async function openInAppPlayer(payload) {
  playerDebugInfo('openInAppPlayer: input payload', payload || {});
  const mediaPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  let remoteUrl = typeof payload?.remoteUrl === 'string' ? payload.remoteUrl.trim() : '';
  let remoteAudioUrl = typeof payload?.secondaryUrl === 'string' ? payload.secondaryUrl.trim() : '';
  const extractUrl = typeof payload?.extractUrl === 'string' ? payload.extractUrl.trim() : '';
  if (!mediaPath && !remoteUrl && !extractUrl) return;
  let sourceReference = mediaPath || remoteUrl || extractUrl;
  let sourceUrl = typeof payload?.sourceUrl === 'string' ? payload.sourceUrl.trim() : '';

  let mediaTitle = typeof payload?.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : titleFromPath(sourceReference);
  const status = document.getElementById('status-active-label');

  // ── Step 1: instant UI feedback ─────────────────────────────────────────
  // Switch to Player tab and show loading state before any async work.
  navigateTo('player');
  pausePlayerPlayback();
  showPlayerLoading(mediaTitle || titleFromPath(sourceReference), sourceReference);
  if (status) {
    status.textContent = (Boolean(remoteUrl) || Boolean(extractUrl))
      ? `Extracting stream for ${mediaTitle || titleFromPath(sourceReference)}...`
      : `Preparing ${mediaTitle || titleFromPath(sourceReference)}...`;
  }

  if (extractUrl && !remoteUrl) {
    if (!isTauriEnvironment()) {
      clearPlayerLoading();
      if (status) status.textContent = 'Run this in Tauri to extract and play.';
      return;
    }
    try {
      const live = await invokeCommand('app_extract_live_source_for_playback', {
        request: { url: extractUrl },
      });
      remoteUrl = typeof live?.playbackUrl === 'string' ? live.playbackUrl.trim() : '';
      if (!remoteUrl) {
        throw new Error('No playable stream URL could be extracted from this link.');
      }

      const extractedSource = typeof live?.sourceUrl === 'string' ? live.sourceUrl.trim() : '';
      const extractedTitle = typeof live?.title === 'string' ? live.title.trim() : '';
      const extractedSecondary = typeof live?.secondaryPlaybackUrl === 'string'
        ? live.secondaryPlaybackUrl.trim()
        : '';
      sourceUrl = extractedSource || extractUrl;
      sourceReference = sourceUrl || extractUrl;
      mediaTitle = extractedTitle || mediaTitle;
      remoteAudioUrl = extractedSecondary || remoteAudioUrl;
      console.info(
        `[PullDown] player: extracted live stream title=${mediaTitle}`,
        `url=${remoteUrl} secondary=${remoteAudioUrl || '<none>'}`,
      );
    } catch (err) {
      clearPlayerLoading();
      const titleEl = document.getElementById('player-title');
      const pathEl = document.getElementById('player-path');
      if (titleEl) titleEl.textContent = 'Stream extraction failed';
      if (pathEl) pathEl.textContent = String(err);
      if (status) status.textContent = 'Stream extraction failed';
      console.error('[PullDown] player: stream extraction failed', err);
      return;
    }
  }

  let mpvPrimarySource = '';
  let mpvSecondarySource = '';
  let mpvTreatAsRemote = false;
  let localResolvedPath = '';

  if (extractUrl && remoteUrl) {
    mpvPrimarySource = remoteUrl;
    mpvSecondarySource = remoteAudioUrl;
    mpvTreatAsRemote = true;
  } else if (isTauriEnvironment() && mediaPath) {
    try {
      const resolvedLocal = await invokeCommand('app_resolve_media_path', {
        request: { path: mediaPath },
      });
      if (typeof resolvedLocal === 'string' && resolvedLocal.trim()) {
        localResolvedPath = resolvedLocal.trim();
      }
    } catch (err) {
      console.warn('[PullDown] player: local resolve for mpv failed, using raw path', err);
    }
    const localSourceCandidate = localResolvedPath || mediaPath;
    // MPV-native playback should use the original local file directly.
    // The old prepare/transcode path was designed for HTML media fallback
    // and can interfere with track fidelity (especially local audio tracks).
    mpvPrimarySource = localSourceCandidate;
    mpvTreatAsRemote = false;
    try {
      await invokeCommand('app_debug_probe_media_for_player', {
        request: { path: mpvPrimarySource },
      });
      playerDebugInfo('backend media probe requested', {
        path: summarizeSourceForLog(mpvPrimarySource),
      });
    } catch (probeErr) {
      playerDebugWarn('backend media probe failed', probeErr);
    }
  } else if (isTauriEnvironment() && remoteUrl && /^(https?:|asset:|file:)/i.test(remoteUrl)) {
    mpvPrimarySource = remoteUrl;
    mpvTreatAsRemote = true;
  } else if (isTauriEnvironment() && remoteUrl) {
    mpvPrimarySource = normalizeMpvSource(remoteUrl);
  }
  playerDebugInfo('openInAppPlayer: source resolved', {
    mediaPath: summarizeSourceForLog(mediaPath),
    remoteUrl: summarizeSourceForLog(remoteUrl),
    remoteAudioUrl: summarizeSourceForLog(remoteAudioUrl),
    extractUrl: summarizeSourceForLog(extractUrl),
    mpvPrimarySource: summarizeSourceForLog(mpvPrimarySource),
    mpvSecondarySource: summarizeSourceForLog(mpvSecondarySource),
    mpvTreatAsRemote,
    localResolvedPath: summarizeSourceForLog(localResolvedPath),
  });

  if (PLAYER_BACKEND === 'libvlc' && isTauriEnvironment() && mpvPrimarySource && !/^(blob:|data:)/i.test(mpvPrimarySource)) {
    try {
      const video = document.getElementById('player-video');
      const audio = document.getElementById('player-audio');
      const empty = document.getElementById('player-empty');
      const titleEl = document.getElementById('player-title');
      const pathEl = document.getElementById('player-path');
      const openFolderBtn = document.getElementById('player-open-folder');
      const clearBtn = document.getElementById('player-clear');

      if (!video || !audio || !empty || !titleEl || !pathEl) {
        throw new Error('Player UI elements are missing.');
      }

      video.style.display = 'none';
      audio.style.display = 'none';
      empty.style.display = 'flex';

      const libVlcSource = mpvPrimarySource;
      const libVlcIsUrl = mpvTreatAsRemote || /^(https?:)/i.test(libVlcSource);
      await playInLibVlc({
        title: mediaTitle || titleFromPath(sourceReference),
        sourceUrl: libVlcSource,
        isUrl: libVlcIsUrl,
      });
      clearPlayerLoading();

      titleEl.textContent = mediaTitle || 'Now playing';
      if (mpvTreatAsRemote) {
        const visibleSource = sourceUrl || remoteUrl || extractUrl || libVlcSource;
        pathEl.textContent = visibleSource;
        pathEl.title = visibleSource;
      } else {
        const visiblePath = mediaPath || localResolvedPath || libVlcSource;
        pathEl.textContent = visiblePath;
        pathEl.title = visiblePath;
      }
      if (empty) {
        const heading = empty.querySelector('.player-empty__title');
        const desc = empty.querySelector('.player-empty__desc');
        if (heading) heading.textContent = 'Playing with libVLC';
        if (desc) desc.textContent = 'Native VLC window is active with built-in controls.';
      }
      if (openFolderBtn) openFolderBtn.disabled = mpvTreatAsRemote;
      if (clearBtn) clearBtn.disabled = false;
      playerCurrentPath = mpvTreatAsRemote ? '' : (localResolvedPath || mediaPath || libVlcSource);
      if (status) {
        status.textContent = `Playing ${mediaTitle || 'media'} via libVLC`;
      }
      return;
    } catch (err) {
      console.error('[PullDown] player: libVLC playback failed', err);
      clearPlayerLoading();
      if (status) {
        status.textContent = `Playback failed: ${err?.message || String(err)}`;
      }
      await stopLibVlcPlayback();
      return;
    }
  }

  if (isTauriEnvironment() && mpvPrimarySource && !/^(blob:|data:)/i.test(mpvPrimarySource)) {
    try {
      const video = document.getElementById('player-video');
      const audio = document.getElementById('player-audio');
      const empty = document.getElementById('player-empty');
      const titleEl = document.getElementById('player-title');
      const pathEl = document.getElementById('player-path');
      const openFolderBtn = document.getElementById('player-open-folder');
      const clearBtn = document.getElementById('player-clear');

      if (!video || !audio || !empty || !titleEl || !pathEl) {
        throw new Error('Player UI elements are missing.');
      }

      video.style.display = 'none';
      audio.style.display = 'none';
      empty.style.display = 'none';

      await playInMpv({
        title: mediaTitle || titleFromPath(sourceReference),
        sourceUrl: mpvPrimarySource,
        secondarySourceUrl: mpvSecondarySource || '',
      });
      clearPlayerLoading();

      titleEl.textContent = mediaTitle || 'Now playing';
      if (mpvTreatAsRemote) {
        const visibleSource = sourceUrl || remoteUrl || extractUrl || mpvPrimarySource;
        pathEl.textContent = visibleSource;
        pathEl.title = `Source: ${visibleSource}${mpvSecondarySource ? `\nAudio: ${mpvSecondarySource}` : ''}`;
      } else {
        const visiblePath = mediaPath || localResolvedPath || mpvPrimarySource;
        pathEl.textContent = visiblePath;
        pathEl.title = visiblePath;
      }
      if (openFolderBtn) openFolderBtn.disabled = mpvTreatAsRemote;
      if (clearBtn) clearBtn.disabled = false;
      playerCurrentPath = mpvTreatAsRemote ? '' : (localResolvedPath || mediaPath || mpvPrimarySource);
      updateMpvStatusLabel();
      scheduleMpvViewportSync();
      queueViewportStabilizationSync();
      return;
    } catch (err) {
      console.error('[PullDown] player: mpv playback failed', err);
      clearPlayerLoading();
      if (status) {
        status.textContent = `Playback failed: ${err?.message || String(err)}`;
      }
      await stopMpvPlayback();
      setMpvShellVisualState(false);
      return;
    }
  }

  clearPlayerLoading();
  if (status) {
    status.textContent = 'Playback source is invalid for MPV mode.';
  }
  return;


}
function showPlayerLoading(mediaTitle, mediaPath) {
  const video  = document.getElementById('player-video');
  const audio  = document.getElementById('player-audio');
  const empty  = document.getElementById('player-empty');
  const title  = document.getElementById('player-title');
  const pathEl = document.getElementById('player-path');

  if (video) video.style.display = 'none';
  if (audio) audio.style.display = 'none';
  if (empty) {
    empty.style.display = 'flex';
    // Swap icon for a pulsing spinner while preparing.
    const svg = empty.querySelector('svg');
    if (svg) svg.setAttribute('data-loading', 'true');
    const h2 = empty.querySelector('.player-empty__title');
    const p  = empty.querySelector('.player-empty__desc');
    if (h2) h2.textContent = mediaTitle || 'Preparing...';
    if (p)  p.textContent  = PLAYER_BACKEND === 'libvlc'
      ? 'Launching libVLC player...'
      : 'Processing media for playback...';
  }
  if (title)  title.textContent  = mediaTitle || 'Preparing...';
  if (pathEl) pathEl.textContent = mediaPath || '';
  setPlayerControlsEnabled(false);
  syncPlayerControlsUi();
}

/** Restore the player shell to a neutral state (called on error or before swapping in media). */
function clearPlayerLoading() {
  const empty = document.getElementById('player-empty');
  if (!empty) return;
  const svg = empty.querySelector('svg');
  if (svg) svg.removeAttribute('data-loading');
  const h2 = empty.querySelector('.player-empty__title');
  const p  = empty.querySelector('.player-empty__desc');
  if (h2) h2.textContent = 'Nothing Playing';
  if (p)  p.textContent  = 'Open any downloaded item to play it in PullDown.';
}
