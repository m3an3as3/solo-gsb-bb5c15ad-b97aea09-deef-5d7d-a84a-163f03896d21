'use strict';

const PX_PER_SEC = 40;
const SNAP_MS = 250;
const ROW_H = 64;
const RULER_H = 26;
const MIN_WIDTH = 30 * PX_PER_SEC;

const el = {
  lanes: document.getElementById('lanes'),
  edge: document.getElementById('edgeLayer'),
  timeline: document.getElementById('timeline'),
  scroll: document.getElementById('timelineScroll'),
  ruler: document.getElementById('rulerCanvas'),
  filter: document.getElementById('trackFilter'),
  undoBtn: document.getElementById('undoBtn'),
  toast: document.getElementById('toast'),
  cueForm: document.getElementById('cueForm'),
  trackList: document.getElementById('trackList'),
  inspector: document.getElementById('inspector'),
  editForm: document.getElementById('editForm'),
  predList: document.getElementById('predList'),
  closeInspector: document.getElementById('closeInspector'),
  deleteBtn: document.getElementById('deleteBtn'),
};

let state = { tracks: [], cues: [], deps: [], canUndo: false };
let hiddenTracks = new Set();
let selectedId = null;
let drag = null;        // {rootId, closure:Set, startX, deltaMs}
let flashBlockers = []; // [{ids:Set, until}]
let flashMoved = new Set();

// ---------- 工具 ----------

const api = async (url, opts) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || '请求失败'), { status: res.status, body });
  return body;
};

const cueById = (id) => state.cues.find((c) => c.id === id);
const fmt = (ms) => (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2) + 's';
const px = (ms) => (ms / 1000) * PX_PER_SEC;

function toast(message, kind = 'info', blockers) {
  el.toast.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = message;
  el.toast.appendChild(main);
  if (blockers && blockers.length) {
    blockers.forEach((b) => {
      const chain = (b.chain || b.blockerIds || []).map((id) => {
        const c = cueById(id);
        return c ? c.name : `#${id}`;
      });
      const line = document.createElement('span');
      line.className = 'bl-chain';
      const tag = b.type === 'locked' ? '🔒 锁定阻塞链'
        : b.type === 'track-conflict' ? '⏱ 同轨冲突链'
        : b.type === 'dependency' ? '🔗 依赖阻塞链'
        : '⚠ 阻塞链';
      line.textContent = `${tag}：${chain.join(' → ')}${b.detail ? `（${b.detail}）` : ''}`;
      el.toast.appendChild(line);
    });
  }
  el.toast.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 4500);
}

function transitiveSuccessors(rootId) {
  const out = new Map();
  for (const d of state.deps) {
    if (!out.has(d.fromCue)) out.set(d.fromCue, []);
    out.get(d.fromCue).push(d.toCue);
  }
  const set = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const s of out.get(id) || []) if (!set.has(s)) { set.add(s); stack.push(s); }
  }
  return set;
}

// ---------- 渲染 ----------

function cueStart(c) {
  let s = c.startMs;
  if (drag && drag.closure.has(c.id)) s += drag.deltaMs;
  return s;
}

function timelineWidth() {
  let endSec = 0;
  for (const c of state.cues) {
    endSec = Math.max(endSec, cueStart(c) / 1000 + c.durationMs / 1000);
  }
  return Math.max(MIN_WIDTH, (endSec + 8) * PX_PER_SEC);
}

function renderFilter() {
  el.filter.innerHTML = '';
  const all = document.createElement('span');
  all.className = 'chip' + (hiddenTracks.size === 0 ? ' on' : '');
  all.textContent = '全部轨道';
  all.onclick = () => { hiddenTracks = new Set(); render(); };
  el.filter.appendChild(all);
  for (const t of state.tracks) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (hiddenTracks.has(t.id) ? '' : ' on');
    chip.textContent = t.name;
    chip.onclick = () => {
      if (hiddenTracks.has(t.id)) hiddenTracks.delete(t.id);
      else hiddenTracks.add(t.id);
      render();
    };
    el.filter.appendChild(chip);
  }
  el.undoBtn.disabled = !state.canUndo;
  el.trackList.innerHTML = state.tracks.map((t) => `<option value="${t.name}"></option>`).join('');
}

function renderRuler(width) {
  const dpr = window.devicePixelRatio || 1;
  el.ruler.style.width = width + 'px';
  el.ruler.style.height = RULER_H + 'px';
  el.ruler.width = Math.round(width * dpr);
  el.ruler.height = RULER_H * dpr;
  const ctx = el.ruler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, RULER_H);
  ctx.font = '10px system-ui';
  ctx.textBaseline = 'middle';
  const totalSec = Math.ceil(width / PX_PER_SEC);
  for (let s = 0; s <= totalSec; s++) {
    const x = s * PX_PER_SEC;
    const major = s % 5 === 0;
    ctx.strokeStyle = major ? '#5a6a8a' : '#2c3850';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, major ? 4 : 12);
    ctx.lineTo(x + 0.5, RULER_H);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = '#93a0b8';
      ctx.fillText(s + 's', x + 4, RULER_H / 2);
    }
  }
}

function renderEdges() {
  const laneIndex = new Map(state.tracks.map((t, i) => [t.id, i]));
  const width = timelineWidth();
  let svg = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
    <path d="M0,0 L7,3 L0,6 Z" fill="#4f8cff"></path></marker></defs>`;

  for (const d of state.deps) {
    const from = cueById(d.fromCue);
    const to = cueById(d.toCue);
    if (!from || !to) continue;
    if (hiddenTracks.has(from.trackId) || hiddenTracks.has(to.trackId)) continue;

    const fs = cueStart(from);
    const ts = cueStart(to);
    // SVG 与 #lanes 顶部对齐（ruler 之外），y 坐标即轨道行内坐标
    const y1 = laneIndex.get(from.trackId) * ROW_H + ROW_H / 2;
    const y2 = laneIndex.get(to.trackId) * ROW_H + ROW_H / 2;
    const x1 = px(fs) + Math.max(8, px(from.durationMs));
    const x2 = px(ts);
    const midX = (x1 + x2) / 2;
    const inBlock = flashBlockers.some((b) => b.ids.has(from.id) && b.ids.has(to.id));
    const color = inBlock ? '#ff4d5e' : '#4f8cff';
    const marker = inBlock ? '' : `marker-end="url(#arrow)"`;
    svg += `<path d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${Math.max(x1 + 2, x2 - 6)},${y2}"
      fill="none" stroke="${color}" stroke-width="${inBlock ? 2.5 : 1.5}"
      stroke-dasharray="${inBlock ? '5,3' : 'none'}" ${marker} opacity="0.9"></path>`;
  }
  el.edge.innerHTML = svg;
  const edgeH = state.tracks.length * ROW_H;
  el.edge.setAttribute('width', width);
  el.edge.setAttribute('height', edgeH);
  el.edge.style.width = width + 'px';
  el.edge.style.height = edgeH + 'px';
}

function render() {
  renderFilter();
  const width = timelineWidth();
  el.timeline.style.width = width + 'px';
  renderRuler(width);

  el.lanes.innerHTML = '';
  state.tracks.forEach((track, i) => {
    const lane = document.createElement('div');
    lane.className = 'lane' + (hiddenTracks.has(track.id) ? ' dim' : '');
    lane.style.height = ROW_H + 'px';
    const label = document.createElement('span');
    label.className = 'lane-label';
    const cuesOnTrack = state.cues.filter((c) => c.trackId === track.id);
    const kind = cuesOnTrack[0] ? cuesOnTrack[0].type : null;
    label.innerHTML = `<span class="t-${kind || ''}">${track.name}</span>`;
    lane.appendChild(label);

    for (const c of cuesOnTrack) {
      if (hiddenTracks.has(track.id)) continue;
      const s = cueStart(c);
      const cue = document.createElement('div');
      cue.className = `cue ${c.type}`;
      if (c.locked) cue.classList.add('locked');
      if (selectedId === c.id) cue.classList.add('selected');
      if (drag && drag.closure.has(c.id)) cue.classList.add('dragging');
      if (flashMoved.has(c.id)) cue.classList.add('flash-ok');
      for (const fb of flashBlockers) if (fb.ids.has(c.id)) cue.classList.add('live-block');

      cue.style.left = px(s) + 'px';
      cue.style.width = Math.max(8, px(c.durationMs)) + 'px';
      cue.dataset.id = c.id;
      cue.innerHTML = `<span class="cue-name">${c.name}</span>
        <span class="cue-time">${fmt(s)} · ${fmt(c.durationMs)}</span>
        ${c.locked ? '<span class="lock-ico">🔒</span>' : ''}`;
      attachDrag(cue, c);
      lane.appendChild(cue);
    }
    el.lanes.appendChild(lane);
  });
  renderEdges();
}

// ---------- 拖动（级联预览 + 拓扑回滚） ----------
// 注意：拖动期间 render() 会重建 cue DOM，因此 move/up 监听挂在 window 上，
// 不依赖被拖节点本身的指针捕获。

function startDrag(e, cue) {
  if (cue.locked) { toast('🔒 该提示已锁定，无法拖动', 'error'); return; }
  e.preventDefault();
  drag = {
    rootId: cue.id,
    closure: transitiveSuccessors(cue.id),
    startX: e.clientX,
    baseStart: cue.startMs,
    deltaMs: 0,
    moved: false,
  };
}

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dxPx = e.clientX - drag.startX;
  if (Math.abs(dxPx) > 4) drag.moved = true;
  let dMs = Math.round((dxPx / PX_PER_SEC) * 1000 / SNAP_MS) * SNAP_MS;
  if (drag.baseStart + dMs < 0) dMs = -drag.baseStart;
  if (dMs !== drag.deltaMs) { drag.deltaMs = dMs; render(); }
});

// window pointerup 完成一次真实拖动后短暂抑制随之而来的 click 选中
let lastDragEndAt = 0;

window.addEventListener('pointerup', async () => {
  if (!drag) return;
  const { rootId, deltaMs, moved } = drag;
  const wasDrag = moved && deltaMs !== 0;
  drag = null;
  if (!moved) { render(); return; }
  if (!wasDrag) { render(); selectCue(rootId); return; }
  lastDragEndAt = Date.now();

  const targetSec = (cueById(rootId).startMs + deltaMs) / 1000;
  try {
    const next = await api(`/api/cues/${rootId}/move`, {
      method: 'POST',
      body: JSON.stringify({ start: targetSec }),
    });
    applyState(next);
    flashMoved = new Set(next.moved || []);
    render();
    toast(`✅ 已移动，级联带动 ${(next.moved || []).length} 个提示（可撤销）`, 'success');
    setTimeout(() => { flashMoved = new Set(); render(); }, 1400);
  } catch (err) {
    if (err.status === 409) {
      markBlocked(err.body.blockers);
      render();
      toast(`⛔ 整次操作已回滚：${err.message}`, 'error', err.body.blockers);
    } else {
      render();
      toast(err.message, 'error');
    }
  }
});

window.addEventListener('pointercancel', () => {
  if (!drag) return;
  drag = null;
  render();
});

function attachDrag(node, cue) {
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startDrag(e, cue);
  });
  // 未移动即抬起视为点击选中（window pointerup 负责处理拖动提交）
  node.addEventListener('click', () => {
    if (Date.now() - lastDragEndAt < 150) return;
    selectCue(cue.id);
  });
}

function markBlocked(blockers) {
  const now = Date.now();
  flashBlockers = (blockers || []).map((b) => ({
    ids: new Set(b.chain || b.blockerIds || []),
    until: now + 2800,
  }));
  setTimeout(() => {
    flashBlockers = flashBlockers.filter((b) => b.until > Date.now());
    render();
  }, 2900);
}

// ---------- 选中 / 详情面板 ----------

function selectCue(id) {
  selectedId = id;
  const c = cueById(id);
  if (!c) { closeInspectorPanel(); return; }
  document.body.querySelector('main').classList.add('inspector-open');
  el.inspector.classList.remove('hidden');
  const f = el.editForm;
  f.name.value = c.name;
  f.type.value = c.type;
  f.trackId.innerHTML = state.tracks.map((t) =>
    `<option value="${t.id}" ${t.id === c.trackId ? 'selected' : ''}>${t.name}</option>`).join('');
  f.start.value = c.startMs / 1000;
  f.duration.value = c.durationMs / 1000;
  f.locked.checked = !!c.locked;

  const preds = new Set(state.deps.filter((d) => d.toCue === id).map((d) => d.fromCue));
  el.predList.innerHTML = '';
  state.cues.filter((x) => x.id !== id).forEach((x) => {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" value="${x.id}" ${preds.has(x.id) ? 'checked' : ''}/>
      ${x.type === 'light' ? '💡' : '🔊'} ${x.name} <span style="color:#93a0b8">(${fmt(x.startMs)}起)</span>`;
    el.predList.appendChild(lab);
  });
  if (!state.cues.some((x) => x.id !== id)) {
    el.predList.innerHTML = '<span style="color:#93a0b8;font-size:12px">暂无其他提示可作为前置</span>';
  }
  render();
}

function closeInspectorPanel() {
  selectedId = null;
  el.inspector.classList.add('hidden');
  document.body.querySelector('main').classList.remove('inspector-open');
  render();
}
el.closeInspector.onclick = closeInspectorPanel;

el.editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (selectedId == null) return;
  const f = el.editForm;
  const predecessorIds = [...el.predList.querySelectorAll('input:checked')].map((i) => Number(i.value));
  try {
    const next = await api(`/api/cues/${selectedId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: f.name.value.trim(),
        type: f.type.value,
        trackId: Number(f.trackId.value),
        start: Number(f.start.value),
        duration: Number(f.duration.value),
        locked: f.locked.checked,
        predecessorIds,
      }),
    });
    applyState(next);
    selectCue(selectedId);
    toast('✅ 已保存', 'success');
  } catch (err) {
    if (err.status === 409) {
      markBlocked(err.body.blockers);
      render();
      toast(`⛔ 保存被阻塞，未做任何改动：${err.message}`, 'error', err.body.blockers);
    } else toast(err.message, 'error');
  }
});

el.deleteBtn.addEventListener('click', async () => {
  if (selectedId == null) return;
  const c = cueById(selectedId);
  if (!confirm(`确认删除提示「${c.name}」？相关依赖会一并移除。`)) return;
  try {
    const next = await api(`/api/cues/${selectedId}`, { method: 'DELETE' });
    closeInspectorPanel();
    applyState(next);
    toast('已删除', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- 新建表单 ----------

el.cueForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = el.cueForm;
  const trackName = f.trackName.value.trim();
  let track = state.tracks.find((t) => t.name === trackName);
  try {
    if (!track) {
      const created = await api('/api/tracks', { method: 'POST', body: JSON.stringify({ name: trackName }) });
      applyState(created);
      track = state.tracks.find((t) => t.name === trackName);
    }
    const next = await api('/api/cues', {
      method: 'POST',
      body: JSON.stringify({
        name: f.name.value.trim(),
        type: f.type.value,
        trackId: track.id,
        start: Number(f.start.value),
        duration: Number(f.duration.value),
        locked: f.locked.checked,
        predecessorIds: [],
      }),
    });
    applyState(next);
    f.name.value = '';
    toast('✅ 提示已添加（可在详情中设置依赖）', 'success');
  } catch (err) {
    if (err.status === 409) {
      markBlocked(err.body.blockers);
      render();
      toast(`无法添加：${err.message}`, 'error', err.body.blockers);
    } else toast(err.message, 'error');
  }
});

// ---------- 撤销 ----------

el.undoBtn.addEventListener('click', async () => {
  try {
    const next = await api('/api/undo', { method: 'POST', body: '{}' });
    applyState(next);
    flashMoved = new Set(next.moved || []);
    render();
    toast('↩ 已撤销最近一次成功调整', 'success');
    setTimeout(() => { flashMoved = new Set(); render(); }, 1400);
  } catch (err) {
    if (err.status === 409 && err.body.blockers && err.body.blockers.length) {
      markBlocked(err.body.blockers);
      render();
      toast(`⛔ 撤销被阻塞：${err.message}`, 'error', err.body.blockers);
    } else {
      toast(err.message, 'error');
    }
  }
});

// ---------- 状态 ----------

function applyState(s) {
  state = s;
  if (selectedId != null && !cueById(selectedId)) closeInspectorPanel();
  render();
}

async function init() {
  try {
    const s = await fetch('/api/state').then((r) => r.json());
    applyState(s);
  } catch (e) {
    toast('加载状态失败：' + e.message, 'error');
  }
}
window.addEventListener('resize', () => render());
init();
