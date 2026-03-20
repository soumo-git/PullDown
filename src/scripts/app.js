/**
 * app.js - Application bootstrap and backend bridge.
 */

import { initRouter } from './router.js';
import { initModal } from './components/modal.js';
import { initSidebar } from './components/sidebar.js';
import { initTopbar } from './components/topbar.js';
import { startProgressSimulation, updateQueueHeader } from './components/progressBar.js';
import { renderQueueItem, updateCardDOM } from './components/downloadCard.js';
import { actions, state, stateEmitter } from './state.js';
import { invokeCommand, isTauriEnvironment, listenEvent } from './tauriApi.js';

const ENGINE = {
  YTDLP: 'yt-dlp',
  FFMPEG: 'ffmpeg',
};

const engineUiState = {
  ytdlpAction: 'none',
  ffmpegAction: 'none',
  ytdlpBusy: false,
  ffmpegBusy: false,
};

const DOWNLOADS_TAB = {
  QUEUE: 'queue',
  DOWNLOADED: 'downloaded',
};

let activeDownloadsTab = DOWNLOADS_TAB.QUEUE;

document.addEventListener('DOMContentLoaded', async () => {
  initRouter();
  initModal();
  initSidebar();
  initTopbar();
  initQueueTabs();
  initQueueDomSync();
  startProgressSimulation();
  initSettingsPanel();
  await initBackendBridge();
});

function initQueueDomSync() {
  stateEmitter.on('queue:add', (item) => {
    if (!shouldRenderInActiveTab(item)) {
      toggleEmptyState();
      updateQueueHeader();
      return;
    }
    const list = document.getElementById('queue-list');
    if (!list) return;
    if (document.getElementById(item.id)) return;
    list.appendChild(renderQueueItem(item));
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:update', ({ item }) => {
    const card = document.getElementById(item.id);
    if (shouldRenderInActiveTab(item)) {
      if (!card) {
        const list = document.getElementById('queue-list');
        if (!list) return;
        list.appendChild(renderQueueItem(item));
      } else {
        updateCardDOM(item);
      }
    } else if (card) {
      card.remove();
    }
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:remove', (id) => {
    const card = document.getElementById(id);
    if (card) card.remove();
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:replace', () => {
    renderActiveTabList();
    toggleEmptyState();
    updateQueueHeader();
  });

  syncQueueTabsUI();
  renderActiveTabList();
  toggleEmptyState();
  updateQueueHeader();
}

function initQueueTabs() {
  const queueBtn = document.getElementById('queue-tab-queue');
  const downloadedBtn = document.getElementById('queue-tab-downloaded');

  queueBtn?.addEventListener('click', () => setActiveDownloadsTab(DOWNLOADS_TAB.QUEUE));
  downloadedBtn?.addEventListener('click', () => setActiveDownloadsTab(DOWNLOADS_TAB.DOWNLOADED));

  const list = document.getElementById('queue-list');
  let touchStartX = null;
  let touchStartY = null;

  list?.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  }, { passive: true });

  list?.addEventListener('touchend', (event) => {
    if (touchStartX === null || touchStartY === null || event.changedTouches.length !== 1) {
      touchStartX = null;
      touchStartY = null;
      return;
    }

    const dx = event.changedTouches[0].clientX - touchStartX;
    const dy = event.changedTouches[0].clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;

    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) + 20) return;
    if (dx < 0 && activeDownloadsTab !== DOWNLOADS_TAB.DOWNLOADED) {
      setActiveDownloadsTab(DOWNLOADS_TAB.DOWNLOADED);
    } else if (dx > 0 && activeDownloadsTab !== DOWNLOADS_TAB.QUEUE) {
      setActiveDownloadsTab(DOWNLOADS_TAB.QUEUE);
    }
  }, { passive: true });
}

function setActiveDownloadsTab(tab) {
  if (tab !== DOWNLOADS_TAB.QUEUE && tab !== DOWNLOADS_TAB.DOWNLOADED) return;
  if (activeDownloadsTab === tab) return;
  activeDownloadsTab = tab;
  syncQueueTabsUI();
  renderActiveTabList();
  toggleEmptyState();
  updateQueueHeader();
}

function syncQueueTabsUI() {
  const queueBtn = document.getElementById('queue-tab-queue');
  const downloadedBtn = document.getElementById('queue-tab-downloaded');
  const view = document.getElementById('view-downloads');
  const queueActive = activeDownloadsTab === DOWNLOADS_TAB.QUEUE;

  if (queueBtn) {
    queueBtn.classList.toggle('is-active', queueActive);
    queueBtn.setAttribute('aria-selected', queueActive ? 'true' : 'false');
  }
  if (downloadedBtn) {
    downloadedBtn.classList.toggle('is-active', !queueActive);
    downloadedBtn.setAttribute('aria-selected', queueActive ? 'false' : 'true');
  }
  if (view) {
    view.dataset.activeTab = activeDownloadsTab;
  }
}

function renderActiveTabList() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  list.innerHTML = '';
  queueItemsForActiveTab().forEach((item) => {
    list.appendChild(renderQueueItem(item));
  });
}

function queueItemsForActiveTab() {
  if (activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED) {
    return state.queueArray().filter((item) => item.status === 'completed').reverse();
  }
  return state.queueArray().filter((item) => item.status !== 'completed');
}

function shouldRenderInActiveTab(item) {
  if (activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED) {
    return item.status === 'completed';
  }
  return item.status !== 'completed';
}

function toggleEmptyState() {
  const empty = document.getElementById('queue-empty');
  if (!empty) return;

  const isQueueTab = activeDownloadsTab === DOWNLOADS_TAB.QUEUE;
  const visibleCount = queueItemsForActiveTab().length;
  empty.style.display = visibleCount === 0 ? 'flex' : 'none';
  empty.setAttribute('aria-label', isQueueTab ? 'Queue is empty' : 'Downloaded list is empty');

  const title = empty.querySelector('.queue-empty__title');
  const hint = empty.querySelector('.queue-empty__hint');
  if (title) {
    title.textContent = isQueueTab ? 'No downloads yet' : 'No completed downloads yet';
  }
  if (hint) {
    hint.textContent = isQueueTab
      ? 'Paste a URL above and hit Enter or click Add'
      : 'Completed files move here automatically after download.';
  }
}

async function initBackendBridge() {
  if (!isTauriEnvironment()) {
    const status = document.getElementById('status-active-label');
    if (status) status.textContent = 'Preview mode (backend unavailable)';
    return;
  }

  try {
    const queue = await invokeCommand('queue_list');
    actions.replaceQueue((queue.jobs || []).map(normalizeJob));
  } catch (err) {
    console.error('[PullDown] Failed to load queue:', err);
  }

  try {
    const engineStatus = await invokeCommand('engines_get_status');
    console.info('[PullDown] engines_get_status:', engineStatus);
    applyEngineStatus(engineStatus);
  } catch (err) {
    console.error('[PullDown] Failed to load engine status:', err);
  }

  try {
    const settings = await invokeCommand('settings_get');
    applySettings(settings);
  } catch (err) {
    console.error('[PullDown] Failed to load settings:', err);
  }

  await listenEvent('pulldown://job-updated', (payload) => {
    if (!payload?.id) return;
    actions.upsertDownload(normalizeJob(payload));
  });

  await listenEvent('pulldown://job-removed', (payload) => {
    if (!payload?.jobId) return;
    actions.removeDownload(payload.jobId);
  });

  await listenEvent('pulldown://engine-install-progress', handleEngineInstallProgress);
}

function applyEngineStatus(status) {
  const yt = status?.ytDlp;
  const ff = status?.ffmpeg;
  const ytAvailable = Boolean(yt?.available);
  const ffAvailable = Boolean(ff?.available);
  const ytVersion = parseYtDlpVersion(yt?.version);
  const ffVersion = parseFfmpegVersion(ff?.version);
  const ytLatest = parseYtDlpVersion(yt?.latestVersion);
  const updateAvailable = Boolean(yt?.updateAvailable);

  const setDotState = (dot, available, warn = false) => {
    if (!dot) return;
    dot.classList.remove('status-dot--active', 'status-dot--green', 'status-dot--amber');
    if (!available || warn) {
      dot.classList.add('status-dot--amber');
    } else {
      dot.classList.add('status-dot--green');
    }
  };

  const statusEngines = document.querySelectorAll('.status-engine .mono');
  if (statusEngines[0]) {
    statusEngines[0].textContent = ytAvailable && ytVersion ? `yt-dlp ${ytVersion}` : 'yt-dlp missing';
  }
  if (statusEngines[1]) {
    statusEngines[1].textContent = ffAvailable && ffVersion ? `ffmpeg ${ffVersion}` : 'ffmpeg missing';
  }

  const cardVersions = document.querySelectorAll('.engine-card__version');
  if (cardVersions[0]) {
    cardVersions[0].textContent = ytAvailable && ytVersion ? `v${ytVersion}` : 'Not installed';
  }
  if (cardVersions[1]) {
    cardVersions[1].textContent = ffAvailable && ffVersion ? `v${ffVersion}` : 'Not installed';
  }

  const latestLabels = document.querySelectorAll('.engine-card__latest');
  if (latestLabels[0]) {
    if (!ytAvailable) {
      latestLabels[0].textContent = 'Install required';
    } else if (ytLatest) {
      latestLabels[0].textContent = updateAvailable
        ? `Latest: v${ytLatest}`
        : `Latest: v${ytVersion || ytLatest} (up to date)`;
    } else if (ytVersion) {
      latestLabels[0].textContent = `Latest: v${ytVersion} (up to date)`;
    } else {
      latestLabels[0].textContent = 'Install required';
    }
  }
  if (latestLabels[1]) {
    latestLabels[1].textContent = ffAvailable && ffVersion
      ? `Latest: v${ffVersion} (up to date)`
      : 'Install required';
  }

  const cardDots = document.querySelectorAll('.engine-card .status-dot');
  setDotState(cardDots[0], ytAvailable, updateAvailable);
  setDotState(cardDots[1], ffAvailable, false);

  const footerDots = document.querySelectorAll('.status-engine .status-dot');
  setDotState(footerDots[0], ytAvailable, updateAvailable);
  setDotState(footerDots[1], ffAvailable, false);

  const ytdlpBtn = document.getElementById('btn-engine-ytdlp');
  const ffmpegBtn = document.getElementById('btn-engine-ffmpeg');
  const installPrompt = document.getElementById('engine-install-prompt');

  if (!engineUiState.ytdlpBusy) {
    if (!ytAvailable) {
      engineUiState.ytdlpAction = 'install';
      setEngineButton(ytdlpBtn, 'Install yt-dlp', true, true);
    } else if (updateAvailable) {
      engineUiState.ytdlpAction = 'update';
      setEngineButton(ytdlpBtn, 'Update yt-dlp', true, true);
    } else {
      engineUiState.ytdlpAction = 'none';
      setEngineButton(ytdlpBtn, 'Up to date', false, false);
    }
  }

  if (!engineUiState.ffmpegBusy) {
    if (!ffAvailable) {
      engineUiState.ffmpegAction = 'install';
      setEngineButton(ffmpegBtn, 'Install ffmpeg', true, true);
    } else {
      engineUiState.ffmpegAction = 'none';
      setEngineButton(ffmpegBtn, 'Up to date', false, false);
    }
  }

  const missing = [];
  if (!ytAvailable) missing.push('yt-dlp');
  if (!ffAvailable) missing.push('ffmpeg');
  if (installPrompt) {
    if (missing.length > 0) {
      installPrompt.style.display = 'block';
      installPrompt.textContent = `Missing engine binaries: ${missing.join(', ')}. Install each missing engine below.`;
    } else {
      installPrompt.style.display = 'none';
    }
  }

  if (ytAvailable && !engineUiState.ytdlpBusy) {
    clearEngineProgress(ENGINE.YTDLP);
  }
  if (ffAvailable && !engineUiState.ffmpegBusy) {
    clearEngineProgress(ENGINE.FFMPEG);
  }

  actions.setEngineUpdateAvailable(updateAvailable && ytAvailable);
}

function initSettingsPanel() {
  const ytdlpBtn = document.getElementById('btn-engine-ytdlp');
  const ffmpegBtn = document.getElementById('btn-engine-ffmpeg');
  const log = document.getElementById('engine-update-log');
  const browseBtn = document.getElementById('btn-browse-download-dir');
  const statusLabel = document.getElementById('status-active-label');

  ytdlpBtn?.addEventListener('click', async () => {
    if (!isTauriEnvironment() || engineUiState.ytdlpBusy) return;

    if (engineUiState.ytdlpAction === 'update') {
      await runYtdlpUpdate(log, statusLabel);
      return;
    }

    if (engineUiState.ytdlpAction !== 'install') return;

    await runEngineInstall({
      engine: ENGINE.YTDLP,
      command: 'engines_install_ytdlp',
      button: ytdlpBtn,
      log,
      statusLabel,
    });
  });

  ffmpegBtn?.addEventListener('click', async () => {
    if (!isTauriEnvironment() || engineUiState.ffmpegBusy) return;
    if (engineUiState.ffmpegAction !== 'install') return;

    await runEngineInstall({
      engine: ENGINE.FFMPEG,
      command: 'engines_install_ffmpeg',
      button: ffmpegBtn,
      log,
      statusLabel,
    });
  });

  browseBtn?.addEventListener('click', async () => {
    if (!isTauriEnvironment()) return;
    browseBtn.disabled = true;
    if (statusLabel) statusLabel.textContent = 'Selecting download folder...';
    try {
      const updatedSettings = await invokeCommand('settings_pick_download_dir');
      if (updatedSettings) {
        applySettings(updatedSettings);
        if (statusLabel) statusLabel.textContent = 'Download folder updated';
      } else if (statusLabel) {
        statusLabel.textContent = 'Folder selection canceled';
      }
    } catch (err) {
      if (statusLabel) statusLabel.textContent = String(err);
      console.error('[PullDown] Failed to pick download folder:', err);
    } finally {
      browseBtn.disabled = false;
    }
  });
}

async function runEngineInstall({ engine, command, button, log, statusLabel }) {
  const engineLabel = engine === ENGINE.YTDLP ? 'yt-dlp' : 'ffmpeg';

  setEngineBusy(engine, true);
  button.disabled = true;
  button.textContent = 'Installing...';
  setEngineProgress(engine, {
    visible: true,
    percent: 0,
    text: `Starting ${engineLabel} installation...`,
    active: true,
  });

  if (statusLabel) {
    statusLabel.textContent = `Installing ${engineLabel}...`;
  }
  appendEngineLog(log, `Installing ${engineLabel}...`);

  try {
    const result = await invokeCommand(command);
    appendEngineLog(log, result || `${engineLabel} installation completed.`);
    if (statusLabel) {
      statusLabel.textContent = `${engineLabel} installation completed`;
    }
  } catch (err) {
    appendEngineLog(log, `Failed to install ${engineLabel}: ${String(err)}`);
    setEngineProgress(engine, {
      visible: true,
      percent: 0,
      text: `Failed to install ${engineLabel}`,
      active: false,
    });
    if (statusLabel) {
      statusLabel.textContent = `${engineLabel} installation failed`;
    }
    console.error(`[PullDown] Failed to install ${engineLabel}:`, err);
  } finally {
    setEngineBusy(engine, false);
    const status = await invokeCommand('engines_get_status').catch(() => null);
    if (status) {
      applyEngineStatus(status);
    }
  }
}

async function runYtdlpUpdate(log, statusLabel) {
  const button = document.getElementById('btn-engine-ytdlp');
  if (!button) return;

  setEngineBusy(ENGINE.YTDLP, true);
  button.disabled = true;
  button.textContent = 'Updating...';
  appendEngineLog(log, 'Updating yt-dlp...');
  if (statusLabel) {
    statusLabel.textContent = 'Updating yt-dlp...';
  }

  try {
    const result = await invokeCommand('engines_update_yt_dlp');
    appendEngineLog(log, result || 'yt-dlp update completed.');
    if (statusLabel) {
      statusLabel.textContent = 'yt-dlp update completed';
    }
  } catch (err) {
    appendEngineLog(log, `Failed to update yt-dlp: ${String(err)}`);
    if (statusLabel) {
      statusLabel.textContent = 'yt-dlp update failed';
    }
    console.error('[PullDown] Failed to update yt-dlp:', err);
  } finally {
    setEngineBusy(ENGINE.YTDLP, false);
    const status = await invokeCommand('engines_get_status').catch(() => null);
    if (status) {
      applyEngineStatus(status);
    }
  }
}

function handleEngineInstallProgress(payload) {
  const engine = normalizeEngineKey(payload?.engine);
  if (!engine) return;

  const stage = String(payload?.stage || '').toLowerCase();
  const message = String(payload?.message || 'Installing engine');
  const percent = toClampedPercent(payload?.progressPercent);
  const bytesDownloaded = toOptionalNumber(payload?.bytesDownloaded);
  const bytesTotal = toOptionalNumber(payload?.bytesTotal);

  const text = formatEngineProgressText({ message, percent, bytesDownloaded, bytesTotal });
  const active = stage !== 'completed' && stage !== 'failed';

  setEngineProgress(engine, {
    visible: true,
    percent,
    text,
    active,
  });

  const statusLabel = document.getElementById('status-active-label');
  if (statusLabel) {
    statusLabel.textContent = text;
  }
}

function normalizeEngineKey(raw) {
  if (!raw) return '';
  const value = String(raw).toLowerCase();
  if (value.includes('yt')) return ENGINE.YTDLP;
  if (value.includes('ffmpeg')) return ENGINE.FFMPEG;
  return '';
}

function setEngineBusy(engine, busy) {
  if (engine === ENGINE.YTDLP) {
    engineUiState.ytdlpBusy = busy;
    return;
  }
  if (engine === ENGINE.FFMPEG) {
    engineUiState.ffmpegBusy = busy;
  }
}

function setEngineButton(button, label, enabled, primary) {
  if (!button) return;
  button.textContent = label;
  button.disabled = !enabled;
  button.classList.toggle('btn--primary', Boolean(primary));
  button.classList.toggle('btn--ghost', !primary);
}

function setEngineProgress(engine, { visible, percent, text, active }) {
  const els = getEngineProgressElements(engine);
  if (!els) return;

  if (!visible) {
    clearEngineProgress(engine);
    return;
  }

  els.wrapper.style.display = 'flex';
  if (Number.isFinite(percent)) {
    els.fill.style.width = `${percent}%`;
  }
  els.fill.dataset.active = active ? 'true' : 'false';
  els.text.textContent = text || (Number.isFinite(percent) ? `${percent}%` : 'Installing...');
}

function clearEngineProgress(engine) {
  const els = getEngineProgressElements(engine);
  if (!els) return;

  els.wrapper.style.display = 'none';
  els.fill.style.width = '0%';
  els.fill.dataset.active = 'false';
  els.text.textContent = '0%';
}

function getEngineProgressElements(engine) {
  if (engine === ENGINE.YTDLP) {
    return {
      wrapper: document.getElementById('engine-progress-ytdlp'),
      fill: document.getElementById('engine-progress-ytdlp-fill'),
      text: document.getElementById('engine-progress-ytdlp-text'),
    };
  }
  if (engine === ENGINE.FFMPEG) {
    return {
      wrapper: document.getElementById('engine-progress-ffmpeg'),
      fill: document.getElementById('engine-progress-ffmpeg-fill'),
      text: document.getElementById('engine-progress-ffmpeg-text'),
    };
  }
  return null;
}

function formatEngineProgressText({ message, percent, bytesDownloaded, bytesTotal }) {
  if (Number.isFinite(percent) && Number.isFinite(bytesTotal)) {
    return `${message} ${percent}% (${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)})`;
  }
  if (Number.isFinite(percent)) {
    return `${message} ${percent}%`;
  }
  if (Number.isFinite(bytesDownloaded) && Number.isFinite(bytesTotal)) {
    return `${message} (${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)})`;
  }
  return message;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = units[0];

  for (let i = 1; i < units.length; i += 1) {
    if (size < 1024) break;
    size /= 1024;
    unit = units[i];
  }

  return `${size.toFixed(unit === 'B' ? 0 : 1)} ${unit}`;
}

function toClampedPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function toOptionalNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function appendEngineLog(log, message) {
  if (!log) return;
  const line = String(message || '').trim();
  if (!line) return;

  log.style.display = 'block';
  log.textContent = log.textContent ? `${log.textContent}\n${line}` : line;
}

function applySettings(settings) {
  const dir = settings?.downloadDir ? String(settings.downloadDir) : '';
  if (!dir) return;

  const dirInput = document.getElementById('settings-download-dir-input');
  if (dirInput) {
    dirInput.value = dir;
    dirInput.title = dir;
  }

  const storage = document.getElementById('status-storage');
  if (storage) {
    storage.textContent = dir;
    storage.title = dir;
  }
}

function normalizeJob(job) {
  const thumbnail = typeof job.thumbnail === 'string' && job.thumbnail.trim()
    ? job.thumbnail.trim()
    : null;

  return {
    id: job.id,
    title: job.title,
    url: job.url,
    platform: job.platform || 'Web',
    duration: job.duration || '--',
    thumbnail,
    color: job.color || '#2d6a4f',
    res: job.res ?? null,
    codec: job.codec || 'Auto',
    audio: job.audio ?? null,
    status: job.status || 'queued',
    progress: Number.isFinite(job.progress) ? job.progress : 0,
    bytesTotal: Number.isFinite(job.bytesTotal) ? job.bytesTotal : 0,
    bytesDown: Number.isFinite(job.bytesDown) ? job.bytesDown : 0,
    speedBps: Number.isFinite(job.speedBps) ? job.speedBps : 0,
    filePath: job.filePath || '',
    error: job.error || null,
  };
}

function parseYtDlpVersion(raw) {
  if (!raw) return '';
  return String(raw).trim();
}

function parseFfmpegVersion(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  const match = text.match(/ffmpeg version\s+([^\s]+)/i);
  if (match) return match[1];
  return text;
}
