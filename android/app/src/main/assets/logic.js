'use strict';
// Pure helpers (no DOM): parsing the OpenBeken log, IRSend codes, automation script. Tested by test_logic.js.

const hex = n => n.toString(16).toUpperCase();
const KASEIKYO = ['PANASONIC', 'KASEIKYO_DENON', 'KASEIKYO_SHARP', 'KASEIKYO_JVC', 'KASEIKYO_MITSUBISHI'];
// protocols for which the firmware fires IR_xxx events (usable as automation triggers)
const EVENT_NAME = { NEC: 'IR_NEC', SAMSUNG: 'IR_Samsung', SONY: 'IR_SONY', RC5: 'IR_RC5', RC6: 'IR_RC6', SHARP: 'IR_SHARP' };

// protocols the Arduino-IRremote IRsend::write() can transmit (PULSE_DISTANCE = long AC frames: receive only)
const SENDABLE = new Set(['NEC', 'NEC2', 'ONKYO', 'SAMSUNG', 'SAMSUNG_LG', 'SONY', 'PANASONIC', 'DENON', 'SHARP', 'LG', 'JVC',
  'RC5', 'RC6', 'APPLE', 'KASEIKYO_DENON', 'KASEIKYO_SHARP', 'KASEIKYO_JVC', 'KASEIKYO_MITSUBISHI', 'BOSEWAVE', 'LEGO_PF']);

// 8-bit NEC address when the high byte is its inverse (same rule as the library builder)
function necKey(a) { const lo = a & 0xFF, hi = a >> 8; return hi === (~lo & 0xFF) ? lo : a; }

/** One decoded IR frame from a log line, or null. Handles the Arduino-IRremote driver
 *  ("IR IR_NEC 0x4 0x8 0 (32 bits)") and the IRremoteESP8266 driver ("IR NEC 4 8 0"). */
function parseIrLine(line) {
  let m = /IR IR_([A-Za-z0-9_]+) 0x([0-9A-F]+) 0x([0-9A-F]+) (\d)(?: \((\d+) bits\))?/i.exec(line);
  if (!m) m = /:IR:IR ([A-Za-z0-9_]+) ([0-9A-F]+) ([0-9A-F]+) (\d)\s*$/i.exec(line);
  if (!m) return null;
  const p = m[1].toUpperCase();
  if (p === 'UNKNOWN') return null;
  const a = hex(parseInt(m[2], 16)), c = hex(parseInt(m[3], 16));
  return { p, a, c, rep: +m[4], bits: m[5] ? +m[5] : 0 };
}

/** IRSend argument for a decoded frame. */
function codeOf(f) {
  if (f.p === 'SONY') return `SONY-${f.a}-${f.c}-2-${hex(f.bits || 12)}`; // 3 frames, Sony needs repeats
  return `${f.p}-${f.a}-${f.c}`;
}

/** protocol:address key used to find library models that share a remote's "device code". */
function keyOf(p, a) {
  const n = parseInt(a, 16);
  if (p === 'NEC' || p === 'ONKYO') return 'NEC:' + hex(necKey(n));
  if (KASEIKYO.includes(p)) return p + ':' + hex(n & 0xFF);
  return p + ':' + hex(n);
}

/** Parse an IRSend code back into {p,a,c}; null if malformed. */
function splitCode(code) {
  const m = /^([A-Z0-9_]+)-([0-9A-F]+)-([0-9A-F]+)/i.exec(code || '');
  return m ? { p: m[1].toUpperCase(), a: m[2].toUpperCase(), c: m[3].toUpperCase() } : null;
}

// days: array of JS weekday numbers (0 = Sunday) -> OpenBeken flag (bit0 = Sunday)
const dayMask = days => days.reduce((m, d) => m | (1 << d), 0);

// ---------------------------------------------------------------- standard remote keys (layout + "complete missing keys")
const CANON = [
  ['power', /^(power|power_?toggle|on_?off|standby)$/], ['mute', /^mute$/], ['source', /^(source|input|input_?source|av|tv_?av)$/],
  ['vol_up', /^vol(ume)?_?(up|\+)$/], ['vol_dn', /^vol(ume)?_?(dn|down|-)$/],
  ['ch_next', /^(ch(annel)?|prog)_?(up|next|\+)$/], ['ch_prev', /^(ch(annel)?|prog)_?(dn|down|prev|-)$/],
  ['up', /^(up|arrow_?up|nav_?up|cursor_?up)$/], ['down', /^(down|arrow_?down|nav_?down|cursor_?down)$/],
  ['left', /^(left|arrow_?left|nav_?left|cursor_?left)$/], ['right', /^(right|arrow_?right|nav_?right|cursor_?right)$/],
  ['ok', /^(ok|select|enter|confirm)$/], ['back', /^(back|return|exit)$/], ['home', /^(home|smart_?hub)$/],
  ['menu', /^(menu|settings)$/], ['info', /^(info|guide|epg)$/],
];
// names given to keys added by "complete": canonKey() recognises them again
const CANON_NAME = { power: 'Power', mute: 'Mute', source: 'Source', vol_up: 'Vol_up', vol_dn: 'Vol_dn', ch_next: 'Ch_next', ch_prev: 'Ch_prev',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'OK', back: 'Back', home: 'Home', menu: 'Menu', info: 'Info' };
/** 'power', 'up', 'd7'... for a button name, or null. */
function canonKey(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const d = /^(num(ber)?|key|digit|btn)?_?([0-9])$/.exec(n);
  if (d) return 'd' + d[3];
  const m = CANON.find(([, re]) => re.test(n));
  return m ? m[0] : null;
}
const canonName = id => id[0] === 'd' && id.length === 2 ? id[1] : CANON_NAME[id];

// Alexa (Hue emulation) uses channels 10..31 of the S18
const HUE_CH = 10, HUE_MAX = 22;
// label goes in quotes in the script (verified on the S18): drop characters that would break it or the JSON
const hueName = s => String(s || '').replace(/["\\;\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);

// ---------------------------------------------------------------- S18 commands
// The custom firmware (build name contains "irraw") adds IRSendRaw, so raw/Gree codes can go through the S18 too.
let S18_RAW = false;
const setS18Raw = v => { S18_RAW = !!v; };
const isLong = code => /^(RAW|GREE):/.test(code || '');
const canS18 = code => S18_RAW || !isLong(code);
/** Raw text for IRSendRaw: "<kHz> t1,t2,..." */
function rawText(code) {
  const p = codeToPattern(code);
  return p ? `${Math.round(p.freq / 1000)} ${p.pattern.join(',')}` : null;
}
/** Command to type on the S18 console / send over HTTP (no length limit there). */
const s18Cmd = code => isLong(code) ? 'IRSendRaw ' + rawText(code) : 'IRSend ' + code;
/** Long codes used by scripts go into LittleFS files (script lines are capped at 255 chars).
 *  Every file costs a whole 4 KB block, so codes are packed PACK_LINES per file and sent with @file:line. */
const PACK_LINES = 6;
function makePack() {
  const codes = [], at = new Map();
  return {
    ref(code) {
      if (!at.has(code)) { at.set(code, codes.length); codes.push(code); }
      const i = at.get(code);
      return `@irpk${Math.floor(i / PACK_LINES)}.txt:${i % PACK_LINES}`;
    },
    fill(files) {
      for (let k = 0; k * PACK_LINES < codes.length; k++)
        files[`irpk${k}.txt`] = codes.slice(k * PACK_LINES, (k + 1) * PACK_LINES).map(rawText).join('\n');
    },
  };
}

function actionCmd(acts, pack) {
  const parts = (acts || []).filter(a => a && a.c && canS18(a.c)).map(a => { // phone-only codes never reach the S18
    if (!isLong(a.c)) return 'IRSend ' + a.c;
    return 'IRSendRaw ' + (pack ? pack.ref(a.c) : rawText(a.c));
  });
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : 'backlog ' + parts.join('; ');
}

/** Text of app.bat. utcOffsetHours comes from the phone so the device clock matches local time.
 *  files (optional object) receives {name: content} for long codes that must be written to LittleFS. */
function buildAppBat(state, utcOffsetHours, files) {
  const L = ["// generato dall'app IR Remote - non modificare a mano",
    `ntp_timeZoneOfs ${utcOffsetHours}`,
    // firmware has no DST rules: fix month ranges after boot, switch on the last Sunday of March/October
    'addRepeatingEvent 90 1 if $month>3 then "if $month<10 then ntp_timeZoneOfs 2"',
    'addRepeatingEvent 91 1 if $month<3 then ntp_timeZoneOfs 1',
    'addRepeatingEvent 92 1 if $month>10 then ntp_timeZoneOfs 1',
    'addClockEvent 02:00 0x01 900 if $month==3 then "if $mday>24 then ntp_timeZoneOfs 2"',
    'addClockEvent 03:00 0x01 901 if $month==10 then "if $mday>24 then ntp_timeZoneOfs 1"'];
  const pack = makePack();
  const al = state.alexa || {};
  const on = actionCmd(al.on, pack), off = actionCmd(al.off, pack);
  if (on) L.push('addChangeHandler Channel1 == 1 ' + on);
  if (off) L.push('addChangeHandler Channel1 == 0 ' + off);
  // Alexa devices (Hue emulation in the custom firmware): device i -> channel 10+i
  (state.devs || []).slice(0, HUE_MAX).forEach((d, i) => {
    const ch = HUE_CH + i, name = hueName(d.name) || 'Dispositivo' + (i + 1);
    const on = d.type === 'onoff' || !d.type ? actionCmd(d.on, pack) : null, off = d.type === 'onoff' || !d.type ? actionCmd(d.off, pack) : null;
    L.push(`setChannelType ${ch} ${d.type === 'onoff' || !d.type ? 'Toggle' : 'Dimmer'}`, `SetChannelLabel ${ch} "${name}"`);
    if (d.type === 'channel') { // percentage = TV channel number: digits (+ OK), then back to 0 so the same channel can be asked again
      const k = d.keys || {};
      for (let n = 1; n <= Math.min(100, d.max || 99); n++) {
        const digits = String(n).split('').map(x => k['d' + x]);
        if (digits.some(c => !c)) continue;
        const run = actionCmd(digits.concat(d.ok && k.ok ? [k.ok] : []).map(c => ({ c })), pack);
        if (run) L.push(`addChangeHandler Channel${ch} == ${n} ${run.startsWith('backlog ') ? run : 'backlog ' + run}; addRepeatingEvent 3 1 SetChannel ${ch} 0`);
      }
    } else if (d.type === 'ac' && canS18('GREE:')) { // percentage = temperature; out-of-range values snap to the nearest sensible one
      const st = t => ({ power: t > 0 ? 1 : 0, mode: d.mode ?? 1, fan: d.fan ?? 0, temp: t || 24, swing: d.swing ? 1 : 0 });
      const acCmd = t => actionCmd([{ c: 'GREE:' + greeState(st(t)).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase() }], pack);
      L.push(`addChangeHandler Channel${ch} == 0 ${acCmd(0)}`);
      for (let t = 16; t <= 30; t++) L.push(`addChangeHandler Channel${ch} == ${t} ${acCmd(t)}`);
      for (let t = 1; t < 16; t++) L.push(`addChangeHandler Channel${ch} == ${t} SetChannel ${ch} 16`);
      L.push(`addChangeHandler Channel${ch} > 30 SetChannel ${ch} 24`);
    } else {
      if (on) L.push(`addChangeHandler Channel${ch} == 1 ${on}`);
      if (off) L.push(`addChangeHandler Channel${ch} == 0 ${off}`);
    }
  });
  for (let i = (state.devs || []).length; i < HUE_MAX; i++) L.push(`setChannelType ${HUE_CH + i} Default`); // drop removed devices
  (state.autos || []).forEach((a, i) => {
    if (a.off) return;
    const run = actionCmd(a.acts, pack);
    if (!run) return;
    if (a.type === 'time' && /^\d\d:\d\d$/.test(a.time) && a.days && a.days.length) {
      L.push(`addClockEvent ${a.time} 0x${hex(dayMask(a.days))} ${i + 1} ${run}`);
    } else if (a.type === 'ir' && a.trig && EVENT_NAME[a.trig.p]) {
      L.push(`addEventHandler3 ${EVENT_NAME[a.trig.p]} 0x${a.trig.a} 0x${a.trig.c} 0 ${run}`);
    }
  });
  if (files) pack.fill(files);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- phone IR blaster: code -> {freq, pattern}
// pattern = alternating mark/space durations in µs, starting with a mark (Android ConsumerIrManager format)

/** Pulse-distance frame: optional header, bytes LSB first, final stop mark. */
function pdFrame(hdr, bytes, mark, zero, one, nbits) {
  const out = hdr.slice();
  const n = nbits || bytes.length * 8;
  for (let k = 0; k < n; k++) out.push(mark, (bytes[k >> 3] >> (k & 7)) & 1 ? one : zero);
  out.push(mark);
  return out;
}
/** Manchester (RC5/RC6): levels -> merged mark/space durations, leading space dropped. */
function manchester(levels) { // levels: [[on(bool), µs], ...]
  const out = []; let last = null;
  for (const [on, us] of levels) {
    if (!out.length && !on) continue;
    if (on === last) out[out.length - 1] += us; else { out.push(us); last = on; }
  }
  if (!last) out.pop(); // must end on a mark
  return out;
}
const VENDOR = { PANASONIC: 0x2002, KASEIKYO_DENON: 0x3254, KASEIKYO_SHARP: 0x5AAA, KASEIKYO_JVC: 0x0103, KASEIKYO_MITSUBISHI: 0xCB23 };

/** Gree AC (also Vaillant climaVAIR, Tosot, Sinclair...): 8-byte state -> frame. Verified on 56 real captures. */
function greeState(o) { // o: {power, mode 0 auto|1 cool|2 dry|3 fan|4 heat, temp 16..30, fan 0 auto|1..3, swing, light}
  const s = [0, 0, 0x20, 0x50, 0, 0x40, 0, 0];
  s[0] = (o.mode & 7) | (o.power ? 8 : 0) | ((o.fan & 3) << 4) | (o.swing ? 0x40 : 0);
  s[1] = Math.min(30, Math.max(16, o.temp | 0)) - 16;
  if (o.light === false) s[2] &= ~0x20;
  s[4] = o.swing ? 1 : 0;
  let sum = 10;
  for (let i = 0; i < 4; i++) sum += s[i] & 0xF;
  for (let i = 4; i < 7; i++) sum += s[i] >> 4;
  s[7] = (sum & 0xF) << 4;
  return s;
}
function greeFrame(s) {
  const a = pdFrame([9000, 4500], [s[0], s[1], s[2], s[3], 0b010], 620, 540, 1600, 35);
  a.push(19980);
  return a.concat(pdFrame([], s.slice(4), 620, 540, 1600));
}

function codeToPattern(code) {
  if (/^RAW:/.test(code)) {
    const [, f, d] = code.split(':');
    return { freq: +f || 38000, pattern: d.split(',').map(Number) };
  }
  if (/^GREE:/.test(code)) {
    const h = code.slice(5), s = [];
    for (let i = 0; i < 16; i += 2) s.push(parseInt(h.slice(i, i + 2), 16));
    return { freq: 38000, pattern: greeFrame(s) };
  }
  const m = /^([A-Z0-9_]+)-([0-9A-F]+)-([0-9A-F]+)(?:-([0-9A-F]+))?(?:-([0-9A-F]+))?$/i.exec(code || '');
  if (!m) return null;
  const p = m[1].toUpperCase(), a = parseInt(m[2], 16), c = parseInt(m[3], 16);
  const rep = m[4] ? parseInt(m[4], 16) : 0;
  const lo = x => x & 0xFF, inv = x => ~x & 0xFF;
  switch (p) {
    case 'NEC': case 'NEC2': {
      const ab = a > 0xFF ? [lo(a), a >> 8] : [a, inv(a)];
      return { freq: 38000, pattern: pdFrame([9000, 4500], [...ab, lo(c), inv(c)], 560, 560, 1690) };
    }
    case 'ONKYO':
      return { freq: 38000, pattern: pdFrame([9000, 4500], [lo(a), a >> 8, lo(c), c >> 8], 560, 560, 1690) };
    case 'SAMSUNG':
      return { freq: 38000, pattern: pdFrame([4500, 4500], [lo(a), a >> 8, lo(c), inv(c)], 560, 560, 1690) };
    case 'SONY': {
      const n = m[5] ? parseInt(m[5], 16) : 12, v = (c & 0x7F) | (a << 7);
      const f = [2400];
      for (let k = 0; k < n; k++) f.push(600, (v >> k) & 1 ? 1200 : 600);
      const total = f.reduce((x, y) => x + y, 0), out = [];
      for (let r = 0; r <= Math.max(2, rep); r++) { // Sony needs >= 3 frames, 45 ms period
        if (r) out.push(45000 - total);
        out.push(...f);
      }
      return { freq: 40000, pattern: out };
    }
    case 'RC5': {
      const bits = [1, c < 0x40 ? 1 : 0, 0];
      for (let k = 4; k >= 0; k--) bits.push((a >> k) & 1);
      for (let k = 5; k >= 0; k--) bits.push((c >> k) & 1);
      const lv = [];
      bits.forEach(b => lv.push([!b, 889], [!!b, 889])); // 1 = space then mark
      return { freq: 36000, pattern: manchester(lv) };
    }
    case 'RC6': {
      const lv = [[true, 2666], [false, 889]];
      const bit = (b, t) => lv.push([!!b, t], [!b, t]); // 1 = mark then space
      bit(1, 444); bit(0, 444); bit(0, 444); bit(0, 444); bit(0, 889); // start, mode 000, toggle (double)
      for (let k = 7; k >= 0; k--) bit((a >> k) & 1, 444);
      for (let k = 7; k >= 0; k--) bit((c >> k) & 1, 444);
      return { freq: 36000, pattern: manchester(lv) };
    }
    default:
      if (VENDOR[p]) {
        const v = VENDOR[p];
        let par = (v ^ (v >> 8)) & 0xFF; par = (par ^ (par >> 4)) & 0xF;
        const d2 = par | ((a & 0xF) << 4), d3 = (a >> 4) & 0xFF, d4 = c & 0xFF;
        return { freq: 37000, pattern: pdFrame([3456, 1728], [v & 0xFF, v >> 8, d2, d3, d4, d2 ^ d3 ^ d4], 432, 432, 1296) };
      }
      return null; // protocol the phone encoder doesn't know (S18 only)
  }
}

const canPhone = code => !!codeToPattern(code);
if (typeof module !== 'undefined') module.exports = { canonKey, canonName, PACK_LINES, hueName, HUE_CH, codeToPattern, greeState, canPhone, canS18, setS18Raw, s18Cmd, SENDABLE, parseIrLine, codeOf, keyOf, splitCode, dayMask, actionCmd, buildAppBat, EVENT_NAME, necKey };
