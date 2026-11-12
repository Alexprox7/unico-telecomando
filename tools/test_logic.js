// node tools/test_logic.js
const assert = require('assert');
const L = require('../android/app/src/main/assets/logic.js');

// old driver line, as seen on the device
const f = L.parseIrLine('Info:IR:IR IR_NEC 0xBEEF 0x5A 0 (32 bits)');
assert.deepStrictEqual(f, { p: 'NEC', a: 'BEEF', c: '5A', rep: 0, bits: 32 });
assert.strictEqual(L.codeOf(f), 'NEC-BEEF-5A');
assert.strictEqual(L.parseIrLine('Info:IR:IR IR_UNKNOWN 0x0 0'), null);
assert.strictEqual(L.parseIrLine('Info:IR:IR send NEC-BEEF-5A-0 protocol 7 addr 0xBEEF cmd 0x5A repeats 0'), null);
// Sony keeps bit count and gets repeats, matching the library format
const s = L.parseIrLine('Info:IR:IR IR_Sony 0x1 0x15 0 (12 bits)');
assert.strictEqual(L.codeOf(s), 'SONY-1-15-2-C');
// new driver format
assert.deepStrictEqual(L.parseIrLine('Info:IR:IR NEC 4 8 0'), { p: 'NEC', a: '4', c: '8', rep: 0, bits: 0 });
// keys agree with the library builder (python build_library.py)
assert.strictEqual(L.keyOf('NEC', '4'), 'NEC:4');
assert.strictEqual(L.keyOf('NEC', 'FB04'), 'NEC:4');
assert.strictEqual(L.keyOf('ONKYO', 'BF'), 'NEC:BF');
assert.strictEqual(L.keyOf('PANASONIC', '8'), 'PANASONIC:8');
assert.strictEqual(L.keyOf('SAMSUNG', '707'), 'SAMSUNG:707');
assert.deepStrictEqual(L.splitCode('SONY-1-15-2-C'), { p: 'SONY', a: '1', c: '15' });
// weekdays Mon-Fri -> 0x3E, Sunday is bit 0
assert.strictEqual(L.dayMask([1, 2, 3, 4, 5]), 0x3E);
assert.strictEqual(L.dayMask([0]), 1);

const bat = L.buildAppBat({
  alexa: { on: [{ c: 'SAMSUNG-707-2' }], off: [{ c: 'SAMSUNG-707-2' }, { c: 'NEC-4-8' }] },
  autos: [
    { type: 'time', time: '07:30', days: [1, 2, 3, 4, 5], acts: [{ c: 'NEC-4-8' }] },
    { type: 'time', time: '08:00', days: [1], acts: [{ c: 'NEC-4-8' }], off: true },
    { type: 'ir', trig: { p: 'NEC', a: '4', c: '9' }, acts: [{ c: 'RC5-0-C' }] },
    { type: 'ir', trig: { p: 'ONKYO', a: '4', c: '9' }, acts: [{ c: 'RC5-0-C' }] }, // no firmware event -> skipped
  ],
}, 1);
const lines = bat.trim().split('\n');
assert.ok(lines.includes('ntp_timeZoneOfs 1'));
assert.ok(lines.includes('addChangeHandler Channel1 == 1 IRSend SAMSUNG-707-2'));
assert.ok(lines.includes('addChangeHandler Channel1 == 0 backlog IRSend SAMSUNG-707-2; IRSend NEC-4-8'));
assert.ok(lines.includes('addClockEvent 07:30 0x3E 1 IRSend NEC-4-8'));
assert.ok(!bat.includes('08:00'));
assert.ok(lines.includes('addEventHandler3 IR_NEC 0x4 0x9 0 IRSend RC5-0-C'));
assert.strictEqual(lines.filter(l => l.startsWith('addEventHandler3')).length, 1);
// Gree state matches a real GREE_YAPOF capture: cool, on, fan high, 25 °C -> 39 09 20 50 00 40 00 00
const hex2 = a => a.map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
assert.strictEqual(hex2(L.greeState({ power: 1, mode: 1, temp: 25, fan: 3 })), '39 09 20 50 00 40 00 00');
assert.strictEqual(hex2(L.greeState({ power: 1, mode: 1, temp: 23, fan: 3 })), '39 07 20 50 00 40 00 E0');
assert.strictEqual(hex2(L.greeState({ power: 0, mode: 3, temp: 25, fan: 3, swing: 0 })).slice(0, 5), '33 09');
assert.ok(L.canS18('NEC-4-8') && !L.canS18('RAW:38000:1,2,3') && !L.canS18('GREE:0011223344556677'));
assert.ok(L.canPhone('RC5-0-C') && !L.canPhone('DENON-1-2'));

// custom S18 firmware (IRSendRaw): long codes become S18-capable; scripts use @files (255-char line limit)
const gree = 'GREE:' + hex2(L.greeState({ power: 1, mode: 1, temp: 25, fan: 3 })).replace(/ /g, '');
assert.strictEqual(L.s18Cmd('NEC-4-8'), 'IRSend NEC-4-8');
assert.ok(L.s18Cmd(gree).startsWith('IRSendRaw 38 9000,4500,620,'));
assert.strictEqual(L.s18Cmd('RAW:36000:100,200,300'), 'IRSendRaw 36 100,200,300');
assert.ok(!L.canS18(gree));
let files = {};
assert.ok(!L.buildAppBat({ autos: [{ type: 'time', time: '07:00', days: [1], acts: [{ c: gree }] }] }, 1, files).includes('07:00'));
L.setS18Raw(true);
assert.ok(L.canS18(gree));
files = {};
const bat2 = L.buildAppBat({ alexa: { on: [{ c: gree }] }, autos: [{ type: 'time', time: '07:00', days: [1], acts: [{ c: gree }, { c: 'NEC-4-8' }] }] }, 1, files);
// same code used twice -> one packed line, referenced as @file:line
assert.ok(bat2.includes('addChangeHandler Channel1 == 1 IRSendRaw @irpk0.txt:0'));
assert.ok(bat2.includes('addClockEvent 07:00 0x2 1 backlog IRSendRaw @irpk0.txt:0; IRSend NEC-4-8'));
assert.deepStrictEqual(Object.keys(files), ['irpk0.txt']);
assert.strictEqual('IRSendRaw ' + files['irpk0.txt'], L.s18Cmd(gree));
// resolve "@file:line" like the firmware does
const lineOf = ref => { const [f, n] = ref.split(':'); return files[f].split('\n')[+n]; };
assert.ok(bat2.split('\n').every(l => l.length <= 255), 'every script line fits the 255-char exec buffer');
// Alexa devices (Hue): channel 10+i, quoted labels, AC percentage = temperature
files = {};
const bat3 = L.buildAppBat({ devs: [
  { name: 'Clima "sala"; x', type: 'ac', mode: 1, fan: 0 },
  { name: 'Decoder', type: 'onoff', on: [{ c: 'NEC-4-8' }], off: [{ c: 'NEC-4-9' }] },
] }, 1, files).split('\n');
assert.ok(bat3.includes('setChannelType 10 Dimmer') && bat3.includes('SetChannelLabel 10 "Clima sala x"'));
assert.ok(bat3.includes('SetChannelLabel 11 "Decoder"') && bat3.includes('addChangeHandler Channel11 == 1 IRSend NEC-4-8'));
assert.ok(bat3.includes('addChangeHandler Channel11 == 0 IRSend NEC-4-9'));
const h22 = bat3.find(l => l.startsWith('addChangeHandler Channel10 == 22 IRSendRaw @'));
assert.ok(h22, 'AC 22% -> Gree cool 22');
const f22 = h22.split('@')[1];
const cool22 = 'GREE:' + hex2(L.greeState({ power: 1, mode: 1, fan: 0, temp: 22 })).replace(/ /g, '');
assert.strictEqual('IRSendRaw ' + lineOf(f22), L.s18Cmd(cool22));
assert.ok(bat3.includes('addChangeHandler Channel10 == 5 SetChannel 10 16') && bat3.includes('addChangeHandler Channel10 > 30 SetChannel 10 24'));
assert.ok(bat3.includes('setChannelType 12 Default') && bat3.includes('setChannelType 31 Default') && !bat3.includes('setChannelType 32 Default'));
// 16 frames (15 temperatures + off) in ceil(16/6) = 3 files, each under one 4 KB block
assert.deepStrictEqual(Object.keys(files), ['irpk0.txt', 'irpk1.txt', 'irpk2.txt']);
assert.ok(Object.values(files).every(t => t.length < 4096 && t.split('\n').length <= L.PACK_LINES));
assert.ok(bat3.every(l => l.length <= 255));
L.setS18Raw(false);
// without the raw firmware the AC device is declared but gets no (unsendable) handlers
assert.ok(!L.buildAppBat({ devs: [{ name: 'Clima', type: 'ac' }] }, 1, {}).includes('Channel10 =='));

// Alexa "TV channel": N% -> digits of N (+ OK), then the channel resets to 0
const keys = Object.fromEntries([...'0123456789'].map(x => ['d' + x, 'SAMSUNG-707-' + (10 + +x).toString(16).toUpperCase()]).concat([['ok', 'SAMSUNG-707-68']]));
const bat4 = L.buildAppBat({ devs: [{ name: 'Canale TV', type: 'channel', keys, ok: true, max: 12 }] }, 1, {}).split('\n');
assert.ok(bat4.includes('setChannelType 10 Dimmer') && bat4.includes('SetChannelLabel 10 "Canale TV"'));
assert.ok(bat4.includes('addChangeHandler Channel10 == 5 backlog IRSend SAMSUNG-707-F; IRSend SAMSUNG-707-68; addRepeatingEvent 3 1 SetChannel 10 0'));
assert.ok(bat4.includes('addChangeHandler Channel10 == 12 backlog IRSend SAMSUNG-707-B; IRSend SAMSUNG-707-C; IRSend SAMSUNG-707-68; addRepeatingEvent 3 1 SetChannel 10 0'));
assert.ok(!bat4.some(l => l.startsWith('addChangeHandler Channel10 == 13')), 'stops at max');
// missing digit -> channels using it are skipped, no OK when not asked
const noNine = { ...keys }; delete noNine.d9;
const bat5 = L.buildAppBat({ devs: [{ name: 'Tv', type: 'channel', keys: noNine, max: 20 }] }, 1, {});
assert.ok(!bat5.includes('== 9 ') && !bat5.includes('== 19 ') && bat5.includes('== 18 backlog IRSend SAMSUNG-707-B; IRSend SAMSUNG-707-12; addRepeatingEvent 3 1 SetChannel 10 0'));
// AC with swing sends swing in every frame
L.setS18Raw(true);
const fs6 = {};
const bat6 = L.buildAppBat({ devs: [{ name: 'Clima oscillazione', type: 'ac', mode: 1, fan: 0, swing: 1 }] }, 1, fs6);
const ref22 = bat6.split('\n').find(l => l.startsWith('addChangeHandler Channel10 == 22 ')).split('IRSendRaw ')[1];
const [pf, pl] = ref22.slice(1).split(':');
assert.strictEqual('IRSendRaw ' + fs6[pf].split('\n')[+pl], L.s18Cmd('GREE:' + hex2(L.greeState({ power: 1, mode: 1, fan: 0, temp: 22, swing: 1 })).replace(/ /g, '')));
L.setS18Raw(false);

// standard key recognition (names seen in the Samsung remote and the library)
const ck = n => L.canonKey(n);
assert.deepStrictEqual(['Power', 'Smart_hub', 'Up', 'Select', 'Return', 'Vol_up', 'Vol_dn', 'Ch_next', 'Ch_prev', 'Mute', 'Source'].map(ck),
  ['power', 'home', 'up', 'ok', 'back', 'vol_up', 'vol_dn', 'ch_next', 'ch_prev', 'mute', 'source']);
assert.deepStrictEqual(['1', 'Num_7', 'KEY_0', 'digit 3', 'Virtual_numarical_pad', 'Netflix', 'Power_off_only'].map(ck), ['d1', 'd7', 'd0', 'd3', null, null, null]);
for (const id of ['d5', 'ok', 'ch_prev', 'home']) assert.strictEqual(ck(L.canonName(id)), id, 'added keys are recognised again');

// patterns for the python cross-check (tools/check_patterns.py decodes them with the library decoder)
const codes = ['NEC-4-8', 'NEC-586-F', 'ONKYO-BF-1234', 'SAMSUNG-707-2', 'SONY-1-15-2-C', 'PANASONIC-8-3D'];
const out = Object.fromEntries(codes.map(c => [c, L.codeToPattern(c).pattern]));
out.GREE = L.codeToPattern('GREE:' + hex2(L.greeState({ power: 1, mode: 1, temp: 25, fan: 3 })).replace(/ /g, '')).pattern;
require('fs').writeFileSync(require('path').join(__dirname, 'patterns.json'), JSON.stringify(out));
for (const p of Object.values(out)) assert.ok(p.length % 2 === 1 && p.every(x => x > 0), 'odd length, positive');
// RC5 addr 0 cmd 0xC: 14 manchester bits -> starts with an 889 µs mark, ends on a mark
const rc5 = L.codeToPattern('RC5-0-C').pattern;
assert.strictEqual(rc5[0], 889); assert.strictEqual(rc5.length % 2, 1);
console.log('logic OK');
