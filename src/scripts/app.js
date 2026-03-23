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
import { initPlayerView } from './app/player/index.js';
import { initConverterView } from './app/converter/index.js';
import { applyEngineStatus, applySettings, handleEngineInstallProgress, initSettingsPanel } from './app/settings/index.js';

const DOWNLOADS_TAB = {
  QUEUE: 'queue',
  DOWNLOADED: 'downloaded',
};

const SCAN_ICON_START = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M5 5h3v3M5 12a7 7 0 117 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const SCAN_ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>
  <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>
</svg>`;
const SCAN_ICON_RESUME = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M7 5l11 7-11 7V5z" fill="currentColor"/>
</svg>`;
const SCAN_ICON_STOP = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
</svg>`;
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
  initConverterView();
  initPlayerView();
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

  if (startBtn) {
    startBtn.innerHTML = SCAN_ICON_START;
    startBtn.setAttribute('title', 'Start scan');
  }
  if (pauseBtn) {
    pauseBtn.innerHTML = SCAN_ICON_PAUSE;
    pauseBtn.setAttribute('title', 'Pause scan');
  }
  if (stopBtn) {
    stopBtn.innerHTML = SCAN_ICON_STOP;
    stopBtn.setAttribute('title', 'Stop scan');
  }

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
  startBtn.innerHTML = SCAN_ICON_START;
  startBtn.setAttribute('title', 'Start scan');
  pauseBtn.innerHTML = downloadedLibraryScanPaused ? SCAN_ICON_RESUME : SCAN_ICON_PAUSE;
  pauseBtn.setAttribute('title', downloadedLibraryScanPaused ? 'Resume scan' : 'Pause scan');
  pauseBtn.setAttribute(
    'aria-label',
    downloadedLibraryScanPaused ? 'Resume media scan' : 'Pause media scan',
  );
  stopBtn.innerHTML = SCAN_ICON_STOP;
  stopBtn.setAttribute('title', downloadedLibraryStopPending ? 'Stopping scan' : 'Stop scan');
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

function normalizeFsPath(path) {
  return String(path || '').trim().replace(/\\/g, '/').toLowerCase();
}

function findCompletedQueueItemByPath(path) {
  const target = normalizeFsPath(path);
  if (!target) return null;
  const queue = state.queueArray();
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (item.status !== 'completed') continue;
    if (normalizeFsPath(item.filePath) === target) return item;
  }
  return null;
}

function normalizeLibraryItem(item) {
  const path = typeof item?.path === 'string' ? item.path.trim() : '';
  const queueItem = findCompletedQueueItemByPath(path);
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
  const knownThumbnail = typeof queueItem?.thumbnail === 'string' && queueItem.thumbnail.trim()
    ? queueItem.thumbnail.trim()
    : null;

  return {
    id,
    source: 'library',
    title: title || 'Untitled video',
    url: '',
    platform: queueItem?.platform || 'Local',
    duration: queueItem?.duration || '--',
    thumbnail: knownThumbnail,
    color: queueItem?.color || '#2d6a4f',
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


