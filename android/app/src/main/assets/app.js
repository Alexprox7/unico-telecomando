'use strict';
/* global canonKey, canonName, splitCode, hueName, codeToPattern, greeState, canPhone, canS18, setS18Raw, s18Cmd, SENDABLE, parseIrLine, codeOf, keyOf, buildAppBat, EVENT_NAME, Native */
const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------- state (phone) + backup (S18)
const DEF = { ip: '', target: 'both', remotes: [], autos: [], alexa: { name: 'TV', on: [], off: [] }, dirty: false };
let hadLocal = false, S;
try {
  const raw = localStorage.getItem('irr');
  hadLocal = !!raw;
  S = Object.assign(structuredClone(DEF), JSON.parse(raw || 'null') || {});
} catch (e) { S = structuredClone(DEF); }

let backupT;
function save(deviceDirty) {
  if (deviceDirty) S.dirty = true;
  try { localStorage.setItem('irr', JSON.stringify(S)); } catch (e) { /* storage full: keep running */ }
  clearTimeout(backupT);
  backupT = setTimeout(backup, 3000);
}
async function backup() {
  if (!S.ip) return;
  const txt = JSON.stringify({ v: 1, remotes: S.remotes, autos: S.autos, alexa: S.alexa, devs: S.devs || [] });
  if (txt.length > 20000) return; // LittleFS is only 32 KB, never fill it with the backup
  await http('POST', dev('api/lfs/irremote.json'), txt);
}
async function restoreFromDevice(silent) {
  const r = await http('GET', dev('api/lfs/irremote.json'));
  let d = null;
  try { d = r.code === 200 ? JSON.parse(r.text) : null; } catch (e) { d = null; }
  if (!d || !Array.isArray(d.remotes)) { if (!silent) toast('Nessun backup sull\'S18', true); return; }
  S.remotes = d.remotes; S.autos = d.autos || []; S.alexa = d.alexa || DEF.alexa; S.devs = d.devs || [];
  save(); toast('Dati ripristinati dall\'S18'); render();
}

// ---------------------------------------------------------------- HTTP through the Java bridge (no CORS)
const pend = {}; let seq = 0;
window.Native_cb = (id, code, text) => { const f = pend[id]; delete pend[id]; if (f) f({ code, text }); };
function http(method, url, body = '') {
  if (window.Native) return new Promise(res => { const id = ++seq; pend[id] = res; Native.http(id, method, url, body); });
  return fetch(url, { method, body: method === 'GET' ? undefined : body })
    .then(async r => ({ code: r.status, text: await r.text() }), e => ({ code: 0, text: String(e) }));
}
const asset = p => window.Native ? Promise.resolve(Native.asset(p)) : fetch(p).then(r => r.ok ? r.text() : null, () => null);
const dev = p => `http://${S.ip}/${p}`;
const cmd = c => http('GET', dev('cm?cmnd=' + encodeURIComponent(c)));
// ---------------------------------------------------------------- where to send: S18, phone blaster, or both
const HAS_IR = !!(window.Native && Native.hasIr && Native.hasIr());
const TARGETS = { s18: 'S18', phone: 'Telefono', both: 'S18 + Tel.' };
// codes only one side can send always go there; otherwise the user's choice decides
const toS18 = code => canS18(code) && (S.target !== 'phone' || !HAS_IR || !canPhone(code));
const toPhone = code => HAS_IR && canPhone(code) && (S.target !== 's18' || !canS18(code));
function phoneSend(code) {
  const p = codeToPattern(code);
  return p ? Native.irTransmit(p.freq, JSON.stringify(p.pattern)) : 'protocollo non supportato';
}
async function send(code) {
  const s = toS18(code), ph = toPhone(code);
  if (!s && !ph) { toast(canS18(code) ? 'Codice non inviabile' : 'Questo tasto richiede il blaster IR del telefono', true); return false; }
  // start the S18 request, then fire the phone at the same time; long raw commands go by POST (no URL limit)
  const job = s ? http('POST', dev('api/cmnd'), s18Cmd(code)) : null;
  let ok = true;
  if (ph) { const err = phoneSend(code); if (err) { toast('Telefono: ' + err, true); ok = false; } }
  if (job) {
    const r = await job;
    if (r.code !== 200) { toast(r.code === 0 ? 'S18 non raggiungibile' : 'S18: comando rifiutato (' + r.code + ')', true); ok = false; }
  }
  return ok;
}
function drawTarget() {
  const b = $('#tgt');
  b.hidden = !HAS_IR;
  b.textContent = '➜ ' + TARGETS[S.target];
}
$('#tgt').onclick = () => {
  S.target = { s18: 'phone', phone: 'both', both: 's18' }[S.target];
  S.dirty = S.dirty || S.autos.length > 0; // automations are split by target: re-apply
  save(); drawTarget(); toast('Invio da: ' + TARGETS[S.target]);
};
// ---------------------------------------------------------------- finding the S18 (IP changes, other networks)
function scanNet() {
  if (!(window.Native && Native.scan)) return Promise.resolve({ net: '', devices: [] });
  return new Promise(res => {
    const id = ++seq;
    pend[id] = r => { let d = null; try { d = JSON.parse(r.text); } catch (e) { d = null; } res(d || { net: '', devices: [] }); };
    Native.scan(id);
  });
}
let lastScan = 0, scanning = false;
/** S18 not answering: look for it (same MAC) on the current network and adopt its new IP. */
async function rediscover() {
  if (scanning || !S.mac || Date.now() - lastScan < 60000) return false;
  scanning = true; lastScan = Date.now();
  const d = await scanNet();
  scanning = false;
  const me = d.devices.find(x => (x.mac || '').toLowerCase() === S.mac);
  if (!me) return false;
  if (me.ip !== S.ip) { S.ip = me.ip; save(); toast('S18 ritrovato al nuovo indirizzo ' + me.ip); }
  return true;
}
/** First run (no IP yet): adopt the only OpenBeken device on the network, or send the user to Settings to pick one. */
async function firstRun() {
  const d = await scanNet();
  if (d.devices.length === 1) { S.ip = d.devices[0].ip; S.mac = (d.devices[0].mac || '').toLowerCase(); save(); toast('S18 trovato: ' + S.ip); ping(); if (!hadLocal) restoreFromDevice(true); return; }
  toast(d.devices.length ? 'Trovati più dispositivi: sceglilo in Impostazioni → Cerca sulla rete' : 'Nessun S18 trovato: inserisci l\'IP in Impostazioni', true);
}
async function ping() {
  if (!S.ip) { $('#dot').className = 'off'; return { code: 0, text: '' }; }
  let r = await http('GET', dev('api/info'));
  if (r.code !== 200 && await rediscover()) r = await http('GET', dev('api/info'));
  $('#dot').className = r.code === 200 ? 'on' : 'off';
  let info = null;
  try { info = r.code === 200 ? JSON.parse(r.text) : null; } catch (e) { info = null; }
  if (info) { // remember it: offline we still know what the S18 can send, and which device is "ours"
    if (info.mac && S.mac !== info.mac.toLowerCase()) { S.mac = info.mac.toLowerCase(); save(); }
    const raw = /irraw/i.test(info.build || '');
    if (raw !== !!S.s18raw) { S.s18raw = raw; setS18Raw(raw); S.dirty = true; save(); render(); }
  }
  return r;
}

// ---------------------------------------------------------------- IR receive (polls the device log)
let pollT = null, polling = false;
const listeners = new Set();
function listen(fn) {
  listeners.add(fn);
  if (!pollT) { http('GET', dev('lograw')); pollT = setInterval(poll, 700); } // first call drops old log lines
  return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(pollT); pollT = null; } };
}
async function poll() {
  if (polling) return;
  polling = true;
  const r = await http('GET', dev('lograw'));
  polling = false;
  if (r.code !== 200) return;
  for (const line of r.text.split('\n')) {
    const f = parseIrLine(line);
    if (f && !f.rep) listeners.forEach(l => l(f));
  }
}

// ---------------------------------------------------------------- UI helpers
let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 1800);
}
let sheetClose = null;
function sheet(html, onClose) {
  $('#sheetIn').innerHTML = html; $('#sheet').hidden = false;
  if (onClose !== undefined) sheetClose = onClose;
}
function closeSheet() {
  if ($('#sheet').hidden) return false;
  $('#sheet').hidden = true; $('#sheetIn').innerHTML = '';
  const f = sheetClose; sheetClose = null; if (f) f();
  return true;
}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

const NICE = { power: 'Accensione', power_on: 'Accendi', power_off: 'Spegni', mute: 'Muto', vol_up: 'Vol +', vol_dn: 'Vol −', ch_next: 'Can +', ch_prev: 'Can −' };
const ORDER = ['power', 'power_on', 'power_off', 'mute', 'vol_up', 'vol_dn', 'ch_next', 'ch_prev'];
const nice = n => NICE[n.toLowerCase()] || n.replace(/_/g, ' ');
const isPower = n => /^power/i.test(n);
function sortKeys(btns) { // -> [[button, originalIndex]] with the usual keys first
  const rank = b => { const r = ORDER.indexOf(b.n.toLowerCase()); return r < 0 ? 99 : r; };
  return btns.map((b, i) => [b, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]);
}
const gridHtml = btns => `<div class="grid">${sortKeys(btns).map(([b, j]) =>
  `<button class="key${isPower(b.n) ? ' pw' : ''}" data-i="${j}">${esc(nice(b.n))}${canS18(b.c) ? '' : '<small>📱 solo telefono</small>'}</button>`).join('')}</div>`;
function bindKeys(root, onTap, onHold) {
  root.querySelectorAll('.key').forEach(k => {
    let t, held = false;
    const i = +k.dataset.i;
    k.addEventListener('pointerdown', () => {
      held = false;
      if (onHold) t = setTimeout(() => { held = true; if (navigator.vibrate) navigator.vibrate(30); onHold(i); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => k.addEventListener(ev, () => clearTimeout(t)));
    k.addEventListener('click', () => { if (held) return; if (navigator.vibrate) navigator.vibrate(12); onTap(i); });
    k.addEventListener('contextmenu', e => e.preventDefault());
  });
}
const actsText = acts => (acts && acts.length) ? acts.map(a => (a.r ? `${a.r}: ${nice(a.n)}` : a.c) + (canS18(a.c) ? '' : ' 📱')).join(', ') : 'niente';

// ---------------------------------------------------------------- navigation
let tab = 'remotes', stack = [], RT = 0;
function render() {
  RT++;
  stopLearn();
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('sel', b.dataset.tab === tab));
  $('#back').hidden = !stack.length;
  window.scrollTo(0, 0);
  (stack.length ? stack[stack.length - 1] : TABS[tab])();
}
function go(t) { closeSheet(); tab = t; stack = []; render(); }
function push(fn) { stack.push(fn); render(); }
function pop() { stack.pop(); render(); }
window.onBack = () => {
  if (closeSheet()) return true;
  if (stack.length) { pop(); return true; }
  if (tab !== 'remotes') { go('remotes'); return true; }
  return false;
};
const title = t => { $('#title').textContent = t; };

// ---------------------------------------------------------------- tab: remotes
function remotesTab() {
  title('Telecomandi');
  view.innerHTML = (S.remotes.length
    ? `<div class="list">${S.remotes.map((r, i) => `<div class="card row" data-i="${i}"><div class="grow"><div class="t ell">${esc(r.name)}</div><div class="s">${r.kind === 'gree' ? 'Condizionatore · ' + esc(acLabel(r.ac)) : r.buttons.length + ' tasti'}</div></div><span class="s">›</span></div>`).join('')}</div>`
    : `<div class="empty">Nessun telecomando.<br>Aggiungine uno dalla <b>Libreria</b>, oppure crealo vuoto e insegnagli i tasti del tuo telecomando.</div>`)
    + '<button class="btn p w" id="new">+ Nuovo telecomando</button>';
  view.querySelectorAll('.list .card').forEach(c => { c.onclick = () => push(() => remoteView(+c.dataset.i)); });
  $('#new').onclick = () => {
    sheet(`<h2>Nuovo telecomando</h2><button class="btn p w" id="fromLib">Cerca nella libreria</button><div style="height:8px"></div><button class="btn w" id="blank">Vuoto: imparo i tasti dal mio telecomando</button>
      <div style="height:8px"></div><button class="btn w" id="ac">Condizionatore Gree e compatibili<br><span class="s">Vaillant climaVAIR, Saunier Duval, Tosot, Sinclair…</span></button>`);
    $('#fromLib').onclick = () => go('library');
    $('#ac').onclick = () => { closeSheet(); newAc('Condizionatore'); };
    $('#blank').onclick = () => {
      const n = prompt('Nome del telecomando', 'TV');
      if (!n || !n.trim()) return;
      S.remotes.push({ id: uid(), name: n.trim(), buttons: [] }); save();
      closeSheet(); push(() => remoteView(S.remotes.length - 1));
    };
  };
}
// ---------------------------------------------------------------- Gree air conditioner panel (phone blaster)
const MODES = [[0, 'Auto'], [1, 'Freddo'], [2, 'Deumidifica'], [3, 'Ventola'], [4, 'Caldo']];
const FANS = [[0, 'Auto'], [1, 'Bassa'], [2, 'Media'], [3, 'Alta']];
const greeCode = a => 'GREE:' + greeState(a).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const acLabel = a => a.power ? `${MODES.find(m => m[0] === a.mode)[1]} ${a.temp}° · ventola ${FANS.find(f => f[0] === a.fan)[1].toLowerCase()}` : 'Spegni';
function newAc(name) {
  const n = prompt('Nome del condizionatore', name);
  if (!n || !n.trim()) return;
  S.remotes.push({ id: uid(), name: n.trim(), kind: 'gree', ac: { power: 0, mode: 1, temp: 24, fan: 0, swing: 0 }, buttons: [] });
  save(); go('remotes'); push(() => remoteView(S.remotes.length - 1));
}
function acView(r, i) {
  title(r.name);
  const a = r.ac;
  const redraw = () => { const y = window.scrollY; acView(r, i); window.scrollTo(0, y); };
  const change = (fn, sendAnyway) => { fn(); save(); redraw(); if (a.power || sendAnyway) send(greeCode(a)); };
  view.innerHTML = `<div class="card" style="text-align:center"><div class="s">${a.power ? esc(MODES.find(m => m[0] === a.mode)[1]) : 'Spento'}</div>
      <div class="big">${a.temp}°</div>
      <div class="row"><button class="btn grow" id="tm">− 1°</button><button class="btn grow" id="tp">+ 1°</button></div></div>
    <button class="key${a.power ? '' : ' pw'}" style="width:100%" id="pw">${a.power ? 'Spegni' : 'Accendi'}</button>
    <label class="f">Modalità</label><div class="chips">${MODES.map(([v, l]) => `<button class="chip${a.mode === v ? ' sel' : ''}" data-m="${v}">${l}</button>`).join('')}</div>
    <label class="f">Ventola</label><div class="chips">${FANS.map(([v, l]) => `<button class="chip${a.fan === v ? ' sel' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
    <div class="card row"><div class="grow">Oscillazione aletta</div><label class="sw"><input type="checkbox" id="swg" ${a.swing ? 'checked' : ''}><span></span></label></div>
    <div class="note">Protocollo Gree. ${S.s18raw ? 'Lo inviano l\'S18 (firmware con invio raw) e/o il telefono, secondo la scelta in alto: funziona anche nelle automazioni dell\'S18 e con Alexa.'
    : `Lo invia ${HAS_IR ? 'il blaster del telefono' : '— questo telefono non ha il blaster IR'}: il firmware attuale dell'S18 non sa trasmettere i comandi dei condizionatori.`}</div>
    <button class="btn w" id="preset">Salva questa impostazione come tasto</button>
    <p class="s">I tasti salvati si possono usare nelle automazioni a orario (le esegue il telefono).</p>
    ${r.buttons.length ? gridHtml(r.buttons) : ''}
    <div class="row"><button class="btn grow" id="ren">Rinomina</button><button class="btn grow" id="del">Elimina</button></div>`;
  $('#tm').onclick = () => change(() => { a.temp = Math.max(16, a.temp - 1); });
  $('#tp').onclick = () => change(() => { a.temp = Math.min(30, a.temp + 1); });
  $('#pw').onclick = () => change(() => { a.power = a.power ? 0 : 1; }, true);
  view.querySelectorAll('[data-m]').forEach(c => { c.onclick = () => change(() => { a.mode = +c.dataset.m; }); });
  view.querySelectorAll('[data-f]').forEach(c => { c.onclick = () => change(() => { a.fan = +c.dataset.f; }); });
  $('#swg').onchange = e => change(() => { a.swing = e.target.checked ? 1 : 0; });
  $('#preset').onclick = () => {
    const n = prompt('Nome del tasto', acLabel(a));
    if (!n || !n.trim()) return;
    r.buttons.push({ n: n.trim(), c: greeCode(a) }); save(); redraw();
  };
  bindKeys(view, j => send(r.buttons[j].c), j => keyMenu(r, j));
  $('#ren').onclick = () => { const n = prompt('Nuovo nome', r.name); if (n && n.trim()) { r.name = n.trim(); save(); render(); } };
  $('#del').onclick = () => { if (confirm(`Eliminare "${r.name}"?`)) { S.remotes.splice(i, 1); save(); pop(); } };
}

// remote layout: standard keys in fixed places (null = empty cell), everything else in "Altri tasti"
const LAYOUT = [
  [['power', 'source', 'mute']],
  [[null, 'up', null], ['left', 'ok', 'right'], ['back', 'down', 'home']],
  [['vol_up', 'menu', 'ch_next'], ['vol_dn', 'info', 'ch_prev']],
  [['d1', 'd2', 'd3'], ['d4', 'd5', 'd6'], ['d7', 'd8', 'd9'], [null, 'd0', null]],
];
const KEY_LABEL = { power: 'Accensione', source: 'Sorgente', mute: 'Muto', up: '▲', down: '▼', left: '◀', right: '▶', ok: 'OK', back: 'Indietro',
  home: 'Home', menu: 'Menu', info: 'Info', vol_up: 'Vol +', vol_dn: 'Vol −', ch_next: 'Can +', ch_prev: 'Can −' };
function layoutHtml(btns) {
  const at = {};
  btns.forEach((b, j) => { const id = canonKey(b.n); if (id && !(id in at)) at[id] = j; });
  const used = new Set(Object.values(at));
  const cell = id => id && id in at
    ? `<button class="key${id === 'power' ? ' pw' : ''}" data-i="${at[id]}">${esc(KEY_LABEL[id] || id.slice(1))}</button>` : '<span></span>';
  const blocks = LAYOUT.filter(rows => rows.some(row => row.some(id => id && id in at)))
    .map(rows => `<div class="grid">${rows.map(row => row.map(cell).join('')).join('')}</div>`).join('');
  const rest = btns.map((b, j) => [b, j]).filter(([, j]) => !used.has(j));
  return blocks + (rest.length ? `<div class="t" style="margin-top:6px">Altri tasti</div><div class="grid">${rest.map(([b, j]) =>
    `<button class="key" data-i="${j}">${esc(nice(b.n))}${canS18(b.c) ? '' : '<small>📱 solo telefono</small>'}</button>`).join('')}</div>` : '');
}
/** Adds standard keys this remote lacks (digits, arrows...) from library models with the same device code, by majority vote. */
async function completeKeys(r) {
  const have = new Set(r.buttons.map(b => canonKey(b.n)).filter(Boolean));
  const cnt = {};
  r.buttons.forEach(b => { const s = splitCode(b.c); if (s) cnt[`${s.p}-${s.a}-`] = (cnt[`${s.p}-${s.a}-`] || 0) + 1; });
  const prefix = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  if (!prefix) { toast('Questo telecomando non ha codici di riferimento', true); return; }
  const sp = splitCode(prefix + '0'), key = keyOf(sp.p, sp.a);
  toast('Cerco nei modelli compatibili…');
  const votes = {};
  for (const e of (await getIndex()).filter(x => x[5].includes(key))) {
    for (const [n, c] of (await getChunk(e[3]))[e[2]] || []) {
      const id = canonKey(n);
      if (!id || have.has(id) || !c.startsWith(prefix)) continue;
      (votes[id] = votes[id] || {})[c] = (votes[id][c] || 0) + 1;
    }
  }
  const ids = Object.keys(votes);
  ids.forEach(id => { const v = votes[id]; r.buttons.push({ n: canonName(id), c: Object.keys(v).sort((a, b) => v[b] - v[a])[0] }); });
  save();
  toast(ids.length ? `Aggiunti ${ids.length} tasti: provali, e tieni premuto per eliminare quelli che non vanno` : 'Nessun tasto mancante trovato nei modelli compatibili', !ids.length);
  render();
}

function remoteView(i) {
  const r = S.remotes[i];
  if (!r) { stack.pop(); return render(); }
  if (r.kind === 'gree') return acView(r, i);
  title(r.name);
  const missing = r.buttons.length && ['d1', 'up', 'ok', 'vol_up'].some(id => !r.buttons.some(b => canonKey(b.n) === id));
  view.innerHTML = (r.buttons.length ? layoutHtml(r.buttons) + '<p class="s">Tieni premuto un tasto per rinominarlo o eliminarlo.</p>' : '<div class="empty">Ancora nessun tasto.</div>')
    + (missing ? '<button class="btn w" id="cmp">Completa i tasti mancanti (numeri, frecce…)</button><div style="height:8px"></div>' : '')
    + '<button class="btn w" id="lrn">+ Impara tasti dal telecomando</button><div style="height:8px"></div>'
    + (r.buttons.length ? '<button class="btn w" id="bulk">Modifica tasti (elimina, sposta, copia…)</button><div style="height:8px"></div>' : '')
    + '<div class="row"><button class="btn grow" id="ren">Rinomina</button><button class="btn grow" id="del">Elimina</button></div>';
  bindKeys(view, j => send(r.buttons[j].c), j => keyMenu(r, j));
  if ($('#cmp')) $('#cmp').onclick = () => completeKeys(r);
  if ($('#bulk')) $('#bulk').onclick = () => push(() => bulkKeys(r));
  $('#lrn').onclick = () => learnInto(r);
  $('#ren').onclick = () => { const n = prompt('Nuovo nome', r.name); if (n && n.trim()) { r.name = n.trim(); save(); render(); } };
  $('#del').onclick = () => { if (confirm(`Eliminare "${r.name}"?`)) { S.remotes.splice(i, 1); save(); pop(); } };
}
/** Multi-select editor for a remote's keys: delete, move or copy many at once. */
function bulkKeys(r) {
  title('Modifica tasti');
  const sel = new Set();
  const draw = () => {
    view.innerHTML = `<div class="s">${esc(r.name)} · ${r.buttons.length} tasti · ${sel.size} selezionati</div>
      <div class="row" style="margin:8px 0"><button class="btn sm grow" id="all">Tutti</button><button class="btn sm grow" id="none">Nessuno</button><button class="btn sm grow" id="dup">Doppioni</button></div>
      <div class="list">${r.buttons.map((b, j) => `<label class="card row" style="padding:10px;margin:6px 0"><input type="checkbox" data-k="${j}" ${sel.has(j) ? 'checked' : ''} style="width:22px;height:22px">
        <div class="grow"><div class="t ell">${esc(nice(b.n))}</div><div class="s ell">${esc(b.c.length > 40 ? b.c.slice(0, 40) + '…' : b.c)}</div></div></label>`).join('')}</div>
      <div class="sticky row"><button class="btn grow" id="mv" ${sel.size ? '' : 'disabled'}>Sposta / copia</button><button class="btn p grow" id="rm" ${sel.size ? '' : 'disabled'}>Elimina (${sel.size})</button></div>`;
    view.querySelectorAll('[data-k]').forEach(c => { c.onchange = () => { const j = +c.dataset.k; if (c.checked) sel.add(j); else sel.delete(j); draw(); }; });
    $('#all').onclick = () => { r.buttons.forEach((_, j) => sel.add(j)); draw(); };
    $('#none').onclick = () => { sel.clear(); draw(); };
    $('#dup').onclick = () => { // same name or same code as an earlier key
      sel.clear();
      const seen = new Set();
      r.buttons.forEach((b, j) => { const k1 = 'n:' + b.n.toLowerCase(), k2 = 'c:' + b.c; if (seen.has(k1) || seen.has(k2)) sel.add(j); seen.add(k1); seen.add(k2); });
      toast(sel.size ? `${sel.size} doppioni selezionati` : 'Nessun doppione'); draw();
    };
    $('#rm').onclick = () => {
      if (!confirm(`Eliminare ${sel.size} tasti?`)) return;
      r.buttons = r.buttons.filter((_, j) => !sel.has(j)); sel.clear(); save(); draw();
    };
    $('#mv').onclick = () => {
      const others = S.remotes.filter(x => x !== r && x.kind !== 'gree');
      sheet(`<h2>${sel.size} tasti</h2><label class="f">Telecomando di destinazione</label><select id="dst">${others.map((x, k) => `<option value="${k}">${esc(x.name)}</option>`).join('')}<option value="new">+ Nuovo telecomando…</option></select>
        <div style="height:12px"></div><div class="row"><button class="btn grow" id="cp">Copia</button><button class="btn p grow" id="mvok">Sposta</button></div>`);
      const go2 = move => {
        let dst = $('#dst').value;
        if (dst === 'new') {
          const n = prompt('Nome del nuovo telecomando', r.name + ' 2');
          if (!n || !n.trim()) return;
          S.remotes.push({ id: uid(), name: n.trim(), buttons: [] }); dst = S.remotes[S.remotes.length - 1];
        } else dst = others[+dst];
        dst.buttons.push(...r.buttons.filter((_, j) => sel.has(j)).map(b => ({ ...b })));
        if (move) r.buttons = r.buttons.filter((_, j) => !sel.has(j));
        const n = sel.size; sel.clear(); save(); closeSheet(); draw();
        toast(`${n} tasti ${move ? 'spostati' : 'copiati'} in "${dst.name}"`);
      };
      $('#cp').onclick = () => go2(false);
      $('#mvok').onclick = () => go2(true);
    };
  };
  draw();
}
function keyMenu(r, j) {
  const b = r.buttons[j];
  sheet(`<h2>${esc(nice(b.n))}</h2><p class="s">Codice: ${esc(b.c)}</p><button class="btn w" id="kr">Rinomina</button><div style="height:8px"></div><button class="btn w" id="kd">Elimina tasto</button>`);
  $('#kr').onclick = () => { const n = prompt('Nome del tasto', b.n); if (n && n.trim()) { b.n = n.trim(); save(); closeSheet(); render(); } };
  $('#kd').onclick = () => { r.buttons.splice(j, 1); save(); closeSheet(); render(); };
}
function learnInto(r) {
  let got = 0;
  const stop = listen(f => {
    if (!SENDABLE.has(f.p)) { toast(`Protocollo ${f.p}: ricevuto ma non trasmissibile`, true); return; }
    const code = codeOf(f);
    if (r.buttons.some(b => b.c === code)) { toast('Tasto già presente'); return; }
    const n = prompt(`Ricevuto ${code}\nNome del tasto?`, '');
    if (!n || !n.trim()) return;
    r.buttons.push({ n: n.trim(), c: code }); save(); got++;
    const el = $('#lcount'); if (el) el.textContent = `${got} tasti aggiunti`;
  });
  sheet(`<h2>Impara tasti: ${esc(r.name)}</h2><p class="pulse">In ascolto… punta il telecomando verso l'S18 (30–50 cm) e premi un tasto.</p><p class="s" id="lcount">0 tasti aggiunti</p>
    <div class="note">Se premi e non compare nulla, quel telecomando usa un protocollo che questo firmware non decodifica (succede spesso con i condizionatori).</div><button class="btn p w" id="done">Fine</button>`,
  () => { stop(); render(); });
  $('#done').onclick = closeSheet;
}

// ---------------------------------------------------------------- tab: library (Flipper-IRDB, converted at build time)
let IDX = null;
const chunks = {};
async function getIndex() { if (!IDX) IDX = JSON.parse(await asset('lib/index.json')); return IDX; }
async function getChunk(n) { if (!chunks[n]) chunks[n] = JSON.parse(await asset('lib/' + n)); return chunks[n]; }
const CAT = { TVs: 'TV', ACs: 'Condizionatori', Projectors: 'Proiettori', SoundBars: 'Soundbar', Audio_and_Video_Receivers: 'Amplificatori AV', LED_Lighting: 'Luci LED', Fans: 'Ventilatori', Speakers: 'Casse', 'Blu-Ray': 'Blu-ray', Cable_Boxes: 'Decoder', DVD_Players: 'DVD', Streaming_Devices: 'Streaming', Miscellaneous: 'Varie', Heaters: 'Stufe', Air_Purifiers: 'Purificatori', Monitors: 'Monitor', CD_Players: 'Lettori CD', Cameras: 'Fotocamere', Consoles: 'Console', Humidifiers: 'Umidificatori', Fireplaces: 'Caminetti', Computers: 'Computer', Car_Multimedia: 'Auto', Head_Units: 'Autoradio', Multimedia: 'Multimedia', Clocks: 'Orologi', Digital_Signs: 'Insegne', Picture_Frames: 'Cornici digitali', Converters: 'Convertitori', Dust_Collectors: 'Aspiratori' };
const catName = c => CAT[c] || c.replace(/_/g, ' ');
let libCat = 'TVs', libQ = '';

async function libraryTab() {
  title('Libreria');
  const t = RT;
  view.innerHTML = '<div class="empty pulse">Carico la libreria…</div>';
  const idx = await getIndex();
  if (t !== RT) return;
  const cats = Object.entries(idx.reduce((m, x) => { m[x[0]] = (m[x[0]] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  view.innerHTML = `<input id="q" type="search" placeholder="Cerca marca o modello" value="${esc(libQ)}">
    <div class="chips">${cats.map(([c, n]) => `<button class="chip${c === libCat ? ' sel' : ''}" data-c="${esc(c)}">${esc(catName(c))} · ${n}</button>`).join('')}</div>
    <div class="list" id="res"></div><p class="s">${idx.length} modelli da Flipper-IRDB: solo i codici che questo firmware sa trasmettere. Se il tuo modello manca, usa <b>Impara</b>.</p>`;
  const res = $('#res');
  const draw = () => {
    const q = libQ.trim().toLowerCase();
    if (q) {
      const hits = idx.filter(e => (e[1] + ' ' + e[2]).toLowerCase().includes(q)).slice(0, 80);
      res.innerHTML = hits.length ? hits.map(e => `<div class="card" data-m="${idx.indexOf(e)}"><div class="t ell">${esc(e[1])} · ${esc(e[2])}</div><div class="s">${esc(catName(e[0]))} · ${e[4]} tasti</div></div>`).join('') : '<div class="empty">Nessun risultato.</div>';
    } else {
      const brands = {};
      idx.forEach(e => { if (e[0] === libCat) brands[e[1]] = (brands[e[1]] || 0) + 1; });
      res.innerHTML = Object.keys(brands).sort((a, b) => a.localeCompare(b)).map(b => `<div class="card row" data-b="${esc(b)}"><div class="grow t ell">${esc(b)}</div><span class="s">${brands[b]} modelli ›</span></div>`).join('');
    }
    res.querySelectorAll('[data-m]').forEach(c => { c.onclick = () => { const e = idx[+c.dataset.m]; push(() => modelView(e)); }; });
    res.querySelectorAll('[data-b]').forEach(c => { c.onclick = () => { const b = c.dataset.b; push(() => brandView(libCat, b)); }; });
  };
  $('#q').oninput = e => { libQ = e.target.value; draw(); };
  view.querySelectorAll('.chip').forEach(c => { c.onclick = () => { libCat = c.dataset.c; libQ = ''; render(); }; });
  draw();
}
async function brandView(cat, brand) {
  title(brand);
  const t = RT;
  const idx = await getIndex();
  if (t !== RT) return;
  const ents = idx.filter(e => e[0] === cat && e[1] === brand);
  view.innerHTML = `<div class="s">${esc(catName(cat))} · ${ents.length} modelli</div>
    <div class="note">Non sai quale modello hai? Prova i codici di accensione uno per uno.</div><button class="btn p w" id="pt">Trova il codice giusto</button>
    <div class="list">${ents.map((e, i) => `<div class="card" data-i="${i}"><div class="t ell">${esc(e[2])}</div><div class="s">${e[4]} tasti</div></div>`).join('')}</div>`;
  view.querySelectorAll('[data-i]').forEach(c => { c.onclick = () => { const e = ents[+c.dataset.i]; push(() => modelView(e)); }; });
  $('#pt').onclick = () => powerTest(ents);
}
async function powerTest(ents) {
  const ch = await getChunk(ents[0][3]);
  const by = new Map(); // power code -> models using it
  for (const e of ents) {
    const b = ch[e[2]] || [];
    const p = b.find(x => /^power$/i.test(x[0])) || b.find(x => /power|on.?off|standby/i.test(x[0]));
    if (!p) continue;
    if (!by.has(p[1])) by.set(p[1], []);
    by.get(p[1]).push(e);
  }
  const list = [...by.entries()].sort((a, b) => b[1].length - a[1].length); // most common first
  if (!list.length) { toast('Nessun tasto di accensione per questa marca', true); return; }
  let k = 0;
  const step = () => {
    const [code, models] = list[k];
    sheet(`<h2>Trova il codice giusto</h2><p>Codice <b>${k + 1}</b> di ${list.length} <span class="s">· usato da ${models.length} modelli</span></p>
      <p class="s">Punta l'S18 verso il dispositivo e premi "Invia". Se si accende o si spegne, premi "Funziona".</p>
      <button class="btn p w" id="snd">Invia accensione</button><div style="height:8px"></div>
      <div class="row"><button class="btn grow" id="nx">${k + 1 < list.length ? 'Prossimo' : 'Ricomincia'}</button><button class="btn grow" id="ok">Funziona ✓</button></div>`);
    $('#snd').onclick = () => send(code);
    $('#nx').onclick = () => { k = (k + 1) % list.length; step(); };
    $('#ok').onclick = () => { closeSheet(); push(() => modelList('Modelli compatibili', models)); };
  };
  step();
}
function modelList(t, ents, extra) {
  title(t);
  view.innerHTML = (extra || '') + `<div class="list">${ents.map((x, i) => {
    const e = x.e || x;
    return `<div class="card" data-i="${i}"><div class="t ell">${esc(e[1])} · ${esc(e[2])}</div><div class="s">${esc(catName(e[0]))} · ${e[4]} tasti${x.hit != null ? ` · <b>${x.hit}</b> tasti uguali ai tuoi` : ''}</div></div>`;
  }).join('')}</div>`;
  view.querySelectorAll('[data-i]').forEach(c => { c.onclick = () => { const x = ents[+c.dataset.i]; push(() => modelView(x.e || x)); }; });
}
async function modelView(e) {
  title(e[1]);
  const t = RT;
  const b = ((await getChunk(e[3]))[e[2]] || []).map(([n, c]) => ({ n, c }));
  if (t !== RT) return;
  view.innerHTML = `<div class="s">${esc(catName(e[0]))} · ${esc(e[2])}</div><div class="note">Tocca un tasto per provarlo sul tuo dispositivo.</div>${layoutHtml(b)}
    <button class="btn p w sticky" id="add">Aggiungi ai miei telecomandi</button>`;
  bindKeys(view, j => send(b[j].c));
  $('#add').onclick = () => {
    const n = prompt('Nome del telecomando', `${catName(e[0])} ${e[1]}`);
    if (!n || !n.trim()) return;
    S.remotes.push({ id: uid(), name: n.trim(), buttons: b }); save();
    toast('Aggiunto ai telecomandi'); go('remotes');
  };
}

// ---------------------------------------------------------------- tab: learn + identify unknown models
let learned = [], unlearn = null;
function stopLearn() { if (unlearn) { unlearn(); unlearn = null; } }
// brands that commonly share an OEM (and so IR codes); a hint, the code match below is the real evidence
const OEM = [
  [['telefunken', 'hitachi', 'finlux', 'jvc', 'toshiba', 'polaroid', 'techwood', 'bush', 'luxor', 'edenwood', 'regal', 'seg', 'medion', 'vestel'],
    'Molti TV europei di queste marche sono prodotti da Vestel e spesso hanno gli stessi codici.', ['Vestel', 'Telefunken', 'Hitachi', 'Finlux', 'JVC', 'Toshiba', 'Bush', 'Edenwood', 'Medion']],
  [['thomson', 'alcatel', 'tcl'], 'Dal 2014 i TV Thomson sono prodotti da TCL.', ['TCL', 'Thomson']],
  [['toshiba', 'hisense'], 'I TV Toshiba più recenti (dal 2018 circa) sono prodotti da Hisense.', ['Hisense', 'Toshiba']],
  [['grundig', 'beko', 'arcelik'], 'Grundig e Beko fanno parte del gruppo Arçelik.', ['Grundig', 'Beko', 'Arcelik']],
  [['goldstar', 'zenith', 'lg'], 'Goldstar e Zenith sono marchi del gruppo LG.', ['LG', 'Zenith', 'Goldstar']],
  [['philips', 'magnavox'], 'Magnavox è un marchio Philips (codici RC5/RC6).', ['Philips', 'Magnavox']],
  [['vaillant', 'saunier', 'tosot', 'sinclair', 'gree'], 'I condizionatori Vaillant climaVAIR e Saunier Duval sono prodotti da Gree e usano il protocollo Gree (verificato sul tuo telecomando). Usa "Nuovo telecomando → Condizionatore Gree".', ['GREE', 'Tosot', 'Sinclair'], 'gree'],
  [['akai', 'nordmende', 'majestic', 'smart-tech', 'smarttech', 'kiano', 'trevi', 'dyon', 'strong', 'orion', 'nikkei'],
    'Queste marche rivendono apparecchi di vari produttori cinesi: il produttore cambia da modello a modello. Premi alcuni tasti e usa "Identifica".', []],
];
function learnTab() {
  title('Impara');
  view.innerHTML = `<div class="note"><span class="pulse">●</span> In ascolto. Punta qualsiasi telecomando verso l'S18 e premi alcuni tasti: i codici compaiono qui.</div>
    <div class="list" id="ll"></div>
    <button class="btn p w" id="ident">Identifica marca e modello</button>
    <label class="f">Marca scritta sul dispositivo (facoltativa)</label><input id="brandIn" placeholder="es. Telefunken"><div id="oem"></div>
    <div style="height:8px"></div><button class="btn w" id="clr">Svuota elenco</button>`;
  const ll = $('#ll');
  const draw = () => {
    ll.innerHTML = learned.length ? learned.map((l, i) => `<div class="card"><div class="row"><span class="tag">${esc(l.f.p)}</span><div class="grow s">Indirizzo ${esc(l.f.a)} · Comando ${esc(l.f.c)} · ×${l.n}</div></div>
      ${SENDABLE.has(l.f.p) ? `<div class="row" style="margin-top:8px"><button class="btn sm grow" data-try="${i}">Prova a inviarlo</button><button class="btn sm grow" data-save="${i}">Salva come tasto</button></div>`
    : l.f.p === 'PULSEDISTANCE' && l.f.bits === 35
      ? '<p class="s">Questo è un condizionatore con protocollo <b>Gree</b> (anche Vaillant, Saunier Duval, Tosot, Sinclair).</p><button class="btn sm p" data-gree="1">Crea telecomando condizionatore</button>'
      : '<p class="s">Ricevuto ma non trasmissibile (tipico dei condizionatori). Cerca la marca nella Libreria: molti modelli si inviano dal telefono.</p>'}</div>`).join('')
      : '<div class="empty">Nessun codice ricevuto per ora.</div>';
    ll.querySelectorAll('[data-try]').forEach(b => { b.onclick = () => send(learned[+b.dataset.try].code); });
    ll.querySelectorAll('[data-save]').forEach(b => { b.onclick = () => saveLearned(learned[+b.dataset.save]); });
    ll.querySelectorAll('[data-gree]').forEach(b => { b.onclick = () => newAc('Condizionatore'); });
    $('#ident').disabled = !learned.length;
  };
  draw();
  unlearn = listen(f => {
    const code = codeOf(f);
    const x = learned.find(l => l.code === code);
    if (x) x.n++; else learned.unshift({ f, code, n: 1 });
    if (navigator.vibrate) navigator.vibrate(20);
    draw();
  });
  $('#clr').onclick = () => { learned = []; draw(); };
  $('#ident').onclick = identify;
  $('#brandIn').oninput = e => oemHints(e.target.value);
}
async function oemHints(v) {
  const q = v.trim().toLowerCase(), box = $('#oem');
  if (!box) return;
  const groups = q.length < 2 ? [] : OEM.filter(g => g[0].some(b => b.startsWith(q) || q.startsWith(b)));
  if (!groups.length) { box.innerHTML = q.length >= 2 ? '<p class="s">Nessuna parentela nota: premi qualche tasto e usa "Identifica".</p>' : ''; return; }
  const idx = await getIndex();
  const find = b => idx.find(e => e[1].toLowerCase() === b.toLowerCase());
  box.innerHTML = groups.map(g => `<div class="note">${esc(g[1])}${g[2].length ? '<br>Prova anche: ' + g[2].filter(find).map(b => `<button class="chip" data-br="${esc(b)}">${esc(b)}</button>`).join(' ') : ''}
    ${g[3] === 'gree' ? '<div style="height:6px"></div><button class="btn sm p" data-gree="1">Crea telecomando condizionatore Gree</button>' : ''}</div>`).join('');
  box.querySelectorAll('[data-br]').forEach(c => { c.onclick = () => { const e = find(c.dataset.br); push(() => brandView(e[0], e[1])); }; });
  box.querySelectorAll('[data-gree]').forEach(c => { c.onclick = () => newAc(v.trim() ? `Clima ${v.trim()}` : 'Condizionatore'); });
}
function saveLearned(l) {
  sheet(`<h2>Salva tasto</h2><p class="s">${esc(l.code)}</p><label class="f">Nome del tasto</label><input id="kn" placeholder="es. Accendi">
    <label class="f">Telecomando</label><select id="kr">${S.remotes.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('')}<option value="new">+ Nuovo telecomando…</option></select>
    <div style="height:12px"></div><button class="btn p w" id="ks">Salva</button>`);
  $('#ks').onclick = () => {
    const n = $('#kn').value.trim();
    if (!n) { toast('Scrivi un nome', true); return; }
    let i = $('#kr').value;
    if (i === 'new') {
      const rn = prompt('Nome del telecomando', 'Nuovo');
      if (!rn || !rn.trim()) return;
      S.remotes.push({ id: uid(), name: rn.trim(), buttons: [] }); i = S.remotes.length - 1;
    }
    S.remotes[+i].buttons.push({ n, c: l.code }); save(); closeSheet(); toast('Salvato');
  };
}
async function identify() {
  const idx = await getIndex();
  const keys = new Set(learned.map(l => keyOf(l.f.p, l.f.a)));
  const codes = new Set(learned.map(l => l.code));
  const scored = [];
  for (const e of idx.filter(x => x[5].some(k => keys.has(k)))) {
    const btns = (await getChunk(e[3]))[e[2]] || [];
    scored.push({ e, hit: new Set(btns.filter(b => codes.has(b[1])).map(b => b[1])).size });
  }
  scored.sort((a, b) => b.hit - a.hit || b.e[4] - a.e[4]);
  const top = scored.filter(s => s.hit > 0).slice(0, 60);
  if (!top.length) {
    sheet(`<h2>Nessun modello trovato</h2><p>Nessun telecomando della libreria usa questo codice dispositivo.</p><p class="s">Nessun problema: salva i tasti uno per uno con "Salva come tasto" e funzioneranno lo stesso.</p><button class="btn p w" id="okk">Ok</button>`);
    $('#okk').onclick = closeSheet;
    return;
  }
  const brands = {};
  top.forEach(s => { brands[s.e[1]] = Math.max(brands[s.e[1]] || 0, s.hit); });
  const extra = `<div class="note">Hai premuto ${codes.size} tasti diversi. Questi modelli hanno gli stessi codici: probabilmente condividono il produttore.<br><b>Marche compatibili:</b> ${Object.keys(brands).slice(0, 12).map(esc).join(', ')}</div>`;
  push(() => modelList('Modelli compatibili', top, extra));
}

// ---------------------------------------------------------------- tab: automations (run on the S18 itself)
const DAYS = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'G'], [5, 'V'], [6, 'S'], [0, 'D']];
function dayText(d) {
  const s = [...d].sort().join();
  if (s === '0,1,2,3,4,5,6') return 'Ogni giorno';
  if (s === '1,2,3,4,5') return 'Lun–Ven';
  if (s === '0,6') return 'Weekend';
  const N = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  return DAYS.filter(([n]) => d.includes(n)).map(([n]) => N[n]).join(' ');
}
function trigName(t) {
  const code = `${t.p}-${t.a}-${t.c}`;
  for (const r of S.remotes) { const b = r.buttons.find(x => x.c === code || x.c.startsWith(code + '-')); if (b) return `${r.name}: ${nice(b.n)}`; }
  return `${t.p} ${t.a}/${t.c}`;
}
const autoTitle = a => a.type === 'time' ? `${dayText(a.days)} alle ${a.time}` : `Quando premi ${trigName(a.trig || {})}`;

function autosTab() {
  title('Automazioni');
  const al = S.alexa;
  view.innerHTML = `<div class="card"><div class="row"><div class="grow"><div class="t">Alexa e tasto sull'S18</div><div class="s">Nome per Alexa: <b>${esc(al.name)}</b></div></div><button class="btn sm" id="edAl">Modifica</button></div>
      <div class="s" style="margin-top:6px">Accendi → ${esc(actsText(al.on))}<br>Spegni → ${esc(actsText(al.off))}</div></div>
    <div class="t" style="margin-top:16px">Dispositivi Alexa</div>
    <div class="s">Ognuno compare in Alexa come una luce: "Alexa, accendi/spegni …". Per i condizionatori: "Alexa, imposta Clima al 22 percento" = 22 °C. Con le routine dell'app Alexa puoi usare qualsiasi frase.</div>
    <div class="list" id="devs">${(S.devs || []).map((d, i) => `<div class="card" data-dv="${i}"><div class="t ell">${esc(d.name)}</div><div class="s ell">${d.type === 'ac'
    ? `Condizionatore · accendi = ${esc(MODES.find(m => m[0] === (d.mode ?? 1))[1])}, ventola ${esc(FANS.find(f => f[0] === (d.fan ?? 0))[1].toLowerCase())}${d.swing ? ', oscillazione' : ''}`
    : d.type === 'channel' ? `Canale TV · "imposta al N percento" = canale N${d.ok ? ' + OK' : ''}`
    : `Accendi → ${esc(actsText(d.on))} · Spegni → ${esc(actsText(d.off))}`}</div></div>`).join('')}</div>
    <button class="btn w" id="addDev">+ Nuovo dispositivo Alexa</button>
    <div class="t" style="margin-top:16px">Programmazioni</div>
    <div class="list">${S.autos.map((a, i) => `<div class="card row" data-i="${i}"><div class="grow"><div class="t ell">${esc(autoTitle(a))}</div><div class="s ell">→ ${esc(actsText(a.acts))}</div></div>
      <label class="sw"><input type="checkbox" data-sw="${i}" ${a.off ? '' : 'checked'}><span></span></label></div>`).join('')}</div>
    <div class="row"><button class="btn grow" id="addT">+ A un orario</button><button class="btn grow" id="addI">+ Con un tasto IR</button></div>
    ${S.dirty ? '<button class="btn p w sticky" id="apply">Applica</button>' : `<div style="height:8px"></div><button class="btn w" id="apply">Riapplica all'S18</button><p class="s">Le automazioni con tasti normali girano sull'S18 (anche a telefono spento). Quelle con tasti 📱 le esegue questo telefono${HAS_IR ? '' : ', che però non ha il blaster IR'}.</p>`}`;
  view.querySelectorAll('.list .card[data-i]').forEach(c => { c.onclick = e => { if (e.target.closest('.sw')) return; editAuto(+c.dataset.i); }; });
  view.querySelectorAll('[data-dv]').forEach(c => { c.onclick = () => editDev(+c.dataset.dv); });
  $('#addDev').onclick = () => editDev(null);
  view.querySelectorAll('[data-sw]').forEach(s => { s.onchange = () => { S.autos[+s.dataset.sw].off = !s.checked; save(true); render(); }; });
  $('#addT').onclick = () => editAuto(null, 'time');
  $('#addI').onclick = () => editAuto(null, 'ir');
  $('#edAl').onclick = editAlexa;
  if ($('#apply')) $('#apply').onclick = apply;
}
/** {d0..d9, ok} codes of a remote, from its standard key names. */
function digitKeys(r) {
  const k = {};
  r.buttons.forEach(b => { const id = canonKey(b.n); if (id && (/^d\d$/.test(id) || id === 'ok') && !k[id]) k[id] = b.c; });
  return k;
}
function editDev(i) {
  const d = i == null ? { id: uid(), name: '', type: 'onoff', on: [], off: [], mode: 1, fan: 0 } : structuredClone(S.devs[i]);
  const chip = (attr, v, sel, label) => `<button class="chip${sel ? ' sel' : ''}" ${attr}="${v}">${label}</button>`;
  const draw = () => {
    sheet(`<h2>${i == null ? 'Nuovo' : 'Modifica'} dispositivo Alexa</h2>
      <label class="f">Nome che dirai ad Alexa</label><input id="dn" value="${esc(d.name)}" placeholder="es. Clima, Decoder, Luci">
      <label class="f">Tipo</label><div class="chips">${chip('data-ty', 'onoff', d.type === 'onoff', 'Acceso / spento')}${chip('data-ty', 'ac', d.type === 'ac', 'Condizionatore')}${chip('data-ty', 'channel', d.type === 'channel', 'Canale TV')}</div>
      ${d.type === 'ac' ? `<div class="s">"Accendi" usa le impostazioni qui sotto e l'ultima temperatura (24° la prima volta). "Imposta al N percento" = N °C (16-30). Lo invia l'S18${S.s18raw ? '' : ' — serve il firmware con invio raw'}.</div>
          <label class="f">Modalità all'accensione</label><div class="chips" style="flex-wrap:wrap">${MODES.map(([v, l]) => chip('data-m', v, d.mode === v, l)).join('')}</div>
          <label class="f">Ventola</label><div class="chips">${FANS.map(([v, l]) => chip('data-f', v, d.fan === v, l)).join('')}</div>
          <div class="card row"><div class="grow">Oscillazione aletta</div><label class="sw"><input type="checkbox" id="dsw" ${d.swing ? 'checked' : ''}><span></span></label></div>
          ${i != null ? `<div class="note">Per le altre modalità con la voce crea delle varianti: es. "Alexa, accendi ${esc(d.name)} caldo", "imposta ${esc(d.name)} oscillazione al 21 percento".</div>
          <button class="btn w" id="vars">Crea varianti: caldo, deumidifica, ventola, oscillazione</button>` : ''}`
    : d.type === 'channel' ? `<div class="s">"Alexa, imposta ${esc(d.name || 'Canale TV')} al 5 percento" porta il TV sul canale 5 (fino a 100): l'S18 invia le cifre una dopo l'altra.</div>
          <label class="f">Telecomando TV (deve avere i tasti numerici)</label><select id="drm">${S.remotes.filter(r => r.kind !== 'gree').map(r => `<option value="${esc(r.id)}" ${r.id === d.remote ? 'selected' : ''}>${esc(r.name)}${digitKeys(r).d1 ? '' : ' — senza numeri'}</option>`).join('')}</select>
          <div class="card row"><div class="grow">Premi OK dopo il numero</div><label class="sw"><input type="checkbox" id="dok" ${d.ok ? 'checked' : ''}><span></span></label></div>`
    : `<label class="f">Accendi → invia (anche più tasti, in ordine)</label><div id="onL">${actsHtml(d.on)}</div><button class="btn w" id="aOn">+ Aggiungi comando</button>
          <label class="f">Spegni → invia</label><div id="offL">${actsHtml(d.off)}</div><button class="btn w" id="aOff">+ Aggiungi comando</button>`}
      <div style="height:12px"></div><button class="btn p w" id="sv">Salva</button>
      ${i != null ? '<div style="height:8px"></div><button class="btn w" id="dl">Elimina</button>' : ''}`);
    $('#dn').oninput = e => { d.name = e.target.value; };
    document.querySelectorAll('#sheetIn [data-ty]').forEach(c => { c.onclick = () => { d.type = c.dataset.ty; draw(); }; });
    document.querySelectorAll('#sheetIn [data-m]').forEach(c => { c.onclick = () => { d.mode = +c.dataset.m; draw(); }; });
    document.querySelectorAll('#sheetIn [data-f]').forEach(c => { c.onclick = () => { d.fan = +c.dataset.f; draw(); }; });
    if ($('#dsw')) $('#dsw').onchange = e => { d.swing = e.target.checked ? 1 : 0; };
    if ($('#dok')) $('#dok').onchange = e => { d.ok = e.target.checked; };
    if ($('#drm')) { if (!d.remote) d.remote = $('#drm').value; $('#drm').onchange = e => { d.remote = e.target.value; }; }
    if ($('#vars')) {
      $('#vars').onclick = () => {
        const base = hueName(d.name);
        const add = [[4, 'caldo'], [2, 'deumidifica'], [3, 'ventola'], [1, 'freddo']].filter(([m]) => m !== d.mode)
          .map(([mode, w]) => ({ id: uid(), name: `${base} ${w}`, type: 'ac', mode, fan: d.fan, swing: d.swing, on: [], off: [] }))
          .concat(d.swing ? [] : [{ id: uid(), name: `${base} oscillazione`, type: 'ac', mode: d.mode, fan: d.fan, swing: 1, on: [], off: [] }])
          .filter(v => !S.devs.some(x => x.name.toLowerCase() === v.name.toLowerCase())).slice(0, 22 - S.devs.length);
        S.devs.push(...add); save(true); closeSheet(); render();
        toast(add.length ? `Create ${add.length} varianti: premi Applica, poi "Alexa, rileva dispositivi"` : 'Varianti già presenti');
      };
    }
    if ($('#onL')) {
      $('#onL').querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { d.on.splice(+b.dataset.rm, 1); draw(); }; });
      $('#offL').querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { d.off.splice(+b.dataset.rm, 1); draw(); }; });
      $('#aOn').onclick = () => pickAction(draw, x => d.on.push(x));
      $('#aOff').onclick = () => pickAction(draw, x => d.off.push(x));
    }
    $('#sv').onclick = () => {
      d.name = hueName(d.name);
      if (!d.name) { toast('Scrivi un nome', true); return; }
      if ((S.devs || []).some((x, j) => j !== i && x.name.toLowerCase() === d.name.toLowerCase())) { toast('Nome già usato', true); return; }
      if (d.type === 'onoff' && !d.on.length && !d.off.length) { toast('Aggiungi almeno un comando', true); return; }
      if (d.type === 'channel') { // snapshot the digit/OK codes: the S18 script must not depend on the phone
        const r = S.remotes.find(x => x.id === d.remote);
        d.keys = r ? digitKeys(r) : {};
        if (!d.keys.d1 || !d.keys.d0) { toast('Il telecomando scelto non ha i tasti numerici: usa "Completa i tasti mancanti"', true); return; }
        d.max = 100;
      }
      S.devs = S.devs || [];
      if (i == null) { if (S.devs.length >= 22) { toast('Massimo 22 dispositivi', true); return; } S.devs.push(d); } else S.devs[i] = d;
      save(true); closeSheet(); render();
    };
    if ($('#dl')) $('#dl').onclick = () => { S.devs.splice(i, 1); save(true); closeSheet(); render(); };
  };
  draw();
}
function actsHtml(acts) {
  return `<div class="list">${acts.map((x, i) => `<div class="card row" style="padding:10px"><div class="grow ell">${esc(actsText([x]))}</div><button class="btn sm" data-rm="${i}">✕</button></div>`).join('')}</div>`;
}
function pickAction(back, done) {
  if (!S.remotes.length) { toast('Prima crea un telecomando', true); return; }
  const ac = { power: 1, mode: 1, temp: 24, fan: 0, swing: 0 }; // composer for AC remotes: no saved preset needed
  const chip = (attr, v, sel, label) => `<button class="chip${sel ? ' sel' : ''}" ${attr}="${v}">${label}</button>`;
  const acPicker = i => `<div class="card">
      <div class="chips">${chip('data-acp', 0, !ac.power, 'Spegni')}${chip('data-acp', 1, ac.power, 'Accendi')}</div>
      ${ac.power ? `<div class="chips" style="flex-wrap:wrap">${MODES.map(([v, l]) => chip('data-acm', v, ac.mode === v, l)).join('')}</div>
      <div class="row" style="margin:6px 0"><button class="btn sm" data-act="-1">−</button><div class="grow t" style="text-align:center">${ac.temp}°</div><button class="btn sm" data-act="1">+</button></div>
      <div class="chips" style="flex-wrap:wrap">${FANS.map(([v, l]) => chip('data-acf', v, ac.fan === v, 'Ventola ' + l.toLowerCase())).join('')}</div>` : ''}
      <button class="btn p w" data-acadd="${i}">Aggiungi: ${esc(acLabel(ac))}</button></div>`;
  const draw = () => {
    sheet(`<h2>Quale comando inviare?</h2>${S.remotes.map((r, i) => `<div class="t" style="margin-top:10px">${esc(r.name)}</div>
      ${r.kind === 'gree' ? acPicker(i) : ''}
      <div class="chips" style="flex-wrap:wrap">${r.buttons.map((b, j) => `<button class="chip" data-r="${i}" data-j="${j}">${esc(nice(b.n))}</button>`).join('')}</div>`).join('')}
      <button class="btn w" id="pb">Annulla</button>`);
    const all = s => document.querySelectorAll('#sheetIn ' + s);
    $('#pb').onclick = back;
    all('[data-r]').forEach(c => {
      c.onclick = () => { const r = S.remotes[+c.dataset.r], b = r.buttons[+c.dataset.j]; done({ r: r.name, n: b.n, c: b.c }); back(); };
    });
    all('[data-acp]').forEach(c => { c.onclick = () => { ac.power = +c.dataset.acp; draw(); }; });
    all('[data-acm]').forEach(c => { c.onclick = () => { ac.mode = +c.dataset.acm; draw(); }; });
    all('[data-acf]').forEach(c => { c.onclick = () => { ac.fan = +c.dataset.acf; draw(); }; });
    all('[data-act]').forEach(c => { c.onclick = () => { ac.temp = Math.min(30, Math.max(16, ac.temp + +c.dataset.act)); draw(); }; });
    all('[data-acadd]').forEach(c => {
      c.onclick = () => { const r = S.remotes[+c.dataset.acadd]; done({ r: r.name, n: acLabel(ac), c: greeCode(ac) }); back(); };
    });
  };
  draw();
}
function editAuto(i, type) {
  const a = i == null ? { id: uid(), type, time: '08:00', days: [1, 2, 3, 4, 5], acts: [] } : structuredClone(S.autos[i]);
  let stopTrig = null;
  const cleanup = () => { if (stopTrig) { stopTrig(); stopTrig = null; } };
  const draw = () => {
    sheet(`<h2>${a.type === 'time' ? 'Automazione a orario' : 'Automazione con tasto IR'}</h2>
      ${a.type === 'time'
    ? `<label class="f">Ora</label><input type="time" id="tm" value="${esc(a.time)}"><label class="f">Giorni</label><div class="days">${DAYS.map(([n, l]) => `<button class="chip${a.days.includes(n) ? ' sel' : ''}" data-d="${n}">${l}</button>`).join('')}</div>`
    : `<label class="f">Quando l'S18 riceve</label><div class="card row"><div class="grow">${a.trig ? esc(trigName(a.trig)) : '<span class="s">nessun tasto</span>'}</div><button class="btn sm" id="rec">${stopTrig ? '<span class="pulse">Premi ora…</span>' : 'Registra tasto'}</button></div>
         <p class="s">Utile per dare nuove funzioni ai tasti inutilizzati di un vecchio telecomando. La esegue l'S18: i tasti 📱 (solo telefono) qui vengono saltati.</p>`}
      <label class="f">Allora invia</label>${actsHtml(a.acts)}<button class="btn w" id="addA">+ Aggiungi tasto da inviare</button>
      <div style="height:12px"></div><button class="btn p w" id="sv">Salva</button>${i != null ? '<div style="height:8px"></div><button class="btn w" id="dl">Elimina automazione</button>' : ''}`, cleanup);
    if ($('#tm')) $('#tm').onchange = e => { a.time = e.target.value; };
    document.querySelectorAll('#sheetIn [data-d]').forEach(c => {
      c.onclick = () => { const d = +c.dataset.d; a.days = a.days.includes(d) ? a.days.filter(x => x !== d) : [...a.days, d]; draw(); };
    });
    document.querySelectorAll('#sheetIn [data-rm]').forEach(b => { b.onclick = () => { a.acts.splice(+b.dataset.rm, 1); draw(); }; });
    if ($('#rec')) {
      $('#rec').onclick = () => {
        if (stopTrig) return;
        stopTrig = listen(f => {
          if (!EVENT_NAME[f.p]) { toast(`Il firmware non genera eventi per il protocollo ${f.p}`, true); return; }
          a.trig = { p: f.p, a: f.a, c: f.c }; cleanup(); draw();
        });
        draw();
      };
    }
    $('#addA').onclick = () => { cleanup(); pickAction(draw, x => a.acts.push(x)); };
    $('#sv').onclick = () => {
      if (a.type === 'time' && (!/^\d\d:\d\d$/.test(a.time) || !a.days.length)) { toast('Scegli ora e giorni', true); return; }
      if (a.type === 'ir' && !a.trig) { toast('Registra il tasto che fa partire l\'automazione', true); return; }
      if (!a.acts.length) { toast('Aggiungi almeno un tasto da inviare', true); return; }
      if (i == null) S.autos.push(a); else S.autos[i] = a;
      save(true); closeSheet(); render();
    };
    if ($('#dl')) $('#dl').onclick = () => { S.autos.splice(i, 1); save(true); closeSheet(); render(); };
  };
  draw();
}
function editAlexa() {
  const al = structuredClone(S.alexa);
  const draw = () => {
    sheet(`<h2>Alexa e tasto sull'S18</h2><p class="s">Alexa vede l'S18 come una presa smart. "Alexa, accendi ${esc(al.name)}" esegue "Accendi", "spegni" esegue "Spegni". Anche il tasto fisico sull'S18 alterna le due azioni. Le esegue l'S18: i tasti 📱 (es. condizionatore) qui vengono saltati.</p>
      <label class="f">Nome per Alexa (una parola è più affidabile)</label><input id="an" value="${esc(al.name)}">
      <label class="f">Accendi → invia</label><div id="onL">${actsHtml(al.on)}</div><button class="btn w" id="aOn">+ Aggiungi tasto</button>
      <label class="f">Spegni → invia</label><div id="offL">${actsHtml(al.off)}</div><button class="btn w" id="aOff">+ Aggiungi tasto</button>
      <div style="height:12px"></div><button class="btn p w" id="sv">Salva</button>`);
    $('#an').oninput = e => { al.name = e.target.value; };
    $('#onL').querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { al.on.splice(+b.dataset.rm, 1); draw(); }; });
    $('#offL').querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { al.off.splice(+b.dataset.rm, 1); draw(); }; });
    $('#aOn').onclick = () => pickAction(draw, x => al.on.push(x));
    $('#aOff').onclick = () => pickAction(draw, x => al.off.push(x));
    $('#sv').onclick = () => {
      al.name = al.name.trim().replace(/\s+/g, ' ') || 'TV';
      S.alexa = al; save(true); closeSheet(); render();
    };
  };
  draw();
}
/** Time automations: the S18 runs what it should send, the phone schedules what it should send (same rules as tapping). */
function phoneSchedules() {
  return S.autos.filter(a => !a.off && a.type === 'time').map(a => {
    const [h, m] = a.time.split(':').map(Number);
    const patterns = a.acts.filter(x => toPhone(x.c)).map(x => codeToPattern(x.c));
    return { h, m, days: a.days.reduce((f, d) => f | (1 << d), 0), patterns };
  }).filter(s => s.patterns.length);
}
async function apply() {
  const forS18 = { ...S, autos: S.autos.map(a => a.type === 'time' ? { ...a, acts: a.acts.filter(x => toS18(x.c)) } : a) };
  if (HAS_IR) Native.setSchedules(JSON.stringify(phoneSchedules()));
  const files = {};
  const bat = buildAppBat(forS18, -new Date().getTimezoneOffset() / 60, files);
  const r = await http('POST', dev('api/lfs/app.bat'), bat);
  if (r.code !== 200) { toast('S18 non raggiungibile', true); return; }
  for (const [name, text] of Object.entries(files)) { // timings of AC/raw codes used by the automations
    const w = await http('POST', dev('api/lfs/' + name), text);
    let size = -1;
    try { size = JSON.parse(w.text).size; } catch (e) { size = -1; }
    // a full LittleFS still answers 200 but stores 0 bytes: check what actually landed
    if (w.code !== 200 || size !== text.length) { toast('Spazio sull\'S18 esaurito o S18 non raggiungibile', true); return; }
  }
  for (const old of (S.rawFiles || []).filter(f => !(f in files))) await cmd('lfs_remove ' + old);
  S.rawFiles = Object.keys(files);
  for (const c of ['clearClockEvents', 'clearAllHandlers', 'clearRepeatingEvents', 'FriendlyName ' + S.alexa.name, 'exec app.bat']) {
    const x = await cmd(c);
    if (x.code !== 200) { toast('Applicazione interrotta: S18 non raggiungibile', true); return; }
  }
  S.dirty = false; save(); toast('Automazioni attive sull\'S18'); render();
}

// ---------------------------------------------------------------- settings
async function settingsView() {
  title('Impostazioni');
  const t = RT;
  view.innerHTML = `<label class="f">Indirizzo IP dell'S18</label><input id="ip" value="${esc(S.ip)}" inputmode="decimal">
    <div style="height:8px"></div><div class="row"><button class="btn grow" id="test">Salva e prova</button><button class="btn grow" id="scan">Cerca sulla rete</button></div>
    <div id="found"></div>
    <div class="card s" id="info">Controllo l'S18…</div>
    <div class="card"><div class="t">Reti Wi-Fi dell'S18</div>
      <div class="s">L'S18 ricorda due reti: se non trova la prima dopo 3 tentativi passa alla seconda, e viceversa. Dopo il salvataggio si riavvia.</div>
      <label class="f">Rete principale (lascia vuoto per non cambiarla)</label><input id="ssid1" placeholder="Nome rete"><input id="pass1" type="password" placeholder="Password" style="margin-top:6px">
      <label class="f">Rete di riserva</label><input id="ssid2" placeholder="Nome rete"><input id="pass2" type="password" placeholder="Password" style="margin-top:6px">
      <div style="height:8px"></div><button class="btn w" id="wifiSave">Salva reti sull'S18</button></div>
    <div class="card"><div class="t">Se non riesco più a collegarmi</div><div class="s">
      <b>Cambia l'indirizzo IP</b> (es. dopo un blackout): l'app ritrova l'S18 da sola sulla rete, riconoscendolo dal suo indirizzo MAC. Consiglio: nel router riserva un IP fisso per l'S18.<br>
      <b>Sei su un'altra rete o fuori casa</b>: l'S18 non è raggiungibile (pallino rosso), ma il blaster del telefono funziona ovunque. Le automazioni dell'S18 continuano a girare a casa.<br>
      <b>Cambi router o password Wi-Fi</b>: prima del cambio inserisci qui la nuova rete come rete di riserva. Se è troppo tardi: stacca e riattacca l'S18 dalla presa <b>5 volte di fila</b>, lasciandolo acceso circa 2 secondi ogni volta. Si avvia in modalità sicura e crea la rete Wi-Fi <b>OpenBK7231N_…</b>: collegati col telefono, apri <b>http://192.168.4.1</b> → Config → WiFi, inserisci la nuova rete. La configurazione IR resta intatta.</div></div>
    <div class="card"><div class="t">Alexa</div><div class="s">1. Di' "Alexa, rileva dispositivi" (oppure nell'app Alexa: Dispositivi → + → Aggiungi dispositivo → Altro → Rileva).<br>2. Compariranno "${esc(S.alexa.name)}" (presa) e i tuoi Dispositivi Alexa (come luci). Ripeti la ricerca ogni volta che aggiungi o rinomini un dispositivo e premi Applica.<br>3. "Alexa, accendi ${esc(S.alexa.name)}", "Alexa, imposta Clima al 22 percento".<br><b>Frasi libere</b>: app Alexa → Altro → Routine → + → Quando: "Quando dici" (es. "fa caldo") → Azione: Casa intelligente → scegli il dispositivo → acceso / luminosità. Così ogni frase può mandare qualsiasi comando IR.<br>Tutto funziona in casa, senza cloud: basta l'Echo.</div></div>
    <div class="card"><div class="t">Blaster IR del telefono</div><div class="s">${HAS_IR
    ? `Disponibile. Il pulsante in alto (➜ ${esc(TARGETS[S.target])}) sceglie da dove inviare: S18, Telefono o entrambi insieme (più portata). I tasti 📱 (condizionatore, codici raw della libreria) partono sempre dal telefono.<br><b>Per le automazioni del telefono</b> su Xiaomi/POCO: Impostazioni → App → IR Remote → attiva <b>Avvio automatico</b> e imposta Batteria su <b>Nessuna restrizione</b>, altrimenti il sistema può bloccarle.`
    : 'Questo telefono non ha un emettitore IR: si usa solo l\'S18.'}</div></div>
    <div class="card"><div class="t">Google Home</div><div class="s">Google non controlla dispositivi locali come questo: servirebbe un ponte cloud (es. Sinric Pro o Home Assistant). Non è configurato.</div></div>
    <button class="btn w" id="restore">Ripristina i dati dal backup sull'S18</button><div style="height:8px"></div>
    <button class="btn w" id="reboot">Riavvia l'S18</button>`;
  const info = async () => {
    const r = await ping();
    if (t !== RT) return;
    let d = null;
    try { d = r.code === 200 ? JSON.parse(r.text) : null; } catch (e) { d = null; }
    $('#info').innerHTML = d ? `<b style="color:var(--ok)">Connesso</b> · ${esc(d.chipset)} · ${esc(d.build)}<br>Acceso da ${Math.round(d.uptime_s / 60)} min · Ricevitore IR su P8, trasmettitore su P7`
      : '<b style="color:var(--bad)">Non raggiungibile.</b> Telefono e S18 devono essere sulla stessa rete Wi-Fi.';
  };
  $('#test').onclick = () => { S.ip = $('#ip').value.trim(); save(); info(); };
  $('#scan').onclick = async () => {
    const box = $('#found');
    box.innerHTML = '<div class="card s pulse">Cerco dispositivi OpenBeken sulla rete…</div>';
    const d = await scanNet();
    if (t !== RT) return;
    box.innerHTML = d.devices.length ? `<div class="list">${d.devices.map((x, i) => `<div class="card" data-d="${i}"><div class="t">${esc(x.shortName || x.mqtttopic || 'OpenBeken')} · ${esc(x.ip)}</div><div class="s">${esc(x.chipset)} · ${esc(x.mac)}${(x.mac || '').toLowerCase() === S.mac ? ' · <b>questo S18</b>' : ''}</div></div>`).join('')}</div>`
      : `<div class="card s">Nessun dispositivo trovato sulla rete ${esc(d.net)}x. Il telefono deve essere sulla stessa rete Wi-Fi dell'S18.</div>`;
    box.querySelectorAll('[data-d]').forEach(c => {
      c.onclick = () => { const x = d.devices[+c.dataset.d]; S.ip = x.ip; S.mac = (x.mac || '').toLowerCase(); save(); $('#ip').value = x.ip; info(); };
    });
  };
  $('#wifiSave').onclick = async () => {
    const q = [['ssid', 'ssid1'], ['pass', 'pass1'], ['ssid2', 'ssid2'], ['pass2', 'pass2']]
      .filter(([, id]) => $('#' + id).value !== '').map(([k, id]) => `${k}=${encodeURIComponent($('#' + id).value)}`);
    if (!q.length) { toast('Inserisci almeno una rete', true); return; }
    if (!confirm('Salvare le reti sull\'S18? Si riavvierà.')) return;
    const r = await http('GET', dev('cfg_wifi_set?' + q.join('&')));
    toast(r.code === 200 ? 'Reti salvate, l\'S18 si riavvia' : 'S18 non raggiungibile', r.code !== 200);
  };
  $('#restore').onclick = () => restoreFromDevice(false);
  $('#reboot').onclick = async () => { if (confirm('Riavviare l\'S18?')) { await cmd('restart'); toast('Riavvio in corso…'); } };
  info();
}

// ---------------------------------------------------------------- start
const TABS = { remotes: remotesTab, library: libraryTab, learn: learnTab, autos: autosTab };
document.querySelectorAll('nav button').forEach(b => { b.onclick = () => go(b.dataset.tab); });
$('#gear').onclick = () => { if (stack[stack.length - 1] !== settingsView) push(settingsView); };
$('#back').onclick = () => window.onBack();
drawTarget();
render();
if (S.ip) ping(); else firstRun();
setInterval(() => { if (!document.hidden) ping(); }, 15000);
if (!hadLocal && S.ip) restoreFromDevice(true);
