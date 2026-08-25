'use strict';
/**
 * First-run sources and settings. All of it is editable in the app.
 *
 * There is deliberately no starter vocabulary here. Keywords are built from the
 * person's own resume on import (`profile.rebuild`), because a list typed by
 * somebody else describes somebody else's career — it filled the board with
 * counselling roles for a data analyst, and every term in it had to be deleted
 * by hand before the board was any use.
 */
const db = require('./db');
const settings = require('./settings');

const SOURCES = [
  ['adzuna', 'Adzuna — India', '', { countries: ['in'], pages: 2, max_queries: 3 }, 1],
  ['remotive', 'Remotive — remote roles', '', {}, 1],
  ['remoteok', 'RemoteOK — remote roles', '', {}, 1],
  ['himalayas', 'Himalayas — remote roles', '', {}, 1],
  ['arbeitnow', 'Arbeitnow — EU/UK feed', '', {}, 1],
  ['greenhouse', 'Anthropic', 'anthropic', {}, 1],
  ['greenhouse', 'Scale AI', 'scaleai', {}, 1],
  ['ashby', 'OpenAI', 'openai', {}, 1],
  // active: 0 — a source with no key would otherwise fail loudly on the very
  // next refresh. ipc.js#settings:setSecret flips it on when the key is saved.
  ['jooble', 'Jooble — India', '', { location: 'India', pages: 3, max_queries: 4 }, 0],
  ['jsearch', 'JSearch — India', '', { location: 'India', country: 'in', num_pages: 1, max_queries: 2 }, 0],
  ['activejobsdb', 'Active Jobs DB — India', '', { location: 'India', time_frame: '7d', max_queries: 3 }, 0],
  ['ycjobs', 'Free Y Combinator Jobs API', '', { window: '7d' }, 0],
];

/** Offered in the app as one-click "test and add". Not enabled by default. */
const SUGGESTED = [
  ['ashby', 'Mercor', 'mercor'],
  ['ashby', 'Surge AI', 'surge'],
  ['ashby', 'Perplexity', 'perplexity'],
  ['greenhouse', 'Lyra Health', 'lyrahealth'],
  ['greenhouse', 'Spring Health', 'springhealth'],
  ['greenhouse', 'Headspace', 'headspace'],
  ['greenhouse', 'Talkspace', 'talkspace'],
  ['greenhouse', 'Modern Health', 'modernhealth'],
  ['greenhouse', 'Calm', 'calm'],
  ['greenhouse', 'BetterUp', 'betterup'],
  ['greenhouse', 'Included Health', 'includedhealth'],
  ['lever', 'Sama', 'samasource'],
  ['lever', 'Turing', 'turing'],
  ['workable', 'Amaha', 'amaha'],
  ['workable', 'YourDOST', 'yourdost'],
];

function seedIfEmpty() {
  if (db.val('SELECT COUNT(*) AS n FROM sources', [], 0) === 0) {
    for (const [type, label, slug, config, active] of SOURCES) {
      db.insert('sources', { type, label, slug, config: JSON.stringify(config), active });
    }
  }
  seedNewSources();
  settings.set('suggested_boards', SUGGESTED);
  for (const [k, v] of Object.entries(settings.DEFAULTS)) {
    if (db.get('SELECT 1 AS x FROM settings WHERE k = ?', [k]) === null) settings.set(k, v);
  }
  seedMailboxFromCv();
}

/**
 * Adds sources introduced after an install was first set up. seedIfEmpty()'s
 * bulk insert above only fires once, on a genuinely empty table, so an
 * existing install would never see a source added to SOURCES later without
 * this running every launch to top it up.
 */
function seedNewSources() {
  for (const [type, label, slug, config, active] of SOURCES) {
    if (db.get('SELECT 1 AS x FROM sources WHERE type = ? AND slug = ?', [type, slug])) continue;
    db.insert('sources', { type, label, slug, config: JSON.stringify(config), active });
  }
}

/**
 * Pre-fills the mailbox from whatever CV is loaded, so she does not retype what
 * the app already knows and no address is baked into the installer.
 */
function seedMailboxFromCv() {
  if (settings.get('smtp_from_email', '')) return;
  let cv;
  try { cv = require('./master').master(); } catch { return; }
  const email = cv && cv.contact && cv.contact.email;
  if (!email || !email.includes('@')) return;

  settings.set('smtp_host', 'mail.' + email.split('@')[1]);
  settings.set('smtp_port', 465);
  settings.set('smtp_secure', true);
  settings.set('smtp_user', email);
  settings.set('smtp_from_email', email);
  settings.set('smtp_from_name', cv.name || '');
}

module.exports = { seedIfEmpty, seedNewSources, seedMailboxFromCv, SUGGESTED };
