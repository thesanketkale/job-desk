'use strict';
/**
 * Preferences live in the database as plain JSON. Secrets (the Claude key, the
 * mailbox password) go through Electron's safeStorage, which encrypts them with
 * a key held by the operating system's own credential store — so the database
 * file on its own does not expose them.
 */
const db = require('./db');

let safeStorage = null;
if (process.versions.electron) {
  try { ({ safeStorage } = require('electron')); } catch { /* main process not ready */ }
}

const DEFAULTS = {
  work_mode_preference: { remote: 12, hybrid: 5, onsite: 0 },
  preferred_countries: ['India', 'Remote'],
  min_score_to_show: 25,
  refresh_on_launch: true,
  refresh_last_date: '',
  followup_days: [7, 16],
  followups_enabled: true,
  max_sends_per_day: 12,
  company_cooldown_days: 30,
  claude_model: 'claude-sonnet-5',
  budget_usd_monthly: 10,
  spend_by_month: {},
  bcc_self: true,
  onboarded: false,
};

// One key per provider, kept separately so switching back does not lose the other.
const SECRET_KEYS = new Set(['anthropic_api_key', 'gemini_api_key', 'openrouter_api_key',
  'smtp_password', 'adzuna', 'usajobs', 'jooble', 'jsearch', 'activejobsdb', 'ycjobs']);

function get(key, fallback = undefined) {
  const row = db.get('SELECT v FROM settings WHERE k = ?', [key]);
  if (!row) return fallback !== undefined ? fallback : DEFAULTS[key];
  try { return JSON.parse(row.v); } catch { return row.v; }
}

function set(key, value) {
  db.run('INSERT INTO settings (k, v, updated_at) VALUES (?, ?, datetime(\'now\')) '
    + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
    [key, JSON.stringify(value)]);
}

function all() {
  const out = { ...DEFAULTS };
  for (const r of db.all('SELECT k, v FROM settings')) {
    if (r.k.startsWith('secret:') || SECRET_KEYS.has(r.k)) continue;
    try { out[r.k] = JSON.parse(r.v); } catch { out[r.k] = r.v; }
  }
  return out;
}

/* ---- secrets ---------------------------------------------------------- */

function setSecret(key, value) {
  if (value === null || value === undefined || value === '') {
    db.run('DELETE FROM settings WHERE k = ?', [`secret:${key}`]);
    return;
  }
  const raw = JSON.stringify(value);
  let stored;
  if (safeStorage?.isEncryptionAvailable()) {
    stored = { enc: 'os', data: safeStorage.encryptString(raw).toString('base64') };
  } else {
    // The OS keyring is unavailable (rare, and mostly on bare Linux). Store it
    // readable rather than silently losing it, and tell the user in Settings.
    stored = { enc: 'plain', data: raw };
  }
  db.run('INSERT INTO settings (k, v, updated_at) VALUES (?, ?, datetime(\'now\')) '
    + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
    [`secret:${key}`, JSON.stringify(stored)]);
}

function getSecret(key, fallback = null) {
  const row = db.get('SELECT v FROM settings WHERE k = ?', [`secret:${key}`]);
  if (!row) return fallback;
  try {
    const stored = JSON.parse(row.v);
    const raw = stored.enc === 'os'
      ? safeStorage.decryptString(Buffer.from(stored.data, 'base64'))
      : stored.data;
    return JSON.parse(raw);
  } catch { return fallback; }
}

const hasSecret = (key) => !!db.get('SELECT 1 AS x FROM settings WHERE k = ?', [`secret:${key}`]);

/** Everything the fetchers and the mailer need, gathered in one place. */
function secrets() {
  return {
    anthropic: getSecret('anthropic_api_key', ''),
    adzuna: getSecret('adzuna', { app_id: '', app_key: '' }),
    usajobs: getSecret('usajobs', { email: '', api_key: '' }),
    jooble: getSecret('jooble', { api_key: '' }),
    jsearch: getSecret('jsearch', { api_key: '' }),
    activejobsdb: getSecret('activejobsdb', { api_key: '' }),
    ycjobs: getSecret('ycjobs', { api_key: '' }),
    smtp: {
      host: get('smtp_host', ''),
      port: Number(get('smtp_port', 465)),
      secure: get('smtp_secure', true),
      user: get('smtp_user', ''),
      pass: getSecret('smtp_password', ''),
      from_name: get('smtp_from_name', ''),
      from_email: get('smtp_from_email', ''),
    },
  };
}

/** What the Settings screen needs to render without ever seeing a secret. */
function redacted() {
  return {
    ...all(),
    smtp_host: get('smtp_host', ''),
    smtp_port: Number(get('smtp_port', 465)),
    smtp_secure: get('smtp_secure', true),
    smtp_user: get('smtp_user', ''),
    smtp_from_name: get('smtp_from_name', ''),
    smtp_from_email: get('smtp_from_email', ''),
    has_anthropic_key: hasSecret('anthropic_api_key'),
    has_gemini_key: hasSecret('gemini_api_key'),
    has_openrouter_key: hasSecret('openrouter_api_key'),
    has_smtp_password: hasSecret('smtp_password'),
    has_adzuna: !!(getSecret('adzuna', {}).app_id),
    has_jooble: !!(getSecret('jooble', {}).api_key),
    has_jsearch: !!(getSecret('jsearch', {}).api_key),
    has_activejobsdb: !!(getSecret('activejobsdb', {}).api_key),
    has_ycjobs: !!(getSecret('ycjobs', {}).api_key),
    encryption_available: !!safeStorage?.isEncryptionAvailable(),
  };
}

module.exports = { DEFAULTS, get, set, all, setSecret, getSecret, hasSecret, secrets, redacted };
