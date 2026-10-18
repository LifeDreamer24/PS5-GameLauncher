// What connected DualSense controllers tell about themselves (battery,
// connection, firmware), read by the helper from the controllers it already
// listens to (main/native/syshelper.cs, PadInfo). Settings › Accessories shows
// it, and the quick menu's Accessories icon shows the battery.

import { api, state, emit } from './state.js';
import { t } from './i18n.js';

state.dualsense = [];

function apply(pads) {
  state.dualsense = Array.isArray(pads) ? pads : [];
  emit('dualsense');
}

/** Start listening (once per window: the launcher and the in-game overlay). */
export function initDualsense() {
  api.on('dualsense:state', apply);
  api.dualsenseInfo().then(apply).catch(() => {});
}

/** Read everything again from the controllers (firmware and MAC included). */
export function refreshDualsense() {
  return api.dualsenseInfo(true).then(apply).catch(() => {});
}

export function modelName(p) {
  return p.model === 'edge' ? 'DualSense Edge Wireless Controller' : 'DualSense Wireless Controller';
}

/** The battery to show on the quick menu icon: the first controller that reports one. */
export function mainBattery() {
  return state.dualsense.find((p) => typeof p.battery === 'number') || null;
}

const POWER = {
  discharging: 'Discharging',
  charging: 'Charging',
  full: 'Fully Charged',
  voltage: 'Battery Voltage Problem',
  temperature: 'Battery Temperature Problem',
  error: 'Charging Error',
  unknown: 'Unknown',
};

export function powerLabel(p) {
  return POWER[p.power] || 'Unknown';
}

export function batteryText(p) {
  return typeof p.battery === 'number' ? `${p.battery}%` : t('Unknown');
}

export function connectionLabel(p) {
  return p.connection === 'usb' ? 'USB' : 'Bluetooth';
}
