/**
 * tauriApi.js - Thin wrapper around Tauri globals for plain ES modules.
 */

function tauriGlobal() {
  return window.__TAURI__ || null;
}

export function isTauriEnvironment() {
  const tauri = tauriGlobal();
  return Boolean(tauri?.core?.invoke);
}

export async function invokeCommand(command, payload = {}) {
  const tauri = tauriGlobal();
  if (!tauri?.core?.invoke) {
    throw new Error('Tauri runtime is not available.');
  }
  return tauri.core.invoke(command, payload);
}

export async function listenEvent(eventName, handler) {
  const tauri = tauriGlobal();
  if (!tauri?.event?.listen) {
    return () => {};
  }
  return tauri.event.listen(eventName, (event) => {
    handler(event?.payload);
  });
}
