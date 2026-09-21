'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS cues (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK (type IN ('light','sound')),
      track_id    INTEGER NOT NULL REFERENCES tracks(id),
      start_ms    INTEGER NOT NULL CHECK (start_ms >= 0),
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      locked      INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1))
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_cue   INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
      to_cue     INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
      UNIQUE(from_cue, to_cue),
      CHECK (from_cue <> to_cue)
    );

    CREATE TABLE IF NOT EXISTS undo_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cues_track      ON cues(track_id);
    CREATE INDEX IF NOT EXISTS idx_deps_from       ON dependencies(from_cue);
    CREATE INDEX IF NOT EXISTS idx_deps_to         ON dependencies(to_cue);
  `);
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  if (count > 0) return;

  const insTrack = db.prepare('INSERT INTO tracks (name) VALUES (?)');
  const trackIds = {};
  for (const name of ['灯光-主台', '灯光-侧台', '音效-主控', '音效-备线']) {
    trackIds[name] = insTrack.run(name).lastInsertRowid;
  }

  const insCue = db.prepare(`
    INSERT INTO cues (name, type, track_id, start_ms, duration_ms, locked)
    VALUES (@name, @type, @track_id, @start_ms, @duration_ms, @locked)
  `);
  const insDep = db.prepare('INSERT INTO dependencies (from_cue, to_cue) VALUES (?, ?)');

  const c = (name, type, track, start_ms, duration_ms, locked = 0) =>
    insCue.run({
      name, type, track_id: trackIds[track],
      start_ms, duration_ms, locked: locked ? 1 : 0,
    }).lastInsertRowid;

  const tx = db.transaction(() => {
    const prelude  = c('开场序曲', 'sound', '音效-主控',    0,  10000);
    const houseOff = c('场灯渐暗', 'light', '灯光-主台',    2000, 8000);
    const spot1    = c('主角追光', 'light', '灯光-主台',    12000, 6000, 1);
    const entry    = c('登场音效', 'sound', '音效-主控',    12000, 3000);
    const wash     = c('蓝调铺光', 'light', '灯光-侧台',    15000, 8000);
    const sting    = c('重音点',   'sound', '音效-备线',    18000, 1500);
    const chase    = c('跑灯序列', 'light', '灯光-侧台',    23000, 5000);
    const finale   = c('终场和弦', 'sound', '音效-主控',    28000, 6000);

    const deps = [
      [prelude, entry],
      [houseOff, spot1],
      [entry, wash],
      [spot1, chase],
      [wash, chase],
      [sting, finale],
    ];
    for (const [f, t] of deps) insDep.run(f, t);
  });
  tx();
}

function initDb() {
  const db = openDb();
  initSchema(db);
  seed(db);
  return db;
}

module.exports = { initDb };
