/**
 * router.js — View router
 * Maps view IDs to section elements and handles transitions.
 */

import { state, actions, stateEmitter } from './state.js';

// ── View element map ──────────────────────────────────────────────────────────
const VIEW_IDS = ['downloads', 'player', 'browse', 'library', 'settings'];

/**
 * Show the given view, hiding all others.
 * @param {string} viewId
 */
function showView(viewId) {
  VIEW_IDS.forEach(id => {
    const el = document.getElementById(`view-${id}`);
    if (!el) return;
    if (id === viewId) {
      // Explicitly set flex — do not rely on CSS class reset which can
      // be overridden by specificity or !important elsewhere
      el.style.display = 'flex';
      el.setAttribute('aria-hidden', 'false');
    } else {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    }
  });
}

/**
 * Update which nav button has the `active` class.
 * @param {string} viewId
 */
function updateNavActive(viewId) {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const isActive = btn.dataset.view === viewId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

/**
 * Navigate to a view.
 * @param {string} viewId
 */
export function navigateTo(viewId) {
  if (!VIEW_IDS.includes(viewId)) return;
  actions.setView(viewId);
}

/**
 * Initialize the router — bind nav buttons and subscribe to view changes.
 */
export function initRouter() {
  // Subscribe to view changes from state
  stateEmitter.on('view:change', (viewId) => {
    showView(viewId);
    updateNavActive(viewId);
  });

  // Bind all nav buttons
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.view);
    });
  });

  // Set initial view
  showView(state.activeView);
  updateNavActive(state.activeView);
}
