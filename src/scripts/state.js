/**
 * state.js - Central app state and pub/sub.
 */

const listeners = {};

export const stateEmitter = {
  on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  },
  off(event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((fn) => fn !== cb);
  },
  emit(event, payload) {
    (listeners[event] || []).forEach((cb) => cb(payload));
  },
};

const DEFAULT_FORMATS = [
  { id: 'stable:va:1080', label: '1080p', res: '1080p', codec: 'h264', audio: 'aac', size: 'Auto', kind: 'video_audio' },
  { id: 'stable:v:1080', label: '1080p', res: '1080p', codec: 'h264', audio: null, size: 'Auto', kind: 'video_only' },
  { id: 'stable:a:best', label: 'Best', res: null, codec: 'aac', audio: 'aac', size: 'Auto', kind: 'audio_only' },
];

const _state = {
  activeView: 'downloads',
  modalOpen: false,
  queue: new Map(),
  selectedFormatIndex: 0,
  formats: [...DEFAULT_FORMATS],
  engineUpdateAvailable: false,
};

export const state = {
  get activeView() { return _state.activeView; },
  get selectedFormatIndex() { return _state.selectedFormatIndex; },
  get selectedFormat() { return _state.formats[_state.selectedFormatIndex] || _state.formats[0] || null; },
  get formats() { return _state.formats; },
  get modalOpen() { return _state.modalOpen; },
  get queue() { return _state.queue; },
  get engineUpdateAvailable() { return _state.engineUpdateAvailable; },
  queueArray() {
    return [..._state.queue.values()];
  },
  activeCount() {
    return [..._state.queue.values()].filter(
      (item) => item.status === 'downloading' || item.status === 'postprocessing'
    ).length;
  },
};

export const actions = {
  setView(view) {
    _state.activeView = view;
    stateEmitter.emit('view:change', view);
  },

  setFormats(formats) {
    if (!Array.isArray(formats) || formats.length === 0) {
      _state.formats = [...DEFAULT_FORMATS];
    } else {
      _state.formats = formats.map((fmt) => ({
        id: fmt.id,
        label: fmt.label || fmt.id,
        res: fmt.res ?? null,
        codec: fmt.codec || 'Auto',
        audio: fmt.audio ?? null,
        size: fmt.size || 'Unknown',
        kind: fmt.kind || null,
      }));
    }
    _state.selectedFormatIndex = 0;
    stateEmitter.emit('formats:change', _state.formats);
    stateEmitter.emit('format:change', state.selectedFormat);
  },

  setFormat(index) {
    if (!_state.formats.length) return;
    const safeIndex = Math.max(0, Math.min(index, _state.formats.length - 1));
    _state.selectedFormatIndex = safeIndex;
    stateEmitter.emit('format:change', state.selectedFormat);
  },

  setModalOpen(open) {
    _state.modalOpen = Boolean(open);
    stateEmitter.emit('modal:toggle', _state.modalOpen);
  },

  setEngineUpdateAvailable(val) {
    _state.engineUpdateAvailable = Boolean(val);
    stateEmitter.emit('engine:updateAvailable', _state.engineUpdateAvailable);
  },

  upsertDownload(download) {
    const exists = _state.queue.has(download.id);
    if (exists) {
      const current = _state.queue.get(download.id);
      const updated = { ...current, ...download };
      _state.queue.set(download.id, updated);
      stateEmitter.emit('queue:update', { id: download.id, item: updated });
      return;
    }
    _state.queue.set(download.id, download);
    stateEmitter.emit('queue:add', download);
  },

  replaceQueue(items) {
    _state.queue.clear();
    (items || []).forEach((item) => _state.queue.set(item.id, item));
    stateEmitter.emit('queue:replace', state.queueArray());
  },

  updateDownload(id, patch) {
    const current = _state.queue.get(id);
    if (!current) return;
    const updated = { ...current, ...patch };
    _state.queue.set(id, updated);
    stateEmitter.emit('queue:update', { id, item: updated });
  },

  removeDownload(id) {
    if (!_state.queue.has(id)) return;
    _state.queue.delete(id);
    stateEmitter.emit('queue:remove', id);
  },
};
