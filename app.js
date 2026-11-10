// Letters to Abba — a private, offline prayer journal.
// Everything is encrypted on this device with the Web Crypto API (AES-256-GCM).
// Nothing is ever sent to a server.
import { DAILY, BY_CATEGORY } from './verses.js';

/* ======================= Settings you may edit ======================= */
// Add verified helpline numbers for your country here, e.g.
// { name: 'Name of service', phone: '000 000', note: 'Free, 24 hours' }
const HELPLINES = [];
const CATEGORIES = ['Family', 'Health', 'Work & Career', 'Finances', 'Guidance', 'Relationships', 'Thanksgiving', 'Others', 'Myself'];
const PBKDF2_ITER = 310000;
const BACKUP_REMINDER_DAYS = 30;
/* ===================================================================== */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const STATUS = {
  waiting: 'Still waiting', answered: 'Answered', different: 'Answered differently', surrendered: 'Surrendered'
};

let db = null, keys = null, dek = null, letters = [], prefs = {};
let editingId = null, statusTarget = null, lockMode = 'pass';
let lastActive = Date.now(), hiddenAt = 0, draftTimer = null;

/* ------------------------------ helpers ------------------------------ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayNum = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const daysBetween = (a, b) => (a && b ? Math.max(0, Math.round(dayNum(b) - dayNum(a))) : 0);
const fmt = (iso) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const after = (l) => { const n = daysBetween(l.dateWritten, l.statusDate); return n ? `after ${plural(n, 'day')}` : 'the same day'; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2800); }
function showErr(el, msg) { el.textContent = msg; el.classList.toggle('hidden', !msg); }
function show(view) { ['#view-setup', '#view-lock', '#view-app'].forEach((v) => $(v).classList.toggle('hidden', v !== view)); }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/* ------------------------------ storage ------------------------------ */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('letters-to-abba', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('letters', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(store, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode); const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}
const metaGet = (k) => req('meta', 'readonly', (s) => s.get(k));
const metaPut = (k, v) => req('meta', 'readwrite', (s) => s.put(v, k));
const metaDel = (k) => req('meta', 'readwrite', (s) => s.delete(k));
const recAll = () => req('letters', 'readonly', (s) => s.getAll());
const recPut = (v) => req('letters', 'readwrite', (s) => s.put(v));
const recDel = (id) => req('letters', 'readwrite', (s) => s.delete(id));

function loadPrefs() {
  try { prefs = JSON.parse(localStorage.getItem('abba-prefs') || '{}'); } catch { prefs = {}; }
  prefs = { theme: 'light', size: 'm', autoLock: 5, ...prefs };
}
function savePrefs() { try { localStorage.setItem('abba-prefs', JSON.stringify(prefs)); } catch {} }
function applyPrefs() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.size = prefs.size;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0b1730' : '#123a75';
}

/* ------------------------------ crypto ------------------------------- */
async function deriveKEK(secret, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
async function wrapWith(secret) {
  const salt = rand(16), iv = rand(12);
  const kek = await deriveKEK(secret, salt, PBKDF2_ITER);
  const w = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { salt: b64(salt), iv: b64(iv), w: b64(w), iter: PBKDF2_ITER };
}
async function unwrapWith(slot, secret) {
  const kek = await deriveKEK(secret, unb64(slot.salt), slot.iter || PBKDF2_ITER);
  return crypto.subtle.unwrapKey('raw', unb64(slot.w), kek, { name: 'AES-GCM', iv: unb64(slot.iv) },
    { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
async function sealObj(obj, key = dek) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function openObj(rec, key = dek) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
  return JSON.parse(dec.decode(pt));
}
const RK_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRecoveryKey() { return [...rand(24)].map((b) => RK_ALPHA[b & 31]).join('').match(/.{4}/g).join('-'); }
const normRK = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
// Try a passphrase first, then treat the text as a recovery key.
async function unlockKeys(k, secret) {
  try { return { key: await unwrapWith(k.p, secret), via: 'pass' }; } catch {}
  const rk = normRK(secret);
  if (rk.length === 24) { try { return { key: await unwrapWith(k.r, rk), via: 'recovery' }; } catch {} }
  return null;
}

/* ------------------------------ letters ------------------------------ */
async function loadLetters() {
  const recs = await recAll(); const out = [];
  for (const r of recs) { try { out.push({ id: r.id, ...(await openObj(r)) }); } catch { /* unreadable record: skip */ } }
  letters = out;
}
async function saveLetter(l) {
  const { id, ...data } = l;
  await recPut({ id, ...(await sealObj(data)) });
  const i = letters.findIndex((x) => x.id === id);
  if (i >= 0) letters[i] = l; else letters.push(l);
}

/* ------------------------------ setup -------------------------------- */
function strength(p) {
  let s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p) || /\s/.test(p)) s++;
  return Math.min(s, 5);
}
$('#pass1').addEventListener('input', (e) => {
  const s = strength(e.target.value);
  $('#meterBar').style.width = (s / 5 * 100) + '%';
  $('#meterText').textContent = e.target.value.length < 8 ? 'At least 8 characters' : ['Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'][s];
});
$('#setupStart').onclick = () => { $('#setup1').classList.add('hidden'); $('#setup2').classList.remove('hidden'); $('#pass1').focus(); };
$('#setupBack').onclick = () => { $('#setup2').classList.add('hidden'); $('#setup1').classList.remove('hidden'); };
$('#setupRestore').onclick = () => $('#restoreFile').click();
let pendingRK = null;
$('#setup2').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('#pass1').value, p2 = $('#pass2').value;
  if (p1.length < 8) return showErr($('#setupErr'), 'Please use at least 8 characters.');
  if (p1 !== p2) return showErr($('#setupErr'), "The two passphrases don't match.");
  showErr($('#setupErr'), ''); $('#setupNext').disabled = true; $('#setupNext').textContent = 'Securing…';
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  pendingRK = makeRecoveryKey();
  keys = { v: 1, p: await wrapWith(p1), r: await wrapWith(normRK(pendingRK)) };
  await metaPut('keys', keys);
  $('#pass1').value = $('#pass2').value = '';
  $('#recoveryKey').textContent = pendingRK;
  $('#setup2').classList.add('hidden'); $('#setup3').classList.remove('hidden');
});
$('#savedKey').onchange = (e) => { $('#setupFinish').disabled = !e.target.checked; };
$('#copyRecovery').onclick = () => copyText(pendingRK);
$('#copyRecovery2').onclick = () => copyText($('#recoveryKey2').textContent);
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Select the key and copy it by hand'); } }
$('#setupFinish').onclick = async () => { pendingRK = null; $('#recoveryKey').textContent = ''; letters = []; await enterApp(); requestPersist(); };

/* ------------------------------ lock --------------------------------- */
function setLockMode(m) {
  lockMode = m;
  $('#lockLabel').textContent = m === 'pass' ? 'Passphrase' : 'Recovery key';
  $('#lockPass').type = m === 'pass' ? 'password' : 'text';
  $('#lockPass').placeholder = m === 'pass' ? '' : 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX';
  $('#useRecovery').textContent = m === 'pass' ? 'Forgot passphrase? Use recovery key' : 'Use my passphrase instead';
  showErr($('#lockErr'), ''); $('#lockPass').value = ''; $('#lockPass').focus();
}
$('#useRecovery').onclick = () => setLockMode(lockMode === 'pass' ? 'recovery' : 'pass');
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = $('#lockPass').value; if (!secret) return;
  $('#unlockBtn').disabled = true; $('#unlockBtn').textContent = 'Unlocking…';
  let key = null;
  try { key = lockMode === 'pass' ? await unwrapWith(keys.p, secret) : await unwrapWith(keys.r, normRK(secret)); } catch {}
  $('#unlockBtn').disabled = false; $('#unlockBtn').textContent = 'Unlock';
  if (!key) return showErr($('#lockErr'), lockMode === 'pass' ? "That passphrase didn't work. Please try again." : "That recovery key didn't work. Check each character.");
  $('#lockPass').value = ''; dek = key;
  await loadLetters(); await enterApp();
  if (lockMode === 'recovery') { setLockMode('pass'); openPassDialog('reset'); }
});
function lock() {
  if ($('#dlgWrite').open) saveDraft(true);
  dek = null; letters = []; editingId = null;
  $$('dialog[open]').forEach((d) => d.close());
  $('#list').innerHTML = ''; $('#timeline').innerHTML = ''; $('#onThisDay').innerHTML = '';
  setLockMode('pass'); show('#view-lock');
}
$('#lockBtn').onclick = lock;
['pointerdown', 'keydown', 'input', 'scroll', 'touchstart'].forEach((ev) => addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
setInterval(() => { if (dek && Date.now() - lastActive > prefs.autoLock * 60000) lock(); }, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (dek && hiddenAt && Date.now() - hiddenAt > 60000) lock();
});

/* ------------------------------ main app ----------------------------- */
async function enterApp() {
  show('#view-app'); switchTab('letters'); renderAll(); refreshBanner(); lastActive = Date.now();
}
function switchTab(t) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ['letters', 'timeline', 'settings'].forEach((x) => $('#tab-' + x).classList.toggle('hidden', x !== t));
  if (t === 'settings') renderSettings();
}
$$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
function renderAll() { renderVOTD(); renderOTD(); renderList(); renderTimeline(); }

function renderVOTD() {
  const [t, r] = DAILY[Math.floor(dayNum(today())) % DAILY.length];
  $('#votd').innerHTML = `<b>Verse for today</b>“${esc(t)}”<span>${esc(r)} (KJV)</span>`;
}
function renderOTD() {
  const t = today(), [ty, tm, td] = t.split('-');
  const hits = letters.filter((l) => l.dateWritten && l.dateWritten < t && l.dateWritten.slice(8, 10) === td)
    .sort((a, b) => b.dateWritten.localeCompare(a.dateWritten)).slice(0, 3);
  const box = $('#onThisDay');
  if (!hits.length) { box.classList.add('hidden'); return; }
  box.innerHTML = '<b>On this day</b>' + hits.map((l) => {
    const sameDay = l.dateWritten.slice(5, 7) === tm;
    const ago = sameDay ? plural(Number(ty) - Number(l.dateWritten.slice(0, 4)), 'year') : plural((Number(ty) - Number(l.dateWritten.slice(0, 4))) * 12 + (Number(tm) - Number(l.dateWritten.slice(5, 7))), 'month');
    return `<button data-open="${esc(l.id)}">${ago} ago: “${esc(l.title)}” — ${esc(STATUS[l.status])}</button>`;
  }).join('');
  box.classList.remove('hidden');
}
$('#onThisDay').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openReadOnly(b.dataset.open); });

function letterCard(l, opts = {}) {
  const st = l.status || 'waiting';
  const long = (l.body || '').length > 260 || (l.body || '').split('\n').length > 3;
  const waited = daysBetween(l.dateWritten, today());
  const waitedTxt = st === 'waiting' ? (waited ? `Waiting ${plural(waited, 'day')}` : 'Waiting since today')
    : st === 'surrendered' ? `Surrendered ${fmt(l.statusDate)}`
      : `Answered ${fmt(l.statusDate)} · ${after(l)}`;
  const noteLabel = st === 'surrendered' ? 'My reflection' : 'How He answered';
  return `<article class="letter st-${st}" data-id="${esc(l.id)}">
    <div class="head"><div><h3>${esc(l.title)}</h3>
      <div class="meta">Written ${esc(fmt(l.dateWritten))} · ${esc(l.category)} · ${esc(waitedTxt)}</div></div>
      <span class="pill st-${st}">${esc(STATUS[st])}</span></div>
    <div class="body ${long && !opts.full ? 'clamp' : ''}">${esc(l.body)}</div>
    ${long && !opts.full ? '<button class="more" data-act="more">Read full letter</button>' : ''}
    ${l.verse ? `<div class="standing">Standing on: ${esc(l.verse)}</div>` : ''}
    ${l.praying ? `<div class="for">Praying for: ${esc(l.praying)}</div>` : ''}
    ${st !== 'waiting' && l.statusNote ? `<div class="testimony st-${st}"><b>${noteLabel}</b><p>${esc(l.statusNote)}</p></div>` : ''}
    ${opts.readonly ? '' : `<div class="actions">
      <select data-act="status" aria-label="Change status">
        <option value="" selected disabled>Change status…</option>
        ${Object.entries(STATUS).filter(([k]) => k !== st).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <button class="btn ghost sm" data-act="edit">Edit</button>
      <button class="btn ghost sm" data-act="delete">Delete</button></div>`}
  </article>`;
}

function renderList() {
  const counts = { waiting: 0, answered: 0, different: 0, surrendered: 0 };
  letters.forEach((l) => counts[l.status || 'waiting']++);
  $('#sTotal').textContent = letters.length;
  $('#sAns').textContent = counts.answered + counts.different;
  $('#sWait').textContent = counts.waiting;
  $('#sSur').textContent = counts.surrendered;

  const fs = $('#fStatus').value, fc = $('#fCategory').value, q = $('#search').value.trim().toLowerCase(), dir = $('#sort').value;
  let rows = letters.filter((l) => (fs === 'all' || l.status === fs) && (fc === 'all' || l.category === fc));
  if (q) rows = rows.filter((l) => [l.title, l.body, l.verse, l.praying, l.category, l.statusNote].join(' ').toLowerCase().includes(q));
  rows.sort((a, b) => { const k = (b.dateWritten || '').localeCompare(a.dateWritten || '') || (b.createdAt || '').localeCompare(a.createdAt || ''); return dir === 'new' ? k : -k; });

  const list = $('#list');
  if (!letters.length) {
    list.innerHTML = `<div class="empty"><h2>Your first letter is waiting</h2><p>Tell Abba what's on your heart. Each letter is dated and locked so only you can read it.</p><button class="btn" id="emptyNew">✎ Write a letter</button></div>`;
    $('#emptyNew').onclick = () => openWrite(); return;
  }
  list.innerHTML = rows.length ? rows.map((l) => letterCard(l)).join('') : '<div class="empty"><h2>Nothing here</h2><p>No letters match this view.</p></div>';
}
['#fStatus', '#fCategory', '#sort'].forEach((s) => $(s).addEventListener('change', renderList));
$('#search').addEventListener('input', renderList);
$('#fCategory').insertAdjacentHTML('beforeend', CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join(''));
$('#wCat').innerHTML = CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('');

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const card = b.closest('.letter'); const l = letters.find((x) => x.id === card.dataset.id); if (!l) return;
  if (b.dataset.act === 'more') { card.querySelector('.body').classList.remove('clamp'); b.remove(); }
  if (b.dataset.act === 'edit') openWrite(l);
  if (b.dataset.act === 'delete') confirmDialog('Delete this letter?', `“${l.title}” will be removed from this device for good.`, null, async () => {
    await recDel(l.id); letters = letters.filter((x) => x.id !== l.id); renderAll(); toast('Letter deleted');
  });
});
$('#list').addEventListener('change', (e) => {
  const s = e.target.closest('select[data-act="status"]'); if (!s) return;
  const l = letters.find((x) => x.id === s.closest('.letter').dataset.id); const v = s.value; s.selectedIndex = 0;
  if (l) openStatus(l, v);
});

function renderTimeline() {
  const rows = letters.filter((l) => l.status === 'answered' || l.status === 'different')
    .sort((a, b) => (b.statusDate || '').localeCompare(a.statusDate || ''));
  $('#printBook').disabled = !rows.length;
  $('#timeline').innerHTML = rows.length ? rows.map((l) => `<div class="tl-item st-${l.status}">
      <div class="tl-date">${esc(fmt(l.statusDate))} · ${l.status === 'different' ? 'Answered differently' : 'Answered'} ${after(l)}</div>
      <h3>${esc(l.title)}</h3>
      <div class="meta">Asked ${esc(fmt(l.dateWritten))}</div>
      ${l.statusNote ? `<p>${esc(l.statusNote)}</p>` : ''}
    </div>`).join('')
    : '<div class="empty"><h2>Testimonies will gather here</h2><p>When Abba answers a letter, mark it answered and write how. Every answer will be remembered here.</p></div>';
}

/* --------------------------- write / edit ---------------------------- */
async function openWrite(l = null) {
  editingId = l ? l.id : null;
  $('#writeTitle').textContent = l ? 'Edit letter' : 'Dear Abba…';
  $('#saveLetter').textContent = l ? 'Save changes' : 'Seal letter';
  const f = l ? { ...l } : { title: '', dateWritten: today(), category: 'Family', body: 'Dear Abba,\n\n', verse: '', praying: '' };
  let restored = false;
  try {
    const d = await metaGet('draft');
    if (d) { const draft = await openObj(d); if ((draft.editingId || null) === editingId) { Object.assign(f, draft.fields); restored = true; } }
  } catch {}
  $('#wTitle').value = f.title; $('#wDate').value = f.dateWritten; $('#wCat').value = f.category;
  $('#wBody').value = f.body; $('#wVerse').value = f.verse || ''; $('#wFor').value = f.praying || '';
  $('#prompts').classList.add('hidden'); updateCatVerse();
  $('#dlgWrite').showModal();
  if (restored) toast('Your unsent draft was restored');
  setTimeout(() => (l ? $('#wBody') : $('#wTitle')).focus(), 30);
}
function writeFields() {
  return { title: $('#wTitle').value.trim(), dateWritten: $('#wDate').value, category: $('#wCat').value, body: $('#wBody').value.trim(), verse: $('#wVerse').value.trim(), praying: $('#wFor').value.trim() };
}
function updateCatVerse() { const v = BY_CATEGORY[$('#wCat').value]; $('#catVerse').textContent = v ? `“${v[0]}” — ${v[1]}` : ''; }
$('#wCat').addEventListener('change', updateCatVerse);
$('#newBtn').onclick = () => openWrite();
$('#promptBtn').onclick = () => $('#prompts').classList.toggle('hidden');
$('#prompts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const ta = $('#wBody'); ta.value = ta.value.replace(/\s*$/, '') + '\n\n' + b.dataset.p; ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; queueDraft();
});
$('#writeForm').addEventListener('input', queueDraft);
function queueDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 1200); }
async function saveDraft(force) { if (!dek || (!force && !$('#dlgWrite').open)) return; try { await metaPut('draft', await sealObj({ editingId, fields: writeFields() })); } catch {} }
$('#writeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = writeFields(); if (!f.title || !f.body) return;
  clearTimeout(draftTimer);
  const now = new Date().toISOString();
  const base = editingId ? letters.find((x) => x.id === editingId) : { id: uid(), status: 'waiting', statusDate: null, statusNote: '', createdAt: now };
  await saveLetter({ ...base, ...f, updatedAt: now });
  await metaDel('draft');
  justSaved = true; $('#dlgWrite').close(); renderAll(); toast(editingId ? 'Letter updated' : 'Letter sealed and kept safe ✉');
  editingId = null;
});

/* ------------------------------ status ------------------------------- */
function openStatus(l, st) {
  if (st === 'waiting') { return setStatus(l, 'waiting', null, '').then(() => toast('Moved back to Still waiting')); }
  statusTarget = { l, st };
  const t = { answered: ['He answered 🙌', 'Date answered', 'How He answered (your testimony)'], different: ['Answered differently', 'Date answered', 'How He answered'], surrendered: ['Surrendered to Abba', 'Date', 'A reflection (optional)'] }[st];
  $('#statusTitle').textContent = t[0]; $('#statusDateWrap').querySelector('label').textContent = t[1]; $('#sNoteLabel').textContent = t[2];
  $('#statusSub').textContent = '“' + l.title + '”';
  $('#sDate').value = today(); $('#sNote').value = l.status === st ? (l.statusNote || '') : '';
  $('#dlgStatus').showModal(); setTimeout(() => $('#sNote').focus(), 30);
}
async function setStatus(l, st, date, note) {
  await saveLetter({ ...l, status: st, statusDate: date, statusNote: note, updatedAt: new Date().toISOString() });
  renderAll();
}
$('#statusForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!statusTarget) return;
  const { l, st } = statusTarget;
  await setStatus(l, st, $('#sDate').value, $('#sNote').value.trim());
  $('#dlgStatus').close(); statusTarget = null;
  toast(st === 'surrendered' ? 'Released into Abba’s hands' : 'Praise God! Added to your testimonies 🙌');
});

function openReadOnly(id) {
  const l = letters.find((x) => x.id === id); if (!l) return;
  $('#pageBody').innerHTML = letterCard(l, { full: true, readonly: true });
  $('#dlgPage').showModal();
}

/* --------------------------- confirm dialog -------------------------- */
let confirmCb = null;
function confirmDialog(title, text, typeWord, cb) {
  $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; confirmCb = cb;
  $('#confirmTypeWrap').classList.toggle('hidden', !typeWord);
  $('#confirmType').value = ''; $('#confirmType').dataset.word = typeWord || '';
  $('#confirmTypeLabel').textContent = typeWord ? `Type ${typeWord} to confirm` : '';
  $('#dlgConfirm').showModal();
}
$('#confirmOk').onclick = async () => {
  const w = $('#confirmType').dataset.word;
  if (w && $('#confirmType').value.trim() !== w) { $('#confirmType').focus(); return; }
  $('#dlgConfirm').close(); if (confirmCb) await confirmCb();
};
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
let justSaved = false;
$('#dlgWrite').addEventListener('close', () => { clearTimeout(draftTimer); if (!justSaved) saveDraft(true); justSaved = false; });

/* ------------------------- passphrase dialogs ------------------------ */
let passMode = 'change', passResolve = null;
function openPassDialog(mode, title, sub) {
  passMode = mode;
  const cfg = {
    change: ['Change passphrase', 'Your letters stay as they are; only the lock changes.', true, true, true],
    reset: ['Set a new passphrase', 'You unlocked with your recovery key. Choose a new passphrase now.', false, true, false],
    ask: [title, sub, true, false, true]
  }[mode];
  $('#passTitle').textContent = cfg[0]; $('#passSub').textContent = cfg[1];
  $('#passOldWrap').classList.toggle('hidden', !cfg[2]); $('#passNewWrap').classList.toggle('hidden', !cfg[3]);
  $('#passCancel').classList.toggle('hidden', !cfg[4]);
  $('#passOldLabel').textContent = mode === 'ask' ? 'Passphrase or recovery key' : 'Current passphrase';
  ['#passOld', '#passNew1', '#passNew2'].forEach((s) => ($(s).value = '')); showErr($('#passErr'), '');
  $('#dlgPass').showModal();
  setTimeout(() => (cfg[2] ? $('#passOld') : $('#passNew1')).focus(), 30);
  return new Promise((r) => (passResolve = r));
}
$('#dlgPass').addEventListener('cancel', (e) => { if (passMode === 'reset') e.preventDefault(); });
$('#dlgPass').addEventListener('close', () => { if (passResolve) { passResolve(null); passResolve = null; } ['#passOld', '#passNew1', '#passNew2'].forEach((s) => ($(s).value = '')); });
$('#passForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const old = $('#passOld').value, n1 = $('#passNew1').value, n2 = $('#passNew2').value;
  if (passMode === 'ask') { const r = passResolve; passResolve = null; $('#dlgPass').close(); r && r(old); return; }
  if (passMode === 'change') {
    try { await unwrapWith(keys.p, old); } catch { return showErr($('#passErr'), "Your current passphrase isn't right."); }
  }
  if (n1.length < 8) return showErr($('#passErr'), 'Please use at least 8 characters.');
  if (n1 !== n2) return showErr($('#passErr'), "The two new passphrases don't match.");
  $('#passSave').disabled = true;
  keys = { ...keys, p: await wrapWith(n1) }; await metaPut('keys', keys);
  $('#passSave').disabled = false; passResolve = null; $('#dlgPass').close(); toast('Passphrase updated');
});
$('#changePassBtn').onclick = () => openPassDialog('change');
$('#newRecoveryBtn').onclick = async () => {
  const secret = await openPassDialog('ask', 'Make a new recovery key', 'Enter your passphrase to confirm. Your old recovery key will stop working.');
  if (!secret) return;
  try { await unwrapWith(keys.p, secret); } catch { return toast("That passphrase didn't work"); }
  const rk = makeRecoveryKey();
  keys = { ...keys, r: await wrapWith(normRK(rk)) }; await metaPut('keys', keys);
  $('#recoveryKey2').textContent = rk; $('#dlgRecoveryShow').showModal();
};
$('#dlgRecoveryShow').addEventListener('close', () => { $('#recoveryKey2').textContent = ''; });

/* -------------------------- backup / restore ------------------------- */
async function makeBackup() {
  const recs = await recAll();
  download(`letters-to-abba-backup-${today()}.abba`,
    JSON.stringify({ app: 'letters-to-abba', format: 1, exportedAt: new Date().toISOString(), keys, letters: recs }), 'application/json');
  prefs.lastBackup = new Date().toISOString(); prefs.lettersAtBackup = letters.length; savePrefs();
  refreshBanner(); renderSettings(); toast('Backup downloaded — keep it somewhere safe');
}
$('#backupBtn').onclick = makeBackup;
$('#restoreBtn').onclick = () => $('#restoreFile').click();
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); if (data.app !== 'letters-to-abba' || !data.keys || !Array.isArray(data.letters)) throw 0; }
  catch { return toast("That file isn't a Letters to Abba backup"); }
  const secret = await openPassDialog('ask', 'Unlock this backup', 'Enter the passphrase (or recovery key) that was in use when this backup was made.');
  if (!secret) return;
  const got = await unlockKeys(data.keys, secret);
  if (!got) return toast("That didn't unlock the backup");
  const bKey = got.key;
  if (!keys) {
    // Fresh device: adopt the backup as this journal.
    keys = data.keys; await metaPut('keys', keys);
    for (const r of data.letters) await recPut(r);
    dek = bKey; await loadLetters(); await enterApp(); requestPersist();
    toast(`Restored ${plural(letters.length, 'letter')}`);
    if (got.via === 'recovery') openPassDialog('reset');
    return;
  }
  // Existing journal: merge, newest version of each letter wins.
  let added = 0, updated = 0;
  for (const r of data.letters) {
    let obj; try { obj = await openObj(r, bKey); } catch { continue; }
    const local = letters.find((x) => x.id === r.id);
    if (!local) { await saveLetter({ id: r.id, ...obj }); added++; }
    else if ((obj.updatedAt || '') > (local.updatedAt || '')) { await saveLetter({ id: r.id, ...obj }); updated++; }
  }
  renderAll(); toast(`Restore done: ${added} added, ${updated} updated`);
});

/* ------------------------- export & book ----------------------------- */
$('#exportTxt').onclick = () => {
  const txt = [...letters].sort((a, b) => (a.dateWritten || '').localeCompare(b.dateWritten || '')).map((l) =>
    `${l.title}\nWritten: ${fmt(l.dateWritten)} | ${l.category} | ${STATUS[l.status]}${l.statusDate ? ' ' + fmt(l.statusDate) : ''}\n\n${l.body}` +
    (l.verse ? `\n\nStanding on: ${l.verse}` : '') + (l.praying ? `\nPraying for: ${l.praying}` : '') + (l.statusNote ? `\n\n${l.status === 'surrendered' ? 'Reflection' : 'How He answered'}: ${l.statusNote}` : '')
  ).join('\n\n— — —\n\n');
  download(`letters-to-abba-${today()}.txt`, 'LETTERS TO ABBA\n\n' + txt, 'text/plain');
};
$('#printBook').onclick = () => {
  const rows = letters.filter((l) => l.status === 'answered' || l.status === 'different').sort((a, b) => (a.statusDate || '').localeCompare(b.statusDate || ''));
  $('#printArea').innerHTML = `<div class="book-cover"><h1>Book of Remembrance</h1><p>“Hitherto hath the LORD helped us.” — 1 Samuel 7:12</p><p>${plural(rows.length, 'answered prayer')}</p></div>` +
    rows.map((l) => `<div class="book-entry"><div class="bm">Asked ${esc(fmt(l.dateWritten))} · Answered ${esc(fmt(l.statusDate))} · ${esc(l.category)}</div><h2>${esc(l.title)}</h2><div class="bl">${esc(l.body)}</div>${l.statusNote ? `<p class="bm">How He answered</p><div class="bt">${esc(l.statusNote)}</div>` : ''}</div>`).join('');
  window.print();
  setTimeout(() => { $('#printArea').innerHTML = ''; }, 1500);
};

/* ------------------------------ settings ----------------------------- */
function renderSettings() {
  $('#autoLock').value = String(prefs.autoLock); $('#theme').value = prefs.theme; $('#textSize').value = prefs.size;
  $('#backupInfo').textContent = prefs.lastBackup ? `Last backup: ${fmt(prefs.lastBackup.slice(0, 10))} (${plural(daysBetween(prefs.lastBackup.slice(0, 10), today()), 'day')} ago).` : 'You have not made a backup yet.';
}
$('#autoLock').onchange = (e) => { prefs.autoLock = Number(e.target.value); savePrefs(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; savePrefs(); applyPrefs(); };
$('#textSize').onchange = (e) => { prefs.size = e.target.value; savePrefs(); applyPrefs(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);
$('#wipeBtn').onclick = () => confirmDialog('Delete everything?', 'Every letter and key on this device will be erased. This cannot be undone.', 'DELETE', async () => {
  db.close(); await new Promise((r) => { const d = indexedDB.deleteDatabase('letters-to-abba'); d.onsuccess = d.onerror = d.onblocked = r; });
  try { localStorage.removeItem('abba-prefs'); } catch {}
  location.reload();
});
async function requestPersist() {
  try { if (navigator.storage?.persist) prefs.persisted = await navigator.storage.persist(); savePrefs(); } catch {}
  updatePersistInfo();
}
async function updatePersistInfo() {
  let p = null; try { p = await navigator.storage?.persisted?.(); } catch {}
  $('#persistInfo').textContent = p ? 'Storage: protected — your browser will not clear your letters to free up space.'
    : 'Storage: not protected yet. Installing the app to your home screen helps keep your letters safe. Keep regular backups.';
}

/* ------------------------------ banners ------------------------------ */
let updateReady = null;
function refreshBanner() {
  const b = $('#banner'); let html = '';
  if (updateReady) html = '<span>A new version of Letters to Abba is ready.</span><button class="btn sm" id="bnUpdate">Update now</button>';
  else if (letters.length && (!prefs.lastBackup || (daysBetween(prefs.lastBackup.slice(0, 10), today()) > BACKUP_REMINDER_DAYS && letters.length !== prefs.lettersAtBackup)))
    html = `<span>${prefs.lastBackup ? `It's been over ${BACKUP_REMINDER_DAYS} days since your last backup.` : "You haven't backed up your letters yet."} A backup protects them if your phone is lost or reset.</span><button class="btn sm" id="bnBackup">Back up now</button>`;
  else if (isIOS() && !isStandalone() && !prefs.iosTipDone)
    html = '<span>To keep your letters safe on iPhone, tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.</span><button class="btn ghost sm" id="bnIos">Got it</button>';
  b.innerHTML = html; b.classList.toggle('hidden', !html);
  $('#bnUpdate') && ($('#bnUpdate').onclick = () => updateReady.postMessage('skipWaiting'));
  $('#bnBackup') && ($('#bnBackup').onclick = makeBackup);
  $('#bnIos') && ($('#bnIos').onclick = () => { prefs.iosTipDone = true; savePrefs(); refreshBanner(); });
}
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* --------------------------- help & privacy -------------------------- */
function openHelp() {
  const lines = HELPLINES.map((h) => `<li><strong>${esc(h.name)}</strong>: ${esc(h.phone)}${h.note ? ' — ' + esc(h.note) : ''}</li>`).join('');
  $('#pageBody').innerHTML = `<div class="page"><h2 class="script">You are not alone</h2>
    <p>If you are going through something heavy, please reach out to someone today — a trusted friend, family member, pastor or counsellor.</p>
    <p><strong>If you or someone else is in immediate danger, contact your local emergency services now.</strong></p>
    ${lines ? `<ul>${lines}</ul>` : ''}
    <p>Find a free, confidential helpline in your country: <a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a></p>
    <p class="verse">“The LORD is nigh unto them that are of a broken heart.”<span>Psalm 34:18</span></p></div>`;
  $('#dlgPage').showModal();
}
function openPrivacy() {
  $('#pageBody').innerHTML = `<div class="page"><h2 class="script">How your letters are kept safe</h2>
    <ul>
      <li><strong>Stored only on this device.</strong> Letters are never sent to any server. There are no accounts, no analytics and no tracking.</li>
      <li><strong>Encrypted.</strong> Every letter is locked with AES-256 encryption using a key that only your passphrase (or recovery key) can open. Even someone with your phone's files sees only scrambled text.</li>
      <li><strong>No one else can read them</strong> — not the people who made this app, and not the website host.</li>
      <li><strong>Auto-lock.</strong> The journal locks itself after a few minutes of no use, or when you leave the app for more than a minute.</li>
      <li><strong>If you lose your phone</strong> or clear your browser data, your letters on that device are gone. That's why backups matter: a backup file is encrypted too, and you can restore it on any device.</li>
      <li><strong>If you forget your passphrase,</strong> use your recovery key. If both are lost, nobody can recover your letters — that is the price of real privacy.</li>
    </ul></div>`;
  $('#dlgPage').showModal();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-help]')) openHelp();
  if (e.target.closest('[data-privacy]')) openPrivacy();
});

/* ----------------------------- start-up ------------------------------ */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const watch = (w) => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) { updateReady = w; if (dek) refreshBanner(); }
    });
    if (reg.waiting && navigator.serviceWorker.controller) { updateReady = reg.waiting; }
    watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateReady && !reloaded) { reloaded = true; location.reload(); } });
}

(async function start() {
  loadPrefs(); applyPrefs(); registerSW();
  if (!window.crypto?.subtle || !window.indexedDB) {
    document.body.innerHTML = '<p class="noscript">This browser can\'t run Letters to Abba securely. Please open it in an up-to-date Chrome, Safari, Edge or Firefox.</p>';
    return;
  }
  try { db = await openDB(); } catch { document.body.innerHTML = '<p class="noscript">Your browser blocked storage (private browsing?). Please open Letters to Abba in a normal window.</p>'; return; }
  keys = await metaGet('keys');
  if (keys) { show('#view-lock'); setLockMode('pass'); } else show('#view-setup');
  updatePersistInfo();
})();
