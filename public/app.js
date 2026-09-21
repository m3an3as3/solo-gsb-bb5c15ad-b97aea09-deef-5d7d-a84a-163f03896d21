'use strict';

/* ---------- 全局状态 ---------- */
const S = {
  cues: [],
  deps: [],
  canUndo: false,
  lastUndoLabel: null,
  pxPerMs: 0.1, // 100px / 秒
  filterTrack: '__ALL__',
  selectedId: null,
};

const ROW_H = 64;
const SNAP_MS = 100;
const ALL = '__ALL__';

const $ = (sel) => document.querySelector(sel);
const elTracks = $('#tracks');
const elRuler = $('#ruler');
const elDepLayer = $('#dep-layer');
const elInner = $('#timeline-inner');

/* ---------- API ---------- */
async function api(url, options) {
  const res = await fetch(url, options);
  return res.json();
}
async function refresh() {
  const st = await api('/api/state');
  applyState(st);
}
function applyState(st) {
  if (!st) return;
  S.cues = st.cues;
  S.deps = st.deps;
  S.canUndo = st.canUndo;
  S.lastUndoLabel = st.lastUndoLabel;
  render();
}

/* ---------- 工具 ---------- */
const fmtS = (ms) => (ms / 1000).toFixed(1) + 's';
const cueById = (id) => S.cues.find((c) => c.id === id);
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// 客户端级联集合（与服务端同一逻辑：沿“完成后触发”依赖拓扑可达）
function cascadeIds(startId) {
  const succMap = new Map();
  for (const d of S.deps) {
    if (!succMap.has(d.pred_id)) succMap.set(d.pred_id, []);
    succMap.get(d.pred_id).push(d.succ_id);
  }
  const out = [];
  const seen = new Set([startId]);
  const q = [startId];
  while (q.length) {
    const cur = q.shift();
    out.push(cur);
    for (const nxt of succMap.get(cur) || []) {
      if (!seen.has(nxt)) { seen.add(nxt); q.push(nxt); }
    }
  }
  return out;
}

function visibleTracks() {
  const tracks = [...new Set(S.cues.map((c) => c.track))];
  return S.filterTrack === ALL ? tracks : tracks.filter((t) => t === S.filterTrack);
}

/* ---------- 渲染 ---------- */
function render() {
  const tracks = visibleTracks();
  const maxEnd = Math.max(60000, ...S.cues.map((c) => c.start_ms + c.duration_ms)) + 30000;
  const width = Math.max(elInner.clientWidth, maxEnd * S.pxPerMs + 120);
  elInner.style.width = width + 'px';

  renderRuler(width);
  renderFilter(tracks);

  // 轨道与提示块
  elTracks.innerHTML = '';
  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = 'track-row';
    const label = document.createElement('div');
    label.className = 'track-label';
    label.textContent = track;
    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.track = track;
    row.append(label, lane);
    elTracks.appendChild(row);

    for (const cue of S.cues.filter((c) => c.track === track)) {
      lane.appendChild(cueEl(cue));
    }
  }
  renderDeps(tracks);
  renderEditor();
  renderUndo();
}

function renderRuler(width) {
  elRuler.innerHTML = '';
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const step = steps.find((s) => s * S.pxPerMs >= 70) || 300000;
  for (let t = 0; t * S.pxPerMs < width; t += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = t * S.pxPerMs + 'px';
    tick.textContent = fmtS(t);
    elRuler.appendChild(tick);
  }
}

function renderFilter(tracks) {
  const sel = $('#track-filter');
  const cur = S.filterTrack;
  sel.innerHTML = `<option value="${ALL}">全部轨道</option>` +
    [...new Set(S.cues.map((c) => c.track))]
      .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : ALL;
  S.filterTrack = sel.value;

  $('#track-list').innerHTML = [...new Set(S.cues.map((c) => c.track))]
    .map((t) => `<option value="${esc(t)}">`).join('');
}

function cueEl(cue) {
  const div = document.createElement('div');
  div.className = `cue ${cue.type}${cue.locked ? ' locked' : ''}${cue.id === S.selectedId ? ' selected' : ''}`;
  div.dataset.id = cue.id;
  div.style.left = cue.start_ms * S.pxPerMs + 'px';
  div.style.width = Math.max(24, cue.duration_ms * S.pxPerMs) + 'px';
  div.title = `${cue.name}｜${fmtS(cue.start_ms)} → ${fmtS(cue.start_ms + cue.duration_ms)}`;
  div.innerHTML =
    `<div class="cue-name">${cue.locked ? '🔒 ' : ''}${cue.type === 'light' ? '💡' : '🔊'} ${esc(cue.name)}</div>` +
    `<div class="cue-meta">${fmtS(cue.start_ms)} · 持续 ${fmtS(cue.duration_ms)}</div>`;
  div.addEventListener('pointerdown', onDragStart);
  div.addEventListener('click', () => { S.selectedId = cue.id; render(); });
  return div;
}

function renderDeps(tracks) {
  const rowIndex = new Map(tracks.map((t, i) => [t, i]));
  const w = elInner.style.width;
  const h = tracks.length * ROW_H;
  elDepLayer.setAttribute('width', parseFloat(w));
  elDepLayer.setAttribute('height', h);
  elDepLayer.style.width = w;
  elDepLayer.style.height = h + 'px';
  elDepLayer.innerHTML =
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="#7c8194" stroke-width="1.6"/></marker></defs>';
  for (const d of S.deps) {
    const pred = cueById(d.pred_id);
    const succ = cueById(d.succ_id);
    if (!pred || !succ) continue;
    if (!rowIndex.has(pred.track) || !rowIndex.has(succ.track)) continue;
    const x1 = (pred.start_ms + pred.duration_ms) * S.pxPerMs;
    const y1 = rowIndex.get(pred.track) * ROW_H + ROW_H / 2;
    const x2 = succ.start_ms * S.pxPerMs;
    const y2 = rowIndex.get(succ.track) * ROW_H + ROW_H / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 4} ${y2}`);
    path.setAttribute('marker-end', 'url(#arrow)');
    path.dataset.pred = d.pred_id;
    path.dataset.succ = d.succ_id;
    elDepLayer.appendChild(path);
  }
}

function renderUndo() {
  const btn = $('#btn-undo');
  btn.disabled = !S.canUndo;
  btn.textContent = S.canUndo ? `↩ 撤销：${S.lastUndoLabel}` : '↩ 撤销';
}

/* ---------- 拖动（级联预览 + 提交，失败回滚并标出阻塞链） ---------- */
let drag = null;

function onDragStart(e) {
  if (e.button !== 0) return;
  const id = Number(e.currentTarget.dataset.id);
  const cue = cueById(id);
  if (!cue) return;
  if (cue.locked) {
    toast(`「${cue.name}」已锁定，无法移动`, true);
    markBlocked([id]);
    return;
  }
  e.preventDefault();
  const ids = cascadeIds(id);
  const els = new Map();
  document.querySelectorAll('.cue').forEach((el) => {
    const cid = Number(el.dataset.id);
    if (ids.includes(cid)) els.set(cid, el);
  });
  drag = {
    id,
    startX: e.clientX,
    origStart: cue.start_ms,
    deltaMs: 0,
    els,
  };
  for (const [cid, el] of els) el.classList.add(cid === id ? 'dragging' : 'cascade-preview');
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  const rawMs = (e.clientX - drag.startX) / S.pxPerMs;
  drag.deltaMs = Math.round(rawMs / SNAP_MS) * SNAP_MS;
  const dx = drag.deltaMs * S.pxPerMs;
  for (const el of drag.els.values()) {
    el.style.transform = `translateX(${dx}px)`;
    el.style.setProperty('--drag-dx', dx + 'px');
  }
}

async function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  if (!drag) return;
  const { id, origStart, deltaMs } = drag;
  drag = null;
  if (deltaMs === 0) { render(); return; }
  const res = await api(`/api/cues/${id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms: origStart + deltaMs }),
  });
  if (res.ok) {
    applyState(res.state);
    toast(res.label || '已移动');
  } else {
    render(); // 回滚：服务端未改动，重绘即恢复原位
    const names = (res.chain || []).map((cid) => cueById(cid)?.name).filter(Boolean).join(' → ');
    toast(`${res.reason}${names ? `｜阻塞链：${names}` : ''}`, true);
    const mark = new Set([...(res.chain || []), res.conflictWith].filter(Boolean));
    markBlocked([...mark], res.chain || []);
  }
}

// 标红阻塞链上的提示块与链上依赖箭头，3 秒后清除
function markBlocked(ids, chain = []) {
  for (const cid of ids) {
    const el = document.querySelector(`.cue[data-id="${cid}"]`);
    if (el) el.classList.add('blocked');
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = elDepLayer.querySelector(`path[data-pred="${chain[i]}"][data-succ="${chain[i + 1]}"]`);
    if (p) p.classList.add('blocked');
  }
  setTimeout(() => {
    document.querySelectorAll('.cue.blocked').forEach((el) => el.classList.remove('blocked'));
    elDepLayer.querySelectorAll('path.blocked').forEach((p) => p.classList.remove('blocked'));
  }, 3000);
}

/* ---------- 编辑侧栏 ---------- */
function renderEditor() {
  const form = $('#editor-form');
  const empty = $('#editor-empty');
  const cue = cueById(S.selectedId);
  if (!cue) {
    form.hidden = true;
    empty.hidden = false;
    return;
  }
  form.hidden = false;
  empty.hidden = true;
  $('#f-name').value = cue.name;
  $('#f-type').value = cue.type;
  $('#f-track').value = cue.track;
  $('#f-start').value = (cue.start_ms / 1000).toFixed(1);
  $('#f-duration').value = (cue.duration_ms / 1000).toFixed(1);
  $('#f-locked').checked = !!cue.locked;

  const out = S.deps.filter((d) => d.pred_id === cue.id);
  const inn = S.deps.filter((d) => d.succ_id === cue.id);
  $('#dep-out').innerHTML = out.length
    ? out.map((d) => `<li>→ ${esc(cueById(d.succ_id)?.name || '?')} <button data-dep="${d.id}" class="dep-del">移除</button></li>`).join('')
    : '<li style="color:var(--muted)">无</li>';
  $('#dep-in').innerHTML = inn.length
    ? inn.map((d) => `<li>${esc(cueById(d.pred_id)?.name || '?')} → <button data-dep="${d.id}" class="dep-del">移除</button></li>`).join('')
    : '<li style="color:var(--muted)">无</li>';
  document.querySelectorAll('.dep-del').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api(`/api/deps/${b.dataset.dep}`, { method: 'DELETE' });
      applyState(res.state);
    })
  );

  const target = $('#dep-target');
  target.innerHTML = S.cues.filter((c) => c.id !== cue.id)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

$('#editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cue = cueById(S.selectedId);
  if (!cue) return;
  const newStart = Math.round(Number($('#f-start').value) * 1000);
  // 非开始时间字段先保存
  const patch = await api(`/api/cues/${cue.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: $('#f-name').value.trim() || cue.name,
      type: $('#f-type').value,
      track: $('#f-track').value.trim() || cue.track,
      duration_ms: Math.round(Number($('#f-duration').value) * 1000),
      locked: $('#f-locked').checked,
    }),
  });
  if (!patch.ok) { toast(patch.reason, true); applyState(patch.state); return; }
  // 开始时间走 move 接口，保持与拖动一致的级联/回滚语义
  if (newStart !== cue.start_ms) {
    const mv = await api(`/api/cues/${cue.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_ms: newStart }),
    });
    if (!mv.ok) {
      applyState(patch.state);
      toast(mv.reason, true);
      const mark = new Set([...(mv.chain || []), mv.conflictWith].filter(Boolean));
      markBlocked([...mark], mv.chain || []);
      return;
    }
    applyState(mv.state);
    toast('已保存');
    return;
  }
  applyState(patch.state);
  toast('已保存');
});

$('#btn-delete').addEventListener('click', async () => {
  const cue = cueById(S.selectedId);
  if (!cue || !confirm(`删除提示「${cue.name}」及其依赖？`)) return;
  const res = await api(`/api/cues/${cue.id}`, { method: 'DELETE' });
  S.selectedId = null;
  applyState(res.state);
});

$('#btn-add-dep').addEventListener('click', async () => {
  const target = Number($('#dep-target').value);
  if (!S.selectedId || !target) return;
  const res = await api('/api/deps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pred_id: S.selectedId, succ_id: target }),
  });
  if (!res.ok) { toast(res.reason, true); return; }
  applyState(res.state);
});

/* ---------- 工具栏 ---------- */
$('#track-filter').addEventListener('change', (e) => { S.filterTrack = e.target.value; render(); });

$('#btn-undo').addEventListener('click', async () => {
  const res = await api('/api/undo', { method: 'POST' });
  if (!res.ok) { toast(res.reason, true); return; }
  applyState(res.state);
  toast(`已撤销：${res.label}`);
});

$('#btn-add').addEventListener('click', async () => {
  const track = S.filterTrack !== ALL ? S.filterTrack : (visibleTracks()[0] || '灯光 A');
  const onTrack = S.cues.filter((c) => c.track === track);
  const start = onTrack.length ? Math.max(...onTrack.map((c) => c.start_ms + c.duration_ms)) + 1000 : 0;
  const res = await api('/api/cues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新提示', type: 'light', track, start_ms: start, duration_ms: 5000 }),
  });
  if (!res.ok) { toast(res.reason, true); return; }
  S.selectedId = res.id;
  applyState(res.state);
});

$('#btn-zoom-in').addEventListener('click', () => { S.pxPerMs = Math.min(0.5, S.pxPerMs * 1.25); render(); });
$('#btn-zoom-out').addEventListener('click', () => { S.pxPerMs = Math.max(0.02, S.pxPerMs / 1.25); render(); });

/* ---------- 启动 ---------- */
refresh();
