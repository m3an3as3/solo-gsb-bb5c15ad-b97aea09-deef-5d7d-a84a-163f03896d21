'use strict';

// 依赖图工具：边 from -> to 表示 “from 完成后触发 to”，
// 即 to.start_ms >= from.start_ms + from.duration_ms。

function buildAdjacency(deps) {
  const out = new Map(); // cueId -> 后继
  const inn = new Map(); // cueId -> 前驱
  for (const d of deps) {
    // 兼容驼峰别名（API）与下划线字段
    const f = d.fromCue ?? d.from_cue;
    const t = d.toCue ?? d.to_cue;
    if (!out.has(f)) out.set(f, []);
    if (!inn.has(t)) inn.set(t, []);
    out.get(f).push(t);
    inn.get(t).push(f);
  }
  return { out, inn };
}

// 从 startIds 出发沿后继边可达的全部节点（含起点）
function transitiveClosure(out, startIds) {
  const reach = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop();
    if (reach.has(id)) continue;
    reach.add(id);
    for (const nxt of out.get(id) || []) stack.push(nxt);
  }
  return reach;
}

// BFS 求 start -> target 的最短路径（节点数组），无路径返回 null
function shortestPath(adj, start, target) {
  if (start === target) return [start];
  const prev = new Map([[start, null]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const nxt of adj.get(cur) || []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === target) {
        const path = [nxt];
        let p = cur;
        while (p !== null) { path.push(p); p = prev.get(p); }
        return path.reverse();
      }
      queue.push(nxt);
    }
  }
  return null;
}

// 加入假设边 extraFrom -> extraTo 后是否形成环
function createsCycle(out, extraFrom, extraTo) {
  if (extraFrom === extraTo) return { cycle: [extraFrom, extraTo] };
  // 若 extraTo 能沿现有后继到达 extraFrom，则 extraFrom -> extraTo 成环
  const path = shortestPath(out, extraTo, extraFrom);
  if (path) return { cycle: path.concat(extraTo) };
  return null;
}

// 拓扑排序（Kahn），用于返回级联顺序；有环返回 null
function topoOrder(out, nodeIds) {
  const nodes = new Set(nodeIds);
  const indeg = new Map();
  for (const id of nodes) indeg.set(id, 0);
  for (const id of nodes) {
    for (const s of out.get(id) || []) {
      if (nodes.has(s)) indeg.set(s, (indeg.get(s) || 0) + 1);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of out.get(id) || []) {
      if (!nodes.has(s)) continue;
      const d = indeg.get(s) - 1;
      indeg.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  return order.length === nodes.size ? order : null;
}

module.exports = { buildAdjacency, transitiveClosure, shortestPath, createsCycle, topoOrder };
