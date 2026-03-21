/**
 * progressBar.js - Queue header/status indicators driven by real queue state.
 */

import { state, stateEmitter } from '../state.js';
import { formatSpeed } from '../utils.js';

let _initialized = false;

export function startProgressSimulation() {
  if (_initialized) return;
  _initialized = true;

  stateEmitter.on('queue:add', updateQueueHeader);
  stateEmitter.on('queue:update', updateQueueHeader);
  stateEmitter.on('queue:remove', updateQueueHeader);
  stateEmitter.on('queue:replace', updateQueueHeader);

  updateQueueHeader();
}

export function updateQueueHeader() {
  const countEl = document.getElementById('queue-count');
  const activeEl = document.getElementById('active-count');
  const speedEl = document.getElementById('speed-indicator');
  const statusEl = document.getElementById('status-active-label');

  const tab = currentDownloadsTab();
  const scanActive = isLibraryScanActive();
  const statusOwned = isLibraryStatusOwned();
  const downloadedCount = readDownloadedCountFromView();
  const allItems = state.queueArray();
  const queueItems = allItems.filter((item) => item.status !== 'completed');
  const total = tab === 'downloaded' ? downloadedCount : queueItems.length;
  const active = queueItems.filter(
    (item) => item.status === 'downloading' || item.status === 'postprocessing'
  ).length;
  const speedBps = queueItems.reduce((acc, item) => {
    if (item.status !== 'downloading') return acc;
    return acc + (item.speedBps || 0);
  }, 0);

  if (countEl) {
    countEl.textContent = `${total} item${total === 1 ? '' : 's'}`;
  }

  if (activeEl) {
    if (tab === 'queue' && active > 0) {
      activeEl.textContent = `${active} active`;
      activeEl.style.display = '';
    } else {
      activeEl.style.display = 'none';
    }
  }

  if (speedEl) {
    speedEl.textContent = tab === 'queue' && speedBps > 0 ? `down ${formatSpeed(speedBps)}` : '';
  }

  if (statusEl) {
    if (tab === 'downloaded' && (scanActive || statusOwned)) {
      // app.js owns downloaded-tab status text.
    } else if (tab === 'downloaded') {
      statusEl.textContent = total > 0
        ? `${total} downloaded item${total > 1 ? 's' : ''}`
        : 'No downloaded items yet';
    } else if (active > 0) {
      statusEl.textContent = `${active} active download${active > 1 ? 's' : ''}`;
    } else if (total > 0) {
      statusEl.textContent = `${total} item${total > 1 ? 's' : ''} in queue`;
    } else {
      statusEl.textContent = 'Ready';
    }
  }
}

function currentDownloadsTab() {
  const view = document.getElementById('view-downloads');
  const tab = view?.dataset?.activeTab;
  return tab === 'downloaded' ? 'downloaded' : 'queue';
}

function readDownloadedCountFromView() {
  const view = document.getElementById('view-downloads');
  const raw = Number(view?.dataset?.downloadedCount ?? '0');
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function isLibraryScanActive() {
  const view = document.getElementById('view-downloads');
  return view?.dataset?.libraryScanActive === 'true';
}

function isLibraryStatusOwned() {
  const view = document.getElementById('view-downloads');
  return view?.dataset?.libraryStatusOwned === 'true';
}
