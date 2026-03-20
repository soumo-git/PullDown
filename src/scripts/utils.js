/**
 * utils.js — Pure utility functions (no DOM, no state deps)
 */

/**
 * Validate that a string looks like a fetchable URL.
 * Accepts http / https / ftp schemes.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidUrl(str) {
  try {
    const url = new URL(str.trim());
    return ['http:', 'https:', 'ftp:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Detect platform from URL hostname.
 * @param {string} urlStr
 * @returns {string}
 */
export function detectPlatform(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (/youtube\.com|youtu\.be/.test(hostname)) return 'YouTube';
    if (/vimeo\.com/.test(hostname))              return 'Vimeo';
    if (/twitter\.com|x\.com/.test(hostname))     return 'Twitter / X';
    if (/reddit\.com/.test(hostname))             return 'Reddit';
    if (/twitch\.tv/.test(hostname))              return 'Twitch';
    if (/dailymotion\.com/.test(hostname))        return 'Dailymotion';
    if (/soundcloud\.com/.test(hostname))         return 'SoundCloud';
    if (/instagram\.com/.test(hostname))          return 'Instagram';
    if (/tiktok\.com/.test(hostname))             return 'TikTok';
    return 'Web';
  } catch {
    return 'Web';
  }
}

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format a speed in bytes/sec to a readable speed string.
 * @param {number} bps
 * @returns {string}
 */
export function formatSpeed(bps) {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Generate a random integer between min and max (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
export function randPick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

/**
 * Truncate a string to maxLen chars, appending ellipsis if truncated.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen = 80) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Generate realistic-looking fake video metadata for simulation.
 * @param {string} platform
 * @returns {{ title: string, duration: string, bytesTotal: number, color: string }}
 */
export function fakeMeta(platform) {
  const titles = [
    'Rick Astley – Never Gonna Give You Up (Official)',
    'Lofi Hip Hop Radio – Beats to Relax / Study',
    'Blender 4.0 – Full Beginner Course',
    'The History of the Internet in 10 Minutes',
    'Gordon Ramsay Makes the Perfect Burger',
    'Alan Watts — The Nature of Consciousness',
    'Cyberpunk 2077 — Official Gameplay Walkthrough',
    'How to Build a Compiler from Scratch',
    'World\'s Most Beautiful Drone Footage 4K',
    'Deep Sea Creatures You\'ve Never Seen Before',
  ];

  const durations = ['3:52', '1:02:35', '3:45:00', '10:14', '22:07', '48:30', '5:19', '1:15:44'];

  const thumbColors = [
    '#1a4d2e', '#2d3a8c', '#5c1a4a', '#3d2b1f',
    '#1a3a4d', '#4d3a1a', '#2b1a4d', '#1a4d40',
  ];

  const totalMB = randInt(30, 3000);

  return {
    title:      randPick(titles),
    duration:   randPick(durations),
    bytesTotal: totalMB * 1024 * 1024,
    color:      randPick(thumbColors),
  };
}
