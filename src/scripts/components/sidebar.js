/**
 * sidebar.js — Sidebar component
 * Handles: engine update banner visibility, settings update log simulation.
 */

import { state, actions, stateEmitter } from '../state.js';
import { navigateTo } from '../router.js';

/**
 * Initialize sidebar: bind update banner button, subscribe to engine state.
 */
export function initSidebar() {
  const banner    = document.getElementById('engine-update-banner');
  const updateBtn = document.getElementById('btn-update-engine');
  const statusBadge = document.getElementById('status-update-badge');

  // Show banner + status bar badge if update available
  function syncBannerVisibility(available) {
    if (banner)      banner.style.display      = available ? 'block' : 'none';
    if (statusBadge) statusBadge.style.display  = available ? 'inline-flex' : 'none';
  }

  // Set initial state
  syncBannerVisibility(state.engineUpdateAvailable);

  // Subscribe to changes
  stateEmitter.on('engine:updateAvailable', syncBannerVisibility);

  // "Update engine →" button → navigate to settings
  updateBtn?.addEventListener('click', () => {
    navigateTo('settings');
    // Small delay then scroll engine-management into view
    setTimeout(() => {
      document.getElementById('engine-management')?.scrollIntoView({ behavior: 'smooth' });
    }, 120);
  });
}
