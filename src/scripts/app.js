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
let downloadedLibraryItems = [];
let downloadedLibraryScanId = null;
let downloadedLibraryScanning = false;
let downloadedLibraryScanPaused = false;
let downloadedLibraryStopPending = false;
let downloadedLibraryControlBusy = false;
let downloadedLibraryStopped = false;
let downloadedSearchQuery = '';
let downloadedLibraryScannedFiles = 0;
let downloadedLibraryVisitedDirs = 0;
let downloadedLibraryMatchedFiles = 0;
let downloadedLibraryRootsDone = 0;
let downloadedLibraryRootsTotal = 0;
let renderCycleToken = 0;
let downloadedLibraryHasSnapshot = false;

document.addEventListener('DOMContentLoaded', async () => {
  initRouter();
  initModal();
  initSidebar();
  initTopbar();
  initQueueTabs();
  initDownloadedScanControls();
  initQueueDomSync();
  startProgressSimulation();
  initSettingsPanel();
  await initBackendBridge();
});

function initQueueDomSync() {
  stateEmitter.on('queue:add', (item) => {
    if (isDownloadedTabUsingLibrary()) {
      syncDownloadedCountMeta();
      toggleEmptyState();
      updateQueueHeader();
      return;
    }
    if (!shouldRenderInActiveTab(item)) {
      syncDownloadedCountMeta();
      toggleEmptyState();
      updateQueueHeader();
      return;
    }
    const list = document.getElementById('queue-list');
    if (!list) return;
    if (document.getElementById(item.id)) return;
    list.appendChild(renderQueueItem(item));
    syncDownloadedCountMeta();
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:update', ({ item }) => {
    if (isDownloadedTabUsingLibrary()) {
      syncDownloadedCountMeta();
      toggleEmptyState();
      updateQueueHeader();
      return;
    }
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
    syncDownloadedCountMeta();
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:remove', (id) => {
    const card = document.getElementById(id);
    if (card) card.remove();
    syncDownloadedCountMeta();
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('queue:replace', () => {
    renderActiveTabList();
    syncDownloadedCountMeta();
    toggleEmptyState();
    updateQueueHeader();
  });

  stateEmitter.on('downloads:search', (rawQuery) => {
    const normalized = String(rawQuery || '').trim().toLowerCase();
    if (normalized === downloadedSearchQuery) return;
    downloadedSearchQuery = normalized;
    if (activeDownloadsTab !== DOWNLOADS_TAB.DOWNLOADED) return;
    renderActiveTabList();
    syncDownloadedCountMeta();
    toggleEmptyState();
    updateLibraryScanStatusBar();
    updateQueueHeader();
  });

  syncQueueTabsUI();
  updateLibraryScanStatusBar();
  renderActiveTabList();
  syncDownloadedCountMeta();
  toggleEmptyState();
  updateQueueHeader();
  stateEmitter.emit('downloads:tab:change', { tab: activeDownloadsTab });
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

function initDownloadedScanControls() {
  const startBtn = document.getElementById('btn-scan-start');
  const pauseBtn = document.getElementById('btn-scan-pause');
  const stopBtn = document.getElementById('btn-scan-stop');

  startBtn?.addEventListener('click', async () => {
    await startDownloadedLibraryScan(true);
  });

  pauseBtn?.addEventListener('click', async () => {
    if (!downloadedLibraryScanning) return;
    if (downloadedLibraryScanPaused) {
      await resumeDownloadedLibraryScan();
      return;
    }
    await pauseDownloadedLibraryScan();
  });

  stopBtn?.addEventListener('click', async () => {
    await stopDownloadedLibraryScan();
  });

  updateLibraryScanControls();
}

function setActiveDownloadsTab(tab) {
  if (tab !== DOWNLOADS_TAB.QUEUE && tab !== DOWNLOADS_TAB.DOWNLOADED) return;
  if (activeDownloadsTab === tab) return;
  activeDownloadsTab = tab;
  syncQueueTabsUI();
  stateEmitter.emit('downloads:tab:change', { tab: activeDownloadsTab });
  updateLibraryScanStatusBar();
  renderActiveTabList();
  toggleEmptyState();
  updateQueueHeader();
}

function syncQueueTabsUI() {
  const queueBtn = document.getElementById('queue-tab-queue');
  const downloadedBtn = document.getElementById('queue-tab-downloaded');
  const view = document.getElementById('view-downloads');
  const speedIndicator = document.getElementById('speed-indicator');
  const scanControls = document.getElementById('downloaded-scan-controls');
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
  if (speedIndicator) {
    speedIndicator.style.display = queueActive ? '' : 'none';
  }
  if (scanControls) {
    scanControls.style.display = queueActive ? 'none' : 'inline-flex';
  }
  updateLibraryScanControls();
  syncDownloadedCountMeta();
}

function renderActiveTabList() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  const token = ++renderCycleToken;
  list.innerHTML = '';
  const items = queueItemsForActiveTab();
  if (items.length === 0) return;

  let idx = 0;
  const renderChunk = () => {
    if (token !== renderCycleToken) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(idx + 60, items.length);
    for (; idx < end; idx += 1) {
      fragment.appendChild(renderQueueItem(items[idx]));
    }
    list.appendChild(fragment);
    if (idx < items.length) {
      requestAnimationFrame(renderChunk);
    }
  };

  requestAnimationFrame(renderChunk);
}

function queueItemsForActiveTab() {
  if (activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED) {
    if (isTauriEnvironment()) {
      return filterDownloadedItems(downloadedLibraryItems, downloadedSearchQuery);
    }
    return filterDownloadedItems(
      state.queueArray().filter((item) => item.status === 'completed').reverse(),
      downloadedSearchQuery,
    );
  }
  return state.queueArray().filter((item) => item.status !== 'completed');
}

function shouldRenderInActiveTab(item) {
  if (activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED) {
    if (isTauriEnvironment()) return false;
    return item.status === 'completed';
  }
  return item.status !== 'completed';
}

function isDownloadedTabUsingLibrary() {
  return activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED && isTauriEnvironment();
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
  if (!isQueueTab && isTauriEnvironment()) {
    if (downloadedLibraryScanning) {
      if (title) title.textContent = downloadedLibraryScanPaused ? 'Scan paused' : 'Scanning local media...';
      if (hint) hint.textContent = downloadedLibraryScanPaused
        ? 'Resume or stop the scan from the controls above.'
        : 'Searching all drives for video and audio files.';
      return;
    }
    if (!downloadedLibraryHasSnapshot) {
      if (title) title.textContent = 'No media scanned yet';
      if (hint) hint.textContent = 'Click Start Scan to load local video and audio files.';
      return;
    }
    if (downloadedSearchQuery) {
      if (title) title.textContent = 'No matching files';
      if (hint) hint.textContent = `No media files matched "${downloadedSearchQuery}".`;
      return;
    }
    if (title) title.textContent = 'No media files found';
    if (hint) hint.textContent = 'No local video/audio files were found on available drives.';
    return;
  }

  if (title) {
    title.textContent = isQueueTab ? 'No downloads yet' : 'No downloaded items yet';
  }
  if (hint) {
    hint.textContent = isQueueTab
      ? 'Paste a URL above and hit Enter or click Add'
      : downloadedSearchQuery
        ? `No items matched "${downloadedSearchQuery}".`
        : 'Completed downloads will appear here.';
  }
}

function syncDownloadedCountMeta() {
  const view = document.getElementById('view-downloads');
  if (!view) return;

  const count = activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED
    ? queueItemsForActiveTab().length
    : state.queueArray().filter((item) => item.status === 'completed').length;
  view.dataset.downloadedCount = String(count);
}

async function startDownloadedLibraryScan(force) {
  if (!isTauriEnvironment()) return;
  if (downloadedLibraryControlBusy) return;

  if (downloadedLibraryScanning) {
    if (downloadedLibraryScanPaused) {
      await resumeDownloadedLibraryScan();
    }
    return;
  }

  if (!force && downloadedLibraryHasSnapshot) {
    syncDownloadedCountMeta();
    updateLibraryScanStatusBar();
    updateQueueHeader();
    return;
  }

  downloadedLibraryControlBusy = true;
  downloadedLibraryStopped = false;
  downloadedLibraryStopPending = false;
  downloadedLibraryItems = [];
  downloadedLibraryScannedFiles = 0;
  downloadedLibraryVisitedDirs = 0;
  downloadedLibraryMatchedFiles = 0;
  downloadedLibraryRootsDone = 0;
  downloadedLibraryRootsTotal = 0;
  downloadedLibraryScanning = true;
  downloadedLibraryScanPaused = false;
  downloadedLibraryScanId = null;
  downloadedLibraryHasSnapshot = false;
  syncDownloadedCountMeta();

  if (isDownloadedTabUsingLibrary()) {
    renderActiveTabList();
    toggleEmptyState();
  }
  updateLibraryScanControls();
  updateLibraryScanStatusBar();
  updateQueueHeader();

  try {
    const startedScanId = await invokeCommand('library_scan_start');
    const parsedId = Number(startedScanId);
    downloadedLibraryScanId = Number.isFinite(parsedId) && parsedId > 0 ? Math.floor(parsedId) : null;
  } catch (err) {
    downloadedLibraryScanning = false;
    downloadedLibraryScanPaused = false;
    updateLibraryScanStatusBar(String(err));
    toggleEmptyState();
    updateQueueHeader();
    console.error('[PullDown] Failed to start media scan:', err);
  } finally {
    downloadedLibraryControlBusy = false;
    updateLibraryScanControls();
  }
}

async function pauseDownloadedLibraryScan() {
  if (!isTauriEnvironment()) return;
  if (!downloadedLibraryScanning || downloadedLibraryScanPaused || downloadedLibraryControlBusy) return;

  downloadedLibraryControlBusy = true;
  updateLibraryScanControls();

  try {
    const ok = await invokeCommand('library_scan_pause');
    if (ok) {
      downloadedLibraryScanPaused = true;
    }
  } catch (err) {
    console.error('[PullDown] Failed to pause media scan:', err);
  } finally {
    downloadedLibraryControlBusy = false;
    updateLibraryScanControls();
    updateLibraryScanStatusBar();
    updateQueueHeader();
  }
}

async function resumeDownloadedLibraryScan() {
  if (!isTauriEnvironment()) return;
  if (!downloadedLibraryScanning || !downloadedLibraryScanPaused || downloadedLibraryControlBusy) return;

  downloadedLibraryControlBusy = true;
  updateLibraryScanControls();

  try {
    const ok = await invokeCommand('library_scan_resume');
    if (ok) {
      downloadedLibraryScanPaused = false;
      downloadedLibraryStopped = false;
    }
  } catch (err) {
    console.error('[PullDown] Failed to resume media scan:', err);
  } finally {
    downloadedLibraryControlBusy = false;
    updateLibraryScanControls();
    updateLibraryScanStatusBar();
    updateQueueHeader();
  }
}

async function stopDownloadedLibraryScan() {
  if (!isTauriEnvironment()) return;
  if (!downloadedLibraryScanning || downloadedLibraryControlBusy || downloadedLibraryStopPending) return;

  downloadedLibraryControlBusy = true;
  downloadedLibraryStopPending = true;
  updateLibraryScanControls();
  updateLibraryScanStatusBar();
  updateQueueHeader();

  try {
    const ok = await invokeCommand('library_scan_stop');
    if (!ok) {
      downloadedLibraryStopPending = false;
    }
  } catch (err) {
    downloadedLibraryStopPending = false;
    console.error('[PullDown] Failed to stop media scan:', err);
  } finally {
    downloadedLibraryControlBusy = false;
    updateLibraryScanControls();
    updateLibraryScanStatusBar();
    updateQueueHeader();
  }
}

function updateLibraryScanControls() {
  const startBtn = document.getElementById('btn-scan-start');
  const pauseBtn = document.getElementById('btn-scan-pause');
  const stopBtn = document.getElementById('btn-scan-stop');
  if (!startBtn || !pauseBtn || !stopBtn) return;

  const controlsVisible = activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED;
  startBtn.disabled = !controlsVisible || downloadedLibraryControlBusy || downloadedLibraryScanning;
  pauseBtn.disabled = !controlsVisible || downloadedLibraryControlBusy || !downloadedLibraryScanning;
  stopBtn.disabled = !controlsVisible
    || downloadedLibraryControlBusy
    || !downloadedLibraryScanning
    || downloadedLibraryStopPending;
  pauseBtn.textContent = downloadedLibraryScanPaused ? 'Resume' : 'Pause';
}

function handleLibraryScanBatch(payload) {
  if (!payload) return;
  const scanId = Number(payload.scanId);
  if (!Number.isFinite(scanId)) return;
  if (downloadedLibraryScanId !== null && scanId !== downloadedLibraryScanId) return;
  downloadedLibraryScanId = scanId;

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (rawItems.length === 0) return;

  const normalized = rawItems.map(normalizeLibraryItem).filter((item) => item.filePath);
  if (normalized.length === 0) return;

  const incomingSorted = normalized.slice().sort(compareDownloadedItems);
  const existingOldest = downloadedLibraryItems.length > 0
    ? downloadedLibraryItems[downloadedLibraryItems.length - 1]
    : null;
  const canAppendInOrder = !existingOldest
    || compareDownloadedItems(existingOldest, incomingSorted[0]) <= 0;
  downloadedLibraryItems = mergeSortedDownloadedItems(downloadedLibraryItems, incomingSorted);
  syncDownloadedCountMeta();

  if (isDownloadedTabUsingLibrary()) {
    if (!downloadedSearchQuery && canAppendInOrder) {
      appendDownloadedItemsToDom(incomingSorted);
    } else {
      renderActiveTabList();
    }
    toggleEmptyState();
  }
  updateLibraryScanStatusBar();
  updateQueueHeader();
}

function handleLibraryScanProgress(payload) {
  if (!payload) return;
  const scanId = Number(payload.scanId);
  if (!Number.isFinite(scanId)) return;
  if (downloadedLibraryScanId !== null && scanId !== downloadedLibraryScanId) return;
  downloadedLibraryScanId = scanId;

  downloadedLibraryScannedFiles = toOptionalInteger(payload.scannedFiles);
  downloadedLibraryVisitedDirs = toOptionalInteger(payload.visitedDirs);
  downloadedLibraryMatchedFiles = toOptionalInteger(payload.matchedFiles);
  downloadedLibraryRootsDone = toOptionalInteger(payload.rootsDone);
  downloadedLibraryRootsTotal = toOptionalInteger(payload.rootsTotal);
  downloadedLibraryScanPaused = Boolean(payload.paused);

  const done = Boolean(payload.done);
  const error = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : null;
  const stoppedByUser = error === 'Stopped by user';
  if (done) {
    downloadedLibraryScanning = false;
    downloadedLibraryScanPaused = false;
    downloadedLibraryStopPending = false;
    downloadedLibraryHasSnapshot = true;
    downloadedLibraryStopped = stoppedByUser;
    downloadedLibraryItems.sort(compareDownloadedItems);
    if (isDownloadedTabUsingLibrary()) {
      renderActiveTabList();
      toggleEmptyState();
    }
  } else {
    downloadedLibraryStopped = false;
    downloadedLibraryScanning = true;
  }

  syncDownloadedCountMeta();
  updateLibraryScanControls();
  updateLibraryScanStatusBar(stoppedByUser ? '' : error);
  updateQueueHeader();
}

function appendDownloadedItemsToDom(items) {
  const list = document.getElementById('queue-list');
  if (!list || !Array.isArray(items) || items.length === 0) return;
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(renderQueueItem(item)));
  list.appendChild(fragment);
}

function updateLibraryScanStatusBar(errorMessage = '') {
  const view = document.getElementById('view-downloads');
  const inDownloadedTab = activeDownloadsTab === DOWNLOADS_TAB.DOWNLOADED;
  const scanVisible = downloadedLibraryScanning && inDownloadedTab;
  const statusOwned = inDownloadedTab && isTauriEnvironment();
  if (view) {
    view.dataset.libraryScanActive = scanVisible ? 'true' : 'false';
    view.dataset.libraryStatusOwned = statusOwned ? 'true' : 'false';
  }

  const wrapper = document.getElementById('library-scan-progress');
  const fill = document.getElementById('library-scan-progress-fill');
  const text = document.getElementById('library-scan-progress-text');
  const status = document.getElementById('status-active-label');

  if (!wrapper || !fill || !text || !status) return;

  if (!inDownloadedTab) {
    wrapper.style.display = 'none';
    return;
  }

  if (errorMessage) {
    wrapper.style.display = 'none';
    status.textContent = `Scan failed: ${errorMessage}`;
    return;
  }

  if (downloadedLibraryScanning) {
    wrapper.style.display = 'flex';
    if (downloadedLibraryScanPaused) {
      fill.dataset.indeterminate = 'false';
      fill.style.width = '100%';
      status.textContent = 'Scan paused';
    } else if (downloadedLibraryStopPending) {
      fill.dataset.indeterminate = 'false';
      fill.style.width = '100%';
      status.textContent = 'Stopping scan...';
    } else {
      fill.dataset.indeterminate = 'true';
      fill.style.width = '35%';
      status.textContent = 'Scanning local media...';
    }
    const detail = `${formatCount(downloadedLibraryMatchedFiles)} found | ${formatCount(downloadedLibraryScannedFiles)} checked | ${formatCount(downloadedLibraryVisitedDirs)} dirs`;
    const roots = downloadedLibraryRootsTotal > 0
      ? ` | drives ${downloadedLibraryRootsDone}/${downloadedLibraryRootsTotal}`
      : '';
    text.textContent = downloadedLibraryScanPaused
      ? `Paused ${detail}${roots}`
      : `Scanning ${detail}${roots}`;
    return;
  }

  wrapper.style.display = 'none';
  if (downloadedLibraryStopped) {
    status.textContent = 'Scan stopped';
    return;
  }
  if (!downloadedLibraryHasSnapshot) {
    status.textContent = 'Click Start Scan to load local media';
    return;
  }
  const visibleCount = queueItemsForActiveTab().length;
  if (downloadedSearchQuery) {
    status.textContent = `${visibleCount} match${visibleCount === 1 ? '' : 'es'} for "${downloadedSearchQuery}"`;
    return;
  }
  status.textContent = `${formatCount(downloadedLibraryItems.length)} media file${downloadedLibraryItems.length === 1 ? '' : 's'} loaded`;
}
function toOptionalInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function formatCount(value) {
  return toOptionalInteger(value).toLocaleString();
}

function compareDownloadedItems(a, b) {
  const at = Number(a?.createdUnixSeconds) || 0;
  const bt = Number(b?.createdUnixSeconds) || 0;
  if (bt !== at) return bt - at;
  return String(a?.filePath || '').localeCompare(String(b?.filePath || ''));
}

function mergeSortedDownloadedItems(existing, incoming) {
  if (!Array.isArray(existing) || existing.length === 0) return incoming.slice();
  if (!Array.isArray(incoming) || incoming.length === 0) return existing.slice();

  const merged = [];
  let i = 0;
  let j = 0;

  while (i < existing.length && j < incoming.length) {
    if (compareDownloadedItems(existing[i], incoming[j]) <= 0) {
      merged.push(existing[i]);
      i += 1;
    } else {
      merged.push(incoming[j]);
      j += 1;
    }
  }

  while (i < existing.length) {
    merged.push(existing[i]);
    i += 1;
  }
  while (j < incoming.length) {
    merged.push(incoming[j]);
    j += 1;
  }

  return merged;
}

function filterDownloadedItems(items, query) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    const title = String(item?.title || '').toLowerCase();
    const path = String(item?.filePath || '').toLowerCase();
    const codec = String(item?.codec || '').toLowerCase();
    return title.includes(needle) || path.includes(needle) || codec.includes(needle);
  });
}

function normalizeLibraryItem(item) {
  const path = typeof item?.path === 'string' ? item.path.trim() : '';
  const id = typeof item?.id === 'string' && item.id.trim()
    ? item.id.trim()
    : `media-${hashString(path)}`;
  const title = typeof item?.title === 'string' && item.title.trim()
    ? item.title.trim()
    : titleFromPath(path);
  const extension = typeof item?.extension === 'string' ? item.extension.trim().toUpperCase() : '';
  const sizeBytesRaw = Number(item?.sizeBytes);
  const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? sizeBytesRaw : 0;
  const createdRaw = Number(item?.createdUnixSeconds);
  const createdUnixSeconds = Number.isFinite(createdRaw) && createdRaw > 0 ? Math.floor(createdRaw) : 0;
  const mediaType = isAudioExtension(extension) ? 'Audio' : 'Video';

  return {
    id,
    source: 'library',
    title: title || 'Untitled video',
    url: '',
    platform: 'Local',
    duration: '--',
    thumbnail: null,
    color: '#2d6a4f',
    res: null,
    codec: `${mediaType}${extension ? ` (${extension})` : ''}`,
    audio: null,
    status: 'completed',
    progress: 100,
    bytesTotal: sizeBytes,
    bytesDown: sizeBytes,
    speedBps: 0,
    filePath: path,
    createdUnixSeconds,
    error: null,
  };
}

function titleFromPath(path) {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const tail = normalized.split('/').pop() || '';
  return tail.replace(/\.[^/.]+$/, '').trim();
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function isAudioExtension(extension) {
  const ext = String(extension || '').trim().toUpperCase();
  return ['MP3', 'M4A', 'AAC', 'WAV', 'FLAC', 'OGG', 'OPUS', 'WMA', 'ALAC', 'AIFF', 'AIF', 'MKA', 'AMR', 'AC3', 'DTS', 'APE', 'M4B'].includes(ext);
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
  await listenEvent('pulldown://library-scan-progress', handleLibraryScanProgress);
  await listenEvent('pulldown://library-scan-batch', handleLibraryScanBatch);
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
    source: 'queue',
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


