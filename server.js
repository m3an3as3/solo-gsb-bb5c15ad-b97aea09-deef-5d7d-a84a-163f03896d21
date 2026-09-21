'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cues.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- 数据库初始化（自动完成） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS cues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'light' CHECK (type IN ('light','sound')),
  track       TEXT NOT NULL,
  start_ms    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 5000 CHECK (duration_ms > 0),
  locked      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deps (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  pred_id INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
  succ_id INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
  UNIQUE (pred_id, succ_id)
);
CREATE TABLE IF NOT EXISTS undo (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  label      TEXT NOT NULL,
  snapshot   TEXT NOT NULL
);
`);

// ---------- 种子数据（仅当库为空时） ----------
function seed() {
  const insCue = db.prepare(
    'INSERT INTO cues (name, type, track, start_ms, duration_ms, locked) VALUES (?,?,?,?,?,?)'
  );
  const insDep = db.prepare('INSERT INTO deps (pred_id, succ_id) VALUES (?,?)');
  const tx = db.transaction(() => {
    const openLight = insCue.run('开场灯光', 'light', '灯光 A', 0, 8000, 0).lastInsertRowid;
    const openMusic = insCue.run('开场音乐', 'sound', '音效 A', 0, 12000, 0).lastInsertRowid;
    const mainPush = insCue.run('主灯推进', 'light', '灯光 A', 9000, 6000, 0).lastInsertRowid;
    const drum = insCue.run('鼓点音效', 'sound', '音效 A', 13000, 4000, 0).lastInsertRowid;
    const fog = insCue.run('烟雾氛围灯', 'light', '灯光 B', 16000, 6000, 0).lastInsertRowid;
    const strobe = insCue.run('高潮频闪', 'light', '灯光 A', 23000, 5000, 1).lastInsertRowid;
    const finale = insCue.run('终场和弦', 'sound', '音效 B', 29000, 8000, 0).lastInsertRowid;
    const curtain = insCue.run('谢幕灯光', 'light', '灯光 B', 38000, 10000, 0).lastInsertRowid;
    insDep.run(openLight, mainPush);
    insDep.run(openMusic, drum);
    insDep.run(mainPush, fog);
    insDep.run(drum, fog);
    insDep.run(fog, strobe);
    insDep.run(strobe, finale);
    insDep.run(finale, curtain);
  });
  tx();
}
if (db.prepare('SELECT COUNT(*) AS c FROM cues').get().c === 0) seed();

// ---------- 查询辅助 ----------
const qAllCues = db.prepare('SELECT * FROM cues ORDER BY track, start_ms, id');
const qAllDeps = db.prepare('SELECT * FROM deps ORDER BY id');
const qCue = db.prepare('SELECT * FROM cues WHERE id = ?');

function statePayload() {
  const lastUndo = db.prepare('SELECT label FROM undo ORDER BY id DESC LIMIT 1').get();
  return {
    cues: qAllCues.all(),
    deps: qAllDeps.all(),
    canUndo: !!lastUndo,
    lastUndoLabel: lastUndo ? lastUndo.label : null,
  };
}

// 计算从 startId 出发、沿“完成后触发”依赖拓扑可达的全部后继（含自身），
// 同时记录父指针以便出错时还原阻塞链。
function cascadeSet(startId) {
  const succMap = new Map();
  for (const d of qAllDeps.all()) {
    if (!succMap.has(d.pred_id)) succMap.set(d.pred_id, []);
    succMap.get(d.pred_id).push(d.succ_id);
  }
  const parent = new Map();
  const order = [];
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    for (const nxt of succMap.get(cur) || []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        parent.set(nxt, cur);
        queue.push(nxt);
      }
    }
  }
  const chainTo = (target) => {
    const chain = [target];
    let cur = target;
    while (parent.has(cur)) {
      cur = parent.get(cur);
      chain.unshift(cur);
    }
    return chain;
  };
  return { order, chainTo };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => res.json(statePayload()));

// 新建提示
app.post('/api/cues', (req, res) => {
  const { name, type, track, start_ms, duration_ms } = req.body || {};
  if (!name || !track) return res.status(400).json({ ok: false, reason: '名称与轨道必填' });
  const t = type === 'sound' ? 'sound' : 'light';
  const start = Math.max(0, Math.round(Number(start_ms) || 0));
  const dur = Math.max(100, Math.round(Number(duration_ms) || 5000));
  const clash = qAllCues.all().find(
    (c) => c.track === track && overlaps(start, start + dur, c.start_ms, c.start_ms + c.duration_ms)
  );
  if (clash) {
    return res.json({ ok: false, reason: `轨道冲突：与「${clash.name}」在 ${track} 重叠`, conflictWith: clash.id });
  }
  const info = db
    .prepare('INSERT INTO cues (name, type, track, start_ms, duration_ms) VALUES (?,?,?,?,?)')
    .run(String(name).slice(0, 60), t, String(track).slice(0, 40), start, dur);
  res.json({ ok: true, id: info.lastInsertRowid, state: statePayload() });
});

// 更新提示属性（开始时间的修改走 /move 以触发级联）
app.patch('/api/cues/:id', (req, res) => {
  const id = Number(req.params.id);
  const cue = qCue.get(id);
  if (!cue) return res.status(404).json({ ok: false, reason: '提示不存在' });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? String(b.name).slice(0, 60) : cue.name,
    type: b.type !== undefined ? (b.type === 'sound' ? 'sound' : 'light') : cue.type,
    track: b.track !== undefined ? String(b.track).slice(0, 40) : cue.track,
    duration_ms: b.duration_ms !== undefined ? Math.max(100, Math.round(Number(b.duration_ms) || cue.duration_ms)) : cue.duration_ms,
    locked: b.locked !== undefined ? (b.locked ? 1 : 0) : cue.locked,
  };
  const clash = qAllCues.all().find(
    (c) =>
      c.id !== id &&
      c.track === next.track &&
      overlaps(cue.start_ms, cue.start_ms + next.duration_ms, c.start_ms, c.start_ms + c.duration_ms)
  );
  if (clash) {
    return res.json({ ok: false, reason: `轨道冲突：与「${clash.name}」在 ${next.track} 重叠`, conflictWith: clash.id });
  }
  db.prepare('UPDATE cues SET name=?, type=?, track=?, duration_ms=?, locked=? WHERE id=?').run(
    next.name, next.type, next.track, next.duration_ms, next.locked, id
  );
  res.json({ ok: true, state: statePayload() });
});

app.delete('/api/cues/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!qCue.get(id)) return res.status(404).json({ ok: false, reason: '提示不存在' });
  db.prepare('DELETE FROM cues WHERE id=?').run(id);
  res.json({ ok: true, state: statePayload() });
});

// 新建依赖（pred 完成后触发 succ），拒绝成环
app.post('/api/deps', (req, res) => {
  const pred = Number(req.body && req.body.pred_id);
  const succ = Number(req.body && req.body.succ_id);
  if (!qCue.get(pred) || !qCue.get(succ)) return res.status(404).json({ ok: false, reason: '提示不存在' });
  if (pred === succ) return res.json({ ok: false, reason: '不能依赖自身' });
  // 若 succ 已能到达 pred，则新增 pred->succ 会成环
  if (cascadeSet(succ).order.includes(pred)) {
    return res.json({ ok: false, reason: '会形成循环依赖，已拒绝' });
  }
  try {
    db.prepare('INSERT INTO deps (pred_id, succ_id) VALUES (?,?)').run(pred, succ);
  } catch (e) {
    return res.json({ ok: false, reason: '依赖已存在' });
  }
  res.json({ ok: true, state: statePayload() });
});

app.delete('/api/deps/:id', (req, res) => {
  db.prepare('DELETE FROM deps WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true, state: statePayload() });
});

// 拖动提示：按依赖拓扑级联移动后继；锁定/同轨冲突/越界 -> 整体回滚并返回阻塞链
app.post('/api/cues/:id/move', (req, res) => {
  const id = Number(req.params.id);
  const cue = qCue.get(id);
  if (!cue) return res.status(404).json({ ok: false, reason: '提示不存在' });
  const startMs = Math.round(Number(req.body && req.body.start_ms));
  if (!Number.isFinite(startMs)) return res.status(400).json({ ok: false, reason: '非法时间' });
  if (cue.locked) {
    return res.json({ ok: false, reason: `「${cue.name}」已锁定，无法移动`, chain: [id], blocker: id });
  }
  const delta = startMs - cue.start_ms;
  if (delta === 0) return res.json({ ok: true, moved: [], delta: 0, state: statePayload() });

  const { order, chainTo } = cascadeSet(id);
  const cuesById = new Map(qAllCues.all().map((c) => [c.id, c]));

  // 1) 锁定检查
  for (const aid of order) {
    const c = cuesById.get(aid);
    if (c.locked) {
      return res.json({
        ok: false,
        reason: `级联受阻：「${c.name}」已锁定`,
        chain: chainTo(aid),
        blocker: aid,
      });
    }
  }
  // 2) 0 时刻边界检查
  for (const aid of order) {
    const c = cuesById.get(aid);
    if (c.start_ms + delta < 0) {
      return res.json({
        ok: false,
        reason: `级联受阻：「${c.name}」将早于 0 时刻`,
        chain: chainTo(aid),
        blocker: aid,
      });
    }
  }
  // 3) 同轨时间冲突检查（仅与未参与本次级联的提示比较；级联内部整体平移，相对关系不变）
  const affected = new Set(order);
  for (const aid of order) {
    const c = cuesById.get(aid);
    const ns = c.start_ms + delta;
    const ne = ns + c.duration_ms;
    for (const other of cuesById.values()) {
      if (affected.has(other.id) || other.track !== c.track) continue;
      if (overlaps(ns, ne, other.start_ms, other.start_ms + other.duration_ms)) {
        return res.json({
          ok: false,
          reason: `轨道冲突：「${c.name}」与「${other.name}」在 ${other.track} 时间重叠`,
          chain: chainTo(aid),
          blocker: aid,
          conflictWith: other.id,
        });
      }
    }
  }

  // 全部通过：先存撤销快照，再事务性应用，保证要么全部成功要么不动
  const snapshot = order.map((aid) => ({ id: aid, start_ms: cuesById.get(aid).start_ms }));
  const label = `移动「${cue.name}」 ${delta > 0 ? '+' : ''}${delta}ms（级联 ${order.length} 项）`;
  const apply = db.transaction(() => {
    db.prepare('INSERT INTO undo (label, snapshot) VALUES (?,?)').run(label, JSON.stringify(snapshot));
    const upd = db.prepare('UPDATE cues SET start_ms = start_ms + ? WHERE id = ?');
    for (const aid of order) upd.run(delta, aid);
  });
  apply();

  res.json({
    ok: true,
    delta,
    label,
    moved: order.map((aid) => ({ id: aid, start_ms: cuesById.get(aid).start_ms + delta })),
    state: statePayload(),
  });
});

// 撤销最近一次成功调整
app.post('/api/undo', (req, res) => {
  const row = db.prepare('SELECT * FROM undo ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ ok: false, reason: '没有可撤销的操作' });
  const snapshot = JSON.parse(row.snapshot);
  // 恢复前先校验不会与现有提示产生同轨冲突
  const posAfter = new Map(qAllCues.all().map((c) => [c.id, c.start_ms]));
  for (const s of snapshot) posAfter.set(s.id, s.start_ms);
  const cues = qAllCues.all();
  for (let i = 0; i < cues.length; i++) {
    for (let j = i + 1; j < cues.length; j++) {
      const a = cues[i], b = cues[j];
      if (a.track !== b.track) continue;
      if (overlaps(posAfter.get(a.id), posAfter.get(a.id) + a.duration_ms, posAfter.get(b.id), posAfter.get(b.id) + b.duration_ms)) {
        return res.json({ ok: false, reason: `撤销将造成「${a.name}」与「${b.name}」同轨冲突，已取消` });
      }
    }
  }
  const apply = db.transaction(() => {
    const upd = db.prepare('UPDATE cues SET start_ms=? WHERE id=?');
    for (const s of snapshot) upd.run(s.start_ms, s.id);
    db.prepare('DELETE FROM undo WHERE id=?').run(row.id);
  });
  apply();
  res.json({ ok: true, label: row.label, state: statePayload() });
});

app.listen(PORT, () => {
  console.log(`Stage Cue Planner 已启动: http://localhost:${PORT}`);
});
