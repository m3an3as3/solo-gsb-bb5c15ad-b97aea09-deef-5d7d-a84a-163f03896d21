'use strict';

const express = require('express');
const {
  buildAdjacency,
  transitiveClosure,
  shortestPath,
  createsCycle,
} = require('./graph');

function routes(db) {
  const router = express.Router();

  // ---------- 基础查询 ----------

  function getTracks() {
    return db.prepare('SELECT id, name FROM tracks ORDER BY id').all();
  }

  function getCues() {
    return db.prepare(`
      SELECT id, name, type, track_id AS trackId,
             start_ms AS startMs, duration_ms AS durationMs, locked
      FROM cues
      ORDER BY start_ms, id
    `).all();
  }

  function getDeps() {
    return db.prepare(`
      SELECT id, from_cue AS fromCue, to_cue AS toCue
      FROM dependencies
    `).all();
  }

  function canUndo() {
    return db.prepare('SELECT COUNT(*) AS n FROM undo_log').get().n > 0;
  }

  function state() {
    return { tracks: getTracks(), cues: getCues(), deps: getDeps(), canUndo: canUndo() };
  }

  // 构造阻塞链：从拖动根节点沿依赖边到 cueId，再附上对端节点
  function chain(root, cueId, extra, out) {
    const path = shortestPath(out, root, cueId) || [cueId];
    return extra == null ? path : path.concat(extra);
  }

  // 半开区间重叠
  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  // ---------- 校验工具 ----------

  function readSeconds(body, field, { allowZero = true } = {}) {
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) {
      const e = new Error(`字段 ${field} 必须是不小于 0 的数字（秒）`);
      e.status = 400;
      throw e;
    }
    return Math.round(v * 1000);
  }

  function conflict(res, reason, blockers) {
    return res.status(409).json({ error: reason, blockers });
  }

  // ---------- 路由 ----------

  router.get('/state', (req, res) => {
    res.json(state());
  });

  // 创建提示
  router.post('/cues', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    if (!['light', 'sound'].includes(b.type)) {
      return res.status(400).json({ error: 'type 必须是 light 或 sound' });
    }
    const trackId = Number(b.trackId);
    if (!getTracks().some((t) => t.id === trackId)) {
      return res.status(400).json({ error: '轨道不存在' });
    }
    let startMs, durationMs;
    try {
      startMs = readSeconds(b, 'start');
      durationMs = readSeconds(b, 'duration');
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const locked = b.locked ? 1 : 0;
    let predIds = Array.isArray(b.predecessorIds) ? b.predecessorIds.map(Number) : [];
    predIds = [...new Set(predIds)];

    const cues = getCues();
    const cueById = new Map(cues.map((c) => [c.id, c]));
    if (predIds.some((id) => !cueById.has(id))) {
      return res.status(400).json({ error: '前置提示不存在' });
    }

    // 同轨时间冲突
    for (const other of cues) {
      if (other.trackId !== trackId) continue;
      if (overlaps(startMs, startMs + durationMs, other.startMs, other.startMs + other.durationMs)) {
        return conflict(res, `与同轨提示「${other.name}」时间冲突`, [{
          type: 'track-conflict',
          blockerIds: [other.id],
          detail: '新提示与已有提示在同一轨道时间重叠',
        }]);
      }
    }
    // “完成后触发”约束
    for (const pid of predIds) {
      const p = cueById.get(pid);
      if (startMs < p.startMs + p.durationMs) {
        return conflict(res, `前置提示「${p.name}」尚未完成，违反“完成后触发”依赖`, [{
          type: 'dependency',
          blockerIds: [p.id],
          detail: `最早可开始于 ${(p.startMs + p.durationMs) / 1000}s`,
        }]);
      }
    }

    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO cues (name, type, track_id, start_ms, duration_ms, locked)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, b.type, trackId, startMs, durationMs, locked);
      const id = Number(info.lastInsertRowid);
      const insDep = db.prepare('INSERT INTO dependencies (from_cue, to_cue) VALUES (?, ?)');
      for (const pid of predIds) insDep.run(pid, id);
      return id;
    });
    const id = tx();
    res.status(201).json(state());
  });

  // 编辑提示（含依赖全量替换）
  router.patch('/cues/:id', (req, res) => {
    const id = Number(req.params.id);
    const cue = db.prepare(`
      SELECT id, name, type, track_id AS trackId,
             start_ms AS startMs, duration_ms AS durationMs, locked
      FROM cues WHERE id = ?
    `).get(id);
    if (!cue) return res.status(404).json({ error: '提示不存在' });

    const b = req.body || {};
    const next = {
      name: b.name === undefined ? cue.name : String(b.name).trim(),
      type: b.type === undefined ? cue.type : b.type,
      trackId: b.trackId === undefined ? cue.trackId : Number(b.trackId),
      startMs: cue.startMs,
      durationMs: cue.durationMs,
      locked: b.locked === undefined ? cue.locked : (b.locked ? 1 : 0),
    };
    if (!next.name) return res.status(400).json({ error: '名称不能为空' });
    if (!['light', 'sound'].includes(next.type)) {
      return res.status(400).json({ error: 'type 必须是 light 或 sound' });
    }
    if (!getTracks().some((t) => t.id === next.trackId)) {
      return res.status(400).json({ error: '轨道不存在' });
    }
    try {
      if (b.start !== undefined) next.startMs = readSeconds(b, 'start');
      if (b.duration !== undefined) next.durationMs = readSeconds(b, 'duration');
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    const replaceDeps = Array.isArray(b.predecessorIds);
    let predIds = replaceDeps ? [...new Set(b.predecessorIds.map(Number))] : null;

    const cues = getCues();
    const byId = new Map(cues.map((c) => [c.id, c]));
    if (predIds && predIds.some((p) => !byId.has(p) || p === id)) {
      return res.status(400).json({ error: '前置提示不存在或不能依赖自身' });
    }

    // 当前入边
    if (!predIds) {
      predIds = db.prepare('SELECT from_cue AS f FROM dependencies WHERE to_cue = ?')
        .all(id).map((r) => r.f);
    }
    const deps = getDeps();
    const { out } = buildAdjacency(deps);

    // 环检测：仅对新增边
    const oldPred = new Set(
      db.prepare('SELECT from_cue AS f FROM dependencies WHERE to_cue = ?').all(id).map((r) => r.f)
    );
    for (const p of predIds) {
      if (oldPred.has(p)) continue;
      const cyc = createsCycle(out, p, id);
      if (cyc) {
        return conflict(res, '该依赖会形成循环，无法保存', [{
          type: 'cycle',
          chain: cyc.cycle,
          detail: '依赖链最终指回了起点',
        }]);
      }
    }

    const blockers = [];
    // 同轨冲突
    for (const other of cues) {
      if (other.id === id || other.trackId !== next.trackId) continue;
      const oEnd = other.startMs + other.durationMs;
      if (overlaps(next.startMs, next.startMs + next.durationMs, other.startMs, oEnd)) {
        blockers.push({
          type: 'track-conflict',
          chain: [other.id, id],
          detail: `与同轨提示「${other.name}」时间重叠`,
        });
      }
    }
    // 入边：前置必须先完成
    for (const p of predIds) {
      const pred = byId.get(p);
      if (next.startMs < pred.startMs + pred.durationMs) {
        blockers.push({
          type: 'dependency',
          chain: [p, id],
          detail: `「${pred.name}」完成前不能开始（最早 ${(pred.startMs + pred.durationMs) / 1000}s）`,
        });
      }
    }
    // 出边：改了 start/duration 后后继仍须满足约束
    for (const s of out.get(id) || []) {
      const succ = byId.get(s);
      if (succ.startMs < next.startMs + next.durationMs) {
        blockers.push({
          type: 'dependency',
          chain: [id, s],
          detail: `后继「${succ.name}」早于本提示完成时间`,
        });
      }
    }
    if (blockers.length) return conflict(res, '修改被阻塞，未做任何改动', blockers);

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE cues SET name=?, type=?, track_id=?, start_ms=?, duration_ms=?, locked=?
        WHERE id=?
      `).run(next.name, next.type, next.trackId, next.startMs, next.durationMs, next.locked, id);
      if (replaceDeps) {
        db.prepare('DELETE FROM dependencies WHERE to_cue = ?').run(id);
        const ins = db.prepare('INSERT INTO dependencies (from_cue, to_cue) VALUES (?, ?)');
        for (const p of predIds) ins.run(p, id);
      }
    });
    tx();
    res.json(state());
  });

  // 删除提示（依赖随之外键级联删除）
  router.delete('/cues/:id', (req, res) => {
    const id = Number(req.params.id);
    const cue = db.prepare('SELECT id FROM cues WHERE id = ?').get(id);
    if (!cue) return res.status(404).json({ error: '提示不存在' });
    db.prepare('DELETE FROM cues WHERE id = ?').run(id);
    res.json(state());
  });

  // 轨道管理
  router.post('/tracks', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: '轨道名称不能为空' });
    try {
      db.prepare('INSERT INTO tracks (name) VALUES (?)').run(name);
    } catch (e) {
      return res.status(409).json({ error: '轨道名称已存在' });
    }
    res.status(201).json(state());
  });

  // ---------- 核心：拖动（依赖拓扑级联移动） ----------

  router.post('/cues/:id/move', (req, res) => {
    const rootId = Number(req.params.id);
    const root = db.prepare(`
      SELECT id, start_ms AS startMs FROM cues WHERE id = ?
    `).get(rootId);
    if (!root) return res.status(404).json({ error: '提示不存在' });

    let targetMs;
    try {
      targetMs = readSeconds(req.body || {}, 'start');
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const delta = targetMs - root.startMs;
    if (delta === 0) return res.json({ ...state(), moved: [] });

    const cues = getCues();
    const deps = getDeps();
    const byId = new Map(cues.map((c) => [c.id, c]));
    const { out, inn } = buildAdjacency(deps);

    // 1) 求后继传递闭包 —— 所有需要级联移动的提示
    const affected = transitiveClosure(out, [rootId]);

    // 2) 锁定检查（拖动路径上的锁定项整次回滚）
    const blockers = [];
    for (const aid of affected) {
      if (byId.get(aid).locked) {
        blockers.push({
          type: 'locked',
          chain: chain(rootId, aid, null, out),
          detail: `后继提示「${byId.get(aid).name}」已锁定，整条链不能移动`,
        });
      }
    }
    if (blockers.length) {
      return conflict(res, '移动回滚：依赖链上存在锁定提示', blockers);
    }

    // 3) 新位置
    const newStart = new Map();
    for (const aid of affected) newStart.set(aid, byId.get(aid).startMs + delta);
    if ([...newStart.values()].some((s) => s < 0)) {
      return conflict(res, '移动回滚：提示不能早于时间轴起点 0s', [{
        type: 'boundary',
        chain: [rootId],
        detail: '存在开始时间小于 0 的后继提示',
      }]);
    }

    // 4) 同轨时间冲突 + 跨越闭包边界的依赖约束
    for (const m of affected) {
      const ms = newStart.get(m);
      const me = ms + byId.get(m).durationMs;

      for (const u of cues) {
        if (affected.has(u.id) || u.trackId !== byId.get(m).trackId) continue;
        const ue = u.startMs + u.durationMs;
        if (overlaps(ms, me, u.startMs, ue)) {
          blockers.push({
            type: 'track-conflict',
            chain: chain(rootId, m, u.id, out),
            detail: `同轨提示「${u.name}」与级联后的「${byId.get(m).name}」时间重叠`,
          });
        }
      }
      // 前驱在闭包外：移动后不得早于前驱完成
      for (const p of inn.get(m) || []) {
        if (affected.has(p)) continue;
        const pred = byId.get(p);
        if (ms < pred.startMs + pred.durationMs) {
          blockers.push({
            type: 'dependency',
            chain: chain(rootId, m, p, out),
            detail: `违反“完成后触发”：「${pred.name}」完成前「${byId.get(m).name}」不能开始`,
          });
        }
      }
      // 后继在闭包外：级联后仍须先完成
      for (const s of out.get(m) || []) {
        if (affected.has(s)) continue;
        const succ = byId.get(s);
        if (succ.startMs < me) {
          blockers.push({
            type: 'dependency',
            chain: chain(rootId, m, s, out),
            detail: `违反“完成后触发”：级联后的「${byId.get(m).name}」完成前「${succ.name}」不能开始`,
          });
        }
      }
    }
    if (blockers.length) {
      return conflict(res, '移动回滚：检测到阻塞项，未做任何改动', blockers);
    }

    // 5) 提交（事务）并记录撤销快照
    const moves = [...affected].map((id) => ({
      id,
      from: byId.get(id).startMs,
      to: newStart.get(id),
    }));
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE cues SET start_ms = ? WHERE id = ?');
      for (const mv of moves) upd.run(mv.to, mv.id);
      db.prepare('INSERT INTO undo_log (action, created_at, payload) VALUES (?, ?, ?)')
        .run('move', Date.now(), JSON.stringify({ moves }));
    });
    tx();

    res.json({ ...state(), moved: moves.map((m) => m.id) });
  });

  // ---------- 撤销最近一次成功调整 ----------

  router.post('/undo', (req, res) => {
    const row = db.prepare('SELECT * FROM undo_log ORDER BY id DESC LIMIT 1').get();
    if (!row) return res.status(409).json({ error: '没有可撤销的调整', blockers: [] });

    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      db.prepare('DELETE FROM undo_log WHERE id = ?').run(row.id);
      return res.status(500).json({ error: '撤销记录损坏，已丢弃' });
    }
    const moves = payload.moves; // {id, from, to}
    const ids = new Set(moves.map((m) => m.id));
    const cues = getCues();
    const byId = new Map(cues.map((c) => [c.id, c]));
    const { out, inn } = buildAdjacency(getDeps());

    const blockers = [];
    for (const mv of moves) {
      const cue = byId.get(mv.id);
      if (!cue) {
        blockers.push({ type: 'missing', chain: [mv.id], detail: '原提示已被删除，无法撤销' });
        continue;
      }
      if (cue.locked) {
        blockers.push({ type: 'locked', chain: [mv.id], detail: `提示「${cue.name}」现已锁定` });
      }
    }
    const newStart = new Map(moves.map((m) => [m.id, m.from]));

    for (const mv of moves) {
      const cue = byId.get(mv.id);
      if (!cue) continue;
      const s = newStart.get(mv.id);
      const e = s + cue.durationMs;
      for (const u of cues) {
        if (ids.has(u.id) || u.trackId !== cue.trackId) continue;
        if (overlaps(s, e, u.startMs, u.startMs + u.durationMs)) {
          blockers.push({
            type: 'track-conflict',
            chain: [mv.id, u.id],
            detail: `撤销后与同轨提示「${u.name}」冲突`,
          });
        }
      }
      for (const p of inn.get(mv.id) || []) {
        if (ids.has(p)) continue;
        const pred = byId.get(p);
        if (s < pred.startMs + pred.durationMs) {
          blockers.push({
            type: 'dependency',
            chain: [p, mv.id],
            detail: `撤销后违反与「${pred.name}」的“完成后触发”依赖`,
          });
        }
      }
      for (const sc of out.get(mv.id) || []) {
        if (ids.has(sc)) continue;
        const succ = byId.get(sc);
        if (succ.startMs < e) {
          blockers.push({
            type: 'dependency',
            chain: [mv.id, sc],
            detail: `撤销后与后继「${succ.name}」冲突`,
          });
        }
      }
    }
    if (blockers.length) {
      return conflict(res, '撤销被阻塞，调整记录已保留（解除阻塞后可重试）', blockers);
    }

    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE cues SET start_ms = ? WHERE id = ?');
      for (const mv of moves) upd.run(mv.from, mv.id);
      // 仅保留最近一次：撤销成功后丢弃该记录
      db.prepare('DELETE FROM undo_log WHERE id = ?').run(row.id);
    });
    tx();
    res.json({ ...state(), moved: [...ids] });
  });

  return router;
}

module.exports = routes;
