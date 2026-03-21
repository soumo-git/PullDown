/**
 * topbar.js - URL input and enqueue flow.
 */

import { state, actions, stateEmitter } from '../state.js';
import { isValidUrl } from '../utils.js';
import { openModal } from './modal.js';
import { invokeCommand, isTauriEnvironment } from '../tauriApi.js';

const getInput = () => document.getElementById('url-input');
const getAddBtn = () => document.getElementById('btn-add');
const getAddLabel = () => document.getElementById('btn-add-label');
const getFormatBtn = () => document.getElementById('btn-format');
const getFormatLabel = () => document.getElementById('btn-format-label');
const getStatusText = () => document.getElementById('status-active-label');

const URL_PLACEHOLDER = 'Paste URL - YouTube | Vimeo | Twitter | Reddit...';
const PLAYER_PLACEHOLDER = 'Paste URL to extract and play instantly (no download)...';
const SEARCH_PLACEHOLDER = 'Search downloaded files by title or path...';

let topbarMode = 'queue';
let activeDownloadsTab = 'queue';
let activeView = 'downloads';

function isDownloadedSearchMode() {
  return topbarMode === 'downloaded';
}

function isPlayerMode() {
  return topbarMode === 'player';
}

function emitDownloadedSearchQuery() {
  if (!isDownloadedSearchMode()) return;
  const input = getInput();
  stateEmitter.emit('downloads:search', input?.value ?? '');
}

function onInputChange() {
  const input = getInput();
  const addBtn = getAddBtn();
  if (!input || !addBtn) return;
  if (isDownloadedSearchMode()) {
    addBtn.disabled = true;
    emitDownloadedSearchQuery();
    return;
  }
  const valid = isValidUrl(input.value);
  addBtn.disabled = !valid;
}

function setBusy(busy, label = 'Ready') {
  const addBtn = getAddBtn();
  const formatBtn = getFormatBtn();
  if (addBtn) {
    addBtn.disabled = isDownloadedSearchMode() || busy || !isValidUrl(getInput()?.value || '');
  }
  if (formatBtn) formatBtn.disabled = topbarMode !== 'queue' || busy;
  const status = getStatusText();
  if (status) status.textContent = label;
}

async function onPlayFromLink() {
  const input = getInput();
  if (!input) return;
  const urlStr = input.value.trim();
  if (!isValidUrl(urlStr)) return;

  if (!isTauriEnvironment()) {
    const status = getStatusText();
    if (status) status.textContent = 'Run this in Tauri to extract and play.';
    return;
  }

  const status = getStatusText();
  if (status) status.textContent = 'Extracting stream...';
  stateEmitter.emit('player:open', {
    extractUrl: urlStr,
  });
}

async function loadFormatsForInputUrl() {
  const input = getInput();
  if (!input) return false;
  if (isDownloadedSearchMode()) return false;
  const urlStr = input.value.trim();
  if (!isValidUrl(urlStr)) return false;
  if (!isTauriEnvironment()) return false;

  setBusy(true, 'Loading formats...');
  try {
    const formats = await invokeCommand('download_extract_formats', {
      request: { url: urlStr },
    });
    actions.setFormats(formats);
    return true;
  } catch (err) {
    const status = getStatusText();
    if (status) status.textContent = String(err);
    return false;
  } finally {
    setBusy(false, 'Ready');
  }
}

async function onAddClick() {
  if (isDownloadedSearchMode()) {
    emitDownloadedSearchQuery();
    return;
  }

  if (isPlayerMode()) {
    await onPlayFromLink();
    return;
  }

  const input = getInput();
  if (!input) return;
  const urlStr = input.value.trim();
  if (!isValidUrl(urlStr)) return;

  if (!isTauriEnvironment()) {
    const status = getStatusText();
    if (status) status.textContent = 'Run this in Tauri to start real downloads.';
    return;
  }

  setBusy(true, 'Adding download...');
  let pendingId = null;

  try {
    const validation = await invokeCommand('download_validate_url', {
      request: { url: urlStr },
    });
    if (!validation.valid || !validation.normalizedUrl) {
      throw new Error(validation.reason || 'Invalid URL');
    }

    const selectedFormatId = state.selectedFormat?.id || null;
    pendingId = `pending-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    actions.upsertDownload(buildPendingJob(pendingId, validation.normalizedUrl, state.selectedFormat));
    const status = getStatusText();
    if (status) status.textContent = 'Extracting metadata...';

    const job = await invokeCommand('queue_add', {
      request: {
        url: validation.normalizedUrl,
        formatId: selectedFormatId,
      },
    });

    if (pendingId) {
      actions.removeDownload(pendingId);
      pendingId = null;
    }
    actions.upsertDownload(job);
    input.value = '';
    onInputChange();
    input.focus();
    const queuedStatus = getStatusText();
    if (queuedStatus) queuedStatus.textContent = 'Download queued';
  } catch (err) {
    if (pendingId) {
      actions.removeDownload(pendingId);
      pendingId = null;
    }
    const status = getStatusText();
    if (status) status.textContent = String(err);
  } finally {
    setBusy(false, 'Ready');
  }
}

function buildPendingJob(id, url, selectedFormat) {
  return {
    id,
    source: 'queue',
    title: 'Preparing download...',
    url,
    platform: 'Web',
    duration: '--',
    thumbnail: null,
    color: '#2d6a4f',
    res: selectedFormat?.res ?? null,
    codec: selectedFormat?.codec || 'Auto',
    audio: selectedFormat?.audio ?? null,
    status: 'queued',
    progress: 0,
    bytesTotal: 0,
    bytesDown: 0,
    speedBps: 0,
    filePath: '',
    error: null,
  };
}

function syncFormatLabel(fmt) {
  const label = getFormatLabel();
  if (!label) return;
  if (!fmt) {
    label.textContent = 'Format';
    return;
  }

  const prefix = fmt.kind === 'video_audio'
    ? 'V+A'
    : fmt.kind === 'video_only'
      ? 'Video'
      : fmt.kind === 'audio_only'
        ? 'Audio'
        : 'Format';
  label.textContent = `${prefix} ${fmt.label}`;
}

function applyTopbarMode(tab) {
  const mode = tab === 'player'
    ? 'player'
    : tab === 'downloaded'
      ? 'downloaded'
      : 'queue';
  topbarMode = mode;

  const input = getInput();
  const addBtn = getAddBtn();
  const addLabel = getAddLabel();
  const fmtBtn = getFormatBtn();

  if (input) {
    input.type = mode === 'downloaded' ? 'text' : 'url';
    input.placeholder = mode === 'downloaded'
      ? SEARCH_PLACEHOLDER
      : mode === 'player'
        ? PLAYER_PLACEHOLDER
        : URL_PLACEHOLDER;
  }

  if (fmtBtn) {
    fmtBtn.style.display = mode === 'queue' ? '' : 'none';
    fmtBtn.disabled = mode !== 'queue';
  }
  if (addBtn) {
    addBtn.style.display = mode === 'downloaded' ? 'none' : '';
    addBtn.setAttribute(
      'aria-label',
      mode === 'player' ? 'Extract URL and play in player' : 'Add URL to download queue',
    );
  }
  if (addLabel) {
    addLabel.textContent = mode === 'player' ? 'Play' : 'Add';
  }

  if (mode === 'downloaded') {
    emitDownloadedSearchQuery();
  } else {
    stateEmitter.emit('downloads:search', '');
  }
  onInputChange();
}

function syncTopbarModeFromState() {
  if (activeView === 'player') {
    applyTopbarMode('player');
    return;
  }
  if (activeView === 'downloads' && activeDownloadsTab === 'downloaded') {
    applyTopbarMode('downloaded');
    return;
  }
  applyTopbarMode('queue');
}

export function initTopbar() {
  const input = getInput();
  const addBtn = getAddBtn();
  const fmtBtn = getFormatBtn();

  input?.addEventListener('input', onInputChange);
  input?.addEventListener('paste', () => setTimeout(onInputChange, 0));
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isDownloadedSearchMode()) {
      e.preventDefault();
      emitDownloadedSearchQuery();
      return;
    }
    if (e.key === 'Enter' && !addBtn?.disabled) {
      e.preventDefault();
      onAddClick();
    }
  });

  addBtn?.addEventListener('click', onAddClick);

  fmtBtn?.addEventListener('click', async () => {
    if (isDownloadedSearchMode()) return;
    await loadFormatsForInputUrl();
    openModal();
  });

  stateEmitter.on('format:change', syncFormatLabel);
  stateEmitter.on('downloads:tab:change', (payload) => {
    activeDownloadsTab = payload?.tab === 'downloaded' ? 'downloaded' : 'queue';
    syncTopbarModeFromState();
  });
  stateEmitter.on('view:change', (view) => {
    activeView = typeof view === 'string' ? view : 'downloads';
    syncTopbarModeFromState();
  });

  activeView = typeof state.activeView === 'string' ? state.activeView : 'downloads';
  syncFormatLabel(state.selectedFormat);
  syncTopbarModeFromState();
}
