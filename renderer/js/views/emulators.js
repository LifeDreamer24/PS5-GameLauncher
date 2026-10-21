// Settings › Library › Emulators: the emulator for each console. For now the
// Nintendo Switch, through Eden or another yuzu-based emulator (main/emulators.js):
// pick its program and its games join the library.

import { api, state, emit, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { optionsMenu, confirmDialog } from '../ui/dialogs.js';
import { browseFiles, showFolder } from '../ui/filebrowser.js';
import { t } from '../i18n.js';

const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** What is set up, from the main process (state.emulators; undefined while loading), and the controllers connected now. */
export async function loadEmulators() {
  try {
    [state.emulators, state.emulatorPads] = await Promise.all([api.emulatorsInfo(), api.emulatorsPads().catch(() => [])]);
  } catch {
    state.emulators = { switch: null };
  }
  emit('emulators');
  return state.emulators;
}

/** A player's controller: '' (as the emulator has it), 'off', or a controller's id. */
async function setPlayer(sw, n, value) {
  const players = Array.from({ length: 8 }, (_, i) => (sw.players || [])[i] || null);
  const pad = (state.emulatorPads || []).find((p) => p.id === value);
  players[n] = value === 'off' ? 'off' : pad ? { id: pad.id, name: pad.name } : value ? players[n] : null;
  state.emulators = await api.emulatorsSet('switch', { players });
  emit('emulators');
}

/** Players 1-8: what the launcher sets in the emulator right before a game starts. */
function playerItems(sw) {
  const pads = state.emulatorPads || [];
  return Array.from({ length: 8 }, (_, n) => {
    const cur = (sw.players || [])[n] || null;
    const value = cur === 'off' ? 'off' : cur ? cur.id : '';
    const options = [
      { value: '', label: 'Emulator’s Own Setting' },
      { value: 'off', label: 'Not Connected' },
      ...pads.map((p) => ({ value: p.id, label: p.name })),
    ];
    // Chosen earlier but not connected right now: still listed.
    if (cur && cur !== 'off' && !pads.some((p) => p.id === cur.id)) options.push({ value: cur.id, label: t('{name} (not connected)', { name: cur.name }) });
    return { type: 'choice', key: `switchPlayer${n}`, label: t('Player {n}', { n: n + 1 }), get: () => value, set: (v) => setPlayer(sw, n, v), options };
  });
}

async function busy(run) {
  state.emulatorsBusy = true;
  emit('emulators');
  try {
    return await run();
  } finally {
    state.emulatorsBusy = false;
    emit('emulators');
  }
}

const switchCount = () => state.games.filter((g) => g.source === 'emulator' && g.platform === 'switch').length;

/** Pick the emulator's program; its games are scanned in right after. */
async function chooseSwitchEmulator(start = null) {
  const exe = await browseFiles({ title: 'Choose the Switch Emulator', mode: 'file', exts: ['exe'], key: 'emulator', start });
  if (!exe) return;
  const r = await busy(() => api.emulatorsSet('switch', { exe })).catch((err) => ({ switch: { error: errText(err) }, rejected: true }));
  if (r.rejected) {
    sfx.error();
    pushNotification({ title: t('Couldn’t use {name}', { name: baseName(exe) }), body: t((r.switch && r.switch.error) || 'This doesn’t look like a yuzu-based emulator.'), icon: 'info', kind: 'library' });
    return;
  }
  state.emulators = r;
  emit('emulators');
  const n = switchCount();
  pushNotification({
    title: t('{name} is set up', { name: (r.switch && r.switch.name) || baseName(exe) }),
    body: t(n === 1 ? '1 game found' : '{n} games found', { n }),
    icon: 'gamepad',
    kind: 'library',
  });
}

async function switchMenu(el, sw) {
  await optionsMenu({
    title: sw.name || 'Emulator',
    anchor: el,
    items: [
      { label: 'Change Emulator…', icon: 'gamepad', run: () => chooseSwitchEmulator(dirOf(sw.exe)) },
      { label: 'Open Its Folder', icon: 'folder', run: () => showFolder(sw.name || 'Emulator', dirOf(sw.exe), baseName(sw.exe)) },
      {
        label: 'Remove Emulator',
        icon: 'trash',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: t('Remove {name}?', { name: sw.name || 'Emulator' }),
            message: 'Its games are removed from the library. Nothing is deleted from the PC, and you can set it up again any time.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (!ok) return;
          state.emulators = await busy(() => api.emulatorsRemove('switch'));
          emit('emulators');
        },
      },
    ],
  });
}

async function setFullscreen(on) {
  state.emulators = await busy(() => api.emulatorsSet('switch', { fullscreen: on }));
  emit('emulators');
}

export function emulatorItems() {
  const em = state.emulators;
  const sw = em && em.switch;
  const items = [{ type: 'header', label: 'Nintendo Switch', busy: !!state.emulatorsBusy }];
  if (em === undefined) return [...items, { type: 'info', label: 'Emulator', value: 'Checking…' }];
  if (!sw) {
    return [
      ...items,
      { type: 'action', icon: 'gamepad', label: 'Choose the Emulator…', value: 'Not set', run: () => chooseSwitchEmulator() },
      {
        type: 'note',
        label: 'Works with Eden and other yuzu-based emulators (Citron, Sudachi, Torzu, suyu). Choose its program, eden.exe for example: the games in the game folders set up in the emulator join the library, with their artwork.',
      },
    ];
  }
  return [
    ...items,
    { type: 'action', icon: 'gamepad', label: sw.name || 'Emulator', value: sw.exe, valueClass: 'path', run: (el) => switchMenu(el, sw) },
    sw.error ? { type: 'note', label: sw.error } : null,
    { type: 'info', label: 'Settings and Saves', value: sw.userDir ? (sw.portable ? 'Portable (next to the program)' : sw.userDir) : '—' },
    { type: 'info', label: 'Games', value: String(switchCount()) },
    { type: 'toggle', label: 'Start Games in Full Screen', get: () => sw.fullscreen !== false, set: (v) => setFullscreen(v) },
    { type: 'action', icon: 'refresh', label: 'Scan for Games', run: () => busy(() => api.scan()).then(loadEmulators) },
    { type: 'header', label: 'Game Folders' },
    ...(sw.gameDirs || []).map((d) => ({ type: 'action', icon: 'folder', label: baseName(d.path), value: d.path, valueClass: 'path', run: () => showFolder(baseName(d.path), d.path) })),
    sw.gameDirs && sw.gameDirs.length ? null : { type: 'info', label: 'No game folders set up', value: '' },
    {
      type: 'note',
      label: 'Game folders are set up in the emulator itself (Add New Game Directory). Updates and add-ons in them aren’t separate games: the emulator applies them.',
    },
    { type: 'header', label: 'Players' },
    ...playerItems(sw),
    { type: 'action', icon: 'refresh', label: 'Look for Controllers Again', run: () => loadEmulators() },
    {
      type: 'note',
      label: 'Right before a game starts, the launcher gives each player the controller chosen here, with the buttons the player already has in the emulator. With controller passthrough the emulator gets the launcher’s virtual controllers; that is taken care of too. A game with its own input profile in the emulator keeps it.',
    },
  ];
}
