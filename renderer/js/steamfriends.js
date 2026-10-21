// Steam friends for the UI (the Web API calls live in main/steamfriends.js).

import { api, emit, pushNotification } from './state.js';
import { t } from './i18n.js';

export const steam = { state: null };

function clean(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

api.on('steamfriends:state', (s) => {
  steam.state = s;
  emit('steamfriends');
});

/** The friends as main has them; refresh: read them from Steam now. */
export async function loadFriends({ refresh = false } = {}) {
  try {
    steam.state = await api.steamFriends({ refresh });
  } catch {
    steam.state = null;
  }
  emit('steamfriends');
  return steam.state;
}

/** Save the Web API key: typed, or { fromClipboard: true }. */
export async function setFriendsKey(data) {
  try {
    steam.state = await api.steamFriendsSetKey(data);
    emit('steamfriends');
    return true;
  } catch (err) {
    pushNotification({ title: 'Steam Friends', body: clean(err), icon: 'steam' });
    return false;
  }
}

export async function forgetFriendsKey() {
  steam.state = await api.steamFriendsForget();
  emit('steamfriends');
}

/** message | profile | join | friends, done by the Steam client. */
export async function openFriend(kind, id) {
  try {
    await api.steamFriendsOpen(kind, id);
    return true;
  } catch (err) {
    pushNotification({ title: 'Steam', body: clean(err), icon: 'steam' });
    return false;
  }
}

export function friendsList() {
  return (steam.state && steam.state.friends) || [];
}

export function onlineCount() {
  return (steam.state && steam.state.online) || 0;
}

/** What a friend is doing, for the line under their name. */
export function presenceText(f) {
  if (f.game) return f.game;
  if (f.state === 'offline') return f.lastOnline ? t('Last online {when}', { when: lastOnline(f.lastOnline) }) : t('Offline');
  return t({ online: 'Online', busy: 'Busy', away: 'Away', snooze: 'Away', trade: 'Online', play: 'Online' }[f.state] || 'Online');
}

function lastOnline(ms) {
  const min = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return t('{n} min ago', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('{n} h ago', { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t('yesterday') : t('{n} days ago', { n: d });
}
