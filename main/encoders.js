// Video encoders for captures (main/obs.js): which ones OBS can use on this
// PC, and what each one can be set to. OBS itself checks the hardware when it
// starts and lists what works in its log ("Available Encoders"), so the
// launcher offers exactly those, instead of encoders OBS would quietly swap
// for x264.
//
// The settings are the ones OBS's own encoder pages have (texture-amf.cpp,
// obs-nvenc, obs-qsv11, obs-x264, obs-ffmpeg-av1 in OBS 32), written to the
// profile's recordEncoder.json.

const fs = require('fs');
const path = require('path');

const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

/**
 * Encoder families. ids: OBS encoder ids per codec, newest first.
 * rc: rate control -> what it uses (bitrate, a quality level, a peak bitrate).
 */
const FAMILIES = {
  amf: {
    label: 'AMD',
    hw: true,
    ids: { h264: ['h264_texture_amf'], hevc: ['h265_texture_amf'], av1: ['av1_texture_amf'] },
    rc: {
      CQP: { quality: 'cqp' },
      CBR: { bitrate: true },
      VBR: { bitrate: true },
      VBR_LAT: { bitrate: true },
      QVBR: { quality: 'cqp' },
      HQCBR: { bitrate: true },
      HQVBR: { bitrate: true },
    },
    qualityMax: (codec) => (codec === 'av1' ? 63 : 51),
    presets: (codec) => [...(codec === 'av1' ? [['highQuality', 'Highest Quality']] : []), ['quality', 'Quality'], ['balanced', 'Balanced'], ['speed', 'Speed']],
    profiles: (codec) => (codec === 'h264' ? ['high', 'main', 'baseline'] : codec === 'av1' ? ['main'] : []),
    bframes: (codec) => (codec === 'hevc' ? 0 : 5),
    bframesKey: 'bf',
    extras: [{ key: 'pre_analysis', label: 'Pre-Analysis', type: 'bool' }],
    defaults: (codec) => ({ rate_control: 'CQP', cqp: codec === 'av1' ? 28 : 20, bitrate: 40000, preset: codec === 'av1' ? 'highQuality' : 'quality', keyint_sec: 2, bf: 0, pre_analysis: false }),
  },
  nvenc: {
    label: 'NVIDIA NVENC',
    hw: true,
    ids: { h264: ['obs_nvenc_h264_tex', 'jim_nvenc'], hevc: ['obs_nvenc_hevc_tex', 'jim_hevc_nvenc'], av1: ['obs_nvenc_av1_tex', 'jim_av1_nvenc'] },
    rc: {
      CQP: { quality: 'cqp' },
      CBR: { bitrate: true },
      VBR: { bitrate: true, max: true },
      CQVBR: { quality: 'target_quality', max: true },
      lossless: {},
    },
    qualityMin: 1,
    qualityMax: (codec) => (codec === 'av1' ? 63 : 51),
    presets: () => [['p1', 'P1: Fastest'], ['p2', 'P2: Faster'], ['p3', 'P3: Fast'], ['p4', 'P4: Medium'], ['p5', 'P5: Slow'], ['p6', 'P6: Slower'], ['p7', 'P7: Slowest']],
    profiles: (codec) => (codec === 'h264' ? ['high', 'main', 'baseline'] : codec === 'hevc' ? ['main', 'main10'] : ['main']),
    bframes: () => 4,
    bframesKey: 'bf',
    extras: [
      { key: 'tune', label: 'Tuning', type: 'choice', options: [['hq', 'High Quality'], ['uhq', 'Ultra High Quality'], ['ll', 'Low Latency'], ['ull', 'Ultra Low Latency']] },
      { key: 'multipass', label: 'Multipass', type: 'choice', options: [['disabled', 'Off'], ['qres', 'Quarter Resolution'], ['fullres', 'Full Resolution']] },
      { key: 'lookahead', label: 'Look-Ahead', type: 'bool' },
      { key: 'adaptive_quantization', label: 'Psycho Visual Tuning', type: 'bool' },
    ],
    defaults: () => ({ rate_control: 'CQP', cqp: 20, target_quality: 20, bitrate: 40000, max_bitrate: 60000, preset: 'p5', tune: 'hq', multipass: 'qres', keyint_sec: 2, bf: 2, lookahead: false, adaptive_quantization: true }),
  },
  qsv: {
    label: 'Intel Quick Sync',
    hw: true,
    ids: { h264: ['obs_qsv11_v2', 'obs_qsv11'], hevc: ['obs_qsv11_hevc'], av1: ['obs_qsv11_av1'] },
    rc: {
      ICQ: { quality: 'icq_quality' },
      CQP: { quality: 'cqp' },
      CBR: { bitrate: true },
      VBR: { bitrate: true, max: true },
    },
    qualityMin: 1,
    qualityMax: (codec) => (codec === 'av1' ? 63 : 51),
    presets: () => [['TU1', 'TU1: Slowest (Best Quality)'], ['TU2', 'TU2: Slower'], ['TU3', 'TU3: Slow'], ['TU4', 'TU4: Balanced'], ['TU5', 'TU5: Fast'], ['TU6', 'TU6: Faster'], ['TU7', 'TU7: Fastest (Best Speed)']],
    presetKey: 'target_usage',
    profiles: (codec) => (codec === 'h264' ? ['high', 'main', 'baseline'] : codec === 'hevc' ? ['main', 'main10'] : ['main']),
    bframes: () => 3,
    bframesKey: 'bframes',
    extras: [{ key: 'latency', label: 'Latency', type: 'choice', options: [['normal', 'Normal'], ['low', 'Low'], ['ultra-low', 'Ultra Low']] }],
    defaults: () => ({ rate_control: 'ICQ', icq_quality: 20, cqp: 20, bitrate: 40000, max_bitrate: 60000, target_usage: 'TU4', keyint_sec: 2, bframes: 3, latency: 'normal' }),
  },
  x264: {
    label: 'x264 (Software)',
    hw: false,
    ids: { h264: ['obs_x264'] },
    rc: { CRF: { quality: 'crf' }, CBR: { bitrate: true }, VBR: { bitrate: true }, ABR: { bitrate: true } },
    qualityMax: () => 51,
    presets: () => X264_PRESETS.map((p) => [p, p]),
    profiles: () => ['high', 'main', 'baseline'],
    bframes: () => 0,
    extras: [{ key: 'tune', label: 'Tuning', type: 'choice', options: [['', 'None'], ['film', 'Film'], ['animation', 'Animation'], ['grain', 'Grain'], ['zerolatency', 'Zero Latency']] }],
    defaults: () => ({ rate_control: 'CRF', crf: 20, bitrate: 40000, preset: 'veryfast', profile: 'high', tune: '', keyint_sec: 2 }),
  },
  svt: {
    label: 'SVT-AV1 (Software)',
    hw: false,
    ids: { av1: ['ffmpeg_svt_av1'] },
    rc: { CQP: { quality: 'cqp' }, CBR: { bitrate: true }, VBR: { bitrate: true } },
    qualityMin: 1,
    qualityMax: () => 63,
    presets: () => [[8, '8: Slow'], [9, '9'], [10, '10: Balanced'], [11, '11'], [12, '12: Fast']],
    profiles: () => [],
    bframes: () => 0,
    extras: [],
    defaults: () => ({ rate_control: 'CQP', cqp: 30, bitrate: 20000, preset: 10, keyint_sec: 2 }),
  },
  aom: {
    label: 'AOM AV1 (Software, Slow)',
    hw: false,
    ids: { av1: ['ffmpeg_aom_av1'] },
    rc: { CQP: { quality: 'cqp' }, CBR: { bitrate: true }, VBR: { bitrate: true } },
    qualityMin: 1,
    qualityMax: () => 63,
    presets: () => [[7, '7: Slow'], [8, '8'], [9, '9'], [10, '10: Fastest']],
    profiles: () => [],
    bframes: () => 0,
    extras: [],
    defaults: () => ({ rate_control: 'CQP', cqp: 30, bitrate: 20000, preset: 10, keyint_sec: 2 }),
  },
};

const CODECS = ['h264', 'hevc', 'av1'];

/** id -> { family, codec } */
const BY_ID = new Map();
for (const [family, f] of Object.entries(FAMILIES)) for (const [codec, ids] of Object.entries(f.ids)) for (const id of ids) BY_ID.set(id, { family, codec });

/** The "Available Encoders" list from OBS's newest log that has one: [id]. Null without one. */
function fromObsLog(obsDir) {
  const dir = path.join(obsDir, 'logs');
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.txt$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 8);
  } catch {
    return null;
  }
  for (const { f } of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const at = text.indexOf('Available Encoders:');
    if (at < 0) continue;
    const block = text.slice(at, text.indexOf('Audio Encoders:', at) > 0 ? text.indexOf('Audio Encoders:', at) : at + 4000);
    const ids = [...block.matchAll(/^\S*\s*\t?-\s+([\w.-]+)\s+\(/gm)].map((m) => m[1]);
    if (ids.length) return ids;
  }
  return null;
}

/** OBS hasn't run here yet: what it most likely has, from the graphics card's name. */
function guess(gpu) {
  const ids = ['obs_x264', 'ffmpeg_svt_av1'];
  if (/nvidia|geforce|rtx|gtx/i.test(gpu)) ids.push('obs_nvenc_h264_tex', 'obs_nvenc_hevc_tex', ...(/rtx\s*[45]0/i.test(gpu) ? ['obs_nvenc_av1_tex'] : []));
  if (/amd|radeon/i.test(gpu)) ids.push('h264_texture_amf', 'h265_texture_amf', ...(/rx\s*[79]\d{3}/i.test(gpu) ? ['av1_texture_amf'] : []));
  if (/intel/i.test(gpu)) ids.push('obs_qsv11_v2', 'obs_qsv11_hevc', ...(/arc/i.test(gpu) ? ['obs_qsv11_av1'] : []));
  return ids;
}

/**
 * The encoders to offer: [{ id, family, codec, label, hw }], one per family
 * and codec (the newest id OBS has), hardware first.
 */
function available(obsDir, gpu) {
  const listed = fromObsLog(obsDir);
  const ids = listed || guess(gpu || '');
  const out = [];
  for (const [family, f] of Object.entries(FAMILIES)) {
    for (const codec of CODECS) {
      const id = (f.ids[codec] || []).find((x) => ids.includes(x));
      if (id) out.push({ id, family, codec, label: f.label, hw: f.hw });
    }
  }
  return { encoders: out, fromObs: !!listed };
}

/** What the settings page needs for one encoder: its choices and their ranges. */
function describe(id) {
  const at = BY_ID.get(id);
  if (!at) return null;
  const f = FAMILIES[at.family];
  return {
    id,
    family: at.family,
    codec: at.codec,
    rateControls: Object.entries(f.rc).map(([value, use]) => ({ value, ...use })),
    qualityMin: f.qualityMin || 0,
    qualityMax: f.qualityMax(at.codec),
    presets: f.presets(at.codec).map(([value, label]) => ({ value, label })),
    presetKey: f.presetKey || 'preset',
    profiles: f.profiles(at.codec),
    bframes: f.bframes(at.codec),
    bframesKey: f.bframesKey || null,
    extras: f.extras,
    defaults: f.defaults(at.codec),
  };
}

/** The settings OBS gets for an encoder: its defaults with what the user changed. */
function settingsFor(id, own) {
  const d = describe(id);
  if (!d) return {};
  const s = { ...d.defaults, ...(own || {}) };
  if (!d.rateControls.some((r) => r.value === s.rate_control)) s.rate_control = d.defaults.rate_control;
  return s;
}

/** Whether a rate control is bitrate-based (the replay buffer is then sized by time, not memory). */
function usesBitrate(id, own) {
  const d = describe(id);
  const s = settingsFor(id, own);
  const rc = d && d.rateControls.find((r) => r.value === s.rate_control);
  return !!(rc && rc.bitrate);
}

module.exports = { FAMILIES, CODECS, BY_ID, available, describe, settingsFor, usesBitrate, fromObsLog };
