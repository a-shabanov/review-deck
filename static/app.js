'use strict';
const $ = s => document.querySelector(s);
const enc = encodeURIComponent;
async function apiRequest(u, options) {
  try {
    const response = await fetch(u, options), result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  } catch (error) {
    toast('Ошибка запроса: ' + error.message);
    throw error;
  }
}
const api = {
  get: u => apiRequest(u),
  post: (u, b) => apiRequest(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function fmt(t, cs = true) {
  if (!isFinite(t)) t = 0;
  const s = Math.max(0, t), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const ss = cs ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
}
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1600); }
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

// ============================================================================ LIBRARY
let LIB = null, CFG = { tracks: [] }, CAT = { people: {}, tags: {}, videos: {} };
// timelines: independent sets of marks per video ('' = source annotation, 'review' = notes on a finished cut), each with its own tracks
const TLS = { '': 'Разметка', review: 'Правки' };
let TLN = ''; try { TLN = localStorage.getItem('rd.tl') || ''; if (!(TLN in TLS)) TLN = ''; } catch (e) {}
const CFGS = {};
const TLQ = () => TLN ? `&tl=${TLN}` : '';
function curCfg() { return TLN ? (CFGS[TLN] || { tracks: [] }) : CFG; }
let FILTER = 'all', FOLDER = null, SEARCH = '', PSEARCH = '', GROUP = 'folder', VIEW = 'lib';
let FP = new Set(), FT = new Set(), FNONE = '';          // participant / tag filters (AND), FNONE: 'people' | 'tags' = only videos without any
let FLAT = [], SEL = 0, ANCHOR = 0, MSEL = new Set();    // FLAT: [{v, el}] — a video sits in several sections when grouped by participant
const byRel = {};
try { GROUP = localStorage.getItem('rd.group') || 'folder'; } catch (e) {}

const vp = rel => CAT.videos[rel]?.people || [];
const vt = rel => CAT.videos[rel]?.tags || [];
const pname = id => CAT.people[id]?.name || id;
const tname = id => CAT.tags[id]?.name || id;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
function hs(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function avatarHtml(id, big) {
  const e = CAT.people[id]; if (!e) return '';
  if (e.avatar) return `<span class="av${big ? ' big' : ''}" style="background-image:url(/api/avatar?id=${enc(id)}&v=${hs(JSON.stringify(e.avatar))})"></span>`;
  const ini = e.name.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
  return `<span class="av${big ? ' big' : ''}" style="background-color:hsl(${hs(e.name) % 360},65%,72%)">${esc(ini)}</span>`;
}
function useCount(kind) {
  const n = {}; for (const id in CAT[kind]) n[id] = 0;
  for (const rel in CAT.videos) if (byRel[rel]) for (const id of CAT.videos[rel][kind] || []) n[id] = (n[id] || 0) + 1;
  return n;
}

async function loadLibrary(keepSel) {
  const st = await api.get('/api/state');
  $('#rootInput').value = st.root || '';
  $('#rootInput').disabled = !!st.root_locked;
  $('#rootBtn').disabled = !!st.root_locked;
  $('#rootInput').title = st.root_locked ? 'Медиатекой управляет администратор сервера' : '';
  if (!st.root) { $('#grid').innerHTML = '<p class="muted">Укажи папку медиатеки сверху и нажми «Открыть».</p>'; return; }
  const prevRel = keepSel && FLAT[SEL] ? FLAT[SEL].v.rel : null;
  LIB = await api.get('/api/library'); CFG = LIB.config; CAT = LIB.catalog;
  for (const k of Object.keys(TLS)) if (k) CFGS[k] = await api.get(`/api/config?tl=${k}`);
  for (const k in byRel) delete byRel[k];
  for (const f of LIB.folders) for (const v of f.videos) { v.folder = f.folder; byRel[v.rel] = v; }
  for (const r of [...MSEL]) if (!byRel[r]) MSEL.delete(r);
  renderSide(); renderGrid();
  if (prevRel) { const i = FLAT.findIndex(x => x.v.rel === prevRel); if (i >= 0) select(i, false); }
}
const allVideos = () => LIB.folders.flatMap(f => f.videos);

function searchText(v) {
  const ppl = vp(v.rel).map(i => pname(i) + ' ' + (CAT.people[i]?.aliases || []).join(' '));
  return ((v.code ? v.code + ' ' : '') + v.name + ' ' + ppl.join(' ') + ' ' + vt(v.rel).map(tname).join(' ') + ' ' + (v.note || '')).toLowerCase();
}
function passes(v) {
  if (FOLDER !== null && v.folder !== FOLDER) return false;
  if (SEARCH && !searchText(v).includes(SEARCH)) return false;
  for (const id of FP) if (!vp(v.rel).includes(id)) return false;
  for (const id of FT) if (!vt(v.rel).includes(id)) return false;
  if (FNONE === 'people' && vp(v.rel).length) return false;
  if (FNONE === 'tags' && vt(v.rel).length) return false;
  if (FILTER === 'all') return true;
  if (FILTER === 'marked') return v.nspans > 0 || v.ndraw > 0;
  return v.status === FILTER;
}

// ---------------------------------------------------------------- sidebar: folders, participants, tags
function sideItem(box, html, n, on, click) {
  const d = document.createElement('div'); d.className = 'it' + (on ? ' on' : '');
  d.innerHTML = `${html}<small>${n}</small>`; d.onclick = click; box.appendChild(d); return d;
}
function toggleFilter(set, id, e) {        // click = only this one, ⌘/Shift-click = add / remove (AND)
  FNONE = '';
  if (e.metaKey || e.ctrlKey || e.shiftKey) set.has(id) ? set.delete(id) : set.add(id);
  else if (set.size === 1 && set.has(id)) set.clear();
  else { set.clear(); set.add(id); }
  renderSide(); renderGrid();
}
function renderSide() {
  const vids = allVideos();
  const fb = $('#folders'); fb.innerHTML = '';
  sideItem(fb, '<span>Все папки</span>', vids.length, FOLDER === null, () => { FOLDER = null; renderSide(); renderGrid(); });
  for (const f of LIB.folders) {
    const bad = f.videos.filter(v => v.status === 'defect').length;
    sideItem(fb, `<span>${esc(f.folder === '.' ? '(корень)' : f.folder)}</span>`, f.videos.length + (bad ? ' · ' + bad + '✕' : ''), FOLDER === f.folder, () => { FOLDER = f.folder; renderSide(); renderGrid(); });
  }
  const pc = useCount('people'), pb = $('#people'); pb.innerHTML = '';
  const ids = Object.keys(CAT.people).filter(id => !PSEARCH || norm(pname(id) + ' ' + (CAT.people[id].aliases || []).join(' ')).includes(PSEARCH))
    .sort((a, b) => pc[b] - pc[a] || pname(a).localeCompare(pname(b)));
  $('#peopleN').textContent = Object.keys(CAT.people).length || '';
  for (const id of ids) sideItem(pb, `${avatarHtml(id)}<span>${esc(pname(id))}</span>`, pc[id], FP.has(id), e => toggleFilter(FP, id, e));
  const nop = vids.filter(v => !vp(v.rel).length).length;
  if (nop) sideItem(pb, '<span class="av">?</span><span>Без участников</span>', nop, FNONE === 'people', () => { FP.clear(); FNONE = FNONE === 'people' ? '' : 'people'; renderSide(); renderGrid(); });
  const tc = useCount('tags'), tb = $('#tags'); tb.innerHTML = '';
  const groups = {};
  for (const id in CAT.tags) (groups[CAT.tags[id].group || ''] ||= []).push(id);
  for (const g of Object.keys(groups).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))) {
    const h = document.createElement('div'); h.className = 'grp'; h.textContent = g || 'прочее'; tb.appendChild(h);
    for (const id of groups[g].sort((a, b) => tname(a).localeCompare(tname(b)))) sideItem(tb, `<span>${esc(tname(id))}</span>`, tc[id], FT.has(id), e => toggleFilter(FT, id, e));
  }
  const not = vids.filter(v => !vt(v.rel).length).length;
  if (not && Object.keys(CAT.tags).length) sideItem(tb, '<span>Без тегов</span>', not, FNONE === 'tags', () => { FT.clear(); FNONE = FNONE === 'tags' ? '' : 'tags'; renderSide(); renderGrid(); });
  renderActive();
}
function renderActive() {
  const box = $('#activeFilters'); box.innerHTML = '';
  const add = (label, off) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = label + '  ✕'; c.onclick = off; box.appendChild(c); };
  for (const id of FP) add(pname(id), () => { FP.delete(id); renderSide(); renderGrid(); });
  for (const id of FT) add('#' + tname(id), () => { FT.delete(id); renderSide(); renderGrid(); });
  if (FNONE) add(FNONE === 'people' ? 'без участников' : 'без тегов', () => { FNONE = ''; renderSide(); renderGrid(); });
  if (MSEL.size) add(`выбрано ${MSEL.size} — A участники · T теги · Esc снять`, () => { MSEL.clear(); paintSel(); renderActive(); });
  box.classList.toggle('hidden', !box.children.length);
}

// ---------------------------------------------------------------- grid, grouped by folder / participant / tag
function sections() {
  if (GROUP === 'folder') return LIB.folders.map(f => ({ title: esc(f.folder === '.' ? '(корень)' : f.folder), vids: f.videos.filter(passes) }));
  const vids = allVideos().filter(passes), kind = GROUP === 'person' ? 'people' : 'tags', get = kind === 'people' ? vp : vt;
  if (GROUP === 'none') {
    const t = [...FP].map(pname).concat([...FT].map(id => '#' + tname(id))).join(' + ') || 'Все видео';
    return [{ title: esc(t), vids: vids.slice().sort((a, b) => a.name.localeCompare(b.name)) }];
  }
  const only = kind === 'people' ? FP : FT;           // filtered by a participant: their group only, other participants stay as chips
  const out = Object.keys(CAT[kind]).filter(id => !only.size || only.has(id)).map(id => ({ id, vids: vids.filter(v => get(v.rel).includes(id)) })).filter(s => s.vids.length);
  if (kind === 'people') out.sort((a, b) => b.vids.length - a.vids.length || pname(a.id).localeCompare(pname(b.id)));
  else out.sort((a, b) => (CAT.tags[a.id].group || '~').localeCompare(CAT.tags[b.id].group || '~') || tname(a.id).localeCompare(tname(b.id)));
  for (const s of out) {
    if (kind === 'people') { const al = CAT.people[s.id].aliases || []; s.title = `${avatarHtml(s.id, true)}<span>${esc(pname(s.id))}</span>${al.length ? `<span class="alias">${esc(al.join(', '))}</span>` : ''}`; }
    else { const g = CAT.tags[s.id].group; s.title = `${g ? esc(g) + ' · ' : ''}#${esc(tname(s.id))}`; }
  }
  const none = vids.filter(v => !get(v.rel).length);
  if (none.length && !only.size) out.push({ title: kind === 'people' ? 'Без участников' : 'Без тегов', vids: none });
  return out;
}

let io = null;
function renderGrid() {
  const g = $('#grid'), keep = FLAT[SEL]?.v.rel; g.innerHTML = ''; FLAT = [];
  if (io) io.disconnect();
  io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { const th = e.target; th.style.backgroundImage = `url(/api/thumb?rel=${enc(th.dataset.rel)})`; io.unobserve(th); }
  }, { root: g, rootMargin: '400px' });
  for (const s of sections()) {
    if (!s.vids.length) continue;
    const sec = document.createElement('div'); sec.className = 'fsec';
    sec.innerHTML = `<h3>${s.title} <small>· ${s.vids.length}</small></h3>`;
    const cards = document.createElement('div'); cards.className = 'cards';
    for (const v of s.vids) { const el = card(v, FLAT.length); cards.appendChild(el); FLAT.push({ v, el }); }
    sec.appendChild(cards); g.appendChild(sec);
  }
  if (!FLAT.length) g.innerHTML = '<p class="muted">Ничего не найдено.</p>';
  const i = keep ? FLAT.findIndex(x => x.v.rel === keep) : -1;
  SEL = clamp(i >= 0 ? i : SEL, 0, Math.max(0, FLAT.length - 1)); paintSel();
}
function rerenderKeep() { const g = $('#grid'), st = g.scrollTop; renderSide(); renderGrid(); g.scrollTop = st; }

function card(v, idx) {
  const c = document.createElement('div'); c.className = 'card' + (v.status === 'defect' ? ' defect' : ''); c.dataset.idx = idx;
  const badge = v.status === 'ok' ? '<span class="badge ok">OK</span>' : v.status === 'defect' ? '<span class="badge defect">брак</span>' : '';
  const marks = v.nspans || v.ndraw ? `<span class="badge">${v.nspans}▮${v.ndraw ? ' ' + v.ndraw + '✎' : ''}</span>` : '';
  const who = vp(v.rel).map(id => `<span class="chip p" data-p="${esc(id)}">${esc(pname(id))}</span>`).join('') + vt(v.rel).map(id => `<span class="chip t" data-t="${esc(id)}">#${esc(tname(id))}</span>`).join('');
  c.innerHTML = `<div class="th" data-rel="${esc(v.rel)}"><div class="spr"></div><div class="scrub"></div><span class="tc">${v.duration ? fmt(v.duration, false) : ''}</span></div>
    <div class="meta">${v.code ? `<span class="code">${esc(v.code)}</span>` : ''}<span class="name" title="${esc(v.name)}">${esc(v.name)}</span>${marks}${badge}</div><div class="who">${who}</div>`;
  const th = c.querySelector('.th'), spr = c.querySelector('.spr'), bar = c.querySelector('.scrub'), tc = c.querySelector('.tc');
  io.observe(th);
  let sprOk = false;
  th.onmouseenter = () => {
    if (!sprOk) { const im = new Image(); im.onload = () => { sprOk = true; spr.style.backgroundImage = `url(${im.src})`; spr.style.backgroundSize = '1000% 1000%'; }; im.src = `/api/sprite?rel=${enc(v.rel)}`; }
    if (!v.duration) api.get(`/api/meta?rel=${enc(v.rel)}`).then(m => { v.duration = m.duration; });
  };
  th.onmousemove = e => {
    if (c.querySelector('video')) return;
    const r = th.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 0.999);
    v.scrub = f; bar.style.width = (f * 100) + '%';
    if (sprOk) { const i = Math.floor(f * 100), col = i % 10, row = Math.floor(i / 10); spr.style.display = 'block'; spr.style.backgroundPosition = `${col / 9 * 100}% ${row / 9 * 100}%`; }
    if (v.duration) tc.textContent = fmt(f * v.duration, false);
  };
  th.onmouseleave = () => { spr.style.display = 'none'; bar.style.width = '0'; if (v.duration) tc.textContent = fmt(v.duration, false); };
  c.querySelectorAll('.chip').forEach(ch => ch.onclick = e => {
    e.stopPropagation();
    if (ch.dataset.p) toggleFilter(FP, ch.dataset.p, e); else toggleFilter(FT, ch.dataset.t, e);
  });
  c.onclick = e => {
    if (e.shiftKey) selectRange(idx);
    else if (e.metaKey || e.ctrlKey) { if (!MSEL.size && FLAT[SEL]) MSEL.add(FLAT[SEL].v.rel); MSEL.has(v.rel) ? MSEL.delete(v.rel) : MSEL.add(v.rel); select(idx, false, true); }
    else { MSEL.clear(); select(idx, false); }
  };
  c.ondblclick = () => openPlayer(v.rel);
  return c;
}

function paintSel() {
  FLAT.forEach((x, i) => { x.el.classList.toggle('sel', i === SEL); x.el.classList.toggle('msel', MSEL.has(x.v.rel)); });
  renderActive();
}
function select(i, scroll = true, keepMulti = false) {
  stopQuick();
  SEL = clamp(i, 0, FLAT.length - 1); const x = FLAT[SEL]; if (!x) return;
  if (!keepMulti) ANCHOR = SEL;
  paintSel(); if (scroll) x.el.scrollIntoView({ block: 'nearest' });
}
function selectRange(i) {
  const a = Math.min(ANCHOR, i), b = Math.max(ANCHOR, i); MSEL.clear();
  for (let k = a; k <= b; k++) MSEL.add(FLAT[k].v.rel);
  select(i, true, true);
}
const targets = () => MSEL.size ? [...MSEL] : (FLAT[SEL] ? [FLAT[SEL].v.rel] : []);

function moveSel(dir, extend) {        // spatial up / down between rows of the grid
  const cur = FLAT[SEL]?.el; if (!cur) return;
  const r0 = cur.getBoundingClientRect(); let best = -1, bd = 1e9;
  FLAT.forEach((x, i) => {
    const r = x.el.getBoundingClientRect(); const dy = (r.top - r0.top) * dir;
    if (dy <= 5) return;
    const d = dy * 3 + Math.abs(r.left - r0.left); if (d < bd) { bd = d; best = i; }
  });
  if (best >= 0) extend ? selectRange(best) : select(best);
}

// quick preview inside the card
let quick = null;
function startQuick() {
  const x = FLAT[SEL]; if (!x) return; const v = x.v;
  const th = x.el.querySelector('.th'); const vid = document.createElement('video');
  vid.src = `/media?rel=${enc(v.rel)}`; vid.muted = true; vid.autoplay = true; vid.playbackRate = 1;
  vid.onloadedmetadata = () => { vid.currentTime = (v.scrub || 0.1) * vid.duration; vid.play(); };
  vid.ontimeupdate = () => { th.querySelector('.scrub').style.width = (vid.currentTime / vid.duration * 100) + '%'; th.querySelector('.tc').textContent = fmt(vid.currentTime, false); };
  th.appendChild(vid); quick = vid;
}
function stopQuick() { if (quick) { quick.pause(); quick.removeAttribute('src'); quick.load(); quick.remove(); quick = null; } }

async function setStatus(rel, status) {
  const m = (await api.get(`/api/marks?rel=${enc(rel)}`)) || {};
  m.status = status; await api.post(`/api/marks?rel=${enc(rel)}`, m);
  const v = byRel[rel]; if (v) { v.status = status; }
}
async function setStatusAll(status, msg) {
  const rels = targets(); for (const r of rels) await setStatus(r, status);
  toast(msg + (rels.length > 1 ? ` · ${rels.length} видео` : '')); rerenderKeep();
}

function libKey(e) {
  const k = e.key, l = latin(e), cmd = e.metaKey || e.ctrlKey;
  if (cmd && l === 'a') { MSEL = new Set(FLAT.map(x => x.v.rel)); paintSel(); }
  else if (cmd) return;
  else if (k === 'ArrowRight') { if (quick) quick.currentTime += e.shiftKey ? 30 : 10; else e.shiftKey ? selectRange(SEL + 1) : select(SEL + 1); }
  else if (k === 'ArrowLeft') { if (quick) quick.currentTime -= e.shiftKey ? 30 : 10; else e.shiftKey ? selectRange(Math.max(0, SEL - 1)) : select(SEL - 1); }
  else if (k === 'ArrowDown') { if (quick) quick.playbackRate = Math.max(0.25, quick.playbackRate / 2); else moveSel(1, e.shiftKey); }
  else if (k === 'ArrowUp') { if (quick) quick.playbackRate = Math.min(16, quick.playbackRate * 2); else moveSel(-1, e.shiftKey); }
  else if (k === ' ') { quick ? stopQuick() : startQuick(); }
  else if (k === 'Enter') { const x = FLAT[SEL]; if (x) openPlayer(x.v.rel); }
  else if (k === 'Escape') { if (quick) stopQuick(); else if (MSEL.size) { MSEL.clear(); paintSel(); } }
  else if (l === 'a') openTagger('people', targets());
  else if (l === 't') openTagger('tags', targets());
  else if (l === 'g') setGroup({ folder: 'person', person: 'tag', tag: 'none', none: 'folder' }[GROUP] || 'folder');
  else if (l === 'x') { const v = FLAT[SEL]?.v; if (v) { const s = v.status === 'defect' ? 'unreviewed' : 'defect'; setStatusAll(s, s === 'defect' ? 'брак' : 'брак снят'); } }
  else if (l === 'o') setStatusAll('ok', 'OK');
  else if (l === 'u') setStatusAll('unreviewed', 'отметка снята');
  else if (k === '?') $('#help').classList.toggle('hidden');
  else return;
  e.preventDefault();
}
function refreshCard() { rerenderKeep(); }
function setGroup(g) {
  GROUP = g; try { localStorage.setItem('rd.group', g); } catch (e) {}
  document.querySelectorAll('#groupBy button').forEach(b => b.classList.toggle('on', b.dataset.g === g));
  if (LIB) { $('#grid').scrollTop = 0; renderGrid(); }
}

// ---------------------------------------------------------------- tagger: assign participants / tags to the selected videos
const TG = { kind: 'people', rels: [], items: [], si: 0 };
async function catOps(ops) {
  const r = await api.post('/api/catalog', { ops });
  if (r.error) { toast(r.error); return null; }
  CAT = r.catalog; return r;
}
function openTagger(kind, rels) {
  if (!rels.length) return toast('ничего не выбрано');
  stopQuick(); if (VIEW === 'player') pause();
  TG.kind = kind; TG.rels = rels; $('#tagger').classList.remove('hidden');
  $('#tgInput').value = ''; renderTagger(); $('#tgInput').focus();
}
function closeTagger() {
  $('#tagger').classList.add('hidden'); $('#tgInput').blur();
  if (VIEW === 'lib') rerenderKeep(); else updatePeople();
}
function renderTagger() {
  const kind = TG.kind, n = TG.rels.length, get = kind === 'people' ? vp : vt, name = kind === 'people' ? pname : tname;
  document.querySelectorAll('#tagger .tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
  $('#tgTarget').textContent = n === 1 ? (byRel[TG.rels[0]]?.name || TG.rels[0]) : `${n} видео`;
  $('#tgInput').placeholder = kind === 'people' ? 'имя участника…' : 'тег… (можно «группа: тег»)';
  const cnt = {}; for (const r of TG.rels) for (const id of get(r)) cnt[id] = (cnt[id] || 0) + 1;
  const box = $('#tgChips'); box.innerHTML = '';
  for (const id of Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])) {
    const c = document.createElement('span'); c.className = 'chip ' + (kind === 'people' ? 'p' : 't') + (cnt[id] < n ? ' part' : '');
    c.innerHTML = (kind === 'people' ? avatarHtml(id) : '') + esc(name(id)) + (cnt[id] < n ? ` <b>${cnt[id]}/${n}</b>` : '')
      + (kind === 'people' && VIEW === 'player' ? '<i data-a="av" title="аватар из текущего кадра (с учётом зума)">📷</i>' : '') + '<i data-a="rm" title="убрать">✕</i>';
    c.onclick = async e => {
      const a = e.target.dataset.a;
      if (a === 'rm') await catOps([{ op: 'unassign', kind, id, rels: TG.rels }]);
      else if (a === 'av') { await catOps([{ op: 'update', kind, id, fields: { avatar: frameRegion() } }]); toast('аватар: ' + name(id)); }
      else if (cnt[id] < n) await catOps([{ op: 'assign', kind, id, rels: TG.rels }]);
      renderTagger(); $('#tgInput').focus();
    };
    box.appendChild(c);
  }
  TG.full = new Set(Object.keys(cnt).filter(id => cnt[id] === n)); suggest();
}
function suggest() {
  const kind = TG.kind, q = norm($('#tgInput').value), uc = useCount(kind);
  const qn = q.includes(':') && kind === 'tags' ? norm(q.split(':').slice(1).join(':')) : q;
  let items = Object.keys(CAT[kind]).filter(id => !TG.full.has(id)).map(id => {
    const e = CAT[kind][id], names = [e.name].concat(e.aliases || []).map(norm);
    const hit = !qn ? 1 : names.some(x => x.startsWith(qn)) ? 2 : names.some(x => x.includes(qn)) ? 1 : 0;
    return { id, hit, n: uc[id] || 0 };
  }).filter(x => x.hit).sort((a, b) => b.hit - a.hit || b.n - a.n || (kind === 'people' ? pname : tname)(a.id).localeCompare((kind === 'people' ? pname : tname)(b.id))).slice(0, 12);
  const exact = Object.values(CAT[kind]).some(e => norm(e.name) === qn || (e.aliases || []).some(a => norm(a) === qn));
  if (q && !exact) items.push({ create: $('#tgInput').value.trim() });
  TG.items = items; TG.si = clamp(TG.si, 0, Math.max(0, items.length - 1));
  if (q) TG.si = 0;
  const box = $('#tgSugg'); box.innerHTML = '';
  items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = i === TG.si ? 'on' : '';
    if (it.create) d.innerHTML = `＋ создать <b>${esc(it.create)}</b>`;
    else {
      const e = CAT[kind][it.id]; const al = (e.aliases || []).length ? ` <span class="muted">(${esc(e.aliases.join(', '))})</span>` : '';
      d.innerHTML = (kind === 'people' ? avatarHtml(it.id) : '') + `<span>${kind === 'tags' && e.group ? esc(e.group) + ' · ' : ''}${esc(e.name)}${al}</span><small>${it.n}</small>`;
    }
    d.onclick = () => { TG.si = i; pick(); };
    box.appendChild(d);
  });
}
async function pick() {
  const it = TG.items[TG.si]; if (!it) return;
  const o = it.create ? { op: 'assign', kind: TG.kind, name: it.create, rels: TG.rels } : { op: 'assign', kind: TG.kind, id: it.id, rels: TG.rels };
  if (await catOps([o])) { $('#tgInput').value = ''; renderTagger(); }
}
function frameRegion() {          // the part of the frame visible in the player, normalised — zoom in on a face, then press 📷
  const W = stage.clientWidth, H = stage.clientHeight, s = P.fit * P.zoom;
  const x0 = clamp(-P.panX / s, 0, P.vw), y0 = clamp(-P.panY / s, 0, P.vh), x1 = clamp((W - P.panX) / s, 0, P.vw), y1 = clamp((H - P.panY) / s, 0, P.vh);
  const r = v => +v.toFixed(4);
  return { rel: P.rel, t: +video.currentTime.toFixed(3), x: r(x0 / P.vw), y: r(y0 / P.vh), w: r((x1 - x0) / P.vw), h: r((y1 - y0) / P.vh) };
}
$('#tgInput').addEventListener('input', () => { TG.si = 0; suggest(); });
$('#tgInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeTagger(); e.preventDefault(); }
  else if (e.key === 'Tab') { TG.kind = TG.kind === 'people' ? 'tags' : 'people'; $('#tgInput').value = ''; renderTagger(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { TG.si = clamp(TG.si + 1, 0, TG.items.length - 1); suggest(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { TG.si = clamp(TG.si - 1, 0, TG.items.length - 1); suggest(); e.preventDefault(); }
  else if (e.key === 'Enter') { pick(); e.preventDefault(); }
  else if (e.key === 'Backspace' && !e.target.value) {
    const last = [...$('#tgChips').children].pop(); if (last) last.querySelector('[data-a="rm"]').click();
    e.preventDefault();
  }
  e.stopPropagation();
});
document.querySelectorAll('#tagger .tabs button').forEach(b => b.onclick = () => { TG.kind = b.dataset.k; renderTagger(); $('#tgInput').focus(); });
$('#tagger').onclick = e => { if (e.target.id === 'tagger') closeTagger(); };

// ---------------------------------------------------------------- catalog manager: rename, aliases, groups, merge, delete
let CK = 'people';
function openCatalog() { $('#catalog').classList.remove('hidden'); $('#catSearch').value = ''; renderCatalog(); }
function closeCatalog() { $('#catalog').classList.add('hidden'); if (VIEW === 'lib') rerenderKeep(); else updatePeople(); }
function renderCatalog() {
  document.querySelectorAll('#catalog .tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === CK));
  const q = norm($('#catSearch').value), uc = useCount(CK), name = CK === 'people' ? pname : tname;
  const ids = Object.keys(CAT[CK]).filter(id => !q || norm(name(id) + ' ' + (CAT[CK][id].aliases || []).join(' ') + ' ' + (CAT[CK][id].group || '')).includes(q))
    .sort((a, b) => CK === 'tags' ? (CAT.tags[a].group || '~').localeCompare(CAT.tags[b].group || '~') || name(a).localeCompare(name(b)) : name(a).localeCompare(name(b)));
  const box = $('#catRows'); box.innerHTML = ids.length ? '' : '<p class="muted">Пусто. Участники и теги появляются, когда их назначают: A / T в медиатеке.</p>';
  const others = Object.keys(CAT[CK]).sort((a, b) => name(a).localeCompare(name(b)));
  for (const id of ids) {
    const e = CAT[CK][id], r = document.createElement('div'); r.className = 'row';
    r.innerHTML = (CK === 'people' ? avatarHtml(id) : '') + `<input class="n" value="${esc(e.name)}" title="имя">`
      + (CK === 'people' ? `<input class="a" value="${esc((e.aliases || []).join(', '))}" placeholder="псевдонимы через запятую">` : `<input class="a" value="${esc(e.group || '')}" placeholder="группа (студия, сцена, …)">`)
      + `<span class="cnt" title="показать в медиатеке">${uc[id] || 0}</span>`
      + `<select><option value="">объединить с…</option>${others.filter(o => o !== id).map(o => `<option value="${esc(o)}">${esc(name(o))}</option>`).join('')}</select>`
      + `<button class="del" title="удалить">✕</button>`;
    const [n, a] = r.querySelectorAll('input');
    n.onchange = async () => { if (await catOps([{ op: 'update', kind: CK, id, fields: { name: n.value } }])) toast('сохранено'); else n.value = e.name; };
    a.onchange = async () => {
      const f = CK === 'people' ? { aliases: a.value.split(',').map(s => s.trim()).filter(Boolean) } : { group: a.value.trim() };
      if (await catOps([{ op: 'update', kind: CK, id, fields: f }])) toast('сохранено');
    };
    r.querySelector('select').onchange = async ev => {
      const into = ev.target.value; if (!into) return;
      if (await catOps([{ op: 'merge', kind: CK, id, into }])) { toast(`«${e.name}» → «${name(into)}»`); renderCatalog(); }
    };
    const del = r.querySelector('.del');
    del.onclick = async () => {               // two clicks: no browser dialogs
      if (!del.dataset.arm) { del.dataset.arm = 1; del.textContent = 'точно?'; setTimeout(() => { delete del.dataset.arm; del.textContent = '✕'; }, 2500); return; }
      if (await catOps([{ op: 'delete', kind: CK, id }])) { toast('удалено: ' + e.name); renderCatalog(); }
    };
    r.querySelector('.cnt').onclick = () => {
      if (VIEW !== 'lib') return;
      FNONE = ''; (CK === 'people' ? FP : FT).clear(); (CK === 'people' ? FP : FT).add(id); closeCatalog();
    };
    box.appendChild(r);
  }
}
document.querySelectorAll('#catalog .tabs button').forEach(b => b.onclick = () => { CK = b.dataset.k; renderCatalog(); });
$('#catSearch').addEventListener('input', renderCatalog);
$('#catalog').onclick = e => { if (e.target.id === 'catalog') closeCatalog(); };
$('#catalogBtn').onclick = openCatalog;
$('#peopleSearch').addEventListener('input', e => { PSEARCH = norm(e.target.value); renderSide(); });
document.querySelectorAll('#groupBy button').forEach(b => b.onclick = () => setGroup(b.dataset.g));
setGroup(GROUP);

// ============================================================================ PLAYER
const video = $('#video'), stage = $('#stage'), zoomer = $('#zoomer'), dcv = $('#draw'), tl = $('#tl');
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
const NUMSPEED = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];
const PEN = ['#ff3b30', '#ffd60a', '#30d158', '#0a84ff', '#ffffff'];
const P = {
  rel: null, meta: null, marks: null, dir: 1, rate: 1, playing: false, vt: 0, last: 0,
  zoom: 1, fit: 1, panX: 0, panY: 0, vw: 1280, vh: 720,
  tlWin: 60, held: {}, latched: {}, undo: [], redo: [], sel: null,
  mode: '', stroke: null, strokes: [], pen: 0, penW: 6, proxy: false, scrubbing: false,
};

function trackDefs() { return curCfg().tracks || []; }
function trackOf(K) {
  const t = P.marks.tracks;
  if (!t[K]) { const d = trackDefs().find(x => x.key === K) || { label: K, color: '#aaa' }; t[K] = { label: d.label, color: d.color, spans: [] }; }
  return t[K];
}
// a track's id (its key in the marks) and the key that marks it may differ: config 'hot' — a letter, a digit, ` or 'alt+X'
const hotOf = t => (t.hot || t.key).toUpperCase();
const keyToTrack = (k, alt) => { const H = (alt ? 'ALT+' : '') + k.toUpperCase(); const t = trackDefs().find(t => hotOf(t) === H); return t ? t.key : null; };
const hotLabel = K => { const t = trackDefs().find(x => x.key === K); if (!t) return K.length === 1 ? K : '·'; const h = hotOf(t); return h.startsWith('ALT+') ? '⌥' + h.slice(4) : (KEY_RU[h] ? h + KEY_RU[h] : h); };
// russian layout: map physical keys to latin letters so marking works on any layout
const RU = { 'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o', 'з': 'p', 'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f', 'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.', 'х': '[', 'ъ': ']' };
const CODE_PUNCT = { Semicolon: ';', Quote: "'", Slash: '/', Backquote: '`' };   // ; ' / ` work as track keys on any layout (RU: ж э . ё)
function latin(e) {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (e.code && CODE_PUNCT[e.code] && !e.metaKey && !e.ctrlKey) return CODE_PUNCT[e.code];
  if (e.code && /^Digit\d$/.test(e.code)) return e.code.slice(5);          // Shift+1 still reads 1
  const k = e.key.toLowerCase(); return RU[k] || k;
}

async function openPlayer(rel) {
  stopQuick();
  VIEW = 'player'; $('#lib').classList.add('hidden'); $('#player').classList.remove('hidden');
  P.rel = rel; P.undo = []; P.redo = []; P.sel = null; P.msel = new Set(); P.box = null; P.held = {}; P.latched = {}; P.mode = ''; P.dir = 1; P.rate = 1; P.playing = false;
  $('#pTitle').textContent = (byRel[rel]?.code ? byRel[rel].code + ' · ' : '') + rel;
  P.meta = await api.get(`/api/meta?rel=${enc(rel)}`);
  await loadTimeline(); updateTlBtn();
  const pr = await api.get(`/api/proxy?rel=${enc(rel)}`);
  setSource(pr.status === 'done' && !['h264', 'vp9', 'av1', 'hevc', 'vp8'].includes(P.meta.codec));
  updateStatusBadge(); updateProxyBtn(pr.status); updatePeople();
  resizeTimeline();
}

async function loadTimeline() {
  const m = await api.get(`/api/marks?rel=${enc(P.rel)}${TLQ()}`);
  P.marks = Object.assign({ version: 1, status: 'unreviewed', note: '', tracks: {}, drawings: [] }, m || {});
  for (const t of trackDefs()) trackOf(t.key);
}
function updateTlBtn() { const b = $('#tlBtn'); if (b) { b.textContent = 'Таймлайн: ' + TLS[TLN]; b.classList.toggle('on', !!TLN); } }
async function switchTimeline() {
  clearTimeout(saveT); if (P.marks) await api.post(`/api/marks?rel=${enc(P.rel)}${TLQ()}`, P.marks);     // flush the one we leave
  const ks = Object.keys(TLS); TLN = ks[(ks.indexOf(TLN) + 1) % ks.length]; try { localStorage.setItem('rd.tl', TLN); } catch (e) {}
  P.sel = null; P.msel = new Set(); P.held = {}; P.latched = {}; P.undo = []; P.redo = [];
  await loadTimeline(); updateTlBtn(); resizeTimeline(); toast('таймлайн: ' + TLS[TLN]);
}

function setSource(proxy, keepTime) {
  const t = keepTime ? video.currentTime : 0;
  P.proxy = proxy;
  video.src = proxy ? `/media?rel=${enc(P.rel)}&proxy=1` : `/media?rel=${enc(P.rel)}`;
  video.onloadedmetadata = () => {
    P.vw = video.videoWidth || 1280; P.vh = video.videoHeight || 720;
    video.style.width = P.vw + 'px'; video.style.height = P.vh + 'px';
    dcv.width = P.vw; dcv.height = P.vh; dcv.style.width = P.vw + 'px'; dcv.style.height = P.vh + 'px';
    fitView(); video.currentTime = t; P.vt = t;
  };
  updateProxyBtn(proxy ? 'done' : null);
}

video.addEventListener('error', () => {
  if (VIEW !== 'player' || P.proxy) return;
  toast('Браузер не играет этот файл — делаю прокси…'); requestProxy(true);
});

function fitView() {
  const W = stage.clientWidth, H = stage.clientHeight;
  P.fit = Math.min(W / P.vw, H / P.vh); P.zoom = 1;
  P.panX = (W - P.vw * P.fit) / 2; P.panY = (H - P.vh * P.fit) / 2; applyZoom();
}
function applyZoom() {
  const s = P.fit * P.zoom;
  zoomer.style.transform = `translate(${P.panX}px, ${P.panY}px) scale(${s})`;
  $('#pZoom').textContent = Math.round(P.zoom * 100) + '%';
}
function zoomAt(f, sx, sy) {
  const W = stage.clientWidth, H = stage.clientHeight;
  if (sx === undefined) { sx = W / 2; sy = H / 2; }
  const s0 = P.fit * P.zoom; P.zoom = clamp(P.zoom * f, 1, 16); const s1 = P.fit * P.zoom;
  if (P.zoom === 1) return fitView();
  P.panX = sx - (sx - P.panX) * (s1 / s0); P.panY = sy - (sy - P.panY) * (s1 / s0); applyZoom();
}
stage.addEventListener('wheel', e => {
  if (VIEW !== 'player') return; e.preventDefault();
  const r = stage.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let drag = null;
stage.addEventListener('pointerdown', e => { if (P.mode === 'draw') return; drag = { x: e.clientX, y: e.clientY, px: P.panX, py: P.panY }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', e => { if (!drag) return; P.panX = drag.px + e.clientX - drag.x; P.panY = drag.py + e.clientY - drag.y; applyZoom(); });
stage.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('resize', () => { if (VIEW === 'player') { fitView(); resizeTimeline(); } });

// ---------------------------------------------------------------- transport
function play() {
  P.playing = true; P.vt = video.currentTime; P.last = performance.now();
  if (P.dir > 0) { video.playbackRate = P.rate; video.play().catch(() => {}); } else video.pause();
}
function pause() { P.playing = false; video.pause(); P.vt = video.currentTime; }
function togglePlay() { P.playing ? pause() : play(); }
function shuttle(d) {
  if (!P.playing || P.dir !== d) { P.dir = d; P.rate = 1; } else P.rate = Math.min(16, P.rate * 2);
  play();
}
function setRate(r) { P.rate = r; if (P.playing) play(); }
function stepRate(d) { let i = SPEEDS.findIndex(s => s >= P.rate - 1e-6); if (i < 0) i = SPEEDS.length - 1; setRate(SPEEDS[clamp(i + d, 0, SPEEDS.length - 1)]); }
function seekTo(t) { t = clamp(t, 0, video.duration || 0); video.currentTime = t; P.vt = t; }
function seekBy(dt) { seekTo((P.playing && P.dir < 0 ? P.vt : video.currentTime) + dt); }
function frameStep(d) { pause(); seekTo(video.currentTime + d / (P.meta.fps || 30)); }
const curT = () => (P.playing && P.dir < 0 ? P.vt : video.currentTime);

function tick(now) {
  requestAnimationFrame(tick);
  if (VIEW !== 'player' || !P.marks) return;
  const dt = Math.min(0.25, (now - P.last) / 1000); P.last = now;
  if (P.playing && P.dir < 0) {        // reverse: browsers can't play backwards, so we seek as fast as the decoder allows
    P.vt -= dt * P.rate;
    if (P.vt <= 0) { P.vt = 0; pause(); }
    if (!video.seeking) video.currentTime = P.vt;
  }
  const t = curT();
  for (const K in P.held) { const h = P.held[K]; h.min = Math.min(h.min, t); h.max = Math.max(h.max, t); }
  if (P.playing && P.dir > 0 && video.ended) pause();
  drawHud(t); drawTimeline(t); if (P.mode !== 'draw') drawSaved(t);
}
requestAnimationFrame(tick);

function drawHud(t) {
  const arrow = P.dir > 0 ? '▶' : '◀';
  $('#pSpeed').textContent = (P.playing ? arrow + (P.rate >= 2 ? arrow : '') : '❚❚ ' + arrow) + ' ' + (+P.rate.toFixed(2)) + '×';
  $('#pTime').textContent = fmt(t) + ' / ' + fmt(video.duration || P.meta?.duration || 0, false);
  const held = $('#held'); let html = '';
  for (const K in P.held) { const tr = trackOf(K); html += `<span style="background:${tr.color}">● ${K} ${tr.label} ${(P.held[K].max - P.held[K].min).toFixed(1)}s</span>`; }
  for (const K in P.marks.tracks) if (SHOW_SPEECH || !SPEECH.includes(K)) for (const sp of P.marks.tracks[K].spans)      // captions of the marks under the playhead
    if (sp[2] && t >= sp[0] - 0.05 && t <= Math.max(sp[1], sp[0] + 1) + 0.05) html += `<span style="background:${trackOf(K).color}">${K.startsWith('auto_') ? trackOf(K).label : K} · ${esc(sp[2])}</span>`;
  for (const K in P.latched) { const tr = trackOf(K); html += `<span style="background:${tr.color}">⏺ ${K} ${tr.label} с ${fmt(P.latched[K])}</span>`; }
  if (held.innerHTML !== html) held.innerHTML = html;
  $('#pMode').textContent = P.mode === 'draw' ? `РИСУНОК · цвет ${P.pen + 1} · ${P.penW}px · Enter сохранить` : '';
}

// ---------------------------------------------------------------- marks
function snapshot() { P.undo.push(JSON.stringify({ tracks: P.marks.tracks, drawings: P.marks.drawings })); if (P.undo.length > 200) P.undo.shift(); P.redo = []; }
function restore(s) { const o = JSON.parse(s); P.marks.tracks = o.tracks; P.marks.drawings = o.drawings; P.sel = null; P.msel = new Set(); save(); }
function undo() { if (!P.undo.length) return toast('нечего отменять'); P.redo.push(JSON.stringify({ tracks: P.marks.tracks, drawings: P.marks.drawings })); restore(P.undo.pop()); toast('отменено'); }
function redo() { if (!P.redo.length) return; P.undo.push(JSON.stringify({ tracks: P.marks.tracks, drawings: P.marks.drawings })); restore(P.redo.pop()); }

function addSpan(K, a, b) {
  snapshot();
  const tr = trackOf(K); a = +a.toFixed(3); b = +b.toFixed(3);
  if (b - a < 0.12) b = a;              // a quick tap is a point mark
  let spans = tr.spans.concat([[a, b]]).sort((x, y) => x[0] - y[0]); const out = [];
  for (const s of spans) {             // merge overlaps on the same track
    const l = out[out.length - 1];
    if (l && s[0] <= l[1] && s[1] - s[0] > 0 && l[1] - l[0] > 0) l[1] = Math.max(l[1], s[1]); else out.push(s.slice());
  }
  tr.spans = out; save();
  toast(`${K} · ${tr.label}: ${fmt(a)}${b > a ? ' – ' + fmt(b) : ''}`);
}
function deleteSel() {
  if (P.msel && P.msel.size) {                 // many selected: one undo step
    snapshot(); let n = 0;
    for (const K in P.marks.tracks) { const tr = P.marks.tracks[K], before = tr.spans.length; tr.spans = tr.spans.filter(x => !P.msel.has(x)); n += before - tr.spans.length; }
    P.msel = new Set(); P.sel = null; save(); return toast(`удалено ${n} меток · ⌘Z вернуть`);
  }
  if (!P.sel) return;
  snapshot();
  if (P.sel.K === '✎') P.marks.drawings.splice(P.sel.i, 1); else trackOf(P.sel.K).spans.splice(P.sel.i, 1);
  P.sel = null; save(); toast('удалено');
}
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const m = P.marks; m.duration = video.duration || P.meta.duration; m.fps = P.meta.fps; m.w = P.meta.w; m.h = P.meta.h;
    for (const K in m.tracks) { const d = trackDefs().find(x => x.key === K); if (d) { m.tracks[K].label = d.label; m.tracks[K].color = d.color; } }
    await api.post(`/api/marks?rel=${enc(P.rel)}${TLQ()}`, m);
    const v = byRel[P.rel]; if (v) { v.status = m.status; v.nspans = Object.values(m.tracks).reduce((a, t) => a + t.spans.length, 0); v.ndraw = m.drawings.length; }
  }, 300);
}
function setPStatus(s) { P.marks.status = s; save(); updateStatusBadge(); toast(s === 'defect' ? 'видео — брак' : s === 'ok' ? 'видео — OK' : 'отметка снята'); }
function updatePeople() {
  const ppl = vp(P.rel).map(pname), tg = vt(P.rel).map(id => '#' + tname(id));
  $('#pPeople').textContent = ppl.concat(tg).join(' · ');
}
function updateStatusBadge() {
  const b = $('#pStatus'), s = P.marks.status;
  b.className = 'badge ' + (s === 'ok' ? 'ok' : s === 'defect' ? 'defect' : ''); b.textContent = s === 'ok' ? 'OK' : s === 'defect' ? 'БРАК' : 'не отсмотрено';
}
function edges() {
  const e = [];
  for (const K in P.marks.tracks) for (const s of P.marks.tracks[K].spans) e.push(s[0], s[1]);
  for (const d of P.marks.drawings) e.push(d.t);
  return e.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- timeline (canvas)
const TL = { left: 130, ovH: 26, rulerH: 20, rowH: 22 };
let SHOW_AUX = false;                // tracks with no key in the config (agent's auto tracks, leftovers) are hidden unless asked for
try { SHOW_AUX = localStorage.getItem('rd.aux') === '1'; } catch (e) {}
const SPEECH = ['auto_speech', 'auto_expr'];   // the agent's speech layer (speechscan.py): its own switch, «Речь»
let SHOW_SPEECH = true;
try { SHOW_SPEECH = localStorage.getItem('rd.speech') !== '0'; } catch (e) {}
function rows() {
  const extra = Object.keys(P.marks?.tracks || {}).filter(K => !trackDefs().find(t => t.key === K) && (SPEECH.includes(K) ? SHOW_SPEECH :
    (SHOW_AUX || (K && !K.startsWith('auto') && P.marks.tracks[K].spans.length))));
  extra.sort((a, b) => SPEECH.includes(b) - SPEECH.includes(a));
  return trackDefs().map(t => t.key).concat(extra).concat(['✎']);
}
const KEY_RU = { ';': 'ж', "'": 'э', '`': 'ё', '/': '.' };   // what the punctuation keys print on the Russian layout
function resizeTimeline() {
  const n = rows().length;
  TL.rowH = clamp(Math.floor((window.innerHeight * 0.42 - TL.ovH - TL.rulerH - 18) / n), 13, 22);   // the timeline never eats the picture
  const h = TL.ovH + TL.rulerH + 10 + n * TL.rowH + 8;
  $('#timeline').style.height = h + 'px';
  const r = tl.getBoundingClientRect(); tl.width = r.width * devicePixelRatio; tl.height = h * devicePixelRatio;
  if (VIEW === 'player') fitView();
}
function win(t) { if (P.winLock) return P.winLock; const d = video.duration || P.meta?.duration || 1; const w = Math.min(P.tlWin, d); let a = t - w / 2; a = clamp(a, 0, Math.max(0, d - w)); return [a, a + w]; }
function drawTimeline(t) {
  const c = tl.getContext('2d'), dpr = devicePixelRatio, W = tl.width / dpr, H = tl.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const D = video.duration || P.meta.duration || 1, L = TL.left, R = W - 10, w = R - L;
  // overview: the whole file
  c.fillStyle = '#0b0c10'; c.fillRect(L, 4, w, TL.ovH - 8);
  const rs = rows();
  rs.forEach((K, i) => {
    if (K === '✎') return; const tr = P.marks.tracks[K]; if (!tr) return;
    c.fillStyle = tr.color; const y = 5 + i * ((TL.ovH - 10) / rs.length), h = Math.max(2, (TL.ovH - 10) / rs.length - 0.5);
    for (const s of tr.spans) c.fillRect(L + s[0] / D * w, y, Math.max(1.5, (s[1] - s[0]) / D * w), h);
  });
  const [a, b] = win(t);
  c.strokeStyle = 'rgba(255,204,51,.8)'; c.lineWidth = 1; c.strokeRect(L + a / D * w, 3, Math.max(2, (b - a) / D * w), TL.ovH - 6);
  c.fillStyle = '#fff'; c.fillRect(L + t / D * w - 1, 2, 2, TL.ovH - 4);
  c.fillStyle = '#8a90a0'; c.font = '11px -apple-system, sans-serif'; c.textBaseline = 'middle';
  c.fillText('весь файл', 10, TL.ovH / 2);
  // ruler of the detail window
  const y0 = TL.ovH + 4, X = tt => L + (tt - a) / (b - a) * w;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]; const step = steps.find(s => (b - a) / s <= w / 70) || 600;
  c.strokeStyle = '#2b2f3a'; c.fillStyle = '#8a90a0';
  for (let s = Math.ceil(a / step) * step; s <= b; s += step) { const x = X(s); c.beginPath(); c.moveTo(x, y0 + 12); c.lineTo(x, H); c.stroke(); c.fillText(fmt(s, step < 1), x + 3, y0 + 7); }
  c.fillText(`окно ${Math.round(b - a)} с  [ ]`, 10, y0 + 7);
  // rows
  const ry = y0 + TL.rulerH;
  const grp = K => (trackDefs().find(t => t.key === K) || {}).group || (K === '✎' ? '✎' : 'служебное');
  rs.forEach((K, i) => {
    const y = ry + i * TL.rowH;
    const sep = () => { if (i && grp(K) !== grp(rs[i - 1])) { c.fillStyle = '#5a6172'; c.fillRect(0, y, W, 2); } };   // a line between groups
    if (K === '✎') {
      sep();
      c.fillStyle = '#ff6ad5'; c.fillText('✎ рисунки', 10, y + TL.rowH / 2);
      P.marks.drawings.forEach((d, j) => {
        if (d.t < a || d.t > b) return; const x = X(d.t); const sel = P.sel && P.sel.K === '✎' && P.sel.i === j;
        c.fillStyle = sel ? '#fff' : '#ff6ad5'; c.beginPath(); c.moveTo(x, y + 3); c.lineTo(x + 6, y + TL.rowH / 2); c.lineTo(x, y + TL.rowH - 3); c.lineTo(x - 6, y + TL.rowH / 2); c.fill();
      });
      return;
    }
    const tr = trackOf(K); const live = P.held[K];
    c.fillStyle = live ? 'rgba(255,255,255,.07)' : (i % 2 ? 'rgba(255,255,255,.02)' : 'transparent'); c.fillRect(0, y, W, TL.rowH); sep();
    const bx = Math.min(10, TL.rowH - 6); c.fillStyle = tr.color; c.fillRect(10, y + (TL.rowH - bx) / 2, bx, bx);
    const kl = hotLabel(K);
    c.fillStyle = '#e6e8ee'; c.fillText(kl, 25, y + TL.rowH / 2); const lx = Math.max(42, 25 + c.measureText(kl).width + 6);   // ⌥T is wider than one letter
    let lab = (trackDefs().find(t => t.key === K) || tr).label || K;     // the config's name wins over the one saved with old marks while (lab.length > 1 && c.measureText(lab).width > TL.left - lx - 4) lab = lab.slice(0, -1);
    c.fillStyle = '#b8bdc9'; c.fillText(lab, lx, y + TL.rowH / 2);
    tr.spans.forEach((s, j) => {
      if (s[1] < a || s[0] > b) return; const x0 = X(Math.max(a, s[0])), x1 = X(Math.min(b, s[1]));
      const sel = (P.sel && P.sel.K === K && P.sel.i === j) || P.msel.has(s);
      c.fillStyle = tr.color; c.globalAlpha = sel ? 1 : 0.8;
      if (s[1] - s[0] <= 0) { c.beginPath(); c.arc(x0, y + TL.rowH / 2, 5, 0, 7); c.fill(); }
      else c.fillRect(x0, y + 3, Math.max(2, x1 - x0), TL.rowH - 6);
      c.globalAlpha = 1;
      if (sel) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.strokeRect(x0 - 1, y + 2, Math.max(4, x1 - x0) + 2, TL.rowH - 4); c.lineWidth = 1; }
      if (s[2]) { c.save(); c.fillStyle = '#fff'; c.shadowColor = '#000'; c.shadowBlur = 3; c.fillText(s[2], Math.max(x0, L) + 6, y + TL.rowH / 2); c.restore(); }
    });
    if (live) { c.fillStyle = tr.color; c.globalAlpha = 0.45; c.fillRect(X(live.min), y + 3, Math.max(2, X(live.max) - X(live.min)), TL.rowH - 6); c.globalAlpha = 1; }
    if (P.latched[K] !== undefined) { const lo = Math.min(P.latched[K], t), hi = Math.max(P.latched[K], t); c.strokeStyle = tr.color; c.setLineDash([4, 3]); c.strokeRect(X(lo), y + 3, Math.max(2, X(hi) - X(lo)), TL.rowH - 6); c.setLineDash([]); }
  });
  if (P.box) {                               // rubber band
    const ia = Math.min(P.box.r0, P.box.r1), ib = Math.max(P.box.r0, P.box.r1);
    c.fillStyle = 'rgba(255,204,51,.12)'; c.strokeStyle = '#ffcc33'; c.lineWidth = 1;
    const x0 = X(Math.min(P.box.t0, P.box.t1)), x1 = X(Math.max(P.box.t0, P.box.t1)), yA = ry + ia * TL.rowH, yB = ry + (ib + 1) * TL.rowH;
    c.fillRect(x0, yA, x1 - x0, yB - yA); c.strokeRect(x0, yA, x1 - x0, yB - yA);
  }
  if (P.msel.size) {
    const msg = `выделено ${P.msel.size} · Del удалить · тянуть — сдвинуть · Esc снять`, mw = c.measureText(msg).width;
    c.fillStyle = '#ffcc33'; c.fillRect(TL.left + 4, y0 - 2, mw + 12, 17); c.fillStyle = '#111'; c.fillText(msg, TL.left + 10, y0 + 7);
  }
  // playhead
  const px = X(t); c.fillStyle = '#ffcc33'; c.fillRect(px - 1, y0, 2, H - y0);
  c.beginPath(); c.moveTo(px - 6, y0); c.lineTo(px + 6, y0); c.lineTo(px, y0 + 8); c.fill();
}
function tlHit(e) {
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, W = r.width;
  const D = video.duration || P.meta.duration || 1, L = TL.left, w = W - 10 - L;
  if (y < TL.ovH) return { overview: clamp((x - L) / w, 0, 1) * D };
  const [a, b] = win(curT()); const tt = a + (x - L) / w * (b - a);
  const i = Math.floor((y - TL.ovH - 4 - TL.rulerH) / TL.rowH); const K = rows()[i];
  return { t: tt, K, x, tol: (b - a) / w * 6 };
}
// marks are edited with the mouse: drag the body to move, drag an edge to resize; a click seeks to the mark
function markAt(h, x) {
  if (!h.K || h.K === '✎') return null;
  const sp = P.marks.tracks[h.K]?.spans || []; const [a, b] = win(curT());
  const w = tl.getBoundingClientRect().width - 10 - TL.left, X = tt => TL.left + (tt - a) / (b - a) * w;
  for (let j = sp.length - 1; j >= 0; j--) {
    const s = sp[j]; if (!(h.t >= s[0] - h.tol && h.t <= s[1] + h.tol)) continue;
    if (s[1] - s[0] <= 0) return { K: h.K, i: j, mode: 'move' };
    const mode = Math.abs(x - X(s[0])) <= 6 ? 'start' : Math.abs(x - X(s[1])) <= 6 ? 'end' : 'move';
    return { K: h.K, i: j, mode };
  }
  return null;
}
tl.addEventListener('pointerdown', e => {
  const h = tlHit(e);
  if (h.overview !== undefined) { seekTo(h.overview); P.scrubbing = 'ov'; tl.setPointerCapture(e.pointerId); return; }
  const rowIdx = y => clamp(Math.floor((y - TL.ovH - 4 - TL.rulerH) / TL.rowH), 0, rows().length - 1);
  const ly = e.clientY - tl.getBoundingClientRect().top;
  if (e.clientX - tl.getBoundingClientRect().left < TL.left) {     // click a track's name: select its marks in view (Shift: the whole file)
    const K = rows()[rowIdx(ly)]; if (!K || K === '✎' || !P.marks.tracks[K]) return;
    const [a, b] = win(curT()); if (!(e.metaKey || e.ctrlKey)) P.msel = new Set();
    for (const sp of P.marks.tracks[K].spans) if (e.shiftKey || (sp[1] >= a && sp[0] <= b)) P.msel.add(sp);
    P.sel = null; toast(`${K}: выделено ${P.msel.size}`); return;
  }
  if (e.shiftKey && h.t !== undefined) {                            // Shift-drag: rubber band over rows and time
    if (!(e.metaKey || e.ctrlKey)) P.msel = new Set();
    P.box = { t0: h.t, t1: h.t, r0: rowIdx(ly), r1: rowIdx(ly) }; P.winLock = win(curT()); P.sel = null; tl.setPointerCapture(e.pointerId); return;
  }
  if ((e.metaKey || e.ctrlKey) && h.K && h.K !== '✎') {             // Cmd-click: add / remove one mark
    const m = markAt(h, h.x);
    if (m) { const sp = P.marks.tracks[m.K].spans[m.i]; P.msel.has(sp) ? P.msel.delete(sp) : P.msel.add(sp); if (P.sel) { const s0 = trackOf(P.sel.K).spans[P.sel.i]; if (s0) P.msel.add(s0); } P.sel = null; }
    return;
  }
  P.sel = null;
  if (h.K === '✎') { const j = P.marks.drawings.findIndex(d => Math.abs(d.t - h.t) < h.tol); if (j >= 0) { P.sel = { K: '✎', i: j }; seekTo(P.marks.drawings[j].t); pause(); return; } }
  else {
    const m = markAt(h, h.x);
    if (m) {
      const span = P.marks.tracks[m.K].spans[m.i];
      const group = P.msel.has(span) && P.msel.size > 1 && m.mode === 'move';
      if (!group) P.msel = new Set();
      P.sel = { K: m.K, i: m.i }; P.winLock = win(curT());
      P.edit = { ...m, span, t0: h.t, orig: span.slice(), moved: false, group: group ? [...P.msel].map(sp => [sp, sp.slice()]) : null };
      tl.setPointerCapture(e.pointerId); return;
    }
  }
  P.msel = new Set();
  seekTo(h.t); P.scrubbing = 'detail'; P.scrubX = e.clientX; P.scrubT = h.t; tl.setPointerCapture(e.pointerId);
});
tl.addEventListener('pointermove', e => {
  if (P.box) { const h = tlHit(e); if (h.t !== undefined) { P.box.t1 = h.t; P.box.r1 = clamp(Math.floor((e.clientY - tl.getBoundingClientRect().top - TL.ovH - 4 - TL.rulerH) / TL.rowH), 0, rows().length - 1); } return; }
  const ed = P.edit;
  if (ed) {
    const h = tlHit(e); if (h.t === undefined) return;
    const D = video.duration || P.meta.duration || 1, dt = h.t - ed.t0, [a0, b0] = ed.orig, s = ed.span;
    if (!ed.moved) { if (Math.abs(dt) < h.tol / 3) return; ed.moved = true; P.undo.push(JSON.stringify({ tracks: P.marks.tracks, drawings: P.marks.drawings })); P.redo = []; pause(); }
    const fr = 1 / (P.meta.fps || 30), q = v => Math.round(v / fr) * fr;    // edges land on frames
    if (ed.group) {                                            // several selected: they all move by the same amount
      const lo = Math.min(...ed.group.map(g => g[1][0])), hi = Math.max(...ed.group.map(g => g[1][1])), d = q(clamp(dt, -lo, D - hi));
      for (const [sp, o] of ed.group) { sp[0] = +(o[0] + d).toFixed(3); sp[1] = +(o[1] + d).toFixed(3); }
      seekTo(s[0]);
    }
    else if (ed.mode === 'move') { const d = clamp(dt, -a0, D - b0); s[0] = +q(a0 + d).toFixed(3); s[1] = +(s[0] + (b0 - a0)).toFixed(3); seekTo(s[0]); }
    else if (ed.mode === 'start') { s[0] = +q(clamp(a0 + dt, 0, s[1])).toFixed(3); seekTo(s[0]); }
    else { s[1] = +q(clamp(b0 + dt, s[0], D)).toFixed(3); seekTo(s[1]); }
    return;
  }
  if (!P.scrubbing) {                     // hover: show what a drag would do
    const h = tlHit(e), m = h.overview === undefined ? markAt(h, h.x) : null;
    tl.style.cursor = !m ? '' : m.mode === 'move' ? 'grab' : 'ew-resize'; return;
  }
  if (P.scrubbing === 'ov') { const h = tlHit(e); seekTo(h.overview ?? 0); return; }
  const r = tl.getBoundingClientRect(), w = r.width - 10 - TL.left; const [a, b] = win(P.scrubT);
  seekTo(P.scrubT + (e.clientX - P.scrubX) / w * (b - a));
});
tl.addEventListener('pointerup', () => {
  if (P.box) {                                 // close the rubber band: every mark it touches is selected
    const b = P.box, ta = Math.min(b.t0, b.t1), tb = Math.max(b.t0, b.t1), rs = rows();
    for (let i = Math.min(b.r0, b.r1); i <= Math.max(b.r0, b.r1); i++) {
      const K = rs[i]; if (!K || K === '✎' || !P.marks.tracks[K]) continue;
      for (const sp of P.marks.tracks[K].spans) if (sp[1] >= ta && sp[0] <= tb) P.msel.add(sp);
    }
    P.box = null; P.winLock = null; toast(`выделено ${P.msel.size}`); return;
  }
  const ed = P.edit;
  if (ed) {
    P.edit = null; P.winLock = null;
    if (ed.moved) {
      for (const K in P.marks.tracks) P.marks.tracks[K].spans.sort((x, y) => x[0] - y[0]);
      const tr = P.marks.tracks[ed.K]; P.sel = ed.group ? null : { K: ed.K, i: tr.spans.indexOf(ed.span) };
      save(); toast(`${ed.K}: ${fmt(ed.span[0])}${ed.span[1] > ed.span[0] ? ' – ' + fmt(ed.span[1]) : ''}`);
    } else { seekTo(ed.span[0]); pause(); }
  }
  P.scrubbing = false;
});
// keyboard editing of the selected mark: ⌥⇧←/→ moves it by a frame, { } put its start / end at the playhead
function nudgeSel(df) {
  if (P.msel.size) {
    snapshot(); const fr = 1 / (P.meta.fps || 30), D = video.duration || P.meta.duration, L = [...P.msel];
    const d = clamp(df * fr, -Math.min(...L.map(s => s[0])), D - Math.max(...L.map(s => s[1])));
    for (const s of L) { s[0] = +(s[0] + d).toFixed(3); s[1] = +(s[1] + d).toFixed(3); } save(); return;
  }
  if (!P.sel || P.sel.K === '✎') return toast('сначала выбери метку на таймлайне');
  snapshot(); const s = trackOf(P.sel.K).spans[P.sel.i], fr = 1 / (P.meta.fps || 30), D = video.duration || P.meta.duration;
  const d = clamp(df * fr, -s[0], D - s[1]); s[0] = +(s[0] + d).toFixed(3); s[1] = +(s[1] + d).toFixed(3); seekTo(s[0]); save();
}
function edgeToPlayhead(which) {
  if (!P.sel || P.sel.K === '✎') return toast('сначала выбери метку на таймлайне');
  snapshot(); const s = trackOf(P.sel.K).spans[P.sel.i], t = +curT().toFixed(3);
  if (s[1] - s[0] <= 0) { s[0] = s[1] = t; }
  else if (which === 'start') s[0] = Math.min(t, s[1]); else s[1] = Math.max(t, s[0]);
  const tr = trackOf(P.sel.K); tr.spans.sort((x, y) => x[0] - y[0]); P.sel.i = tr.spans.indexOf(s); save();
  toast(`${P.sel.K}: ${fmt(s[0])}${s[1] > s[0] ? ' – ' + fmt(s[1]) : ''}`);
}
tl.addEventListener('wheel', e => { e.preventDefault(); P.tlWin = clamp(P.tlWin * Math.exp(e.deltaY * 0.002), 5, 7200); }, { passive: false });

// ---------------------------------------------------------------- drawing on still frames
function enterDraw() { pause(); P.mode = 'draw'; P.strokes = []; stage.classList.add('drawing'); clearDraw(); }
function clearDraw() { dcv.getContext('2d').clearRect(0, 0, dcv.width, dcv.height); }
function paintStrokes(strokes, alpha = 1) {
  const c = dcv.getContext('2d'); c.lineCap = 'round'; c.lineJoin = 'round'; c.globalAlpha = alpha;
  for (const s of strokes) {
    c.strokeStyle = s.c; c.lineWidth = s.w * dcv.width / 1000; c.beginPath();
    s.pts.forEach((p, i) => { const x = p[0] * dcv.width, y = p[1] * dcv.height; i ? c.lineTo(x, y) : c.moveTo(x, y); });
    if (s.pts.length === 1) c.lineTo(s.pts[0][0] * dcv.width + 0.1, s.pts[0][1] * dcv.height);
    c.stroke();
  }
  c.globalAlpha = 1;
}
dcv.addEventListener('pointerdown', e => {
  if (P.mode !== 'draw') return; dcv.setPointerCapture(e.pointerId);
  P.stroke = { c: PEN[P.pen], w: P.penW, pts: [[e.offsetX / dcv.clientWidth, e.offsetY / dcv.clientHeight]] }; P.strokes.push(P.stroke);
});
dcv.addEventListener('pointermove', e => {
  if (!P.stroke) return; P.stroke.pts.push([+(e.offsetX / dcv.clientWidth).toFixed(4), +(e.offsetY / dcv.clientHeight).toFixed(4)]);
  clearDraw(); paintStrokes(P.strokes);
});
dcv.addEventListener('pointerup', () => { P.stroke = null; });
async function saveDraw() {
  const t = +video.currentTime.toFixed(3);
  if (P.strokes.length) {
    const off = document.createElement('canvas'); off.width = P.vw; off.height = P.vh; const c = off.getContext('2d');
    c.drawImage(video, 0, 0, P.vw, P.vh); c.drawImage(dcv, 0, 0);
    const r = await api.post(`/api/drawing?rel=${enc(P.rel)}`, { t, png: off.toDataURL('image/png') });
    snapshot(); P.marks.drawings.push({ t, png: r.abs, strokes: P.strokes }); P.marks.drawings.sort((a, b) => a.t - b.t); save();
    toast('рисунок сохранён · ' + fmt(t));
  }
  exitDraw();
}
function exitDraw() { P.mode = ''; P.strokes = []; P.stroke = null; stage.classList.remove('drawing'); clearDraw(); lastDrawn = null; }
let lastDrawn = null;
function drawSaved(t) {      // show saved drawings around their frame
  const near = P.marks.drawings.filter(d => Math.abs(d.t - t) < (P.playing ? 0.35 : 0.08));
  const key = near.map(d => d.t).join(',');
  if (key === lastDrawn) return; lastDrawn = key; clearDraw(); for (const d of near) paintStrokes(d.strokes, P.playing ? 0.6 : 1);
}

// ---------------------------------------------------------------- proxy
async function requestProxy(auto) {
  const r = await api.post(`/api/proxy?rel=${enc(P.rel)}`, {}); updateProxyBtn(r.status);
  if (r.status === 'done') return setSource(true, true);
  const rel = P.rel; toast('прокси готовится…');
  const poll = setInterval(async () => {
    const s = await api.get(`/api/proxy?rel=${enc(rel)}`); if (P.rel === rel) updateProxyBtn(s.status);
    if (s.status === 'done') { clearInterval(poll); if (P.rel === rel) { setSource(true, true); toast('прокси готов: обратная перемотка плавная'); } }
    if (s.status === 'error') { clearInterval(poll); toast('прокси не получился'); }
  }, 2000);
}
function updateProxyBtn(st) {
  const b = $('#proxyBtn');
  b.textContent = P.proxy ? 'Прокси ✓' : st === 'running' || st === 'queued' ? 'Прокси…' : st === 'done' ? 'Прокси (есть)' : 'Прокси';
  b.classList.toggle('on', P.proxy);
}
$('#proxyBtn').onclick = async () => {
  const s = await api.get(`/api/proxy?rel=${enc(P.rel)}`);
  if (s.status === 'done') setSource(!P.proxy, true); else requestProxy();
};

// ---------------------------------------------------------------- navigation
function backToLib() {
  pause(); exitDraw(); clearTimeout(saveT); if (P.marks) save();
  video.removeAttribute('src'); video.load();
  VIEW = 'lib'; $('#player').classList.add('hidden'); $('#lib').classList.remove('hidden');
  setTimeout(() => loadLibrary(true), 400);
}
function nextVideo(d) {
  let i = FLAT.findIndex(x => x.v.rel === P.rel), j = i + d;
  while (j >= 0 && j < FLAT.length && FLAT[j].v.rel === P.rel) j += d;      // grouped by participant, the same video may repeat
  if (i < 0 || j < 0 || j >= FLAT.length) return toast('это крайнее видео');
  clearTimeout(saveT); save(); SEL = j; openPlayer(FLAT[j].v.rel);
}

function playerKeyDown(e) {
  const k = e.key, l = latin(e), cmd = e.metaKey || e.ctrlKey;
  if (P.mode === 'draw') {
    if (k === 'Escape') exitDraw();
    else if (k === 'Enter' || l === 'p') saveDraw();
    else if (k >= '1' && k <= '5') P.pen = +k - 1;
    else if (l === '[') P.penW = Math.max(2, P.penW - 2);
    else if (l === ']') P.penW = Math.min(40, P.penW + 2);
    else if (cmd && l === 'z') { P.strokes.pop(); clearDraw(); paintStrokes(P.strokes); }
    else return;
    return e.preventDefault();
  }
  if (cmd && l === 'z') { e.shiftKey ? redo() : undo(); return e.preventDefault(); }
  if (cmd && l === 'a') {                       // every mark in the visible window (Shift: the whole file)
    const [a, b] = win(curT()); P.msel = new Set(); P.sel = null;
    for (const K in P.marks.tracks) for (const sp of P.marks.tracks[K].spans) if (e.shiftKey || (sp[1] >= a && sp[0] <= b)) P.msel.add(sp);
    toast(`выделено ${P.msel.size}`); return e.preventDefault();
  }
  if (e.ctrlKey && k.startsWith('Arrow')) {
    const d = 60; if (k === 'ArrowLeft') P.panX += d; if (k === 'ArrowRight') P.panX -= d; if (k === 'ArrowUp') P.panY += d; if (k === 'ArrowDown') P.panY -= d;
    applyZoom(); return e.preventDefault();
  }
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { $('#help').classList.toggle('hidden'); return e.preventDefault(); }   // ? stays help even with / as a track key
  // marking keys first: hold = span, Shift = latch
  const K = !cmd ? keyToTrack(l, e.altKey) : null;
  if (K) {
    if (!e.repeat) {
      const t = curT();
      if (e.shiftKey) { if (P.latched[K] === undefined) { P.latched[K] = t; toast(`${K}: начало ${fmt(t)}`); } else { const a = P.latched[K]; delete P.latched[K]; addSpan(K, Math.min(a, t), Math.max(a, t)); } }
      else if (!P.held[K]) P.held[K] = { t0: t, min: t, max: t };
    }
    return e.preventDefault();
  }
  if (k === ' ') togglePlay();
  // left hand (right one on the mouse): Tab / ` seek, ⌥3 ⌥4 ⌥5 speed, ⌥Z ⌥C frame, ⌥X delete, ⌥Tab next video, ⌥R direction.
  // No track sits on ⌥: a track key is held while Space is pressed, and ⌥Space is a system shortcut (Spotlight)
  else if (k === 'Tab' && e.altKey) nextVideo(e.shiftKey ? -1 : 1);
  else if (k === 'Tab') seekBy(e.shiftKey ? -10 : -2);
  else if (l === '`') seekBy(e.shiftKey ? 10 : 2);
  else if (l === '3' && e.altKey) stepRate(-1);
  else if (l === '4' && e.altKey) stepRate(1);
  else if (l === '5' && e.altKey) setRate(1);
  else if (e.altKey && (l === 'z' || l === 'c')) frameStep(l === 'z' ? -1 : 1);
  else if (e.altKey && l === 'x') deleteSel();
  else if (e.altKey && l === 'r') { P.dir = -P.dir; if (P.playing) play(); }
  else if (l === 'l') shuttle(1);
  else if (l === 'j') shuttle(-1);
  else if (l === 'k') pause();
  else if (k === 'ArrowUp') stepRate(1);
  else if (k === 'ArrowDown') stepRate(-1);
  else if (k === '0') setRate(1);
  else if (k >= '6' && k <= '9' && !e.shiftKey) setRate(NUMSPEED[+k - 1]);
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.altKey && e.shiftKey) nudgeSel(k === 'ArrowLeft' ? -1 : 1);
  else if (l === '[' && e.shiftKey) edgeToPlayhead('start');
  else if (l === ']' && e.shiftKey) edgeToPlayhead('end');
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const s = k === 'ArrowLeft' ? -1 : 1;
    if (e.altKey) frameStep(s); else seekBy(s * (e.metaKey ? 60 : e.shiftKey ? 10 : 2));
  }
  else if (l === ',' || k === '<') frameStep(-1);
  else if (l === '.' || k === '>') frameStep(1);
  else if (k === 'Home') seekTo(0);
  else if (k === 'End') seekTo((video.duration || 0) - 0.05);
  else if (k === 'PageUp') { const t = curT(), e2 = edges().filter(x => x < t - 0.05); if (e2.length) seekTo(e2[e2.length - 1]); }
  else if (k === 'PageDown') { const t = curT(), e2 = edges().find(x => x > t + 0.05); if (e2 !== undefined) seekTo(e2); }
  else if (k === '=' || k === '+') zoomAt(1.25);
  else if (k === '-' || k === '_') zoomAt(0.8);
  else if (k === '\\') fitView();
  else if (l === '[') P.tlWin = clamp(P.tlWin / 1.5, 5, 7200);
  else if (l === ']') P.tlWin = clamp(P.tlWin * 1.5, 5, 7200);
  else if (l === 'p' && e.shiftKey) requestProxy();
  else if (l === 'p') enterDraw();
  else if (l === 'o') setPStatus('ok');
  else if (l === 'u') setPStatus('unreviewed');
  else if (l === 'i') openTagger('people', [P.rel]);
  else if (l === 'n' && P.sel && P.sel.K !== '✎') {          // a selected mark gets its own caption: [start, end, "text"]
    const sp = trackOf(P.sel.K).spans[P.sel.i], n = prompt(`Подпись к метке ${P.sel.K} ${fmt(sp[0])}`, sp[2] || '');
    if (n !== null) { snapshot(); if (n.trim()) sp[2] = n.trim(); else sp.length = 2; save(); }
  }
  else if (l === 'n') { const n = prompt('Заметка к видео', P.marks.note || ''); if (n !== null) { P.marks.note = n; save(); } }
  else if (k === 'Delete' || k === 'Backspace') deleteSel();
  else if (k === 'Escape') { if (P.msel.size) { P.msel = new Set(); toast('выделение снято'); } else if (P.sel) P.sel = null; else backToLib(); }
  else if (k === '?') $('#help').classList.toggle('hidden');
  else return;
  e.preventDefault();
}
function playerKeyUp(e) {
  const l = latin(e).toUpperCase(), K = Object.keys(P.held).find(K => { const t = trackDefs().find(x => x.key === K); return t && hotOf(t).replace('ALT+', '') === l; });
  if (K && P.held[K]) { const h = P.held[K]; delete P.held[K]; const t = curT(); addSpan(K, Math.min(h.min, t), Math.max(h.max, t)); }
}
window.addEventListener('blur', () => { for (const K in P.held) { const h = P.held[K]; delete P.held[K]; addSpan(K, h.min, h.max); } });

// ============================================================================ global wiring
document.addEventListener('keydown', e => {
  if (typing()) { if (e.key === 'Escape') { document.activeElement.blur(); if (!$('#catalog').classList.contains('hidden')) closeCatalog(); } return; }
  if (!$('#catalog').classList.contains('hidden')) { if (e.key === 'Escape') { closeCatalog(); e.preventDefault(); } return; }
  if (!$('#tagger').classList.contains('hidden')) { if (e.key === 'Escape') { closeTagger(); e.preventDefault(); } return; }
  for (const o of ['#help', '#settings']) if (!$(o).classList.contains('hidden')) { if (e.key === 'Escape' || e.key === '?') { $(o).classList.add('hidden'); e.preventDefault(); } return; }
  VIEW === 'player' ? playerKeyDown(e) : libKey(e);
});
document.addEventListener('keyup', e => { if (VIEW === 'player' && !typing()) playerKeyUp(e); });

$('#rootBtn').onclick = async () => {
  const r = await api.post('/api/root', { path: $('#rootInput').value.trim() });
  if (r.error) return toast(r.error);
  FOLDER = null; SEL = 0; FP.clear(); FT.clear(); FNONE = ''; MSEL.clear();
  loadLibrary();
};
$('#rootInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#rootBtn').click(); });
$('#search').addEventListener('input', e => { SEARCH = e.target.value.toLowerCase(); renderGrid(); });
document.querySelectorAll('#filters button').forEach(b => b.onclick = () => {
  FILTER = b.dataset.f; document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b)); renderGrid();
});
$('#exportBtn').onclick = async () => { const r = await api.get('/api/export'); toast(`all.json: ${Object.keys(r.videos).length} видео`); };
$('#backBtn').onclick = backToLib;
$('#pTagBtn').onclick = () => openTagger('people', [P.rel]);
$('#auxBtn').classList.toggle('on', SHOW_AUX);
$('#speechBtn').classList.toggle('on', SHOW_SPEECH);
$('#tlBtn').onclick = () => switchTimeline(); updateTlBtn();
$('#speechBtn').onclick = () => { SHOW_SPEECH = !SHOW_SPEECH; try { localStorage.setItem('rd.speech', SHOW_SPEECH ? '1' : '0'); } catch (e) {} $('#speechBtn').classList.toggle('on', SHOW_SPEECH); resizeTimeline(); };
$('#auxBtn').onclick = () => { SHOW_AUX = !SHOW_AUX; try { localStorage.setItem('rd.aux', SHOW_AUX ? '1' : '0'); } catch (e) {} $('#auxBtn').classList.toggle('on', SHOW_AUX); resizeTimeline(); };
$('#helpBtn1').onclick = $('#helpBtn2').onclick = () => $('#help').classList.remove('hidden');
$('#help').onclick = e => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };

// settings: key -> label / colour
function renderTrackRows() {
  const box = $('#trackRows'); box.innerHTML = '';
  for (const t of curCfg().tracks) {
    const r = document.createElement('div'); r.className = 'row';
    r.dataset.group = t.group || '';
    r.innerHTML = `<input class="k" maxlength="1" value="${t.key}" title="код дорожки в разметке"><input class="h" value="${t.hot || ''}" placeholder="${t.key}" title="клавиша: буква, цифра или alt+буква"><input class="l" value="${t.label.replace(/"/g, '&quot;')}"><input type="color" value="${t.color}"><button>✕</button>`;
    r.querySelector('button').onclick = () => r.remove(); box.appendChild(r);
  }
}
$('#settingsBtn').onclick = () => { renderTrackRows(); $('#settings').classList.remove('hidden'); };
$('#settings').onclick = e => { if (e.target.id === 'settings') $('#settings').classList.add('hidden'); };
$('#addTrack').onclick = () => { curCfg().tracks = readTrackRows(); curCfg().tracks.push({ key: '', label: '', color: '#cccccc' }); renderTrackRows(); };
function readTrackRows() {
  return [...document.querySelectorAll('#trackRows .row')].map(r => ({ key: r.querySelector('.k').value.toUpperCase(), ...(r.querySelector('.h').value.trim() ? { hot: r.querySelector('.h').value.trim().toUpperCase().replace('⌥', 'ALT+') } : {}), label: r.querySelector('.l').value, color: r.querySelector('[type=color]').value, ...(r.dataset.group ? { group: r.dataset.group } : {}) }));
}
const RESERVED = ['J', 'K', 'L', 'P', 'O', 'U', 'N', 'I', '`'];   // playback / tools keys
$('#saveTracks').onclick = async () => {
  const tr = readTrackRows().filter(t => /^[A-Z;'\/`]$/.test(t.key));
  const bad = tr.filter(t => RESERVED.includes(hotOf(t))); if (bad.length) return toast(`клавиши ${RESERVED.join(' ')} заняты управлением`);
  const hs = tr.map(hotOf); if (new Set(hs).size < hs.length) return toast('одна клавиша на двух дорожках');
  if (hs.some(h => h.startsWith('SHIFT+'))) return toast('Shift занят защёлкой (начало/конец метки) — выбери букву или цифру');
  if (hs.some(h => h.startsWith('ALT+'))) toast('⌥ у дорожки: с зажатым ⌥ пробел вызовет Spotlight');
  curCfg().tracks = tr; await api.post('/api/config' + (TLN ? `?tl=${TLN}` : ''), curCfg()); $('#settings').classList.add('hidden');
  if (P.marks) { for (const t of tr) trackOf(t.key); save(); resizeTimeline(); }
  toast('дорожки сохранены');
};

// clicked buttons must not keep focus: Space / Enter belong to the player
document.addEventListener('mouseup', () => { if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur(); });
loadLibrary();
