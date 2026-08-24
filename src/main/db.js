'use strict';
/**
 * Local database. node:sqlite ships inside Electron, so there is no native
 * module to compile and nothing to install on the machine this runs on.
 * Everything — jobs, applications, the CVs that were sent, follow-ups —
 * lives in one file the user owns and can copy anywhere.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

let db = null;
let paths = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS keywords (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  term    TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'query',   -- query | boost | exclude
  weight  INTEGER NOT NULL DEFAULT 6,
  bucket  TEXT NOT NULL DEFAULT 'general',
  active  INTEGER NOT NULL DEFAULT 1,
  hits    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (term, kind)
);

CREATE TABLE IF NOT EXISTS sources (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  type   TEXT NOT NULL,
  label  TEXT NOT NULL,
  slug   TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_count  INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  source_id INTEGER,
  source_type TEXT NOT NULL DEFAULT '',
  source_label TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  company_site TEXT NOT NULL DEFAULT '',
  location_raw TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  work_mode TEXT NOT NULL DEFAULT 'unknown',
  employment_type TEXT NOT NULL DEFAULT '',
  salary_text TEXT NOT NULL DEFAULT '',
  description_html TEXT,
  description_text TEXT,
  apply_url TEXT NOT NULL DEFAULT '',
  apply_email TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  score INTEGER NOT NULL DEFAULT 0,
  pool TEXT NOT NULL DEFAULT 'general',
  matched_terms TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new'      -- new | saved | hidden | applied
);
CREATE INDEX IF NOT EXISTS idx_jobs_browse ON jobs(status, score DESC, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_mode   ON jobs(work_mode);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  -- draft | queued | sent | failed | submitted | replied | interview | rejected | offer | withdrawn
  method TEXT NOT NULL DEFAULT 'email',   -- email | form | manual
  to_email TEXT NOT NULL DEFAULT '',
  to_name  TEXT NOT NULL DEFAULT '',
  subject  TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  cover_letter TEXT NOT NULL DEFAULT '',
  resume_json TEXT,
  resume_pdf  TEXT NOT NULL DEFAULT '',
  resume_docx TEXT NOT NULL DEFAULT '',
  match_score INTEGER NOT NULL DEFAULT 0,
  match_notes TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'template',   -- 'ai' if a key rewrote it, else 'template'
  notes TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status, created_at DESC);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | sent | skipped | cancelled
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fu_due ON followups(status, due_on);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  job_id INTEGER,
  application_id INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at DESC);

CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  label TEXT NOT NULL DEFAULT '',
  ms INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
`;

function init(userDataDir) {
  paths = {
    root: userDataDir,
    dbFile: path.join(userDataDir, 'jobdesk.sqlite'),
    resumes: path.join(userDataDir, 'resumes'),
    logs: path.join(userDataDir, 'logs'),
    backups: path.join(userDataDir, 'backups'),
  };
  for (const d of [paths.root, paths.resumes, paths.logs, paths.backups]) {
    fs.mkdirSync(d, { recursive: true });
  }
  db = new DatabaseSync(paths.dbFile);
  db.exec(SCHEMA);
  migrate();
  return db;
}

/** Additive-only migrations, safe to run on every launch. */
function migrate() {
  const cols = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
  if (!cols.includes('mode')) {
    db.exec("ALTER TABLE applications ADD COLUMN mode TEXT NOT NULL DEFAULT 'template'");
  }
}

const handle = () => {
  if (!db) throw new Error('Database is not open yet');
  return db;
};

const all = (sql, args = []) => handle().prepare(sql).all(...args);
const get = (sql, args = []) => handle().prepare(sql).get(...args) ?? null;
const run = (sql, args = []) => handle().prepare(sql).run(...args);
const val = (sql, args = [], fallback = null) => {
  const row = get(sql, args);
  if (!row) return fallback;
  const v = Object.values(row)[0];
  return v === undefined || v === null ? fallback : v;
};

function insert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(run(sql, cols.map((c) => row[c])).lastInsertRowid);
}

function update(table, row, where, args = []) {
  const cols = Object.keys(row);
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE ${where}`;
  return run(sql, [...cols.map((c) => row[c]), ...args]).changes;
}

function logActivity(kind, detail, ids = {}) {
  insert('activity', {
    kind,
    detail: String(detail).slice(0, 500),
    job_id: ids.jobId ?? null,
    application_id: ids.applicationId ?? null,
  });
}

/** Timestamped copy of the database file — cheap insurance before a risky change. */
function backup() {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(paths.backups, `jobdesk-${stamp}.sqlite`);
  handle().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(paths.dbFile, target);
  const kept = fs.readdirSync(paths.backups).filter((f) => f.endsWith('.sqlite')).sort();
  while (kept.length > 10) fs.unlinkSync(path.join(paths.backups, kept.shift()));
  return target;
}

module.exports = { init, all, get, run, val, insert, update, logActivity, backup,
  get paths() {
    if (!paths) throw new Error('The database is not open yet.');
    return paths;
  },
  handle };
