// Settings › Captures › Encoder and Quality: the codec, the encoder (only the
// ones OBS can use on this PC, see main/encoders.js) and all of that encoder's
// own settings: rate control, bitrate or quality level, preset, profile,
// keyframes, B-frames and its extras.

import { api, state, emit, setSetting } from '../state.js';
import { t } from '../i18n.js';

const CODEC_LABELS = { h264: 'H.264 (AVC)', hevc: 'H.265 (HEVC)', av1: 'AV1' };
const RC_LABELS = {
  CBR: 'Constant Bitrate (CBR)',
  VBR: 'Variable Bitrate (VBR)',
  VBR_LAT: 'Variable Bitrate, Low Latency',
  ABR: 'Average Bitrate (ABR)',
  CQP: 'Constant Quality (CQP)',
  CRF: 'Constant Rate Factor (CRF)',
  ICQ: 'Intelligent Constant Quality (ICQ)',
  QVBR: 'Quality-Defined VBR (QVBR)',
  HQCBR: 'High Quality CBR',
  HQVBR: 'High Quality VBR',
  CQVBR: 'Constant Quality VBR',
  lossless: 'Lossless',
};
const BITRATES = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 130].map((m) => m * 1000);

/** Encoders and the one in use, from the main process (state.captureEncoders). */
export async function loadEncoders() {
  try {
    state.captureEncoders = await api.captureEncoders();
  } catch {
    state.captureEncoders = null;
  }
  emit('capture-encoders');
}

/** Quality levels to choose from: the usual range for the scale, plus the current value. */
function qualityLevels(d, cur) {
  const list = d.qualityMax > 51 ? [16, 20, 24, 26, 28, 30, 32, 34, 38, 42, 48] : [12, 14, 16, 18, 20, 22, 23, 24, 26, 28, 30, 34];
  const vals = [...new Set([...list.filter((v) => v >= d.qualityMin && v <= d.qualityMax), Number(cur)].filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  return vals.map((v, i) => ({ value: v, label: String(v), hint: i === 0 ? t('Best quality, biggest files') : i === vals.length - 1 ? t('Smallest files') : '' }));
}

/** Change some of the encoder's own settings (kept per encoder, so switching back keeps them). */
async function setEnc(id, patch) {
  const all = { ...(state.settings.captureEnc || {}) };
  all[id] = { ...(state.settings.captureEnc || {})[id], ...state.captureEncoders.settings, ...patch };
  await setSetting('captureEnc', all);
  await loadEncoders();
}

export function encoderItems() {
  const info = state.captureEncoders;
  if (info === undefined) {
    loadEncoders();
    return [{ type: 'info', label: 'Encoder', value: 'Checking…' }];
  }
  if (!info || !info.encoders.length) return [{ type: 'info', label: 'Encoder', value: 'Not available' }];
  const s = info.settings;
  const d = info.encoders.find((e) => e.id === info.current) || info.encoders[0];
  const codecs = ['h264', 'hevc', 'av1'].filter((c) => info.encoders.some((e) => e.codec === c));
  const forCodec = info.encoders.filter((e) => e.codec === info.codec);
  const auto = forCodec.find((e) => e.hw) || forCodec[0];
  const rc = d.rateControls.find((r) => r.value === s.rate_control) || d.rateControls[0];
  const enc = (patch) => setEnc(d.id, patch);

  const items = [
    {
      type: 'choice',
      key: 'captureCodec',
      label: 'Video Codec',
      get: () => info.codec,
      // The same kind of encoder for the new codec when there is one (AMD H.264 -> AMD AV1).
      set: async (codec) => {
        const same = info.chosen !== 'auto' && info.encoders.find((e) => e.codec === codec && e.family === d.family);
        state.settings = await api.setSettings({ captureCodec: codec, captureEncoder: same ? same.id : 'auto' });
        emit('settings', 'captureCodec');
        await loadEncoders();
      },
      options: codecs.map((c) => ({ value: c, label: CODEC_LABELS[c] })),
    },
    {
      type: 'choice',
      key: 'captureEncoder',
      label: 'Encoder',
      get: () => info.chosen,
      set: async (v) => {
        await setSetting('captureEncoder', v);
        await loadEncoders();
      },
      options: [
        { value: 'auto', label: auto ? t('Automatic ({name})', { name: t(auto.label) }) : 'Automatic' },
        ...forCodec.map((e) => ({ value: e.id, label: e.label, hint: e.hw ? t('Graphics card') : t('Processor') })),
      ],
    },
    {
      type: 'choice',
      key: 'captureEncRc',
      label: 'Rate Control',
      get: () => rc.value,
      set: (v) => enc({ rate_control: v }),
      options: d.rateControls.map((r) => ({ value: r.value, label: RC_LABELS[r.value] || r.value })),
    },
  ];
  if (rc.bitrate) {
    items.push({
      type: 'choice',
      key: 'captureEncBitrate',
      label: 'Bitrate',
      get: () => Number(s.bitrate),
      set: (v) => enc({ bitrate: Number(v) }),
      options: [...new Set([...BITRATES, Number(s.bitrate)])].sort((a, b) => a - b).map((v) => ({ value: v, label: t('{n} Mbps', { n: Math.round(v / 100) / 10 }) })),
    });
  }
  if (rc.max) {
    items.push({
      type: 'choice',
      key: 'captureEncMax',
      label: 'Maximum Bitrate',
      get: () => Number(s.max_bitrate),
      set: (v) => enc({ max_bitrate: Number(v) }),
      options: [...new Set([...BITRATES, Number(s.max_bitrate)])].sort((a, b) => a - b).map((v) => ({ value: v, label: t('{n} Mbps', { n: Math.round(v / 100) / 10 }) })),
    });
  }
  if (rc.quality) {
    items.push({
      type: 'choice',
      key: 'captureEncQuality',
      label: rc.value === 'CRF' ? 'Quality (CRF)' : rc.value === 'ICQ' ? 'Quality (ICQ)' : 'Quality Level (QP)',
      get: () => Number(s[rc.quality]),
      set: (v) => enc({ [rc.quality]: Number(v) }),
      options: qualityLevels(d, s[rc.quality]),
    });
  }
  if (d.presets.length) {
    items.push({
      type: 'choice',
      key: 'captureEncPreset',
      label: d.family === 'qsv' ? 'Target Usage' : 'Preset',
      get: () => s[d.presetKey],
      set: (v) => enc({ [d.presetKey]: v }),
      options: d.presets,
    });
  }
  if (d.profiles.length) {
    items.push({ type: 'choice', key: 'captureEncProfile', label: 'Profile', get: () => s.profile || d.profiles[0], set: (v) => enc({ profile: v }), options: d.profiles.map((p) => ({ value: p, label: p })) });
  }
  items.push({
    type: 'choice',
    key: 'captureEncKeyint',
    label: 'Keyframe Interval',
    get: () => Number(s.keyint_sec) || 0,
    set: (v) => enc({ keyint_sec: Number(v) }),
    options: [0, 1, 2, 3, 4, 5, 10].map((v) => ({ value: v, label: v ? t('{n} s', { n: v }) : 'Automatic' })),
  });
  if (d.bframes && d.bframesKey) {
    items.push({
      type: 'choice',
      key: 'captureEncBf',
      label: 'B-Frames',
      get: () => Number(s[d.bframesKey]) || 0,
      set: (v) => enc({ [d.bframesKey]: Number(v) }),
      options: Array.from({ length: d.bframes + 1 }, (_, i) => ({ value: i, label: String(i) })),
    });
  }
  for (const x of d.extras) {
    if (x.type === 'bool') items.push({ type: 'toggle', label: x.label, get: () => !!s[x.key], set: (v) => enc({ [x.key]: !!v }) });
    else items.push({ type: 'choice', key: `captureEnc_${x.key}`, label: x.label, get: () => s[x.key], set: (v) => enc({ [x.key]: v }), options: x.options.map(([value, label]) => ({ value, label })) });
  }
  items.push(
    {
      type: 'choice',
      key: 'captureFormat',
      label: 'Video Format',
      options: [
        { value: 'mp4', label: 'MP4' },
        { value: 'mkv', label: 'MKV' },
        { value: 'hybrid_mp4', label: 'Hybrid MP4', hint: t('Stays playable if OBS crashes') },
      ],
    },
    {
      type: 'note',
      label: info.fromObs
        ? 'Only the encoders OBS can use on this PC are listed. Lower quality levels mean better quality and bigger files. Changes apply when nothing is recording.'
        : 'OBS hasn’t run here yet, so the encoders are a guess from your graphics card: the list is exact once OBS has started once. Changes apply when nothing is recording.',
    }
  );
  return items;
}
