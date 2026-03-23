import { invokeCommand, isTauriEnvironment, listenEvent } from '../../tauriApi.js';

const FORMAT_OPTIONS = {
  video: [
    { value: 'mp4', label: 'MP4 (H.264 + AAC)' },
    { value: 'mkv', label: 'MKV (H.264 + AAC)' },
    { value: 'webm', label: 'WebM (VP9 + Opus)' },
    { value: 'mov', label: 'MOV (H.264 + AAC)' },
    { value: 'm4v', label: 'M4V (H.264 + AAC)' },
    { value: 'avi', label: 'AVI (MPEG4 + MP3)' },
    { value: 'flv', label: 'FLV (FLV1 + AAC)' },
    { value: 'ts', label: 'TS (H.264 + AAC)' },
    { value: 'mpg', label: 'MPEG (MPEG2 + MP2)' },
    { value: 'ogv', label: 'OGV (Theora + Vorbis)' },
    { value: 'wmv', label: 'WMV (WMV2 + WMA)' },
    { value: '3gp', label: '3GP (H.263 + AAC)' },
  ],
  audio: [
    { value: 'mp3', label: 'MP3 (LAME)' },
    { value: 'm4a', label: 'M4A (AAC)' },
    { value: 'aac', label: 'AAC' },
    { value: 'wav', label: 'WAV (PCM 16-bit)' },
    { value: 'flac', label: 'FLAC (Lossless)' },
    { value: 'ogg', label: 'OGG (Vorbis)' },
    { value: 'opus', label: 'Opus' },
    { value: 'wma', label: 'WMA' },
    { value: 'aiff', label: 'AIFF' },
    { value: 'ac3', label: 'AC3' },
    { value: 'mp2', label: 'MP2' },
    { value: 'alac', label: 'ALAC' },
    { value: 'mka', label: 'MKA (Matroska Audio)' },
  ],
  image: [
    { value: 'png', label: 'PNG' },
    { value: 'jpg', label: 'JPG' },
    { value: 'webp', label: 'WebP' },
    { value: 'bmp', label: 'BMP' },
    { value: 'tiff', label: 'TIFF' },
    { value: 'tga', label: 'TGA' },
    { value: 'gif', label: 'GIF' },
    { value: 'ico', label: 'ICO' },
    { value: 'jp2', label: 'JPEG 2000 (JP2)' },
    { value: 'avif', label: 'AVIF' },
  ],
};

const TYPE_BY_EXTENSION = new Map([
  ['mp4', 'video'],
  ['mkv', 'video'],
  ['webm', 'video'],
  ['mov', 'video'],
  ['avi', 'video'],
  ['m4v', 'video'],
  ['flv', 'video'],
  ['wmv', 'video'],
  ['3gp', 'video'],
  ['ts', 'video'],
  ['mpg', 'video'],
  ['mpeg', 'video'],
  ['ogv', 'video'],
  ['asf', 'video'],
  ['m3u8', 'video'],
  ['mp3', 'audio'],
  ['m4a', 'audio'],
  ['aac', 'audio'],
  ['wav', 'audio'],
  ['flac', 'audio'],
  ['ogg', 'audio'],
  ['opus', 'audio'],
  ['wma', 'audio'],
  ['aiff', 'audio'],
  ['aif', 'audio'],
  ['ac3', 'audio'],
  ['mp2', 'audio'],
  ['alac', 'audio'],
  ['mka', 'audio'],
  ['amr', 'audio'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['png', 'image'],
  ['webp', 'image'],
  ['bmp', 'image'],
  ['gif', 'image'],
  ['tiff', 'image'],
  ['tif', 'image'],
  ['tga', 'image'],
  ['ico', 'image'],
  ['jp2', 'image'],
  ['avif', 'image'],
]);

const ui = {
  root: null,
  dropzone: null,
  sourceInput: null,
  sourceName: null,
  sourceMeta: null,
  sourcePath: null,
  pickBtn: null,
  typeButtons: [],
  formatSelect: null,
  outputName: null,
  outputExt: null,
  overwrite: null,
  startBtn: null,
  statusText: null,
  statusChip: null,
  progressFill: null,
  progressValue: null,
  resultWrap: null,
  outputPath: null,
  openFolderBtn: null,
};

const model = {
  activeType: 'video',
  sourcePath: '',
  sourceName: '',
  sourceDir: '',
  converting: false,
  activeTaskId: '',
  latestOutputPath: '',
  statusState: 'idle',
};

export function initConverterView() {
  ui.root = document.getElementById('view-converter');
  if (!ui.root) return;

  ui.dropzone = document.getElementById('converter-dropzone');
  ui.sourceInput = document.getElementById('converter-source-input');
  ui.sourceName = document.getElementById('converter-source-name');
  ui.sourceMeta = document.getElementById('converter-source-meta');
  ui.sourcePath = document.getElementById('converter-source-path');
  ui.pickBtn = document.getElementById('btn-converter-pick');
  ui.typeButtons = Array.from(document.querySelectorAll('.converter-type[data-type]'));
  ui.formatSelect = document.getElementById('converter-format-select');
  ui.outputName = document.getElementById('converter-output-name');
  ui.outputExt = document.getElementById('converter-output-ext');
  ui.overwrite = document.getElementById('converter-overwrite');
  ui.startBtn = document.getElementById('btn-converter-start');
  ui.statusText = document.getElementById('converter-status-text');
  ui.statusChip = document.getElementById('converter-status-chip');
  ui.progressFill = document.getElementById('converter-progress-fill');
  ui.progressValue = document.getElementById('converter-progress-value');
  ui.resultWrap = document.getElementById('converter-result');
  ui.outputPath = document.getElementById('converter-output-path');
  ui.openFolderBtn = document.getElementById('btn-converter-open-folder');

  bindEvents();
  setActiveType('video');
  setStatus('Ready to convert.', 'idle');
  setProgress(0, false);
  hideResult();
  updateStartEnabled();

  if (isTauriEnvironment()) {
    void listenEvent('pulldown://converter-progress', onProgressEvent);
    bindNativeDropEvents();
  } else {
    setStatus('Preview mode: run in Tauri to perform real conversions.', 'idle');
  }
}

function bindEvents() {
  bindGlobalDropGuards();

  ui.typeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveType(btn.dataset.type || 'video');
    });
  });

  ui.formatSelect?.addEventListener('change', () => {
    syncOutputExt();
  });

  ui.outputName?.addEventListener('input', () => {
    updateStartEnabled();
  });

  ui.pickBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void pickSourceFile();
  });

  ui.sourceInput?.addEventListener('change', () => {
    const file = ui.sourceInput?.files?.[0];
    if (!file) return;
    applyPickedSource(resolveDroppedFilePath(file), file.name || 'Selected file');
  });

  ui.dropzone?.addEventListener('click', () => {
    void pickSourceFile();
  });

  ui.dropzone?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void pickSourceFile();
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    ui.dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (ui.dropzone) ui.dropzone.dataset.dragover = 'true';
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    ui.dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (ui.dropzone) ui.dropzone.dataset.dragover = 'false';
    });
  });

  ui.dropzone?.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    const droppedPath = resolveDroppedPath(event, file || null);
    if (!file && !droppedPath) return;
    applyPickedSource(
      droppedPath,
      (file?.name || fileNameFromPath(droppedPath) || 'Selected file'),
    );
  });

  ui.startBtn?.addEventListener('click', () => {
    void startConversion();
  });

  ui.openFolderBtn?.addEventListener('click', () => {
    void openOutputFolder();
  });
}

async function pickSourceFile() {
  if (!isTauriEnvironment()) {
    ui.sourceInput?.click();
    return;
  }

  try {
    const picked = await invokeCommand('converter_pick_source_file', {
      request: { path: model.sourceDir || null },
    });
    if (!picked) return;
    applyPickedSource(String(picked), fileNameFromPath(String(picked)));
  } catch (err) {
    setStatus(`Failed to open picker: ${String(err)}`, 'error');
  }
}

function applyPickedSource(pathValue, fallbackName) {
  const cleanPath = normalizeSourcePath(pathValue);
  if (!cleanPath) {
    model.sourcePath = '';
    model.sourceName = fallbackName;
    model.sourceDir = '';
    ui.sourceName.textContent = fallbackName;
    ui.sourcePath.textContent = 'Path: unavailable in preview mode';
    setStatus('Selected file cannot be resolved in this environment.', 'error');
    updateStartEnabled();
    return;
  }

  model.sourcePath = cleanPath;
  model.sourceName = fallbackName || fileNameFromPath(cleanPath);
  model.sourceDir = parentDirFromPath(cleanPath);
  model.latestOutputPath = '';
  hideResult();

  ui.sourceName.textContent = model.sourceName;
  ui.sourcePath.textContent = `Path: ${cleanPath}`;
  ui.sourceMeta.textContent = 'Ready for conversion';

  const inferred = inferMediaType(model.sourceName);
  setActiveType(inferred);

  const suggestedName = stemFromFileName(model.sourceName);
  if (ui.outputName && !ui.outputName.value.trim()) {
    ui.outputName.value = suggestedName || 'converted-media';
  }

  setStatus('Source file selected.', 'idle');
  updateStartEnabled();
}

function setActiveType(type) {
  const nextType = FORMAT_OPTIONS[type] ? type : 'video';
  model.activeType = nextType;

  ui.typeButtons.forEach((btn) => {
    const isActive = btn.dataset.type === nextType;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const options = FORMAT_OPTIONS[nextType];
  if (ui.formatSelect) {
    ui.formatSelect.innerHTML = '';
    options.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      ui.formatSelect.appendChild(option);
    });
  }
  syncOutputExt();
  updateStartEnabled();
}

function syncOutputExt() {
  const ext = String(ui.formatSelect?.value || '').trim().toLowerCase();
  ui.outputExt.textContent = ext ? `.${ext}` : '';
}

function updateStartEnabled() {
  if (!ui.startBtn) return;
  const hasSource = Boolean(model.sourcePath);
  const hasFormat = Boolean(ui.formatSelect?.value);
  const hasName = Boolean(sanitizeName(ui.outputName?.value || ''));
  ui.startBtn.disabled = model.converting || !isTauriEnvironment() || !hasSource || !hasFormat || !hasName;
}

async function startConversion() {
  if (!isTauriEnvironment()) {
    setStatus('Run this screen inside Tauri to convert files.', 'error');
    return;
  }
  if (model.converting || !model.sourcePath) return;

  const outputFormat = String(ui.formatSelect?.value || '').trim().toLowerCase();
  const outputName = sanitizeName(ui.outputName?.value || '') || stemFromFileName(model.sourceName) || 'converted-media';
  if (!outputFormat) {
    setStatus('Select an output format.', 'error');
    return;
  }

  ui.outputName.value = outputName;
  const taskId = `conv-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  model.activeTaskId = taskId;
  model.converting = true;
  model.latestOutputPath = '';
  hideResult();
  setStatus('Initializing conversion...', 'running');
  setProgress(0, true);
  setBusy(true);
  updateStartEnabled();

  try {
    const resolvedSourcePath = await invokeCommand('app_resolve_media_path', {
      request: { path: model.sourcePath },
    });
    const response = await invokeCommand('converter_run', {
      request: {
        taskId,
        sourcePath: String(resolvedSourcePath || model.sourcePath),
        mediaType: model.activeType,
        outputFormat,
        outputName,
        overwrite: Boolean(ui.overwrite?.checked),
      },
    });

    if (response?.taskId !== model.activeTaskId) return;
    finishSuccess(response?.outputPath || '');
  } catch (err) {
    finishError(String(err));
  }
}

function onProgressEvent(payload) {
  if (!payload || payload.taskId !== model.activeTaskId) return;

  const stage = String(payload.stage || '').toLowerCase();
  const message = String(payload.message || '').trim();
  const percentRaw = Number(payload.progressPercent);
  const percent = Number.isFinite(percentRaw) ? Math.max(0, Math.min(100, Math.round(percentRaw))) : null;

  if (stage === 'starting' || stage === 'running') {
    setStatus(message || 'Converting...', 'running');
    setProgress(percent ?? 0, percent === null);
    return;
  }

  if (stage === 'completed') {
    finishSuccess(String(payload.outputPath || ''));
    return;
  }

  if (stage === 'failed') {
    finishError(message || 'Conversion failed');
  }
}

function finishSuccess(outputPath) {
  model.converting = false;
  setBusy(false);
  setStatus('Conversion completed.', 'success');
  setProgress(100, false);
  if (outputPath) {
    model.latestOutputPath = outputPath;
    showResult(outputPath);
  }
  updateStartEnabled();
}

function finishError(message) {
  model.converting = false;
  setBusy(false);
  setStatus(message || 'Conversion failed', 'error');
  setProgress(0, false);
  updateStartEnabled();
}

async function openOutputFolder() {
  if (!model.latestOutputPath || !isTauriEnvironment()) return;
  try {
    await invokeCommand('app_open_in_file_manager', {
      request: { path: model.latestOutputPath },
    });
  } catch (err) {
    setStatus(`Failed to open output folder: ${String(err)}`, 'error');
  }
}

function setBusy(busy) {
  ui.pickBtn.disabled = busy;
  ui.typeButtons.forEach((btn) => { btn.disabled = busy; });
  if (ui.formatSelect) ui.formatSelect.disabled = busy;
  if (ui.outputName) ui.outputName.disabled = busy;
  if (ui.overwrite) ui.overwrite.disabled = busy;
}

function setStatus(text, state) {
  model.statusState = state;
  if (ui.statusText) ui.statusText.textContent = text;
  if (ui.statusChip) {
    ui.statusChip.dataset.state = state;
    ui.statusChip.textContent = state === 'running'
      ? 'Running'
      : state === 'success'
        ? 'Done'
        : state === 'error'
          ? 'Failed'
          : 'Idle';
  }
}

function setProgress(percent, indeterminate) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  if (ui.progressFill) {
    ui.progressFill.dataset.indeterminate = indeterminate ? 'true' : 'false';
    ui.progressFill.style.width = indeterminate ? '34%' : `${safePercent}%`;
  }
  if (ui.progressValue) {
    ui.progressValue.textContent = indeterminate ? '--' : `${safePercent}%`;
  }
}

function showResult(pathValue) {
  if (ui.outputPath) ui.outputPath.textContent = pathValue;
  if (ui.resultWrap) ui.resultWrap.style.display = 'flex';
}

function hideResult() {
  if (ui.resultWrap) ui.resultWrap.style.display = 'none';
  if (ui.outputPath) ui.outputPath.textContent = '';
}

function inferMediaType(name) {
  const ext = fileExtension(name);
  return TYPE_BY_EXTENSION.get(ext) || 'video';
}

function fileExtension(name) {
  const clean = String(name || '').trim();
  const idx = clean.lastIndexOf('.');
  if (idx < 0 || idx === clean.length - 1) return '';
  return clean.slice(idx + 1).toLowerCase();
}

function fileNameFromPath(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/');
  return normalized.split('/').pop() || normalized;
}

function parentDirFromPath(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '' : normalized.slice(0, idx);
}

function stemFromFileName(fileName) {
  const name = String(fileName || '');
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name.trim();
  return name.slice(0, idx).trim();
}

function sanitizeName(raw) {
  const normalized = String(raw || '').trim();
  if (!normalized) return '';
  return normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
}

function resolveDroppedPath(event, file) {
  const fromFile = resolveDroppedFilePath(file);
  if (fromFile) return fromFile;

  const uriList = String(event?.dataTransfer?.getData('text/uri-list') || '').trim();
  if (uriList) {
    const first = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (first) {
      const path = pathFromFileUri(first);
      if (path) return path;
    }
  }

  const plain = String(event?.dataTransfer?.getData('text/plain') || '').trim();
  if (plain) {
    const maybePath = normalizeSourcePath(plain);
    if (looksLikeFsPath(maybePath)) return maybePath;
    const fromPlainUri = pathFromFileUri(maybePath);
    if (fromPlainUri) return fromPlainUri;
  }

  return '';
}

function resolveDroppedFilePath(file) {
  if (!file) return '';
  const fromPath = String(file.path || '').trim();
  if (fromPath) return fromPath;
  return '';
}

function pathFromFileUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw.toLowerCase().startsWith('file://')) return '';
  try {
    const url = new URL(raw);
    let pathname = decodeURIComponent(url.pathname || '');
    if (/^\/[a-zA-Z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, '\\');
  } catch {
    return '';
  }
}

function normalizeSourcePath(raw) {
  return String(raw || '')
    .replace(/\u0000/g, '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

function looksLikeFsPath(value) {
  const input = String(value || '').trim();
  if (!input) return false;
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\');
}

function bindGlobalDropGuards() {
  ['dragenter', 'dragover', 'drop'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (!isConverterVisible()) return;
      event.preventDefault();
    }, true);
  });
}

function bindNativeDropEvents() {
  const dropEvents = ['tauri://drag-drop', 'tauri://file-drop'];
  dropEvents.forEach((eventName) => {
    void listenEvent(eventName, (payload) => {
      if (!isConverterVisible()) return;
      const path = firstPathFromNativePayload(payload);
      if (!path) return;
      applyPickedSource(path, fileNameFromPath(path));
      if (ui.dropzone) ui.dropzone.dataset.dragover = 'false';
    });
  });

  const hoverEnterEvents = ['tauri://drag-enter', 'tauri://file-drop-hover'];
  hoverEnterEvents.forEach((eventName) => {
    void listenEvent(eventName, () => {
      if (!isConverterVisible()) return;
      if (ui.dropzone) ui.dropzone.dataset.dragover = 'true';
    });
  });

  const hoverLeaveEvents = ['tauri://drag-leave', 'tauri://file-drop-cancelled'];
  hoverLeaveEvents.forEach((eventName) => {
    void listenEvent(eventName, () => {
      if (ui.dropzone) ui.dropzone.dataset.dragover = 'false';
    });
  });
}

function firstPathFromNativePayload(payload) {
  if (Array.isArray(payload)) {
    const first = payload.find((item) => typeof item === 'string' && item.trim());
    return normalizeSourcePath(first || '');
  }
  if (Array.isArray(payload?.paths)) {
    const first = payload.paths.find((item) => typeof item === 'string' && item.trim());
    return normalizeSourcePath(first || '');
  }
  if (typeof payload?.path === 'string') {
    return normalizeSourcePath(payload.path);
  }
  if (typeof payload?.filePath === 'string') {
    return normalizeSourcePath(payload.filePath);
  }
  return '';
}

function isConverterVisible() {
  if (!ui.root) return false;
  return ui.root.style.display !== 'none' && ui.root.getAttribute('aria-hidden') !== 'true';
}
