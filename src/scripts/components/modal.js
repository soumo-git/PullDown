/**
 * modal.js - Format picker modal component.
 */

import { state, actions, stateEmitter } from '../state.js';

const getBackdrop = () => document.getElementById('format-modal');
const getModalInner = () => document.getElementById('format-modal-inner');
const getBtnClose = () => document.getElementById('btn-modal-close');
const getBtnConfirm = () => document.getElementById('btn-format-confirm');
const getBody = () => document.querySelector('#format-modal .modal__body');

let _pendingIndex = state.selectedFormatIndex;

function renderFormatOptions() {
  const body = getBody();
  if (!body) return;
  body.innerHTML = '';

  const groups = [
    { id: 'video_audio', label: 'Video + Audio' },
    { id: 'video_only', label: 'Video only' },
    { id: 'audio_only', label: 'Audio only' },
  ];

  groups.forEach((group) => {
    const entries = state.formats
      .map((fmt, idx) => ({ fmt, idx }))
      .filter((entry) => (entry.fmt.kind || 'video_audio') === group.id);

    if (!entries.length) return;

    const heading = document.createElement('div');
    heading.className = 'format-group-heading mono';
    heading.textContent = group.label;
    body.appendChild(heading);

    entries.forEach(({ fmt, idx }) => {
      const card = document.createElement('div');
      card.className = 'format-option';
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', idx === _pendingIndex ? 'true' : 'false');
      card.setAttribute('tabindex', '0');
      card.dataset.idx = String(idx);

      const left = document.createElement('div');
      left.className = 'format-option__left';

      const name = document.createElement('span');
      name.className = 'format-option__name';
      name.textContent = fmt.res || fmt.label;
      left.appendChild(name);

      const check = document.createElement('div');
      check.className = 'format-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = `<svg viewBox="0 0 12 12" fill="none" width="12" height="12">
        <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

      card.appendChild(left);
      card.appendChild(check);

      card.addEventListener('click', () => selectFormat(idx));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectFormat(idx);
        }
      });

      body.appendChild(card);
    });
  });
}

function selectFormat(idx) {
  _pendingIndex = idx;
  document.querySelectorAll('.format-option').forEach((card, i) => {
    card.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
}

export function openModal() {
  _pendingIndex = state.selectedFormatIndex;
  renderFormatOptions();

  const backdrop = getBackdrop();
  if (!backdrop) return;
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    const selected = backdrop.querySelector('.format-option[aria-selected="true"]');
    (selected || getBtnClose())?.focus();
  });

  actions.setModalOpen(true);
}

export function closeModal() {
  const backdrop = getBackdrop();
  if (!backdrop) return;
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  actions.setModalOpen(false);
  document.getElementById('btn-format')?.focus();
}

export function initModal() {
  const backdrop = getBackdrop();
  if (!backdrop) return;

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  getBtnClose()?.addEventListener('click', closeModal);

  getBtnConfirm()?.addEventListener('click', () => {
    actions.setFormat(_pendingIndex);
    closeModal();
  });

  stateEmitter.on('formats:change', () => {
    if (state.modalOpen) renderFormatOptions();
  });

  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      return;
    }

    if (e.key !== 'Tab') return;
    const focusable = getModalInner()?.querySelectorAll('button, [tabindex="0"]') || [];
    const arr = [...focusable];
    if (!arr.length) return;
    const first = arr[0];
    const last = arr[arr.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
