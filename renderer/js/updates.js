// Launcher updates for the UI (main/updater.js does the work).

import { api, emit, pushNotification } from './state.js';
import { t } from './i18n.js';

export const update = { state: null };

function clean(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

api.on('update:state', (s) => {
  update.state = s;
  emit('update');
});

export async function loadUpdate() {
  try {
    update.state = await api.updateState();
  } catch {
    update.state = null;
  }
  emit('update');
  return update.state;
}

export async function checkUpdate() {
  try {
    update.state = await api.updateCheck();
  } catch (err) {
    pushNotification({ title: 'Software Update', body: clean(err), icon: 'download', kind: 'system' });
  }
  emit('update');
}

export async function downloadUpdate() {
  try {
    update.state = await api.updateDownload();
  } catch (err) {
    pushNotification({ title: 'Software Update', body: clean(err), icon: 'download', kind: 'system' });
  }
  emit('update');
}

export async function installUpdate() {
  try {
    await api.updateInstall();
  } catch (err) {
    pushNotification({ title: 'Software Update', body: clean(err), icon: 'download', kind: 'system' });
  }
}

/** The status line under "Software Update". */
export function updateStatus(s = update.state) {
  if (!s) return '';
  const v = s.latest && s.latest.version;
  switch (s.status) {
    case 'checking':
      return t('Checking for updates…');
    case 'none':
      return t('Up to date');
    case 'available':
      return t('Version {v} is available', { v });
    case 'downloading':
      return t('Downloading {v}… {p}%', { v, p: Math.round((s.progress || 0) * 100) });
    case 'ready':
      return t('Version {v} is ready to install', { v });
    case 'installing':
      return t('Installing…');
    case 'error':
      return s.error || t('Couldn’t check for updates');
  }
  return '';
}
