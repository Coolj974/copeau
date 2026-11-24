import { Viewer, outline } from './viewer.js';
import { startTour } from './tour.js';
import { Preview } from './preview.js';
import { ibtn, initInfo } from './info.js';
import { splitProgram, analyze, buildResume, fmt } from './shared/gcode.js';
import { PROFILES, profileOf, laserSMax } from './shared/profiles.js';
import { rasterGcode, powerMap, RASTER_DEFAULTS } from './shared/raster.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('copeau.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('copeau.' + k, JSON.stringify(v)); } catch {} },
};

const S = {
  serverConnected: false,
  machine: { connected: false, ready: false, status: { state: 'Déconnecté', wpos: { X: 0, Y: 0, Z: 0 }, mpos: { X: 0, Y: 0, Z: 0 }, ov: {} }, modal: {} },
  job: null,
  lines: [],
  info: null,
  settings: {},
  macros: [],
  zones: { table: null, zone: null },
  config: { machine: {} },
};

// ---- Profil de machine (CNC, laser Grbl, Emblaser 2…) ------------------------
// Machine connectée : son profil. Sinon : celui choisi dans la barre du haut,
// partagé entre les écrans (config serveur).
const prof = () => profileOf((S.machine.connected && S.machine.profile) || S.config.machine?.profile);
const isLaser = () => !!prof().laser;
const isSmoothie = () => prof().firmware === 'smoothie';
// Valeur S pour 100 % : réglée à la main, sinon celle du profil ou de $30.
const sMax = () => (S.config.machine?.sMax > 0 ? S.config.machine.sMax : laserSMax(prof(), S.settings));
const laserOpts = () => (isLaser() ? { firmware: prof().firmware, sMax: sMax() } : null);
// Laser : pas de montée au Z de survol (le Z sert à la mise au point).
const liftZ = () => (isLaser() ? null : safeZ());
const unlockCmd = () => (isSmoothie() ? 'M999' : '$X');

// ---- WebSocket ------------------------------------------------------------

let ws;
let reqId = 0;
const pending = new Map();
const serverControlSelector = [
  '#btn-connect', '#btn-refresh', '#btn-unlock', '#btn-home', '#btn-reset', '[data-zero]',
  '[data-axis-home]', '[data-edit]', '[data-jog]', '#jog-stop', '#btn-goto-zero',
  '#btn-goto-origin', '[data-rt]', '#btn-pointer', '#btn-frame', '#btn-run', '#btn-pause',
  '#btn-spindle', '#btn-stop', '#btn-resume-run', '#btn-probe', '#btn-tool-probe',
  '#btn-tool-continue', '#btn-tool-stop', '#btn-place', '[data-outline]', '#btn-outline-job',
  '[data-cap]', '[data-draw]', '[data-from-job]', '[data-dims-apply]', '[data-from-grbl]',
  '[data-cmd]', '#console-input', '#console-form button', '#settings-list input', '[data-macro-run]',
].join(',');

function setServerControlLock(locked) {
  $$(serverControlSelector).forEach((el) => {
    if (locked) {
      if (!el.hasAttribute('data-server-disabled')) {
        el.dataset.serverDisabled = String(el.disabled);
      }
      el.disabled = true;
    } else if (el.hasAttribute('data-server-disabled')) {
      el.disabled = el.dataset.serverDisabled === 'true';
      delete el.dataset.serverDisabled;
    }
  });
}

function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { refreshPorts(); loadMacros(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('Serveur injoignable'));
    pending.clear();
    S.serverConnected = false;
    S.machine = { ...S.machine, connected: false, ready: false, status: { ...S.machine.status, state: 'État inconnu' } };
    setBadge('État inconnu', 'alarm');
    const alarm = $('#alarm-bar');
    alarm.textContent = 'Serveur déconnecté : état de la machine inconnu. Ne lancez aucune commande avant la reconnexion.';
    alarm.hidden = false;
    setServerControlLock(true);
    updateEnabled();
    setTimeout(connectWs, 1500);
  };
}

function request(t, payload = {}) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== 1) return reject(new Error('Serveur injoignable'));
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t, id, ...payload }));
  });
}

// Requête dont l'erreur s'affiche en toast.
const act = (t, payload) => request(t, payload).catch((e) => { toast(e.message, 'err'); throw e; });
const cmd = (line) => act('cmd', { line }).catch(() => {});
const rt = (name) => act('realtime', { name }).catch(() => {});

function onMessage(m) {
  switch (m.t) {
    case 'reply': {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      return;
    }
    case 'state':
      setServerControlLock(false);
      S.serverConnected = true;
      S.machine = m.s;
      applyProfile();
      return renderMachine();
    case 'job': S.job = m.j; return renderJob();
    case 'job-text': return onJobText(m.name, m.text);
    case 'settings': S.settings = m.s; applyProfile(); return renderSettings();
    case 'logs': $('#console').innerHTML = ''; m.list.forEach(addLog); return;
    case 'log': return addLog(m.entry);
    case 'macros': S.macros = m.list; return renderMacros();
    case 'config':
      S.config = { ...m.config, machine: m.config.machine || {} };
      S.zones = { table: null, zone: null, ...(m.config.zones || {}) };
      if (!$('#net-host').value && S.config.machine.host) $('#net-host').value = S.config.machine.host;
      resetDrafts();
      applyProfile();
      return renderZones();
  }
}

// ---- Toasts & console -----------------------------------------------------

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

const modalReturnFocus = new WeakMap();
const modalFocusSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function openModal(modal) {
  if (modal.hidden) modalReturnFocus.set(modal, document.activeElement);
  modal.hidden = false;
  requestAnimationFrame(() => modal.querySelector(modalFocusSelector)?.focus());
}

function closeModal(modal) {
  if (modal.hidden) return;
  modal.hidden = true;
  const returnFocus = modalReturnFocus.get(modal);
  modalReturnFocus.delete(modal);
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function handleModalKeydown(modal, event, onEscape) {
  if (event.key === 'Escape' && onEscape) {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.querySelectorAll(modalFocusSelector)].filter((el) => !el.closest('[hidden]'));
  if (!focusable.length) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

$('#toolchange').addEventListener('keydown', (event) => handleModalKeydown($('#toolchange'), event));
$('#raster').addEventListener('keydown', (event) => handleModalKeydown($('#raster'), event, () => {
  if (!rasterGenerating) closeRaster();
}));

function addLog({ dir, text }) {
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const el = document.createElement('div');
  el.className = dir;
  el.textContent = text;
  box.append(el);
  while (box.childElementCount > 1000) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (dir === 'err' && /Alarme/.test(text)) $('#alarm-bar').dataset.text = text;
}

// ---- Connexion ------------------------------------------------------------

async function refreshPorts() {
  const list = await request('ports').catch(() => []);
  const sel = $('#port');
  const prev = sel.value || store.get('port', 'simulateur');
  sel.innerHTML = list.map((p) => `<option value="${p.path}">${escapeHtml(p.label)}</option>`).join('');
  if (list.some((p) => p.path === prev)) sel.value = prev;
  updateConnectFields();
}

// Réseau : champ d'adresse. Smoothieware (USB natif) ignore la vitesse.
function updateConnectFields() {
  const net = $('#port').value === 'reseau';
  $('#net-host').hidden = !net;
  $('#baud').hidden = net || isSmoothie();
}
$('#port').addEventListener('change', updateConnectFields);
$('#profile').innerHTML = Object.values(PROFILES).map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
$('#profile').onchange = () => {
  const profile = $('#profile').value;
  S.config.machine = { ...S.config.machine, profile };
  applyProfile();
  act('setConfig', { key: 'machine', value: S.config.machine }).catch(() => {});
};

// Applique le profil : ce qui s'affiche, couleurs du parcours, libellés.
let appliedProfile = null;
function applyProfile() {
  const p = prof();
  document.body.classList.toggle('laser', !!p.laser);
  document.body.classList.toggle('smoothie', p.firmware === 'smoothie');
  if ($('#profile').value !== p.id) $('#profile').value = p.id;
  $('#btn-unlock').title = `Déverrouiller (${unlockCmd()})`;
  $('#btn-reset').title = p.firmware === 'smoothie' ? 'Arrêt immédiat de la carte (Ctrl-X, HALT)' : 'Reset logiciel (Ctrl-X)';
  if (document.activeElement !== $('#laser-smax')) $('#laser-smax').value = fmt(sMax());
  updateConnectFields();
  const key = `${p.id}|${sMax()}`;
  if (key === appliedProfile) return;
  appliedProfile = key;
  if (p.laser && activeTab === 'probe') showTab('console');
  if (S.lines.length) {
    viewer.load(S.lines, { laser: laserOpts() });
    if (S.job && S.job.state !== 'loaded') viewer.setProgress(S.job.acked);
  }
  renderSettings();
  renderZones();
}

$('#btn-refresh').onclick = refreshPorts;
$('#baud').value = store.get('baud', '115200');
$('#btn-connect').onclick = async () => {
  if (S.machine.connected) return act('disconnect').catch(() => {});
  const port = $('#port').value;
  const host = $('#net-host').value.trim();
  if (port === 'reseau' && !host) { $('#net-host').focus(); return toast('Indiquez l\'adresse IP de la machine (ex. 192.168.1.50)', 'err'); }
  store.set('port', port);
  store.set('baud', $('#baud').value);
  await act('connect', { port, baud: $('#baud').value, profile: $('#profile').value, host }).catch(() => {});
};
$('#btn-unlock').onclick = () => cmd(unlockCmd());
$('#btn-home').onclick = () => cmd('$H');
$('#btn-reset').onclick = () => rt('reset');

// ---- Rendu machine ----------------------------------------------------------

const STATE_LABEL = {
  Idle: 'Prêt', Run: 'Usinage', Hold: 'Pause', Jog: 'Jog', Alarm: 'Alarme', Door: 'Porte',
  Check: 'Vérif.', Home: 'Origine', Sleep: 'Veille',
};

function setBadge(text, cls) {
  const b = $('#state-badge');
  b.textContent = text;
  b.className = `badge ${cls || ''}`;
}

const drO = {};
let lastWcoKey = null;
function buildDro() {
  $('#dro').innerHTML = ['X', 'Y', 'Z'].map((a) => `
    <div class="dro-row">
      <span class="dro-axis ${a}">${a}</span>
      <span class="dro-val">
        <button class="dro-num" data-edit="${a}" title="Cliquer pour saisir la position actuelle de ${a}"><span data-w="${a}">0.000</span></button>
        <input class="dro-input" data-input="${a}" type="number" step="any" inputmode="decimal" hidden>
        <small data-m="${a}">M 0.000</small>
      </span>
      <button class="ghost dro-home" data-axis-home="${a}" title="Ramener seulement ${a} à l'origine (${a}0)">⌂</button>
      <button class="ghost" data-zero="${a}" title="Définir la position actuelle comme ${a}0">${a} = 0</button>
    </div>`).join('');
  for (const a of ['X', 'Y', 'Z']) drO[a] = { w: $(`[data-w="${a}"]`), m: $(`[data-m="${a}"]`) };
}
buildDro();

// Pose l'origine travail : la position actuelle de l'axe devient `value`.
// G10 L20 P0 écrit dans le repère actif (G54…), conservé par Grbl à l'arrêt.
function setWork(axes) {
  const words = Object.entries(axes).map(([a, v]) => `${a}${v}`).join('');
  const label = Object.entries(axes).map(([a, v]) => `${a} = ${v}`).join(', ');
  return act('cmd', { line: `G10L20P0${words}` })
    .then(() => toast(`Origine posée : ${label}`, 'ok'))
    .catch(() => {});
}

// Saisie directe : clic sur la valeur, Entrée pour valider, Échap pour annuler.
$('#dro').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn || btn.disabled) return;
  const a = btn.dataset.edit;
  const input = $(`[data-input="${a}"]`);
  btn.hidden = true;
  input.hidden = false;
  input.value = S.machine.status.wpos[a].toFixed(3);
  input.focus();
  input.select();
});
$('#dro').addEventListener('keydown', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input) return;
  if (e.key === 'Enter') {
    const v = Number(input.value.replace(',', '.'));
    if (input.value.trim() === '' || !Number.isFinite(v)) return toast('Valeur invalide', 'err');
    setWork({ [input.dataset.input]: Math.round(v * 1000) / 1000 });
    input.blur();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    input.blur();
  }
});
$('#dro').addEventListener('focusout', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input) return;
  input.hidden = true;
  $(`[data-edit="${input.dataset.input}"]`).hidden = false;
});

function renderMachine() {
  const m = S.machine;
  const s = m.status;
  const state = s.state;
  $('#btn-connect').textContent = m.connected ? 'Déconnecter' : 'Connecter';
  $('#btn-connect').className = m.connected ? 'ghost' : 'primary';
  $('#port').disabled = m.connected;
  $('#baud').disabled = m.connected;
  $('#profile').disabled = m.connected;
  $('#profile').title = m.connected ? 'Déconnectez pour changer de type de machine' : 'Type de machine';
  $('#net-host').disabled = m.connected;

  if (!m.connected) setBadge('Déconnecté');
  else if (!m.ready) setBadge('Connexion…');
  else setBadge(STATE_LABEL[state] || state, state.toLowerCase());

  for (const a of ['X', 'Y', 'Z']) {
    drO[a].w.textContent = s.wpos[a].toFixed(3);
    drO[a].m.textContent = `M ${s.mpos[a].toFixed(3)}`;
  }
  $('#wcs-name').textContent = m.modal?.wcs || 'G54';
  $('#units').textContent = m.modal?.units === 'G20' ? 'pouces' : 'mm';
  $('#ov-feed').textContent = `${s.ov?.feed ?? 100}%`;
  $('#ov-spindle').textContent = `${s.ov?.spindle ?? 100}%`;
  $('#ov-rapid').textContent = `${s.ov?.rapid ?? 100}%`;
  $('#live-feed').textContent = m.ready && Number.isFinite(s.feed) ? fmtNum(s.feed) : '—';
  const power = laserPower();
  $('#live-rpm').textContent = m.ready && Number.isFinite(s.speed) ? fmtNum(s.speed) : '—';
  $('#live-laser-power').textContent = m.ready ? fmtNum(power) : '—';
  const live = $('#laser-live');
  live.textContent = m.pointer ? `repérage ${fmt(m.pointer.power)} %` : power > 0 ? `${fmtNum(power)} %` : 'éteint';
  live.classList.toggle('on', !!m.pointer || power > 0);
  $('#live-modal').textContent = m.ready && m.modal
    ? [m.modal.spindle, m.modal.distance, m.modal.coolant].filter(Boolean).join(' · ')
    : '—';

  const alarm = m.ready && state === 'Alarm';
  const bar = $('#alarm-bar');
  bar.hidden = !alarm;
  if (alarm) bar.textContent = `${bar.dataset.text || 'Machine en alarme'}. Faites l'origine ($H) ou déverrouillez (${unlockCmd()}) si la position est sûre.`;

  viewer.setWorkOffset(s.wco);
  viewer.setTool(s.wpos);
  updateManualPos();
  const wcoKey = `${s.wco?.X},${s.wco?.Y},${s.wco?.Z}`;
  if (wcoKey !== lastWcoKey) { lastWcoKey = wcoKey; renderZones(); }
  updateEnabled();
}

// Puissance laser actuelle en % : Smoothieware la donne (L:), Grbl donne S.
function laserPower() {
  const s = S.machine.status;
  if (!isLaser() || !S.machine.ready) return 0;
  if (isSmoothie()) return s.laserPower || 0;
  return ['Run', 'Jog'].includes(s.state) ? Math.min(100, ((s.speed || 0) / sMax()) * 100) : 0;
}

function updateEnabled() {
  const m = S.machine;
  const state = m.status.state;
  const idle = m.ready && state === 'Idle';
  const jobActive = ['running', 'paused', 'spinup', 'finishing', 'stopping', 'toolchange'].includes(S.job?.state);
  const canJog = m.ready && (state === 'Idle' || state === 'Jog') && !(jobActive && S.job.state !== 'toolchange');
  $$('[data-jog], #jog-stop').forEach((b) => (b.disabled = !canJog));
  // Zéros grisés tant qu'un jog se termine : un zéro posé en plein arrêt
  // tomberait à côté de la position finale.
  const settled = idle && !jogSettling;
  $$('[data-zero], [data-edit], [data-axis-home], #btn-goto-zero, #btn-goto-origin').forEach((b) => (b.disabled = !settled || (jobActive && S.job.state !== 'toolchange')));
  $('#btn-unlock').disabled = !m.ready;
  $('#btn-home').disabled = !m.ready || jobActive;
  $('#btn-reset').disabled = !m.connected;
  $$('[data-rt]').forEach((b) => (b.disabled = !m.ready));

  const j = S.job;
  const canRun = idle && j && !jobActive && S.lines.length && !m.pointer;
  $('#btn-run').disabled = !canRun;
  const pointer = $('#btn-pointer');
  pointer.disabled = !(m.ready && ((idle && !jobActive) || m.pointer));
  pointer.classList.toggle('active', !!m.pointer);
  pointer.textContent = m.pointer ? '■ Éteindre le laser' : 'Tir de repérage';
  $('#btn-frame').disabled = !(S.info && Number.isFinite(S.info.min.X)) || !canJog;
  $('#btn-resume-run').disabled = !canRun;
  const machineHeld = state === 'Hold' || state === 'Door'; // M0 ou porte de sécurité
  const pauseBtn = $('#btn-pause');
  pauseBtn.disabled = !(j && (j.state === 'running' || j.state === 'paused'));
  pauseBtn.textContent = j?.state === 'spinup' ? 'Redémarrage…'
    : j?.state === 'paused' || (j?.state === 'running' && machineHeld) ? 'Reprendre' : 'Pause';
  // Broche : coupable seulement quand le mouvement est arrêté (pause ou M0).
  const inPause = j && (j.state === 'paused' || (j.state === 'running' && machineHeld));
  const spBtn = $('#btn-spindle');
  spBtn.hidden = !inPause && j?.state !== 'spinup';
  spBtn.classList.toggle('held', !!m.spindleHeld);
  spBtn.textContent = m.spindleHeld ? '⏻ Broche coupée' : '⏻ Couper la broche';
  spBtn.title = m.spindleHeld ? 'La broche se rallumera à la reprise' : 'Arrêter la broche pendant la pause';
  spBtn.disabled = !!m.spindleHeld || !inPause || !(state === 'Hold' && m.status.subState === '0');
  $('#btn-stop').disabled = !jobActive || j.state === 'stopping';
  const toolReady = idle && !jogSettling;
  $('#btn-tool-continue').disabled = !toolReady;
  $('#btn-tool-continue').title = toolReady ? '' : 'Attendez l\'arrêt complet de la machine';
  $('#btn-tool-probe').disabled = !toolReady;
  $('#btn-probe').disabled = !idle || (jobActive && j.state !== 'toolchange');
  $('#btn-place').disabled = !canRun && !$('#btn-place').classList.contains('active');
  $('#btn-preview').disabled = !S.lines.length || (jobActive && !preview?.active);
  $('#btn-refresh').disabled = !S.serverConnected;
  $('#console-input').disabled = !S.serverConnected;
  $('#console-form button').disabled = !S.serverConnected;
  $$('[data-cmd]').forEach((b) => (b.disabled = !S.serverConnected || !m.ready));
  $$('#settings-list input').forEach((input) => (input.disabled = !S.serverConnected || !m.ready));
  $$('[data-macro-run]').forEach((b) => (b.disabled = !S.serverConnected || !m.ready));
  const zoneOutline = $('.zone-card[data-target="zone"] [data-outline]');
  if (zoneOutline) {
    zoneOutline.disabled = !S.zones.zone || !canJog;
    $('#btn-outline-job').disabled = !(S.info && Number.isFinite(S.info.min.X)) || !canJog;
  }
  setServerControlLock(!S.serverConnected);
}

// ---- Zéro / déplacements ----------------------------------------------------

document.addEventListener('click', (e) => {
  const z = e.target.closest('[data-zero]');
  if (z && !z.disabled) setWork(Object.fromEntries(z.dataset.zero.split('').map((a) => [a, 0])));
  const c = e.target.closest('[data-cmd]');
  if (c) cmd(c.dataset.cmd);
  const r = e.target.closest('[data-rt]');
  if (r) rt(r.dataset.rt);
});
// → X0 Y0 : au-dessus de l'origine, après montée au Z de survol si besoin.
$('#btn-goto-zero').onclick = () => {
  act('jogTo', { X: 0, Y: 0, liftZ: liftZ(), feed: Number($('#jog-feed').value) }).catch(() => {});
};
// ⌂ Origine : retour complet au zéro établi (X0 Y0 puis Z0, descente lente).
// ⌂ d'un axe : seul cet axe revient à 0 (Z descend lentement, X/Y à la hauteur actuelle).
$('#dro').addEventListener('click', (e) => {
  const b = e.target.closest('[data-axis-home]');
  if (!b || b.disabled) return;
  const axis = b.dataset.axisHome;
  const w = S.machine.status.wpos;
  if (Math.abs(w[axis]) < 0.0005) return toast(`${axis} est déjà à 0`, 'info');
  if (axis !== 'Z' && w.Z < 0 && !confirm(`L'outil est sous Z0 (Z ${w.Z.toFixed(3)}), donc dans la pièce.\n\nDéplacer ${axis} jusqu'à 0 à cette hauteur ?`)) return;
  act('axisToZero', { axis, feed: Number($('#jog-feed').value), plungeFeed: 300 }).catch(() => {});
});

$('#btn-goto-origin').onclick = () => {
  const w = S.machine.status.wco || {};
  if (!w.X && !w.Y && !w.Z && !confirm('Aucun zéro ne semble défini : l\'origine est celle de la machine (0, 0, 0).\n\nY aller quand même ?')) return;
  toast('Retour à l\'origine… Échap pour arrêter');
  act('gotoOrigin', { liftZ: liftZ(), feed: Number($('#jog-feed').value), plungeFeed: 300 }).catch(() => {});
};

let jogStep = store.get('jogStep', 1);
function renderSteps() {
  $$('#jog-steps button').forEach((b) => {
    const active = Number(b.dataset.step) === jogStep;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}
$('#jog-steps').onclick = (e) => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  jogStep = Number(b.dataset.step);
  store.set('jogStep', jogStep);
  renderSteps();
};
renderSteps();
$('#jog-feed').value = store.get('jogFeed', 2000);
$('#jog-feed').onchange = () => store.set('jogFeed', Number($('#jog-feed').value));

const parseJog = (spec) => Object.fromEntries(spec.split(' ').map((p) => [p[0], Number(p.slice(1))]));

// Appui = un pas de la taille choisie. Appui maintenu = le même pas répété
// (1, 1, 1… ou 10, 10, 10…) au rythme où la machine le parcourt, avec un pas
// d'avance pour un mouvement fluide. Au relâchement, arrêt immédiat là où se
// trouve la tête (jog cancel). ■ ou Échap arrêtent aussi net.
// Nombre de jogs en train de s'arrêter : les zéros restent grisés pendant ce
// temps, pour être posés à la position finale.
let jogSettling = 0;

function makeJogger() {
  let holdTimer = null, repeatTimer = null, dir = null, step = 1, stopping = false;
  const feed = () => Number($('#jog-feed').value) || 1000;
  const stepOnce = () => {
    const axes = Object.fromEntries(Object.entries(dir).map(([a, v]) => [a, v * step]));
    // « Annulé » : pas d'avance retiré au relâchement, c'est voulu.
    request('jog', { axes, feed: feed() }).catch((e) => { if (e.message !== 'Annulé') toastOnce(e.message); });
  };
  const stopTimers = () => {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = repeatTimer = null;
  };
  // Arrêt immédiat. Les zéros restent grisés jusqu'à l'arrêt complet, pour
  // être posés à la position finale. Smoothieware ne sait pas annuler un
  // mouvement en douceur : il finit le pas en cours (gentle).
  async function stopNow() {
    stopping = true;
    jogSettling++;
    updateEnabled();
    try {
      await request('jogStop', { gentle: true });
      await waitUntil(() => S.machine.status.state === 'Idle', 5000);
    } catch (e) {
      toastOnce(e.message);
    } finally {
      stopping = false;
      jogSettling--;
      updateEnabled();
    }
  }
  return {
    press(d) {
      if (holdTimer || repeatTimer || stopping) return;
      dir = d;
      step = jogStep;
      stepOnce();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Durée d'un pas à la vitesse jog (diagonale comprise).
        const dist = step * Math.hypot(...Object.values(dir));
        const ms = Math.max(40, (dist / feed()) * 60000);
        // Un pas d'avance pour un mouvement fluide. Pas avec Smoothieware : au
        // relâchement il finit les pas reçus, un pas d'avance dépasserait.
        if (!isSmoothie()) stepOnce();
        repeatTimer = setInterval(stepOnce, ms);
      }, 300);
    },
    release() {
      const repeating = !!repeatTimer;
      stopTimers();
      if (repeating) stopNow();
    },
  };
}

const buttonJoggers = [];
for (const b of $$('[data-jog]')) {
  const j = makeJogger();
  buttonJoggers.push(j);
  const dir = parseJog(b.dataset.jog);
  b.addEventListener('pointerdown', (e) => { if (b.disabled) return; b.setPointerCapture(e.pointerId); b.classList.add('active'); j.press(dir); });
  const up = () => { b.classList.remove('active'); j.release(dir); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('keydown', (e) => {
    if (!['Enter', ' '].includes(e.key) || e.repeat || b.disabled) return;
    e.preventDefault();
    b.classList.add('active');
    j.press(dir);
  });
  b.addEventListener('keyup', (e) => {
    if (!['Enter', ' '].includes(e.key)) return;
    b.classList.remove('active');
    j.release(dir);
  });
  b.addEventListener('blur', () => {
    b.classList.remove('active');
    j.release(dir);
  });
}
$('#jog-stop').onclick = () => act('jogStop').catch(() => {});

// + / − (rangée principale ou pavé numérique) pilotent Z comme PgUp / PgDn.
// « = » compte comme « + » : c'est la même touche sans Maj.
const KEYS = {
  ArrowLeft: { X: -1 }, ArrowRight: { X: 1 }, ArrowUp: { Y: 1 }, ArrowDown: { Y: -1 },
  PageUp: { Z: 1 }, PageDown: { Z: -1 }, '+': { Z: 1 }, '=': { Z: 1 }, '-': { Z: -1 },
};
const KEY_BUTTON = { ArrowLeft: 'X-1', ArrowRight: 'X1', ArrowUp: 'Y1', ArrowDown: 'Y-1', PageUp: 'Z1', PageDown: 'Z-1', '+': 'Z1', '=': 'Z1', '-': 'Z-1' };
// Touches enfoncées, indexées par touche physique (e.code) : avec Maj, « + »
// peut se relâcher en « = », il faut quand même arrêter le bon jog.
const keyJoggers = {};
const heldKeys = {};
// Seuls les champs de saisie gardent les flèches ; un menu ou un bouton qui a
// le focus ne doit pas empêcher de déplacer la machine.
const typing = (e) => e.target.isContentEditable
  || !!e.target.closest('input, select, textarea, button, a, summary, [role="button"], [role="tab"], [role="slider"]');

function jogBlockedReason() {
  const m = S.machine;
  if (!m.connected) return 'Connectez la machine pour la déplacer.';
  if (!m.ready) return 'Connexion en cours…';
  if (m.status.state === 'Alarm') return 'Machine en alarme : cliquez sur Origine (ou Déverrouiller).';
  return `Déplacement impossible pendant l'état « ${STATE_LABEL[m.status.state] || m.status.state} ».`;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { act('jogStop').catch(() => {}); closeGoto(); stopDraw(); stopPlace(); return; }
  if (e.key === ' ' && preview.active && !typing(e) && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    preview.playing ? preview.pause() : preview.play();
    return;
  }
  if (!KEYS[e.key] || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (e.target.tagName === 'SELECT') e.target.blur();
  if (e.repeat || heldKeys[e.code]) return;
  if ($('#jog-stop').disabled) { toastOnce(jogBlockedReason()); return; }
  const held = { key: e.key, jogger: (keyJoggers[e.code] ||= makeJogger()) };
  heldKeys[e.code] = held;
  $(`[data-jog="${KEY_BUTTON[held.key]}"]`)?.classList.add('active');
  held.jogger.press(KEYS[held.key]);
});
document.addEventListener('keyup', (e) => {
  const held = heldKeys[e.code];
  if (!held) return;
  delete heldKeys[e.code];
  $(`[data-jog="${KEY_BUTTON[held.key]}"]`)?.classList.remove('active');
  held.jogger.release(KEYS[held.key]);
});
window.addEventListener('blur', () => {
  // La fenêtre perd le focus : aucun relâchement de touche ne viendra.
  for (const code of Object.keys(heldKeys)) {
    $(`[data-jog="${KEY_BUTTON[heldKeys[code].key]}"]`)?.classList.remove('active');
    heldKeys[code].jogger.release();
    delete heldKeys[code];
  }
  for (const j of buttonJoggers) j.release();
  act('jogStop').catch(() => {});
});

// ---- Visualiseur & job ------------------------------------------------------

const viewer = new Viewer($('#viewer'));
$$('[data-view]').forEach((b) => (b.onclick = () => viewer.view(b.dataset.view)));

function onJobText(name, text) {
  S.jobText = text;
  S.jobName = name;
  $('#btn-save-program').disabled = false;
  S.lines = splitProgram(text);
  const rapid = Number(S.settings[110]) || 3000;
  S.info = analyze(S.lines, { rapidRate: rapid });
  viewer.load(S.lines, { laser: laserOpts() });
  const i = S.info;
  const dims = Number.isFinite(i.min.X)
    ? `${fmtNum(i.max.X - i.min.X)} × ${fmtNum(i.max.Y - i.min.Y)} × ${fmtNum(i.max.Z - i.min.Z)} mm`
    : '';
  $('#job-name').textContent = name;
  $('#job-meta').textContent = [`${i.lines} lignes`, `≈ ${fmtDuration(i.seconds)}`, dims,
    i.toolChanges ? `${i.toolChanges} changement(s) d'outil` : ''].filter(Boolean).join(' · ');
  if (!isLaser() && Number.isFinite(i.min.Z) && i.min.Z >= 0) toast('Attention : aucune passe sous Z0. Le zéro Z est-il au bon endroit ?', 'err');
  closePreview();
  setupResume();
  renderZones();
  const fit = fitCheck();
  if (fit && !fit.ok) toast(fit.text, 'err');
  renderJob();
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) return toast('Fichier trop gros (60 Mo max)', 'err');
  const text = await file.text();
  await act('load', { name: file.name, text }).then(() => toast(`${file.name} chargé`, 'ok')).catch(() => {});
}
$('#file-input').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
$('#btn-save-program').onclick = () => {
  if (S.jobText == null) return toast('Aucun programme à enregistrer', 'err');
  const name = /\.[A-Za-z0-9]{1,5}$/.test(S.jobName) ? S.jobName : `${S.jobName || 'programme'}.nc`;
  const url = URL.createObjectURL(new Blob([S.jobText], { type: 'text/plain;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`${name} enregistré dans le dossier de téléchargements`, 'ok');
};

const REPO = 'CodeNinjaPython/copeau';
const versionParts = (v) => String(v).replace(/^v/i, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
const isNewer = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
$('#btn-update').onclick = async () => {
  const button = $('#btn-update');
  button.disabled = true;
  try {
    const current = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.json());
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (response.status === 404) return toast(`Version ${current.version} : aucune version publiée sur GitHub`, 'info');
    if (!response.ok) throw new Error(`GitHub a répondu ${response.status}`);
    const release = await response.json();
    if (!isNewer(release.tag_name, current.version)) return toast(`Copeau ${current.version} est à jour`, 'ok');
    toast(`Version ${release.tag_name} disponible (vous avez ${current.version}). Ouverture de la page de téléchargement.`, 'ok');
    window.open(String(release.html_url).startsWith('https://github.com/') ? release.html_url : `https://github.com/${REPO}/releases`, '_blank', 'noopener');
  } catch (e) {
    toast(`Recherche de mise à jour impossible : ${e.message}`, 'err');
  } finally {
    button.disabled = false;
  }
};
const wrap = $('.viewer-wrap');
wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragging'); });
wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dragging'); });
wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('dragging'); loadFile(e.dataTransfer.files[0]); });

const JOB_STATE = {
  loaded: 'Prêt', running: 'En cours', paused: 'En pause', spinup: 'Redémarrage broche', toolchange: 'Changement d\'outil',
  finishing: 'Finition', stopping: 'Arrêt…', stopped: 'Arrêté', done: 'Terminé',
};

function renderJob() {
  const j = S.job;
  const jobState = j ? (JOB_STATE[j.state] || j.state) : 'Aucun programme';
  if ($('#job-state').textContent !== jobState) $('#job-state').textContent = jobState;
  if (j && ['running', 'finishing'].includes(j.state)) closePreview();
  const bar = $('#job-progress');
  if (!j) {
    bar.style.transform = 'scaleX(0)';
    bar.parentElement.setAttribute('aria-valuenow', '0');
    updateEnabled();
    return;
  }
  const pct = j.total ? (j.acked / j.total) * 100 : 0;
  bar.style.transform = `scaleX(${pct / 100})`;
  bar.parentElement.setAttribute('aria-valuenow', String(Math.round(pct)));
  viewer.setProgress(j.state === 'loaded' ? 0 : j.acked);
  renderTimes();
  if (j.error && j.error !== lastJobError) { lastJobError = j.error; toast(j.error, 'err'); }
  const toolchange = $('#toolchange');
  if (j.state === 'toolchange' && toolchange.hidden) openModal(toolchange);
  else if (j.state !== 'toolchange' && !toolchange.hidden) closeModal(toolchange);
  if (j.state === 'stopped' && (j.resumeFrom !== null || j.lostAt) && lastJobState !== 'stopped') setupResume();
  if (j.state === 'toolchange') $('#tool-number').textContent = `T${j.tool}`;
  if (j.state === 'done' && lastJobState !== 'done') toast(`Job terminé en ${fmtDuration((j.finishedAt - j.startedAt) / 1000)}`, 'ok');
  lastJobState = j.state;
  updateEnabled();
}
let lastJobState = null;
let lastError = null;
let lastJobError = null;
function toastOnce(msg) {
  if (msg === lastError) return;
  lastError = msg;
  toast(msg, 'err');
  setTimeout(() => { if (lastError === msg) lastError = null; }, 4000);
}

function renderTimes() {
  const j = S.job;
  if (!j) return;
  let label = JOB_STATE[j.state] || j.state;
  if (j.state === 'spinup' && j.spinUpUntil) label += ` (${Math.max(0, Math.ceil((j.spinUpUntil - Date.now()) / 1000))} s)`;
  else if (j.state === 'paused' && j.spindleHeld) label += ', broche coupée';
  const pct = j.total ? Math.round((j.acked / j.total) * 100) : 0;
  if (!j.startedAt || j.state === 'loaded') {
    $('#job-elapsed').textContent = label;
    $('#job-remaining').textContent = S.info ? `durée estimée ${fmtDuration(S.info.seconds)}` : '';
    return;
  }
  const end = j.finishedAt || Date.now();
  const elapsed = (end - j.startedAt) / 1000;
  $('#job-elapsed').textContent = `${label} · ${pct}% · ${j.acked}/${j.total} · ${fmtDuration(elapsed)}`;
  const doneFrac = (j.acked - j.startIndex) / Math.max(1, j.total - j.startIndex);
  const active = ['running', 'paused', 'spinup', 'toolchange'].includes(j.state);
  $('#job-remaining').textContent = active && doneFrac > 0.02 ? `reste ≈ ${fmtDuration(elapsed / doneFrac - elapsed)}` : '';
}
setInterval(renderTimes, 1000);

$('#btn-run').onclick = () => {
  const fit = fitCheck();
  if (fit && !fit.ok && !confirm(`${fit.text}\n\nDémarrer quand même ?`)) return;
  if (isLaser()) {
    if (!confirm(`Démarrer la gravure ?\n\nCouvercle fermé, lunettes adaptées à la longueur d'onde, aspiration en marche : ne laissez jamais un laser travailler sans surveillance.${laserModeWarning()}`)) return;
  } else if (S.info && Number.isFinite(S.info.min.Z) && S.info.min.Z < 0 && !confirm('Démarrer l\'usinage ? Vérifiez l\'origine, le serrage et la broche.')) return;
  act('run', { from: 0 }).catch(() => {});
};
// Grbl en mode laser ($32=1) éteint le laser pendant les G0 et les pauses.
function laserModeWarning() {
  if (prof().firmware !== 'grbl' || S.settings[32] === undefined || S.settings[32] === '1') return '';
  return '\n\n⚠ Mode laser désactivé dans la carte ($32=0) : le laser restera allumé pendant les déplacements rapides. Envoyez $32=1.';
}
$('#opt-pause-spindle').checked = store.get('pauseSpindle', false);
$('#opt-pause-spindle').onchange = (e) => store.set('pauseSpindle', e.target.checked);
const spinUpSeconds = () => { const v = Number($('#resume-spinup').value); return Number.isFinite(v) && v >= 0 ? v : 3; };
$('#btn-pause').onclick = () => {
  const j = S.job;
  // Reprise après une pause ou un M0 : le serveur rallume la broche si besoin.
  if (j?.state === 'paused' || (j?.state === 'running' && ['Hold', 'Door'].includes(S.machine.status.state))) {
    act('resume', { spinUp: isLaser() ? 0 : spinUpSeconds() }).catch(() => {});
  } else {
    act('pause', { stopSpindle: !isLaser() && $('#opt-pause-spindle').checked }).catch(() => {});
  }
};
$('#btn-spindle').onclick = () => act('spindleStop').then(() => toast('Broche coupée : elle se rallumera à la reprise', 'ok')).catch(() => {});
$('#btn-stop').onclick = () => act('stop').catch(() => {});
$('#btn-tool-continue').onclick = () => act('toolDone').catch(() => {});
$('#btn-tool-stop').onclick = () => act('stop').catch(() => {});
$('#btn-tool-probe').onclick = () => runProbe('z', probeValues('z')).catch(() => {});

// ---- Reprise ---------------------------------------------------------------

function setupResume() {
  const n = Math.max(1, S.lines.length);
  for (const el of [$('#resume-line'), $('#resume-slider')]) { el.max = n; }
  // Après un arrêt, « acquittée » ne veut pas dire « usinée » : la carte accepte
  // les lignes bien avant de les exécuter. On repart de la ligne du parcours la
  // plus proche de la position réelle de l'outil.
  let suggested = 1;
  if (S.job?.state === 'stopped' && S.job.resumeFrom !== null && S.job.resumeFrom !== undefined) {
    suggested = S.job.resumeFrom + 1;
  } else if (S.job && ['stopped', 'paused'].includes(S.job.state)) {
    // Carte redémarrée : sa position est perdue, on part de la dernière connue.
    const near = viewer.nearestLine(S.job.lostAt || S.machine.status.wpos, Math.max(0, S.job.acked - 200), S.job.acked);
    suggested = near !== null ? near + 1 : Math.max(1, S.job.acked - 1);
  }
  setResumeLine(suggested);
}

function setResumeLine(n) {
  const max = Math.max(1, S.lines.length);
  n = Math.max(1, Math.min(max, Math.round(n) || 1));
  $('#resume-line').value = n;
  $('#resume-slider').value = n;
  const i = n - 1;
  const ctx = [];
  for (let k = Math.max(0, i - 3); k <= Math.min(S.lines.length - 1, i + 3); k++) {
    const t = `${String(k + 1).padStart(6)}  ${escapeHtml(S.lines[k])}`;
    ctx.push(k === i ? `<span class="cur">${t}</span>` : t);
  }
  $('#resume-context').innerHTML = ctx.join('\n') || 'Aucun programme chargé';
  const pre = S.lines.length && i > 0
    ? buildResume(S.lines, i, { spinUpSeconds: spinUpSeconds(), minSafeZ: safeZ(), laser: isLaser(), firmware: prof().firmware }).lines
    : [];
  $('#resume-preamble').textContent = pre.length ? `Préambule envoyé avant la ligne ${n} :\n${pre.join('\n')}` : 'Départ au début : pas de préambule.';
  if (activeTab === 'resume') viewer.setMarker(i);
}
$('#resume-line').oninput = (e) => setResumeLine(Number(e.target.value));
$('#resume-slider').oninput = (e) => setResumeLine(Number(e.target.value));
$('#resume-spinup').oninput = () => setResumeLine(Number($('#resume-line').value));
// Clic dans la vue 3D : choix de la ligne de reprise dans l'onglet Reprise,
// sinon proposition d'amener la tête au point cliqué du plateau.
viewer.onClick = ({ line, point, screen }) => {
  if (draw) { if (point) drawClick(point); return; }
  if (activeTab === 'resume') {
    if (line !== null) setResumeLine(line + 1);
    return;
  }
  if (point) openGoto(point, screen);
};

let gotoPoint = null;
const safeZ = () => { const v = Number($('#zone-safe-z').value); return Number.isFinite(v) ? v : 5; };
function openGoto(point, screen) {
  if ($('#jog-stop').disabled) { toastOnce(jogBlockedReason()); return; }
  const table = shapeToWork(S.zones.table);
  if (table && !insideShape(table, point)) { toastOnce('Ce point est en dehors du plateau.'); return; }
  gotoPoint = { X: Math.round(point.X * 10) / 10, Y: Math.round(point.Y * 10) / 10 };
  viewer.setTarget(gotoPoint);
  $('#goto-coords').innerHTML = `<b>X</b> ${gotoPoint.X.toFixed(1)} &nbsp; <b>Y</b> ${gotoPoint.Y.toFixed(1)}`;
  $('#goto-safe').textContent = safeZ();
  $('#goto-lift').checked = S.machine.status.wpos.Z < safeZ();
  const pop = $('#goto-pop');
  pop.hidden = false;
  const box = $('#viewer').getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(8, screen.x + 14), box.width - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(Math.max(8, screen.y + 14), box.height - pop.offsetHeight - 8)}px`;
  $('#goto-go').focus();
}
function closeGoto() {
  gotoPoint = null;
  $('#goto-pop').hidden = true;
  viewer.setTarget(null);
}
$('#goto-cancel').onclick = closeGoto;
$('#goto-go').onclick = () => {
  if (!gotoPoint) return;
  act('jogTo', { ...gotoPoint, liftZ: $('#goto-lift').checked ? liftZ() : null, feed: Number($('#jog-feed').value) })
    .catch(() => {});
  $('#goto-pop').hidden = true;
  setTimeout(() => viewer.setTarget(null), 600);
};

$('#btn-resume-run').onclick = () => {
  const n = Number($('#resume-line').value);
  const how = isLaser()
    ? 'La tête va rejoindre le point de reprise laser éteint, puis le laser se rallumera.'
    : 'L\'outil va monter au Z de sécurité puis se placer au-dessus du point de reprise.';
  if (!confirm(`Reprendre à la ligne ${n} ?\n${S.lines[n - 1]}\n\n${how}`)) return;
  act('run', { from: n - 1, spinUp: spinUpSeconds(), safeZ: safeZ() }).catch(() => {});
};

// ---- Onglets ---------------------------------------------------------------

const tabButtons = () => $$('.tabs [role="tab"]:not([hidden])').filter((button) => getComputedStyle(button).display !== 'none');
const validTabs = () => tabButtons().map((button) => button.dataset.tab);
const storedTab = store.get('tab', 'console');
let activeTab = validTabs().includes(location.hash.slice(1)) ? location.hash.slice(1)
  : validTabs().includes(storedTab) ? storedTab : 'console';
function showTab(name) {
  if (!validTabs().includes(name)) name = 'console';
  activeTab = name;
  store.set('tab', name);
  $$('.tabs [role="tab"]').forEach((b) => {
    const selected = b.dataset.tab === name;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  $$('.tab').forEach((p) => (p.hidden = p.dataset.pane !== name));
  if (name === 'resume') setResumeLine(Number($('#resume-line').value));
  else viewer.setMarker(0);
}
$('.tabs').onclick = (e) => { const b = e.target.closest('[role="tab"]'); if (b) showTab(b.dataset.tab); };
$('.tabs').addEventListener('keydown', (event) => {
  const current = event.target.closest('[role="tab"]');
  if (!current) return;
  const tabs = tabButtons();
  const index = tabs.indexOf(current);
  let next = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = tabs[(index + 1) % tabs.length];
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tabs[(index - 1 + tabs.length) % tabs.length];
  else if (event.key === 'Home') next = tabs[0];
  else if (event.key === 'End') next = tabs[tabs.length - 1];
  if (next) {
    event.preventDefault();
    showTab(next.dataset.tab);
    next.focus();
  }
});
showTab(activeTab);

// ---- Console ---------------------------------------------------------------

const history = store.get('history', []);
let histPos = history.length;
$('#console-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#console-input');
  const line = input.value.trim();
  if (!line) return;
  cmd(line);
  if (history[history.length - 1] !== line) history.push(line);
  history.splice(0, Math.max(0, history.length - 100));
  store.set('history', history);
  histPos = history.length;
  input.value = '';
};
$('#console-input').onkeydown = (e) => {
  if (e.key === 'ArrowUp' && histPos > 0) { histPos--; e.target.value = history[histPos]; e.preventDefault(); }
  if (e.key === 'ArrowDown') { histPos = Math.min(history.length, histPos + 1); e.target.value = history[histPos] ?? ''; e.preventDefault(); }
};
$('#btn-clear-console').onclick = () => { $('#console').innerHTML = ''; };

// ---- Palpage ---------------------------------------------------------------

const PROBE_FIELDS = {
  z: [
    ['plate', 'Épaisseur de la cale (mm)', 0],
    ['travel', 'Course max (mm)', 25],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
    ['retract', 'Dégagement final (mm)', 5],
  ],
  corner: [
    ['toolDia', 'Diamètre outil (mm)', 6],
    ['plate', 'Épaisseur cale en Z (mm)', 0],
    ['wall', 'Épaisseur paroi cale XY (mm)', 0],
    ['inset', 'Distance outil / bords (mm)', 10],
    ['depth', 'Profondeur palpage latéral (mm)', 3],
    ['travel', 'Course max Z (mm)', 25],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
  ],
  center: [
    ['toolDia', 'Diamètre outil (mm)', 6],
    ['maxRadius', 'Rayon max du trou (mm)', 30],
    ['fastFeed', 'Avance rapide (mm/min)', 150],
    ['slowFeed', 'Avance fine (mm/min)', 30],
  ],
};
const PROBE_HELP = {
  z: 'Placez l\'outil 5 à 20 mm au-dessus de la pièce (ou de la cale). Copeau palpe deux fois (rapide puis fin) et pose Z0 sur le dessus de la pièce.',
  corner: 'Placez l\'outil au-dessus de la pièce, à la distance indiquée des deux bords du coin choisi. Copeau palpe Z, puis X et Y sur les flancs, et pose X0 Y0 Z0 sur le coin.',
  center: 'Descendez l\'outil dans le trou, sous le bord, à peu près au centre. Copeau palpe ±X, ±Y puis ±X à nouveau et pose X0 Y0 au centre.',
  manual: 'Méthode de la feuille de papier, sans sonde : glissez une feuille entre l\'outil et la pièce, approchez par petits pas jusqu\'à ce qu\'elle frotte, puis cliquez « Contact ». Broche à l\'arrêt, outil tourné à la main.',
};
let probeKind = 'z';
let probeCorner = store.get('probeCorner', 'FL');

function probeValues(kind) {
  if (!PROBE_FIELDS[kind]) return {};
  const saved = store.get(`probe.${kind}`, {});
  const out = {};
  for (const [k, , d] of PROBE_FIELDS[kind]) out[k] = saved[k] ?? d;
  if (kind === 'corner') out.corner = probeCorner;
  return out;
}

function renderProbe() {
  $$('#probe-kind button').forEach((b) => {
    const active = b.dataset.kind === probeKind;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('#probe-help').textContent = PROBE_HELP[probeKind];
  const manual = probeKind === 'manual';
  $('#probe-manual').hidden = !manual;
  $('#probe-auto').hidden = manual;
  $('#probe-fields').hidden = manual;
  if (manual) { $('#probe-corners').hidden = true; $('#probe-result').hidden = true; renderManual(); return; }
  $('#probe-corners').hidden = probeKind !== 'corner';
  $$('#probe-corners button').forEach((b) => {
    const active = b.dataset.corner === probeCorner;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const vals = probeValues(probeKind);
  $('#probe-fields').innerHTML = PROBE_FIELDS[probeKind].map(([k, label]) =>
    `<label class="field"><span>${label} ${ibtn(`pf-${k}`)}</span><input type="number" step="any" data-pk="${k}" value="${vals[k]}"></label>`).join('');
}
$('#probe-kind').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { probeKind = b.dataset.kind; renderProbe(); } };
$('#probe-corners').onclick = (e) => { const b = e.target.closest('[data-corner]'); if (b) { probeCorner = b.dataset.corner; store.set('probeCorner', probeCorner); renderProbe(); } };
$('#probe-fields').oninput = () => {
  const v = {};
  $$('#probe-fields [data-pk]').forEach((i) => (v[i.dataset.pk] = Number(i.value)));
  store.set(`probe.${probeKind}`, v);
};
renderProbe();

// ---- Palpage sans sonde (méthode de la feuille) -------------------------------
// On approche à la main par petits pas ; au contact, la position actuelle
// devient : épaisseur de la feuille (Z) ou -(rayon + feuille) côté approche (X/Y).

const MANUAL_SIDES = {
  Z: { label: 'Dessus Z', axis: 'Z', dir: -1, radius: false, approach: '▼ Descendre', away: '▲ Monter',
    help: 'Outil au-dessus de la pièce, feuille posée dessous. Descendez jusqu\'à ce que la feuille frotte.' },
  XL: { label: 'Bord gauche', axis: 'X', dir: 1, radius: true, approach: '→ Approcher', away: '← Reculer',
    help: 'Outil à gauche de la pièce, sous le dessus. Approchez vers la droite jusqu\'à coincer la feuille contre le bord.' },
  XR: { label: 'Bord droit', axis: 'X', dir: -1, radius: true, approach: '← Approcher', away: '→ Reculer',
    help: 'Outil à droite de la pièce, sous le dessus. Approchez vers la gauche jusqu\'à coincer la feuille.' },
  YF: { label: 'Bord avant', axis: 'Y', dir: 1, radius: true, approach: '↑ Approcher', away: '↓ Reculer',
    help: 'Outil devant la pièce, sous le dessus. Approchez vers l\'arrière jusqu\'à coincer la feuille.' },
  YB: { label: 'Bord arrière', axis: 'Y', dir: -1, radius: true, approach: '↓ Approcher', away: '↑ Reculer',
    help: 'Outil derrière la pièce, sous le dessus. Approchez vers l\'avant jusqu\'à coincer la feuille.' },
};
const manualState = { side: 'Z', paper: 0.1, toolDia: 6, step: 0.1, retract: true, ...store.get('probe.manualState', {}) };
const saveManual = () => store.set('probe.manualState', manualState);

function renderManual() {
  const m = manualState;
  const side = MANUAL_SIDES[m.side] || MANUAL_SIDES.Z;
  const steps = [0.01, 0.05, 0.1, 0.5, 1];
  $('#probe-manual').innerHTML = `
    <div class="seg">${Object.entries(MANUAL_SIDES).map(([k, s]) =>
      `<button data-mside="${k}" class="${k === m.side ? 'active' : ''}">${s.label}</button>`).join('')}</div>
    <p class="muted small">${side.help}</p>
    <div class="grid2">
      <label class="field"><span>Épaisseur feuille / cale (mm) ${ibtn('pf-paper')}</span><input type="number" step="any" min="0" data-mfield="paper" value="${m.paper}"></label>
      ${side.radius ? `<label class="field"><span>Diamètre outil (mm) ${ibtn('pf-toolDia')}</span><input type="number" step="any" min="0" data-mfield="toolDia" value="${m.toolDia}"></label>` : '<span></span>'}
    </div>
    <div class="section-title"><span>Pas d'approche ${ibtn('pf-mstep')}</span></div>
    <div class="seg">${steps.map((v) => `<button data-mstep="${v}" class="${v === m.step ? 'active' : ''}">${v}</button>`).join('')}</div>
    <div class="manual-pos" id="manual-pos"></div>
    <div class="manual-moves">
      <button class="primary" data-mmove="1">${side.approach}</button>
      <button class="ghost" data-mmove="-1">${side.away}</button>
    </div>
    <label class="check small"><input type="checkbox" data-mretract ${m.retract ? 'checked' : ''}> Dégager de 2 mm après le contact</label>
    <button class="primary block" data-mcontact>✓ Contact : poser ${side.axis}0</button>
    <div class="probe-result" id="manual-result" hidden></div>`;
  updateManualPos();
}

function updateManualPos() {
  const el = $('#manual-pos');
  if (!el || $('#probe-manual').hidden) return;
  const side = MANUAL_SIDES[manualState.side];
  const v = S.machine.status.wpos[side.axis];
  el.innerHTML = `${side.axis} ${v.toFixed(3)}<small>position travail actuelle</small>`;
}

function manualContactValue() {
  const side = MANUAL_SIDES[manualState.side];
  const r = side.radius ? manualState.toolDia / 2 : 0;
  return r3(-side.dir * (r + manualState.paper));
}

$('#probe-manual').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const m = manualState;
  const side = MANUAL_SIDES[m.side];
  if (b.dataset.mside) { m.side = b.dataset.mside; saveManual(); renderManual(); return; }
  if (b.dataset.mstep) { m.step = Number(b.dataset.mstep); saveManual(); renderManual(); return; }
  if ($('#jog-stop').disabled) return toastOnce(jogBlockedReason());
  const feed = Math.min(Number($('#jog-feed').value) || 300, 300);
  if (b.dataset.mmove) {
    act('jog', { axes: { [side.axis]: side.dir * Number(b.dataset.mmove) * m.step }, feed }).catch(() => {});
    return;
  }
  if ('mcontact' in b.dataset) {
    // Le zéro se pose sur la position actuelle : elle doit être définitive.
    if (S.machine.status.state !== 'Idle') return toast('Attendez l\'arrêt complet de la machine avant le contact', 'err');
    const value = manualContactValue();
    await act('cmd', { line: `G10L20P0${side.axis}${value}` }).catch(() => {});
    const msg = `${side.axis} posé : la position actuelle vaut ${side.axis} ${value} (${side.radius ? `rayon ${r3(m.toolDia / 2)} + ` : ''}feuille ${m.paper} mm), donc ${side.axis}0 est sur ${side.axis === 'Z' ? 'le dessus de la pièce' : 'le bord'}.`;
    const box = $('#manual-result');
    box.hidden = false;
    box.className = 'probe-result';
    box.textContent = msg;
    toast(`${side.axis}0 posé (méthode de la feuille)`, 'ok');
    if (m.retract) act('jog', { axes: { [side.axis]: -side.dir * 2 }, feed }).catch(() => {});
  }
});
$('#probe-manual').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.mfield) {
    const v = Number(t.value);
    if (Number.isFinite(v) && v >= 0) { manualState[t.dataset.mfield] = v; saveManual(); }
  } else if ('mretract' in t.dataset) {
    manualState.retract = t.checked;
    saveManual();
  }
});

async function runProbe(kind, params) {
  const box = $('#probe-result');
  box.hidden = false;
  box.className = 'probe-result';
  box.textContent = 'Palpage en cours…';
  try {
    const r = await request('probe', { kind, params });
    box.textContent = r.message;
    toast(r.message, 'ok');
  } catch (e) {
    box.className = 'probe-result err';
    box.textContent = e.message;
    toast(e.message, 'err');
    throw e;
  }
}
$('#btn-probe').onclick = () => {
  if (!$('#probe-confirm').checked) return toast('Confirmez que la sonde est branchée et testée.', 'err');
  runProbe(probeKind, probeValues(probeKind)).catch(() => {});
};


// ---- Plateau et zone de travail ---------------------------------------------
// Formes enregistrées en coordonnées machine : { kind: 'rect', a, b } ou
// { kind: 'circle', c, r }. Affichage et saisie en coordonnées travail.

const wcoXY = () => S.machine.status.wco || { X: 0, Y: 0 };
const toWork = (p) => p && { X: p.X - wcoXY().X, Y: p.Y - wcoXY().Y };
const toMachine = (p) => p && { X: p.X + wcoXY().X, Y: p.Y + wcoXY().Y };
const r3 = (v) => Math.round(v * 1000) / 1000;

function shapeToWork(sh) {
  if (!sh) return null;
  if (sh.kind === 'circle') return { kind: 'circle', c: toWork(sh.c), r: sh.r };
  const out = { kind: 'rect', a: toWork(sh.a), b: toWork(sh.b) };
  // Course Z du plateau : volume machine de -z à 0, ramené en Z travail.
  if (sh.z) {
    const wz = S.machine.status.wco?.Z || 0;
    out.zTop = -wz;
    out.zBottom = -sh.z - wz;
  }
  return out;
}

function insideShape(sh, p, tol = 0.001) {
  if (sh.kind === 'circle') return Math.hypot(p.X - sh.c.X, p.Y - sh.c.Y) <= sh.r + tol;
  return p.X >= Math.min(sh.a.X, sh.b.X) - tol && p.X <= Math.max(sh.a.X, sh.b.X) + tol &&
    p.Y >= Math.min(sh.a.Y, sh.b.Y) - tol && p.Y <= Math.max(sh.a.Y, sh.b.Y) + tol;
}

function shapeSize(sh) {
  if (!sh) return 'non défini';
  if (sh.kind === 'circle') return `Ø ${fmtNum(sh.r * 2)} mm`;
  return `${fmtNum(Math.abs(sh.b.X - sh.a.X))} × ${fmtNum(Math.abs(sh.b.Y - sh.a.Y))}${sh.z ? ` × ${fmtNum(sh.z)}` : ''} mm`;
}

// Brouillons en cours de saisie (coordonnées machine), un par carte.
const drafts = {};
let zoneKind = 'rect';
function resetDrafts() {
  drafts.table = { kind: 'rect', ...(S.zones.table || {}) };
  const z = S.zones.zone;
  if (z) zoneKind = z.kind;
  drafts.zone = { kind: zoneKind, ...(z || {}) };
}
resetDrafts();

function complete(d) {
  if (d.kind === 'circle') return d.c && d.r > 0 ? { kind: 'circle', c: d.c, r: r3(d.r) } : null;
  if (!d.a || !d.b || Math.abs(d.a.X - d.b.X) < 0.1 || Math.abs(d.a.Y - d.b.Y) < 0.1) return null;
  return { kind: 'rect', a: d.a, b: d.b, ...(d.z > 0 ? { z: r3(d.z) } : {}) };
}

function saveShape(target, shape) {
  // Redessiner le plateau à la souris ne doit pas perdre sa course Z.
  if (target === 'table' && shape && !shape.z && S.zones.table?.z) shape = { ...shape, z: S.zones.table.z };
  const zones = { ...S.zones, [target]: shape };
  return act('setConfig', { key: 'zones', value: zones })
    .then(() => toast(shape ? `${target === 'table' ? 'Plateau' : 'Zone de travail'} : ${shapeSize(shape)}` : 'Forme effacée', 'ok'))
    .catch(() => {});
}

function commitDraft(target) {
  const shape = complete(drafts[target]);
  if (shape) saveShape(target, shape);
  else renderZones();
}

function pointRow(label, key, p, capLabel) {
  const w = toWork(p);
  const v = (a) => (w ? r3(w[a]) : '');
  return `<div class="zone-pt"><span>${label}</span>
    <input type="number" step="any" data-pt="${key}" data-axis="X" placeholder="X" aria-label="${label} X en coordonnées de travail" value="${v('X')}" class="${w ? '' : 'empty'}">
    <input type="number" step="any" data-pt="${key}" data-axis="Y" placeholder="Y" aria-label="${label} Y en coordonnées de travail" value="${v('Y')}" class="${w ? '' : 'empty'}">
    <button class="ghost small" data-cap="${key}" aria-label="${capLabel} : ${label}" title="Prendre la position actuelle de l'outil">${capLabel}</button></div>`;
}

function renderZoneCard(target) {
  const card = $(`.zone-card[data-target="${target}"]`);
  const saved = S.zones[target];
  card.querySelector('[data-size]').textContent = shapeSize(saved);
  const d = drafts[target];
  card.querySelectorAll('[data-kind]').forEach((b) => {
    const active = b.dataset.kind === d.kind;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const drawBtn = card.querySelector('[data-draw]');
  drawBtn.textContent = draw?.target === target ? 'Annuler le tracé' : 'Tracer sur la vue';
  const form = card.querySelector('[data-form]');
  if (form.contains(document.activeElement)) return; // ne pas écraser une saisie
  form.innerHTML = d.kind === 'circle'
    ? pointRow('Centre', 'c', d.c, 'Capturer') +
      `<div class="zone-pt"><span>Rayon</span>
        <input type="number" step="any" min="0" data-radius placeholder="R" aria-label="Rayon de la zone en millimètres" value="${d.r ? r3(d.r) : ''}" class="${d.r ? '' : 'empty'}">
        <span></span>
        <button class="ghost small" data-cap="edge" aria-label="Capturer le point du bord du cercle" title="Rayon = distance entre le centre et la position actuelle">Point du bord</button></div>`
    : pointRow('Coin 1', 'a', d.a, 'Capturer') + pointRow('Coin 2', 'b', d.b, 'Capturer');
  if (target === 'table') renderTableDims(card, saved);
}

// Course machine (taille de travail max) : X × Y × Z, saisie ou lue dans la
// carte ($130 / $131 / $132), avec écriture possible dans Grbl.
function renderTableDims(card, saved) {
  const box = card.querySelector('[data-dims]');
  if (box.contains(document.activeElement)) return;
  const set = S.settings;
  // Sans réglage lu dans la carte, on propose la surface annoncée du profil (Emblaser 2 : 500 × 300 × 50).
  const area = prof().area;
  const fromArea = (key) => (area ? area[{ 130: 'X', 131: 'Y', 132: 'Z' }[key]] ?? '' : '');
  const val = (fromShape, key) => (fromShape !== undefined ? r3(fromShape) : set[key] ? r3(Number(set[key])) : fromArea(key));
  const w = val(saved && Math.abs(saved.b.X - saved.a.X), 130);
  const h = val(saved && Math.abs(saved.b.Y - saved.a.Y), 131);
  const z = val(saved ? saved.z || undefined : undefined, 132);
  const field = (k, v, ph) => `<input type="number" step="any" min="1" data-dim="${k}" placeholder="${ph}" aria-label="Course machine ${k} en millimètres" value="${v}" class="${v !== '' ? '' : 'empty'}" title="Course ${k} (mm)">`;
  const anchor = store.get('tableAnchor', 'machine');
  box.innerHTML = `
    <div class="zone-dims-row"><span>Course</span>${field('X', w, 'X')}${field('Y', h, 'Y')}${field('Z', z, 'Z')}</div>
    <div class="zone-dims-anchor"><span>Ancrage ${ibtn('anchor')}</span>
      <select data-anchor>
        <option value="machine"${anchor === 'machine' ? ' selected' : ''}>Origine machine (Grbl, vers X− Y−)</option>
        <option value="coin1"${anchor === 'coin1' ? ' selected' : ''}>Coin 1 fixe</option>
        <option value="tool"${anchor === 'tool' ? ' selected' : ''}>Outil = coin avant gauche</option>
      </select></div>
    <label class="check small grbl-only"><input type="checkbox" data-write-grbl ${S.machine.ready ? 'checked' : 'disabled'}> Écrire aussi dans la carte ($130 / $131 / $132) ${ibtn('writeGrbl')}</label>
    <div class="row gap"><button class="primary small grow" data-dims-apply>Appliquer</button><button class="ghost small grbl-only" data-from-grbl title="Lire la course enregistrée dans la carte">Lire la carte</button></div>`;
}

async function applyTableDims(card) {
  const W = Number(card.querySelector('[data-dim="X"]').value);
  const D = Number(card.querySelector('[data-dim="Y"]').value);
  const zIn = card.querySelector('[data-dim="Z"]').value;
  const Z = zIn === '' ? 0 : Number(zIn);
  if (!(W >= 1) || !(D >= 1)) return toast('Indiquez une course X et Y d\'au moins 1 mm', 'err');
  if (zIn !== '' && !(Z >= 1)) return toast('Course Z invalide', 'err');
  const anchor = card.querySelector('[data-anchor]').value;
  store.set('tableAnchor', anchor);
  let a, b;
  if (anchor === 'machine') {
    a = { X: 0, Y: 0 };
    b = { X: -W, Y: -D };
  } else if (anchor === 'tool') {
    if (!S.machine.ready) return toast('Connectez la machine pour utiliser la position de l\'outil', 'err');
    const m = S.machine.status.mpos;
    a = { X: r3(m.X), Y: r3(m.Y) };
    b = { X: r3(m.X + W), Y: r3(m.Y + D) };
  } else {
    // Coin 1 fixe, on garde le sens actuel du rectangle.
    const cur = drafts.table;
    if (!cur.a) return toast('Capturez ou saisissez d\'abord le coin 1', 'err');
    const sx = cur.b && cur.b.X < cur.a.X ? -1 : 1, sy = cur.b && cur.b.Y < cur.a.Y ? -1 : 1;
    a = cur.a;
    b = { X: r3(a.X + sx * W), Y: r3(a.Y + sy * D) };
  }
  const write = !isSmoothie() && card.querySelector('[data-write-grbl]')?.checked;
  if (write) {
    const st = S.machine.status.state;
    if (!S.machine.ready || !['Idle', 'Alarm'].includes(st)) return toast('La carte accepte les réglages seulement à l\'arrêt (Prêt ou Alarme)', 'err');
    const lines = [`$130=${r3(W)}`, `$131=${r3(D)}`, ...(Z ? [`$132=${r3(Z)}`] : [])];
    if (!confirm(`Écrire la course dans la carte ?\n\n${lines.join('\n')}\n\nGrbl s'en sert pour les limites logicielles et la prise d'origine.`)) return;
    await act('cmd', { line: [...lines, '$$'].join('\n') }).catch(() => {});
  }
  drafts.table = { kind: 'rect', a, b, ...(Z ? { z: Z } : {}) };
  document.activeElement?.blur();
  commitDraft('table');
}

// offset : décalage du programme à tester (mode « Placer »), repère travail.
function fitCheck(offset = { X: 0, Y: 0 }) {
  const i = S.info;
  if (!i || !Number.isFinite(i.min.X)) return null;
  const corners = [
    { X: i.min.X, Y: i.min.Y }, { X: i.max.X, Y: i.min.Y }, { X: i.max.X, Y: i.max.Y }, { X: i.min.X, Y: i.max.Y },
  ].map((p) => ({ X: p.X + offset.X, Y: p.Y + offset.Y }));
  const zone = shapeToWork(S.zones.zone);
  const table = shapeToWork(S.zones.table);
  const size = `${fmtNum(i.max.X - i.min.X)} × ${fmtNum(i.max.Y - i.min.Y)} mm`;
  if (table && !corners.every((p) => insideShape(table, p))) return { ok: false, text: `Le programme (${size}) dépasse du plateau avec le zéro actuel.` };
  if (table?.zBottom !== undefined && Number.isFinite(i.min.Z)) {
    if (i.min.Z < table.zBottom - 0.001) return { ok: false, text: `Le programme descend à Z ${fmtNum(i.min.Z)}, sous la course Z de la machine (Z ${fmtNum(table.zBottom)} au plus bas avec le zéro actuel).` };
    if (i.max.Z > table.zTop + 0.001) return { ok: false, text: `Le programme monte à Z ${fmtNum(i.max.Z)}, au-dessus de la course Z de la machine (Z ${fmtNum(table.zTop)} au plus haut avec le zéro actuel).` };
  }
  if (zone && !corners.every((p) => insideShape(zone, p))) return { ok: false, text: `Le programme (${size}) sort de la zone de travail avec le zéro actuel.` };
  if (!zone && !table) return { ok: true, text: `Programme : ${size}. Définissez une zone pour vérifier qu'il tient.` };
  return { ok: true, text: `Le programme (${size}) tient dans la ${zone ? 'zone de travail' : 'surface du plateau'}.` };
}

function renderZones() {
  if (!$('.zone-card')) return;
  const preview = draw?.first && draw.hover ? drawShape(draw.first, draw.hover) : null;
  viewer.setShapes({
    table: shapeToWork(S.zones.table),
    zone: shapeToWork(S.zones.zone),
    preview: preview && shapeToWork(preview),
  });
  renderZoneCard('table');
  renderZoneCard('zone');
  const fit = fitCheck();
  const st = $('#fit-status');
  st.textContent = fit ? fit.text : 'Aucun programme chargé';
  st.className = `fit-status ${fit ? (fit.ok ? 'ok' : 'bad') : 'muted'}`;
  const canJog = !$('#jog-stop').disabled;
  $('.zone-card[data-target="zone"] [data-outline]').disabled = !S.zones.zone || !canJog;
  $('#btn-outline-job').disabled = !fit || !canJog;
}

// Tracé à la souris : premier clic = coin (ou centre), second = coin opposé (ou bord).
let draw = null;
function drawShape(first, second) {
  return draw.kind === 'circle'
    ? { kind: 'circle', c: first, r: Math.hypot(second.X - first.X, second.Y - first.Y) }
    : { kind: 'rect', a: first, b: second };
}
function setHint() {
  const hint = $('#viewer-hint');
  hint.classList.toggle('drawing', !!draw);
  if (!draw) { hint.textContent = 'Cliquez sur le plateau pour y amener la tête · flèches = X/Y · + / − = Z · Échap = stop'; return; }
  const what = draw.target === 'table' ? 'du plateau' : 'de la zone';
  hint.textContent = draw.kind === 'circle'
    ? (draw.first ? `Cliquez un point du bord ${what} (Échap pour annuler)` : `Cliquez le centre ${what}`)
    : (draw.first ? `Cliquez le coin opposé ${what} (Échap pour annuler)` : `Cliquez un premier coin ${what}`);
}
function startDraw(target) {
  closeGoto();
  draw = { target, kind: drafts[target].kind, first: null, hover: null };
  viewer.onHover = (p) => { if (draw?.first) { draw.hover = toMachine(p); renderZones(); } };
  viewer.view('top');
  setHint();
  renderZones();
}
function stopDraw() {
  if (!draw) return;
  draw = null;
  viewer.onHover = null;
  setHint();
  renderZones();
}
function drawClick(point) {
  const p = toMachine({ X: r3(point.X), Y: r3(point.Y) });
  if (!draw.first) { draw.first = p; setHint(); return; }
  const shape = complete(drawShape(draw.first, p));
  const target = draw.target;
  stopDraw();
  if (!shape) return toast('Forme trop petite', 'err');
  drafts[target] = { ...shape };
  saveShape(target, shape);
}

for (const card of $$('.zone-card[data-target]')) {
  const target = card.dataset.target;
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.kind) {
      zoneKind = b.dataset.kind;
      drafts.zone = { kind: zoneKind, ...(S.zones.zone?.kind === zoneKind ? S.zones.zone : {}) };
      renderZones();
    } else if (b.dataset.cap) {
      if (!S.machine.ready) return toast('Connectez la machine pour capturer sa position', 'err');
      const m = S.machine.status.mpos;
      const d = drafts[target];
      if (b.dataset.cap === 'edge') {
        if (!d.c) return toast('Capturez d\'abord le centre', 'err');
        d.r = Math.hypot(m.X - d.c.X, m.Y - d.c.Y);
      } else {
        d[b.dataset.cap] = { X: r3(m.X), Y: r3(m.Y) };
      }
      commitDraft(target);
    } else if ('draw' in b.dataset) {
      draw?.target === target ? stopDraw() : startDraw(target);
    } else if ('clear' in b.dataset) {
      drafts[target] = { kind: drafts[target].kind };
      saveShape(target, null);
    } else if ('fromGrbl' in b.dataset) {
      const w = Number(S.settings[130]), h = Number(S.settings[131]), z = Number(S.settings[132]);
      if (!w || !h) return toast('Réglages $130 / $131 indisponibles : connectez la machine', 'err');
      toast('Course lue dans la carte (volume valable après la prise d\'origine)', 'info');
      drafts.table = { kind: 'rect', a: { X: 0, Y: 0 }, b: { X: -w, Y: -h }, ...(z ? { z } : {}) };
      commitDraft('table');
    } else if ('fromJob' in b.dataset) {
      const i = S.info;
      if (!i || !Number.isFinite(i.min.X)) return toast('Aucun programme chargé', 'err');
      zoneKind = 'rect';
      drafts.zone = { kind: 'rect', a: toMachine({ X: i.min.X, Y: i.min.Y }), b: toMachine({ X: i.max.X, Y: i.max.Y }) };
      commitDraft('zone');
    } else if ('dimsApply' in b.dataset) {
      applyTableDims(card);
    } else if ('outline' in b.dataset) {
      const z = shapeToWork(S.zones.zone);
      const pts = outline(z, 48);
      runPath([...pts, pts[0]]);
    }
  });
  card.addEventListener('change', (e) => {
    const d = drafts[target];
    const input = e.target;
    if (input.dataset.radius !== undefined) {
      const r = Number(input.value);
      d.r = input.value !== '' && r > 0 ? r : null;
    } else if (input.dataset.pt) {
      const key = input.dataset.pt;
      const row = input.closest('.zone-pt');
      const x = row.querySelector('[data-axis="X"]').value, y = row.querySelector('[data-axis="Y"]').value;
      d[key] = x !== '' && y !== '' ? toMachine({ X: Number(x), Y: Number(y) }) : null;
    } else return;
    input.blur();
    commitDraft(target);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    if (e.target.dataset.dim) { e.preventDefault(); applyTableDims(card); return; }
    e.target.blur();
  });
}

// pointer : % du tir de repérage à garder allumé pendant le parcours.
function runPath(points, pointer = 0) {
  if ($('#jog-stop').disabled) return toastOnce(jogBlockedReason());
  act('jogPath', { points, liftZ: liftZ(), feed: Number($('#jog-feed').value), pointer }).catch(() => {});
}
// Cadre du programme. Laser : à la hauteur actuelle, laser éteint (ou
// pointeur allumé avec Smoothieware) pour voir où tombera la gravure.
function outlineJob(pointer = 0) {
  const i = S.info;
  if (!i || !Number.isFinite(i.min.X)) return;
  runPath([
    { X: i.min.X, Y: i.min.Y }, { X: i.max.X, Y: i.min.Y }, { X: i.max.X, Y: i.max.Y },
    { X: i.min.X, Y: i.max.Y }, { X: i.min.X, Y: i.min.Y },
  ], pointer);
}
$('#btn-outline-job').onclick = () => outlineJob();
$('#btn-frame').onclick = () => outlineJob(isSmoothie() && $('#frame-pointer').checked ? Number($('#pointer-power').value) || 1 : 0);
$('#zone-safe-z').value = store.get('safeZ', 5);
$('#zone-safe-z').onchange = () => store.set('safeZ', safeZ());



// ---- Laser : tir de repérage, S max -------------------------------------------

$('#pointer-power').value = store.get('pointerPower', 1);
$('#pointer-power').onchange = () => store.set('pointerPower', Number($('#pointer-power').value) || 1);
$('#frame-pointer').checked = store.get('framePointer', false);
$('#frame-pointer').onchange = (e) => store.set('framePointer', e.target.checked);
$('#btn-pointer').onclick = () => {
  if (S.machine.pointer) return act('laserPointer', { on: false }).catch(() => {});
  const p = Number($('#pointer-power').value) || 1;
  if (p > 5 && !confirm(`Tir de repérage à ${fmt(p)} % : à cette puissance le laser marque ou brûle la matière, et le faisceau est dangereux pour les yeux.\n\nAllumer quand même ?`)) return;
  act('laserPointer', { on: true, power: p })
    .then(() => toast('Laser allumé à faible puissance : il s\'éteint tout seul après 60 s', 'info'))
    .catch(() => {});
};
$('#laser-smax').onchange = (e) => {
  const v = Number(e.target.value);
  if (!(v > 0)) { e.target.value = fmt(sMax()); return toast('S max doit être positif', 'err'); }
  S.config.machine = { ...S.config.machine, sMax: v };
  act('setConfig', { key: 'machine', value: S.config.machine }).then(() => toast(`100 % de puissance = S${fmt(v)}`, 'ok')).catch(() => {});
  e.target.blur();
};

// ---- Laser : gravure d'une image ------------------------------------------------
// L'image est redimensionnée dans le navigateur (un pixel = un pas de gravure),
// convertie en puissances puis en G-code ligne à ligne, chargé comme un
// programme ordinaire.

const raster = { img: null, url: null, name: '', aspect: 1, opts: { ...RASTER_DEFAULTS, width: 50, height: 50, ...store.get('raster', {}) } };
const RASTER_MAX_POINTS = 16e6;
let rasterGenerating = false;

async function openRaster(file) {
  if (!file) return;
  if (rasterGenerating) return toast('Attendez la fin de la génération en cours.', 'info');
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Image illisible')); img.src = url; });
  } catch (e) { URL.revokeObjectURL(url); return toast(e.message, 'err'); }
  closeRaster();
  Object.assign(raster, { img, url, name: file.name.replace(/\.[^.]+$/, ''), aspect: img.naturalHeight / img.naturalWidth });
  raster.opts.height = r3(raster.opts.width * raster.aspect);
  fillRasterForm();
  openModal($('#raster'));
  drawRaster();
}
function closeRaster() {
  closeModal($('#raster'));
  if (raster.url) URL.revokeObjectURL(raster.url);
  raster.img = raster.url = null;
}
function fillRasterForm() {
  const o = raster.opts;
  for (const el of $$('[data-r]')) {
    if (el.type === 'checkbox') el.checked = !!o[el.dataset.r];
    else if (document.activeElement !== el) el.value = o[el.dataset.r];
  }
  $$('#raster-mode button').forEach((b) => {
    const active = b.dataset.rmode === o.mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('[data-only="threshold"]').hidden = o.mode !== 'threshold';
}
// Pixels en niveaux de gris, à la résolution de gravure (scale < 1 : aperçu allégé).
function rasterPixels(scale = 1) {
  const o = raster.opts;
  const width = Math.max(1, Math.round(o.width * o.resolution * scale));
  const height = Math.max(1, Math.round(o.height * o.resolution * scale));
  if (width * height > RASTER_MAX_POINTS) throw new Error(`Image trop grande à graver (${width} × ${height} points) : réduisez la taille ou la résolution.`);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // les zones transparentes ne se gravent pas
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(raster.img, 0, 0, width, height);
  const d = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { gray, width, height };
}
let rasterTimer = null;
function drawRaster() {
  clearTimeout(rasterTimer);
  rasterTimer = setTimeout(() => {
    if (!raster.img) return;
    const o = raster.opts;
    const info = $('#raster-info');
    const full = Math.round(o.width * o.resolution) * Math.round(o.height * o.resolution);
    if (full > RASTER_MAX_POINTS) { info.innerHTML = '<span class="bad">Image trop grande à graver : réduisez la taille ou la résolution.</span>'; return; }
    const scale = Math.min(1, Math.sqrt(1.5e6 / Math.max(1, full))); // aperçu : 1,5 million de points au plus
    let px;
    try { px = rasterPixels(scale); } catch (e) { info.innerHTML = `<span class="bad">${escapeHtml(e.message)}</span>`; return; }
    const pow = powerMap(px.gray, px.width, px.height, o);
    const hi = Math.max(0.01, o.powerMax / 100);
    const canvas = $('#raster-canvas');
    canvas.width = px.width;
    canvas.height = px.height;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(px.width, px.height);
    let burnRows = 0, burnLen = 0;
    for (let y = 0; y < px.height; y++) {
      let first = -1, last = -1;
      for (let x = 0; x < px.width; x++) {
        const i = y * px.width + x;
        const v = Math.round(255 * (1 - Math.min(1, pow[i] / hi)));
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
        out.data[i * 4 + 3] = 255;
        if (pow[i] > 0) { if (first < 0) first = x; last = x; }
      }
      if (first >= 0) { burnRows++; burnLen += (last - first + 1) / (o.resolution * scale) + 2 * o.overscan; }
    }
    ctx.putImageData(out, 0, 0);
    // Durée : lignes gravées (ramenées à la vraie résolution) à la vitesse de gravure.
    const seconds = ((burnLen / Math.max(1, o.speed)) * 60) / scale;
    const hint = o.powerMax > 80 ? '<br><span class="bad">Puissance max élevée : faites d\'abord un essai sur une chute.</span>' : '';
    info.innerHTML = `${fmtNum(o.width)} × ${fmtNum(o.height)} mm · ${Math.round(o.width * o.resolution)} × ${Math.round(o.height * o.resolution)} points · ${Math.round(burnRows / scale)} lignes gravées<br>`
      + `Durée estimée ≈ ${fmtDuration(seconds)} · S${fmt((o.powerMin / 100) * sMax())} à S${fmt((o.powerMax / 100) * sMax())}${hint}`;
  }, 80);
}
$('#image-input').onchange = (e) => { openRaster(e.target.files[0]); e.target.value = ''; };
$('#raster-mode').onclick = (e) => {
  const b = e.target.closest('[data-rmode]');
  if (!b) return;
  raster.opts.mode = b.dataset.rmode;
  store.set('raster', raster.opts);
  fillRasterForm();
  drawRaster();
};
$('#raster-form').addEventListener('input', (e) => {
  const el = e.target.closest('[data-r]');
  if (!el) return;
  const k = el.dataset.r;
  const o = raster.opts;
  if (el.type === 'checkbox') o[k] = el.checked;
  else if (el.tagName === 'SELECT') o[k] = el.value;
  else {
    const v = Number(el.value);
    if (!(v >= 0) || el.value === '') return;
    o[k] = v;
    // Les proportions de l'image sont gardées.
    if (k === 'width' && v > 0) o.height = r3(v * raster.aspect);
    if (k === 'height' && v > 0) o.width = r3(v / raster.aspect);
  }
  store.set('raster', o);
  fillRasterForm();
  drawRaster();
});
$('#raster-cancel').onclick = closeRaster;
$('#raster-go').onclick = async () => {
  const o = raster.opts;
  if (!(o.width > 0 && o.height > 0 && o.resolution > 0 && o.speed > 0)) return toast('Réglages de gravure invalides', 'err');
  if (o.powerMax <= 0) return toast('Puissance max à 0 : rien ne serait gravé', 'err');
  const width = Math.max(1, Math.round(o.width * o.resolution));
  const height = Math.max(1, Math.round(o.height * o.resolution));
  if (width * height > RASTER_MAX_POINTS) return toast(`Image trop grande à graver (${width} × ${height} points) : réduisez la taille ou la résolution.`, 'err');
  const button = $('#raster-go');
  const cancel = $('#raster-cancel');
  rasterGenerating = true;
  button.disabled = true;
  cancel.disabled = true;
  button.textContent = 'Génération…';
  let worker;
  let bitmap;
  let r;
  try {
    bitmap = await createImageBitmap(raster.img);
    r = await new Promise((resolve, reject) => {
      worker = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error('Le traitement en arrière-plan a échoué.'));
      };
      worker.postMessage({ bitmap, width, height, options: { ...o, firmware: prof().firmware, sMax: sMax() } }, [bitmap]);
      bitmap = null;
    });
  } catch (e) {
    toast(e.message, 'err');
    return;
  } finally {
    bitmap?.close();
    rasterGenerating = false;
    worker?.terminate();
    button.disabled = false;
    cancel.disabled = false;
    button.textContent = 'Générer et charger';
  }
  if (!r.rows) return toast('Rien à graver avec ces réglages (image blanche ?)', 'err');
  const name = `${raster.name || 'image'}-gravure.nc`;
  closeRaster();
  await act('load', { name, text: r.text })
    .then(() => toast(`${name} : ${r.lines} lignes. Vérifiez-le dans la vue (Dessus), puis faites le cadre.`, 'ok'))
    .catch(() => {});
};

// ---- Simulation avant usinage --------------------------------------------------

const preview = new Preview(viewer, { onFrame: renderPlaybar });
let scrubbing = false;

function renderPlaybar(st) {
  $('#pb-play').textContent = st.playing ? '⏸' : '▶';
  $('#pb-play').setAttribute('aria-label', st.playing ? 'Mettre en pause la simulation' : 'Lire la simulation');
  if (!scrubbing) $('#pb-scrub').value = st.total ? Math.round((st.t / st.total) * 1000) : 0;
  $('#pb-scrub').setAttribute('aria-valuetext', `${fmtClock(st.t)} sur ${fmtClock(st.total)}, ligne ${st.line + 1}`);
  $('#pb-time').textContent = `${fmtClock(st.t)} / ${fmtClock(st.total)}`;
  $('#pb-line').textContent = S.lines.length ? `L${st.line + 1}  ${S.lines[st.line]}` : '';
}
const fmtClock = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function openPreview() {
  if (!S.lines.length) return toast('Chargez d\'abord un programme', 'err');
  const jobActive = ['running', 'paused', 'spinup', 'finishing', 'stopping', 'toolchange'].includes(S.job?.state);
  if (jobActive) return toast('Simulation indisponible pendant un usinage', 'err');
  closeGoto();
  stopDraw();
  stopPlace();
  try {
    preview.open({ rapidRate: Number(S.settings[110]) || 3000, toolDia: Number($('#pb-tool').value) || 6 });
  } catch (e) { return toast(e.message, 'err'); }
  preview.speed = Number($('#pb-speed').value);
  preview.setShowStock($('#pb-stock').checked);
  $('#playbar').hidden = false;
  $('#btn-preview').classList.add('active');
  $('#btn-preview').textContent = '■ Simulation';
  if (!preview.cutBounds && !isLaser()) toast('Aucune passe sous Z0 : pas de matière à creuser', 'info');
  viewer.view('iso', { programOnly: true });
  preview.play();
}
function closePreview() {
  if (!preview.active) return;
  preview.close();
  $('#playbar').hidden = true;
  $('#btn-preview').classList.remove('active');
  $('#btn-preview').textContent = '▶ Simuler';
  renderJob();
}
$('#btn-preview').onclick = () => (preview.active ? closePreview() : openPreview());
$('#pb-close').onclick = closePreview;
$('#pb-play').onclick = () => (preview.playing ? preview.pause() : preview.play());
$('#pb-restart').onclick = () => preview.seek(0);
$('#pb-scrub').addEventListener('pointerdown', () => { scrubbing = true; });
$('#pb-scrub').addEventListener('input', (e) => preview.seekFraction(Number(e.target.value) / 1000));
$('#pb-scrub').addEventListener('change', () => { scrubbing = false; });
$('#pb-speed').value = String(store.get('pbSpeed', 5));
$('#pb-speed').onchange = (e) => { preview.speed = Number(e.target.value); store.set('pbSpeed', preview.speed); };
$('#pb-tool').value = store.get('pbTool', store.get('probe.corner', {}).toolDia ?? 6);
$('#pb-tool').onchange = (e) => {
  const d = Number(e.target.value);
  if (!(d > 0)) return;
  store.set('pbTool', d);
  preview.setToolDia(d);
};
$('#pb-stock').onchange = (e) => preview.setShowStock(e.target.checked);

// ---- Placer le programme sur le plateau ------------------------------------
// On glisse le parcours ; à la validation, l'origine X/Y est décalée d'autant
// (G10 L20 sur la position actuelle). Le fichier G-code ne change pas.

let placeDelta = null;
function canPlace() {
  const j = S.job;
  const jobActive = ['running', 'paused', 'spinup', 'finishing', 'stopping', 'toolchange'].includes(j?.state);
  return S.machine.ready && S.machine.status.state === 'Idle' && !jobActive;
}
function startPlace() {
  if (!S.lines.length) return toast('Chargez d\'abord un programme', 'err');
  if (!canPlace()) return toast('La machine doit être Prêt, sans usinage en cours', 'err');
  closePreview();
  closeGoto();
  stopDraw();
  placeDelta = null;
  $('#btn-place').classList.add('active');
  const hint = $('#viewer-hint');
  hint.classList.add('drawing');
  hint.textContent = 'Glissez le parcours pour le placer · clic droit = déplacer la vue · Échap pour annuler';
  if (S.zones.table || S.zones.zone) viewer.view('top');
  viewer.setPlaceMode({
    onMove: (d) => { placeDelta = d; showPlacePop(false); },
    onDrop: (d) => { placeDelta = d; showPlacePop(true); },
  });
}
function showPlacePop(final) {
  const d = placeDelta;
  $('#viewer-hint').textContent = `Décalage X ${fmtSigned(d.X)}  Y ${fmtSigned(d.Y)} mm`;
  const pop = $('#place-pop');
  pop.hidden = !final;
  if (!final) return;
  $('#place-delta').innerHTML = `<b>ΔX</b> ${fmtSigned(d.X)} &nbsp; <b>ΔY</b> ${fmtSigned(d.Y)} mm`;
  const fit = fitCheck(d);
  const el = $('#place-fit');
  el.textContent = fit ? fit.text.replace('avec le zéro actuel', 'à cette position') : '';
  el.className = `small ${fit ? (fit.ok ? 'fit-status ok' : 'fit-status bad') : ''}`;
  pop.style.left = '50%';
  pop.style.top = '64px';
  pop.style.transform = 'translateX(-50%)';
}
function stopPlace() {
  if (!$('#btn-place').classList.contains('active')) return;
  $('#btn-place').classList.remove('active');
  $('#place-pop').hidden = true;
  placeDelta = null;
  viewer.setPlaceMode(null);
  setHint();
}
const fmtSigned = (v) => `${v >= 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}`;
$('#btn-place').onclick = () => ($('#btn-place').classList.contains('active') ? stopPlace() : startPlace());
$('#place-cancel').onclick = stopPlace;
$('#place-apply').onclick = async () => {
  const d = placeDelta;
  if (!d || !canPlace()) return toast('La machine doit être Prêt', 'err');
  const fit = fitCheck(d);
  if (fit && !fit.ok && !confirm(`${fit.text.replace('avec le zéro actuel', 'à cette position')}\n\nPlacer quand même ?`)) return;
  // Le zéro se déplace de +d : la position actuelle vaut alors (travail - d).
  const w = S.machine.status.wpos;
  const x = Math.round((w.X - d.X) * 1000) / 1000, y = Math.round((w.Y - d.Y) * 1000) / 1000;
  await act('cmd', { line: `G10L20P0X${x}Y${y}` }).then(() => {
    toast(`Programme déplacé de X ${fmtSigned(d.X)} Y ${fmtSigned(d.Y)} mm (origine décalée)`, 'ok');
  }).catch(() => {});
  stopPlace();
};

// ---- Démo guidée -------------------------------------------------------------

const TOUR = [
  {
    title: 'Bienvenue dans Copeau',
    body: `<p>Copeau pilote une CNC <b>Grbl / grblHAL</b> depuis le navigateur.</p>
      <p>Cette démo présente l'écran en 13 étapes. Utilisez <kbd>→</kbd> / <kbd>←</kbd> ou les boutons. À la fin, vous pourrez tout essayer sur une <b>machine simulée</b>, sans risque.</p>
      <p class="muted">Gardez toujours l'arrêt d'urgence de la vraie machine à portée de main.</p>`,
  },
  {
    target: '.connect', title: 'Connexion',
    body: `<p>Choisissez le port USB de la carte (ou <b>Simulateur Grbl</b>), laissez <b>115200</b>, puis <b>Connecter</b>.</p>
      <p><b>↻</b> rafraîchit la liste si vous venez de brancher la machine.</p>`,
  },
  {
    target: '.machine-state', title: 'État de la machine',
    body: `<p>Le badge indique l'état : <b>Prêt</b>, <b>Usinage</b>, <b>Pause</b> ou <b>Alarme</b>.</p>
      <ul><li><b>Origine</b> : prise d'origine sur les fins de course (à faire au démarrage).</li>
      <li><b>Déverrouiller</b> : lève une alarme si la position est sûre.</li>
      <li><b>Reset</b> : réinitialise la carte (ce n'est pas un arrêt d'urgence).</li></ul>`,
  },
  {
    target: '.dro', title: 'Position et zéro',
    body: `<p>Les grands chiffres sont la <b>position travail</b>, la petite ligne <b>M</b> la position machine.</p>
      <p><b>X = 0</b>, <b>Y = 0</b>, <b>Z = 0</b> posent l'origine de la pièce là où est l'outil. <b>Cliquez sur un chiffre</b> pour taper une valeur précise (ex. épaisseur d'une cale).</p>`,
  },
  {
    target: '.jog', title: 'Déplacer la tête',
    body: `<p><b>Appui</b> = un pas de la taille choisie. <b>Appui maintenu</b> = le même pas répété (avec 1 : 1 mm, 1 mm, 1 mm…), arrêt immédiat au relâchement.</p>
      <p>Au clavier : <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> pour X/Y, <kbd>+</kbd><kbd>−</kbd> ou <kbd>PgUp</kbd><kbd>PgDn</kbd> pour Z, <kbd>Échap</kbd> pour arrêter.</p>`,
  },
  {
    target: '.viewer-wrap', title: 'Vue 3D et suivi en temps réel',
    body: `<p>Le parcours d'outil s'affiche en <b>bleu</b> (usinage) et <b>gris</b> (rapides). Le cône jaune est l'outil, mis à jour 5 fois par seconde.</p>
      <p>Pendant l'usinage, la partie faite passe en <b>orange</b> en direct.</p>
      <p>Glisser = tourner, molette = zoom. <b>Cliquez sur le plateau</b> pour y amener la tête.</p>`,
  },
  {
    target: '#btn-place', title: 'Placer le programme',
    body: `<p><b>Placer</b> permet de glisser le parcours sur le plateau. Copeau indique si la nouvelle position tient dans la zone, puis décale l'origine X/Y d'autant.</p>`,
  },
  {
    target: '#btn-preview', title: 'Simuler avant de lancer',
    body: `<p><b>▶ Simuler</b> joue l'usinage dans la vue : un outil vert suit le parcours à la vitesse du programme et <b>creuse la matière</b> au fur et à mesure.</p>
      <p>Barre de lecture : ▶ / ⏸ (ou <kbd>Espace</kbd>), curseur pour aller à n'importe quel moment, vitesse 1× à 100×, diamètre de fraise. Rien n'est envoyé à la machine.</p>`,
  },
  {
    target: '.job-bar', title: 'Programme',
    body: `<p><b>Ouvrir</b> ou glissez un fichier G-code sur la vue. Vous voyez la durée estimée et les dimensions.</p>
      <p><b>Démarrer</b>, <b>Pause</b> / <b>Reprendre</b>, <b>Arrêter</b> (arrêt propre, la position est conservée). La barre montre la progression et le temps restant.</p>`,
  },
  {
    target: '.overrides', title: 'Corrections en direct',
    body: `<p>Accélérez ou ralentissez l'<b>avance</b>, la <b>broche</b> et les <b>rapides</b> pendant l'usinage, sans toucher au fichier.</p>`,
  },
  {
    target: '.panel.right', title: 'Palpage', before: () => showTab('probe'),
    body: `<p>Avec une sonde (pince sur l'outil + plaque), Copeau trouve l'origine tout seul : <b>Z</b> sur le dessus, un <b>coin XYZ</b>, ou le <b>centre d'un trou</b>.</p>`,
  },
  {
    target: '.panel.right', title: 'Plateau et zone de travail', before: () => showTab('zones'),
    body: `<p>Définissez le <b>plateau</b> et la <b>zone de travail</b> (rectangle par 2 coins, ou cercle) : en capturant la position de l'outil, en traçant sur la vue, ou en tapant les valeurs.</p>
      <p>Copeau vérifie que le programme tient dedans et peut <b>parcourir le contour</b>.</p>`,
  },
  {
    target: '.panel.right', title: 'Reprise, console, macros', before: () => showTab('resume'),
    body: `<p><b>Reprise</b> : relance un usinage interrompu à une ligne choisie (ou en cliquant sur le parcours).</p>
      <p><b>Console</b> pour les commandes, <b>Macros</b> pour vos séquences favorites, <b>Réglages</b> pour les paramètres $ de la carte.</p>`,
  },
  {
    target: '.help', title: 'À vous de jouer', before: () => showTab('console'),
    body: `<p>Le bouton <b>?</b> relance cette démo, <b>Manuel</b> ouvre le mode d'emploi complet.</p>
      <p>Pour essayer maintenant : Copeau connecte la machine simulée, fait l'origine, pose le zéro sur une pièce virtuelle et charge un programme de démonstration.</p>`,
    actions: [{ label: 'Essayer avec le simulateur', primary: true, run: () => tryDemo() }],
  },
];

function runTour(start = 0) {
  closeGoto();
  stopDraw();
  stopPlace();
  startTour(TOUR, { start, onClose: () => store.set('tourDone', true) });
}
$('#btn-tour').onclick = () => runTour();

async function waitUntil(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('La machine simulée ne répond pas');
}

// Installe une séance d'essai sur le simulateur. Ne touche jamais une vraie machine.
async function tryDemo() {
  try {
    const m = S.machine;
    if (m.connected && m.port !== 'simulateur') {
      return toast('Une vraie machine est connectée : déconnectez-la pour essayer le simulateur.', 'err');
    }
    if (['running', 'paused', 'spinup', 'toolchange', 'finishing'].includes(S.job?.state)) return toast('Un usinage est en cours', 'err');
    toast('Préparation de la démo…');
    if (!m.connected) {
      $('#port').value = 'simulateur';
      await request('connect', { port: 'simulateur' });
    }
    await waitUntil(() => S.machine.ready);
    if (S.machine.status.state === 'Alarm') {
      await request('cmd', { line: '$H' });
      await waitUntil(() => S.machine.status.state === 'Idle', 30000);
    }
    if (isLaser()) return laserDemo();
    // Zéro sur le coin avant gauche de la pièce virtuelle, dessus à Z −50 machine,
    // avec 10 mm de marge.
    await request('cmd', { line: 'G10L2P1X-210Y-190Z-50\nG90G0Z5\n$#\n$G' });
    const text = await fetch('/demo/copeau-demo.nc').then((r) => r.text());
    await request('load', { name: 'copeau-demo.nc', text });
    if (!S.zones.zone && !S.zones.table) {
      await request('setConfig', { key: 'zones', value: {
        table: { kind: 'rect', a: { X: -1, Y: -1 }, b: { X: -300, Y: -300 } },
        zone: { kind: 'rect', a: { X: -220, Y: -200 }, b: { X: -120, Y: -100 } },
      } });
    }
    showTab('zones');
    toast('Démo prête : cliquez sur Démarrer pour lancer l\'usinage simulé', 'ok');
    const run = $('#btn-run');
    run.classList.remove('pulse');
    void run.offsetWidth;
    run.classList.add('pulse');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Démo laser : un disque dégradé de 40 mm gravé en niveaux de gris, généré ici
// par le même code que « Image… ».
async function laserDemo() {
  await request('cmd', { line: 'G10L20P0X0Y0Z0\n$#\n$G' });
  const n = 200, gray = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const ring = Math.abs(Math.sin(r * Math.PI * 3)) > 0.97;
      gray[y * n + x] = r > 1 ? 255 : ring ? 0 : Math.round(255 * r);
    }
  }
  const r = rasterGcode({ gray, width: n, height: n }, { resolution: 5, speed: 3000, powerMin: 5, powerMax: 60, firmware: prof().firmware, sMax: sMax() });
  await request('load', { name: 'copeau-laser-demo.nc', text: r.text });
  viewer.view('top');
  toast('Démo laser prête : faites le cadre, puis Démarrer (gravure simulée)', 'ok');
  const run = $('#btn-run');
  run.classList.remove('pulse');
  void run.offsetWidth;
  run.classList.add('pulse');
}

// ---- Macros ----------------------------------------------------------------

let editingMacro = null;
async function loadMacros() {
  S.macros = await request('macros').catch(() => []);
  renderMacros();
}
function renderMacros() {
  $('#macro-list').innerHTML = S.macros.map((m) => `
    <div class="macro" data-id="${escapeHtml(m.id)}">
      <span title="${escapeHtml(m.gcode)}">${escapeHtml(m.name)}</span>
      <button class="primary small" data-macro-run>Lancer</button>
      <button class="ghost small" data-macro-edit>Modifier</button>
      <button class="ghost small" data-macro-del aria-label="Supprimer la macro ${escapeHtml(m.name)}" title="Supprimer">✕</button>
    </div>`).join('') || '<p class="muted">Aucune macro.</p>';
  updateEnabled();
}
$('#macro-list').onclick = async (e) => {
  const row = e.target.closest('.macro');
  if (!row) return;
  const m = S.macros.find((x) => x.id === row.dataset.id);
  if (e.target.closest('[data-macro-run]')) act('runMacro', { id: m.id }).catch(() => {});
  if (e.target.closest('[data-macro-edit]')) {
    editingMacro = m.id;
    $('#macro-name').value = m.name;
    $('#macro-gcode').value = m.gcode;
    $('.macro-edit').open = true;
  }
  if (e.target.closest('[data-macro-del]') && confirm(`Supprimer « ${m.name} » ?`)) {
    act('saveMacros', { list: S.macros.filter((x) => x.id !== m.id) }).catch(() => {});
  }
};
$('#btn-macro-new').onclick = () => { editingMacro = null; $('#macro-name').value = ''; $('#macro-gcode').value = ''; };
$('#btn-macro-save').onclick = () => {
  const name = $('#macro-name').value.trim();
  const gcode = $('#macro-gcode').value.trim();
  if (!name || !gcode) return toast('Nom et G-code requis', 'err');
  const list = editingMacro
    ? S.macros.map((m) => (m.id === editingMacro ? { ...m, name, gcode } : m))
    : [...S.macros, { id: `m${Date.now().toString(36)}`, name, gcode }];
  act('saveMacros', { list }).then(() => { toast('Macro enregistrée', 'ok'); $('#btn-macro-new').click(); }).catch(() => {});
};

// ---- Réglages Grbl -----------------------------------------------------------

const SETTING_NAMES = {
  0: 'Durée impulsion de pas (µs)', 1: 'Délai avant mise en veille moteurs (ms)', 2: 'Inversion impulsion de pas (masque)',
  3: 'Inversion direction (masque)', 4: 'Inversion activation moteurs', 5: 'Inversion fins de course', 6: 'Inversion sonde',
  10: 'Contenu du rapport d\'état (masque)', 11: 'Écart de jonction (mm)', 12: 'Tolérance des arcs (mm)', 13: 'Rapport en pouces',
  20: 'Limites logicielles', 21: 'Limites matérielles', 22: 'Prise d\'origine activée', 23: 'Sens de prise d\'origine (masque)',
  24: 'Avance fine prise d\'origine (mm/min)', 25: 'Recherche prise d\'origine (mm/min)', 26: 'Anti-rebond fins de course (ms)',
  27: 'Dégagement après origine (mm)', 30: 'Vitesse broche max (tr/min)', 31: 'Vitesse broche min (tr/min)', 32: 'Mode laser',
  100: 'Pas/mm X', 101: 'Pas/mm Y', 102: 'Pas/mm Z', 110: 'Vitesse max X (mm/min)', 111: 'Vitesse max Y (mm/min)',
  112: 'Vitesse max Z (mm/min)', 120: 'Accélération X (mm/s²)', 121: 'Accélération Y (mm/s²)', 122: 'Accélération Z (mm/s²)',
  130: 'Course max X (mm)', 131: 'Course max Y (mm)', 132: 'Course max Z (mm)',
};

function renderSettings() {
  const keys = Object.keys(S.settings).sort((a, b) => a - b);
  const list = $('#settings-list');
  if (isSmoothie()) {
    list.innerHTML = `<p class="muted">Smoothieware (Emblaser 2) n'a pas de réglages <code>$$</code> : ils sont dans le fichier <code>config</code> de la carte SD de la machine (vitesses, accélérations, <code>laser_module_maximum_s_value</code>…).</p>
      <p class="muted">Lecture d'un réglage depuis la console : <code>config-get sd laser_module_maximum_s_value</code>. Copeau ne modifie pas ce fichier.</p>`;
    return;
  }
  if (!keys.length) { list.innerHTML = '<p class="muted">Connectez une machine pour lire ses réglages ($$).</p>'; return; }
  if (list.contains(document.activeElement)) return; // ne pas écraser une saisie en cours
  list.innerHTML = keys.map((k) => `
    <div class="setting" data-k="${k}">
      <code>$${k}</code><span>${SETTING_NAMES[k] || 'Réglage'}</span>
      <input value="${escapeHtml(S.settings[k])}" data-orig="${escapeHtml(S.settings[k])}" aria-label="$${k} ${SETTING_NAMES[k] || 'Réglage'}">
    </div>`).join('');
  filterSettings();
}
function filterSettings() {
  const q = $('#settings-filter').value.toLowerCase();
  $$('.setting').forEach((r) => (r.hidden = q && !r.textContent.toLowerCase().includes(q) && !`$${r.dataset.k}`.includes(q)));
}
$('#settings-filter').oninput = filterSettings;
$('#settings-list').addEventListener('input', (e) => e.target.classList.toggle('dirty', e.target.value !== e.target.dataset.orig));
$('#settings-list').addEventListener('change', async (e) => {
  const input = e.target;
  const k = input.closest('.setting').dataset.k;
  if (input.value === input.dataset.orig) return;
  if (!confirm(`Écrire $${k}=${input.value} dans la carte ?`)) { input.value = input.dataset.orig; input.classList.remove('dirty'); return; }
  await act('cmd', { line: `$${k}=${input.value}\n$$` }).catch(() => {});
  input.blur();
});


// ---- Bulles d'aide « i » -------------------------------------------------------

const INFO = {
  connect: { title: 'Connexion', html: `<p><b>Port</b> : la carte apparaît comme <code>/dev/cu.usbserial…</code> ou <code>/dev/cu.usbmodem…</code> sur Mac, <code>COM3</code>… sur Windows. <b>Simulateur</b> = machine virtuelle, sans risque.</p>
    <p><b>Type de machine</b> (premier menu) : <b>CNC Grbl</b>, <b>Laser Grbl</b> ($32=1) ou <b>Emblaser 2</b> (firmware Smoothieware). Il change les commandes envoyées et l'écran.</p>
    <p><b>Réseau</b> : pour une machine en Wi-Fi ou Ethernet (Emblaser 2 en Wi-Fi, grblHAL…), tapez son adresse IP, éventuellement suivie du port (<code>192.168.1.50:23</code>).</p>
    <p><b>Vitesse</b> : 115200 pour Grbl standard. Si rien ne répond, essayez 250000. Inutile pour l'Emblaser 2.</p>
    <p>Un seul logiciel peut utiliser le port : fermez UGS, Candle, CNCjs, LightBurn ou LaserGRBL.</p>` },
  laser: { title: 'Laser', html: `<p>Puissance laser en direct (% de la puissance max). Le laser ne tire que pendant les mouvements de gravure (G1) : jamais pendant les déplacements ni les jogs.</p>
    <p>Avant chaque gravure : <b>couvercle fermé</b>, lunettes adaptées, aspiration en marche, et toujours quelqu'un à côté de la machine.</p>
    <p>La correction <b>Puissance</b> (−10 / +10) agit pendant la gravure, sans modifier le fichier.</p>` },
  pointer: { title: 'Tir de repérage', html: `<p>Allume le laser à très faible puissance, tête immobile, pour voir le point et placer l'origine. 1 % suffit en général ; au-delà de 5 % il marque la matière.</p>
    <p>Il s'éteint au second clic, au bout de 60 s, si l'écran se déconnecte, et au démarrage interdit d'une gravure.</p>
    <p>Grbl l'éteint pendant un jog : rallumez-le une fois la tête arrêtée. L'Emblaser 2 le garde allumé.</p>` },
  frame: { title: 'Cadre du programme', html: `<p>La tête fait le tour du rectangle qui contient le programme, à la hauteur actuelle, <b>laser éteint</b>, pour vérifier qu'il tombe bien sur la matière.</p>
    <p>Emblaser 2 : cochez <b>pointeur allumé</b> pour voir le trajet sur la matière (puissance du tir de repérage). <kbd>Échap</kbd> arrête.</p>` },
  smax: { title: 'S max', html: `<p>Valeur de <code>S</code> qui correspond à 100 % de puissance dans le G-code.</p>
    <p><b>Grbl</b> : <code>$30</code> de la carte (souvent 1000). <b>Emblaser 2 / Smoothieware</b> : <code>laser_module_maximum_s_value</code> du fichier config, 1 par défaut (S0.5 = 50 %).</p>
    <p>Elle doit être la même que dans LightBurn ou LaserGRBL si vous y préparez vos fichiers. Elle sert à la gravure d'image, au tir de repérage et aux couleurs de la vue.</p>` },
  image: { title: 'Graver une image', html: `<p>Comme LaserGRBL : l'image est balayée ligne par ligne, aller-retour. Un point = un pas de 1 / résolution mm.</p>
    <p><b>Niveaux de gris</b> : la puissance suit la teinte (photos). <b>Noir et blanc</b> : tout ou rien selon le seuil (logos, textes). <b>Tramage</b> : points tout ou rien qui imitent les gris (photos sur bois clair).</p>
    <p>L'image commence à X0 Y0 (coin bas gauche ou centre). Faites un essai sur une chute pour trouver vitesse et puissance.</p>` },
  rResolution: { html: `<p>Nombre de lignes par millimètre. 10 (0,1 mm) convient à une diode de 5 W ; au-delà, les lignes se chevauchent et la gravure fonce sans gagner en détail.</p>` },
  rPower: { html: `<p>En niveaux de gris, le blanc n'est pas gravé et le gris le plus clair commence à la puissance <b>min</b> ; le noir est gravé à la puissance <b>max</b>.</p>` },
  rOverscan: { html: `<p>La tête démarre un peu avant chaque ligne, laser éteint, pour être à pleine vitesse quand elle commence à graver : les bords ne brûlent pas plus que le reste. Elle peut sortir de l'image de cette distance.</p>` },
  state: { title: 'Origine, déverrouillage, reset', html: `<p><b>Origine ($H)</b> : la machine va chercher ses fins de course, sa position devient exacte. À faire à chaque mise sous tension.</p>
    <p><b>Déverrouiller ($X)</b> : lève l'alarme sans bouger. Seulement si vous êtes sûr de la position.</p>
    <p><b>Reset</b> vide la mémoire de la carte. Ce n'est <b>pas</b> un arrêt d'urgence.</p>` },
  dro: { title: 'Position travail et machine', html: `<p><b>Grands chiffres</b> : position par rapport au zéro de la pièce (G54). C'est le repère du programme.</p>
    <p><b>Ligne M</b> : position machine, par rapport aux fins de course. Elle ne change pas quand on refait le zéro.</p>
    <p><b>X = 0</b> pose le zéro à la position actuelle. <b>Cliquez un chiffre</b> pour taper une valeur, par exemple 20 si l'outil est posé sur une cale de 20 mm. Le zéro reste mémorisé dans la carte.</p>` },
  jog: { title: 'Déplacer la tête', html: `<p><b>Appui</b> : un pas de la taille choisie. <b>Appui maintenu</b> : le même pas répété (avec 10 : 10 mm, 10 mm, 10 mm…). Au relâchement, la tête s'arrête aussitôt.</p>
    <p><b>■</b> ou <kbd>Échap</kbd> arrêtent tout de suite.</p>
    <p>Clavier : <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> X/Y, <kbd>+</kbd><kbd>−</kbd> ou <kbd>PgUp</kbd><kbd>PgDn</kbd> Z, <kbd>Échap</kbd> stop.</p>
    <p>Bloqué en alarme et pendant l'usinage. Si l'écran perd la connexion, le mouvement s'arrête.</p>` },
  jogFeed: { title: 'Vitesse jog', html: `<p>Vitesse des déplacements manuels, en mm/min. 2000 convient en général ; réduisez près de la pièce.</p><p>Grbl la plafonne à la vitesse max de chaque axe ($110 à $112).</p>` },
  overrides: { title: 'Corrections en direct', html: `<p>Agissent tout de suite, même pendant l'usinage, <b>sans modifier le fichier</b>.</p>
    <p><b>Avance</b> et <b>broche</b> : 10 à 200 %. <b>Rapide</b> : 25, 50 ou 100 %.</p>
    <p>Utile pour ralentir une passe qui vibre. Un reset remet tout à 100 %.</p>` },
  viewer: { title: 'Vue 3D', html: `<p>Glisser : tourner. Clic droit ou deux doigts : déplacer. Molette ou pincement : zoom.</p>
    <p><b>Bleu</b> usinage, <b>gris</b> rapides, <b>orange</b> déjà usiné, <b>vert</b> simulé. Cône jaune = outil réel.</p>
    <p><b>Clic sur le plateau</b> : y amener la tête. <b>Placer</b> : glisser le programme (décale l'origine). <b>Simuler</b> : voir l'usinage avant de lancer.</p>` },
  gotoLift: { title: 'Monter avant de traverser', html: `<p>Remonte d'abord à la hauteur de survol (onglet Zone), pour ne pas traverser la pièce ou une bride en ligne droite.</p>` },
  sim: { title: 'Simulation', html: `<p>Tout se passe dans le navigateur : <b>rien n'est envoyé à la machine</b>.</p>
    <p>Suppose une fraise droite du Ø indiqué et un dessus de pièce à Z0. Les accélérations ne sont pas simulées : la durée réelle sera un peu plus longue.</p>
    <p><kbd>Espace</kbd> : lecture / pause. Le curseur va en avant comme en arrière.</p>` },
  pauseSpindle: { title: 'Broche pendant la pause', html: `<p>Cochée, la broche s'arrête à chaque <b>Pause</b>, dès que le mouvement est complètement arrêté. Sinon, le bouton <b>⏻ Couper la broche</b> apparaît pendant la pause.</p>
    <p>À la <b>reprise</b>, Copeau rallume la broche, attend sa montée en vitesse (réglage <i>Attente broche</i> de l'onglet Reprise, 3 s par défaut), puis seulement reprend le mouvement.</p>
    <p>Pratique pour dégager un copeau ou vérifier une passe. Ne remplace pas l'arrêt d'urgence.</p>` },
  job: { title: 'Programme', html: `<p><b>Durée estimée</b> d'après les avances du fichier ; la durée réelle est un peu plus longue.</p>
    <p><b>Pause</b> : arrêt immédiat du mouvement. <b>Arrêter</b> : ralentit puis vide la carte, la position est conservée.</p>
    <p>Une erreur de la carte met le job en pause au lieu de continuer.</p>` },
  console: { title: 'Console', html: `<p>Envoie n'importe quelle commande G-code ou $. <kbd>↑</kbd><kbd>↓</kbd> : historique.</p>
    <p><code>$$</code> réglages, <code>$G</code> modes actifs, <code>$#</code> origines, <code>$I</code> version.</p><p>Orange = envoyé, bleu = info, rouge = erreur.</p>` },
  resume: { title: 'Numéro de ligne', html: `<p>Les numéros comptent <b>seulement les lignes envoyées</b> (sans commentaires ni lignes vides) : ils peuvent différer de votre éditeur. Fiez-vous au code affiché.</p>
    <p>Choisissez une ligne un peu avant l'arrêt. Le préambule rétablit les modes, relance la broche, monte au Z le plus haut déjà utilisé puis replonge lentement.</p>` },
  spinup: { title: 'Attente broche', html: `<p>Temps laissé à la broche pour atteindre sa vitesse avant de replonger. 3 s pour une petite broche, 5 à 10 s pour une grosse broche avec variateur.</p>` },
  probe: { title: 'La sonde', html: `<p>Une pince sur l'outil et une plaque (ou la pièce si elle est conductrice) reliée à l'entrée sonde de la carte.</p>
    <p><b>Testez avant</b> : touchez la plaque avec la pince, puis envoyez <code>?</code> dans la console : l'état doit contenir <code>Pn:P</code>.</p>
    <p>Sans contact : alarme 5. Déverrouillez, rapprochez l'outil et recommencez.</p>` },
  'pf-plate': { html: `<p>Épaisseur de la plaque posée sur la pièce. <b>0</b> si l'outil touche directement la pièce.</p>` },
  'pf-travel': { html: `<p>Distance maximale d'approche. Sans contact sur cette distance : arrêt et alarme 5.</p>` },
  'pf-fastFeed': { html: `<p>Première approche, rapide. Restez modéré (100 à 200 mm/min) pour ne pas abîmer l'outil ou la plaque.</p>` },
  'pf-slowFeed': { html: `<p>Seconde approche, lente : c'est elle qui fait la mesure. Plus lent = plus précis.</p>` },
  'pf-retract': { html: `<p>Remontée de l'outil à la fin du palpage.</p>` },
  'pf-toolDia': { html: `<p>Diamètre <b>réel</b> de l'outil, mesuré au pied à coulisse : il sert à corriger X et Y du rayon.</p>` },
  'pf-wall': { html: `<p>Avec une cale d'angle : épaisseur de sa paroi entre l'outil et la pièce. <b>0</b> si l'outil touche directement les flancs.</p>` },
  'pf-inset': { html: `<p>Distance approximative entre l'outil et chaque bord du coin au départ. L'outil sortira de cette distance + son rayon + 5 mm avant de redescendre.</p>` },
  'pf-depth': { html: `<p>Profondeur sous le dessus de la pièce à laquelle les flancs X et Y sont palpés.</p>` },
  'pf-paper': { html: `<p>Épaisseur de ce que vous glissez sous l'outil : une feuille de papier ordinaire fait environ <b>0,1 mm</b>. Avec une cale étalon, son épaisseur exacte. Copeau la retranche pour que le zéro soit sur la pièce.</p>` },
  'pf-mstep': { html: `<p>Distance de chaque clic d'approche. Approchez en 0,5 ou 1 mm, puis finissez en <b>0,01</b> quand la feuille commence à frotter.</p><p>Les touches <kbd>+</kbd> / <kbd>−</kbd> et les flèches marchent aussi, avec le pas du jog.</p>` },
  'pf-maxRadius': { html: `<p>Rayon maximal attendu du trou : course de palpage dans chaque direction depuis le départ.</p>` },
  table: { title: 'Plateau · course machine', html: `<p>La <b>taille de travail maximale</b> de la CNC : la course de chaque axe, X × Y × Z.</p>
    <p>Elle est dessinée en 3D. Copeau vérifie que le programme ne sort pas de cette course (y compris en Z) et refuse un « Aller ici » en dehors.</p>
    <p>Mémorisée en coordonnées machine : elle ne bouge pas quand vous refaites le zéro.</p>` },
  anchor: { title: 'Ancrage', html: `<p><b>Origine machine</b> : Grbl standard. Après une prise d'origine, la machine travaille de 0 vers les X, Y et Z négatifs. C'est le bon choix si votre machine a des fins de course.</p>
    <p><b>Coin 1 fixe</b> : redimensionne le rectangle sans déplacer son coin 1.</p>
    <p><b>Outil = coin avant gauche</b> : pour une machine sans prise d'origine, amenez l'outil au coin avant gauche puis appliquez.</p>` },
  writeGrbl: { title: 'Écrire dans la carte', html: `<p>Enregistre la course dans Grbl : <code>$130</code> (X), <code>$131</code> (Y), <code>$132</code> (Z).</p>
    <p>Grbl s'en sert pour les <b>limites logicielles</b> ($20=1) et la prise d'origine. Une course trop grande peut envoyer la machine en butée : mesurez-la.</p>
    <p>Copeau demande confirmation avant d'écrire.</p>` },
  zone: { title: 'Zone de travail', html: `<p>L'emplacement de la <b>pièce</b> sur le plateau : rectangle (2 coins opposés) ou cercle (centre + un point du bord).</p>
    <p>Copeau vérifie que le programme tient dedans. <b>Parcourir le contour</b> fait le tour à la hauteur de survol : pratique pour vérifier le bridage.</p>` },
  fit: { title: 'Vérification', html: `<p>Compare le cadre du programme (avec le zéro actuel) au plateau, à la course Z et à la zone de travail.</p>
    <p>Rouge : le programme dépasse. Copeau demandera confirmation au démarrage.</p>` },
  origin: { title: 'Revenir à l\'origine', html: `<p>Le petit <b>⌂</b> de chaque ligne X, Y ou Z ramène <b>seulement cet axe</b> à 0, les autres ne bougent pas. Z descend lentement vers Z0 ; X et Y se déplacent à la hauteur actuelle (confirmation demandée si l'outil est sous Z0).</p>`
    + `<p><b>⌂ Origine</b> ramène l'outil exactement au zéro établi : il monte d'abord à la hauteur de survol (onglet Zone) s'il est plus bas, rejoint X0 Y0, puis <b>descend lentement jusqu'à Z0</b> (300 mm/min au plus).</p>
    <p><b>→ X0 Y0</b> s'arrête au-dessus de l'origine, à la hauteur de survol, sans descendre.</p>
    <p>Pratique pour vérifier un zéro avant de lancer. <kbd>Échap</kbd> ou ■ arrête le mouvement.</p>` },
  safeZ: { title: 'Hauteur de survol', html: `<p>Hauteur (Z travail) à laquelle la tête monte avant « Aller ici » et les parcours de contour. Elle doit dépasser les brides et la pièce.</p>` },
  macros: { title: 'Macros', html: `<p>Une commande par ligne (G-code ou $), exécutées dans l'ordre comme si vous les tapiez dans la console.</p>
    <p>Enregistrées sur l'ordinateur qui fait tourner Copeau (<code>data/macros.json</code>).</p>` },
  settings: { title: 'Réglages de la carte', html: `<p>Paramètres enregistrés dans Grbl. Une mauvaise valeur peut inverser un moteur ou envoyer un axe en butée : <b>notez l'ancienne valeur</b> avant de changer.</p>
    <p>Copeau demande confirmation à chaque écriture.</p>` },
};
initInfo(INFO);

// ---- Utilitaires -------------------------------------------------------------

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : m ? `${m} min ${String(s).padStart(2, '0')}` : `${s} s`;
}
function fmtNum(n) { return (Math.round(n * 10) / 10).toString(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

applyProfile();
renderMachine();
setServerControlLock(true);
connectWs();
const tourParam = new URLSearchParams(location.search).get('tour');
if (tourParam !== null) setTimeout(() => runTour(Math.max(0, Number(tourParam) || 0)), 600);
else if (!store.get('tourDone', false)) setTimeout(() => runTour(), 600);
