/**
 * downloadCard.js - Queue card rendering and per-card actions.
 */

import { invokeCommand } from '../tauriApi.js';
import { formatBytes, formatSpeed } from '../utils.js';

const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>
  <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>
</svg>`;

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
</svg>`;

const ICON_CANCEL = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
</svg>`;

const ICON_RETRY = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
  <path d="M20 11a8 8 0 10-2.34 5.66L20 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_PLAY_THUMB = `<svg viewBox="0 0 24 24" fill="none" width="18" height="18" aria-hidden="true">
  <path d="M5 3l14 9-14 9V3z" fill="white"/>
</svg>`;

export function renderQueueItem(item) {
  const card = document.createElement('article');
  card.className = 'queue-card';
  card.id = item.id;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `Download: ${item.title}`);
  card.dataset.status = item.status;

  const thumb = buildThumb(item);
  const body = document.createElement('div');
  body.className = 'card-body';
  body.appendChild(buildTitle(item));
  body.appendChild(buildChips(item));
  body.appendChild(buildProgress(item));
  body.appendChild(buildStatusRow(item));

  card.appendChild(thumb);
  card.appendChild(body);
  card.appendChild(buildActions(item));
  return card;
}

export function updateCardDOM(item) {
  const card = document.getElementById(item.id);
  if (!card) return;

  card.dataset.status = item.status;
  syncCardThumb(card, item);

  const fill = card.querySelector('.progress-fill');
  if (fill) {
    fill.style.width = `${item.progress}%`;
    fill.dataset.active = item.status === 'downloading' ? 'true' : 'false';
    fill.classList.toggle('progress-fill--complete', item.status === 'completed');
  }

  const statusText = card.querySelector('.card-status-text');
  if (statusText) {
    statusText.textContent = statusTextFor(item);
    statusText.className = `card-status-text${item.status === 'completed' ? ' card-status-text--complete' : ''}`;
  }

  const pct = card.querySelector('.card-pct');
  if (pct) {
    if (item.status === 'completed') pct.textContent = 'Done';
    else if (item.status === 'failed') pct.textContent = 'Failed';
    else pct.textContent = `${item.progress}%`;
  }

  const actions = card.querySelector('.card-actions');
  if (actions) {
    actions.replaceWith(buildActions(item));
  }

  const chips = card.querySelector('.card-chips');
  if (chips && (item.status === 'completed' || item.status === 'failed')) {
    chips.replaceWith(buildChips(item));
  }
}

function buildThumb(item) {
  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  thumb.setAttribute('aria-hidden', 'true');

  const play = document.createElement('span');
  play.className = 'card-thumb__play';
  play.innerHTML = ICON_PLAY_THUMB;
  thumb.appendChild(play);

  applyThumbnailToElement(thumb, item);
  syncThumbInteractivity(thumb, item);
  return thumb;
}

function syncCardThumb(card, item) {
  const thumb = card.querySelector('.card-thumb');
  if (!thumb) return;
  applyThumbnailToElement(thumb, item);
  syncThumbInteractivity(thumb, item);
}

function applyThumbnailToElement(thumb, item) {
  thumb.style.background = item.color || '#2d6a4f';
  const thumbnail = normalizedThumbnailUrl(item);
  let image = thumb.querySelector('.card-thumb__img');

  if (!thumbnail) {
    if (image) image.remove();
    thumb.dataset.hasImage = 'false';
    return;
  }

  if (!image) {
    image = document.createElement('img');
    image.className = 'card-thumb__img';
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      thumb.dataset.hasImage = 'false';
      image.remove();
    });
    thumb.prepend(image);
  }

  if (image.dataset.src !== thumbnail) {
    image.dataset.src = thumbnail;
    image.src = thumbnail;
  }

  thumb.dataset.hasImage = 'true';
}

function normalizedThumbnailUrl(item) {
  if (typeof item?.thumbnail !== 'string') return null;
  const url = item.thumbnail.trim();
  return url.length > 0 ? url : null;
}

function syncThumbInteractivity(thumb, item) {
  const playable = item.status === 'completed' && typeof item.filePath === 'string' && item.filePath.trim();
  thumb.onclick = null;
  thumb.onkeydown = null;

  if (!playable) {
    thumb.dataset.playable = 'false';
    thumb.removeAttribute('role');
    thumb.removeAttribute('tabindex');
    thumb.removeAttribute('title');
    thumb.setAttribute('aria-hidden', 'true');
    return;
  }

  thumb.dataset.playable = 'true';
  thumb.setAttribute('role', 'button');
  thumb.setAttribute('tabindex', '0');
  thumb.setAttribute('title', 'Play media');
  thumb.setAttribute('aria-label', `Play ${item.title || 'downloaded media'}`);
  thumb.removeAttribute('aria-hidden');
  thumb.onclick = () => playMedia(item.filePath);
  thumb.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    playMedia(item.filePath);
  };
}

function buildTitle(item) {
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title;
  title.title = item.title;
  return title;
}

function buildChips(item) {
  const row = document.createElement('div');
  row.className = 'card-chips';

  if (item.status === 'completed' || item.status === 'failed') {
    const stateChip = document.createElement('span');
    stateChip.className = `badge ${item.status === 'completed' ? 'badge--complete' : 'badge--codec'}`;
    stateChip.textContent = item.status === 'completed' ? 'Complete' : 'Failed';
    row.appendChild(stateChip);
  }

  if (item.res) {
    const res = document.createElement('span');
    res.className = 'badge badge--res';
    res.textContent = item.res;
    row.appendChild(res);
  }

  const codec = document.createElement('span');
  codec.className = 'badge badge--codec';
  codec.textContent = item.codec;
  row.appendChild(codec);

  if (item.audio) {
    const audio = document.createElement('span');
    audio.className = 'badge badge--codec';
    audio.textContent = item.audio;
    row.appendChild(audio);
  }

  const info = document.createElement('span');
  info.className = 'badge badge--platform mono';
  info.textContent = `· ${item.duration} · ${item.platform}`;
  row.appendChild(info);
  return row;
}

function buildProgress(item) {
  const wrap = document.createElement('div');
  wrap.className = 'progress-wrap';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = `progress-fill${item.status === 'completed' ? ' progress-fill--complete' : ''}`;
  fill.style.width = `${item.progress}%`;
  fill.dataset.active = item.status === 'downloading' ? 'true' : 'false';
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}

function buildStatusRow(item) {
  const row = document.createElement('div');
  row.className = 'card-status-row';

  const text = document.createElement('span');
  text.className = `card-status-text${item.status === 'completed' ? ' card-status-text--complete' : ''}`;
  text.textContent = statusTextFor(item);

  const pct = document.createElement('span');
  pct.className = 'card-pct mono';
  if (item.status === 'completed') pct.textContent = 'Done';
  else if (item.status === 'failed') pct.textContent = 'Failed';
  else pct.textContent = `${item.progress}%`;

  row.appendChild(text);
  row.appendChild(pct);
  return row;
}

function buildActions(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card-actions';

  if (item.status === 'completed') {
    const openBtn = document.createElement('button');
    openBtn.className = 'btn-icon btn-icon--success';
    openBtn.innerHTML = ICON_OPEN;
    openBtn.title = 'Open in file manager';
    openBtn.setAttribute('aria-label', 'Open in file manager');
    openBtn.addEventListener('click', () => openInFileManager(item.filePath));
    wrap.appendChild(openBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon btn-icon--danger';
    removeBtn.innerHTML = ICON_CANCEL;
    removeBtn.title = 'Remove from queue';
    removeBtn.setAttribute('aria-label', 'Remove completed item');
    removeBtn.addEventListener('click', () => removeDownload(item.id));
    wrap.appendChild(removeBtn);
    return wrap;
  }

  if (item.status === 'failed') {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-icon';
    retryBtn.innerHTML = ICON_RETRY;
    retryBtn.title = 'Retry';
    retryBtn.setAttribute('aria-label', 'Retry download');
    retryBtn.addEventListener('click', () => retryDownload(item.id));
    wrap.appendChild(retryBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon btn-icon--danger';
    removeBtn.innerHTML = ICON_CANCEL;
    removeBtn.title = 'Remove';
    removeBtn.setAttribute('aria-label', 'Remove failed item');
    removeBtn.addEventListener('click', () => removeDownload(item.id));
    wrap.appendChild(removeBtn);
    return wrap;
  }

  if (item.status === 'downloading' || item.status === 'paused') {
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'btn-icon';
    pauseBtn.innerHTML = item.status === 'paused' ? ICON_PLAY : ICON_PAUSE;
    pauseBtn.title = item.status === 'paused' ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', item.status === 'paused' ? 'Resume download' : 'Pause download');
    pauseBtn.addEventListener('click', () => togglePause(item.id, item.status));
    wrap.appendChild(pauseBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-icon btn-icon--danger';
  cancelBtn.innerHTML = ICON_CANCEL;
  cancelBtn.title = 'Cancel';
  cancelBtn.setAttribute('aria-label', 'Cancel download');
  cancelBtn.addEventListener('click', () => cancelDownload(item.id));
  wrap.appendChild(cancelBtn);

  return wrap;
}

async function togglePause(id, currentStatus) {
  const command = currentStatus === 'paused' ? 'queue_resume' : 'queue_pause';
  try {
    await invokeCommand(command, { request: { jobId: id } });
  } catch (err) {
    console.error('[PullDown] Failed to toggle pause:', err);
  }
}

async function cancelDownload(id) {
  try {
    await invokeCommand('queue_cancel', { request: { jobId: id } });
  } catch (err) {
    console.error('[PullDown] Failed to cancel download:', err);
  }
}

async function retryDownload(id) {
  try {
    await invokeCommand('queue_resume', { request: { jobId: id } });
  } catch (err) {
    console.error('[PullDown] Failed to retry download:', err);
  }
}

async function removeDownload(id) {
  try {
    await invokeCommand('queue_remove', { request: { jobId: id } });
  } catch (err) {
    console.error('[PullDown] Failed to remove item:', err);
  }
}

async function openInFileManager(path) {
  try {
    const cleanPath = typeof path === 'string' && path.trim() ? path.trim() : null;
    await invokeCommand('app_open_in_file_manager', {
      request: { path: cleanPath },
    });
  } catch (err) {
    console.error('[PullDown] Failed to open in file manager:', err);
  }
}

async function playMedia(path) {
  try {
    const cleanPath = typeof path === 'string' && path.trim() ? path.trim() : null;
    await invokeCommand('app_play_media', {
      request: { path: cleanPath },
    });
  } catch (err) {
    console.error('[PullDown] Failed to play media:', err);
  }
}

function statusTextFor(item) {
  switch (item.status) {
    case 'downloading':
      if (item.bytesTotal > 0) {
        const speed = item.speedBps ? ` · ${formatSpeed(item.speedBps)}` : '';
        return `${formatBytes(item.bytesDown)} / ${formatBytes(item.bytesTotal)} · downloading${speed}`;
      }
      return 'Downloading...';
    case 'postprocessing':
      return 'Post-processing via ffmpeg...';
    case 'paused':
      return `${formatBytes(item.bytesDown)} / ${formatBytes(item.bytesTotal || 0)} · Paused`;
    case 'queued':
      return 'Queued';
    case 'completed':
      return 'Completed';
    case 'failed':
      return item.error || 'Download failed';
    default:
      return '';
  }
}
