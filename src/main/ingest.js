'use strict';
const db = require('./db');
const settings = require('./settings');
const normalize = require('./normalize');
const score = require('./score');
const { fetchSource } = require('./sources');

/**
 * Runs every active source and folds what comes back into the jobs table.
 * onProgress lets the window show which source it is on rather than freezing.
 */
async function runAll({ sourceId = null, onProgress = () => {} } = {}) {
  const keywords = db.all('SELECT term, kind, weight, active FROM keywords WHERE active = 1');
  const queries = keywords.filter((k) => k.kind === 'query').map((k) => k.term);
  if (!queries.length) queries.push('counselling psychologist');

  const prefs = {
    work_mode_preference: settings.get('work_mode_preference'),
    preferred_countries: settings.get('preferred_countries'),
  };
  const minScore = Number(settings.get('min_score_to_show', 25));
  const secrets = settings.secrets();

  const sources = sourceId
    ? db.all('SELECT * FROM sources WHERE id = ?', [sourceId])
    : db.all('SELECT * FROM sources WHERE active = 1 ORDER BY id');

  const summary = { sources: 0, found: 0, inserted: 0, updated: 0, errors: [] };

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    onProgress({ index: i, total: sources.length, label: src.label });

    const started = Date.now();
    const { rows, error } = await fetchSource(src, queries, secrets);
    let inserted = 0;
    let updated = 0;

    for (const raw of rows) {
      const r = upsert(raw, src, keywords, prefs, minScore);
      if (r === 'insert') inserted++;
      else if (r === 'update') updated++;
    }

    const ms = Date.now() - started;
    db.insert('fetch_log', {
      label: src.label, ms, found: rows.length, inserted, updated,
      ok: error ? 0 : 1, error: error || null,
    });
    db.update('sources', {
      last_run_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      last_status: error ? 'error' : 'ok',
      last_count: rows.length,
      last_error: error || null,
    }, 'id = ?', [src.id]);

    summary.sources++;
    summary.found += rows.length;
    summary.inserted += inserted;
    summary.updated += updated;
    if (error) summary.errors.push(`${src.label}: ${error}`);
  }

  prune();
  settings.set('last_refresh_at', new Date().toISOString());
  db.logActivity('refresh', `${summary.inserted} new, ${summary.updated} updated, from ${summary.sources} sources`);
  return summary;
}

function upsert(raw, src, keywords, prefs, minScore) {
  const title = String(raw.title || '').trim();
  if (!title) return 'skip';

  const descText = normalize.text(raw.description_html);
  const { city, region, country } = normalize.place(raw.location_raw || '');
  const mode = normalize.workMode(title, raw.location_raw || '', descText, raw.remote_flag);
  const email = raw.apply_email || normalize.findEmail(descText);

  const job = {
    title: title.slice(0, 255),
    company: String(raw.company || '').trim().slice(0, 190),
    company_site: String(raw.company_site || '').slice(0, 255),
    location_raw: String(raw.location_raw || '').slice(0, 255),
    city, region, country,
    work_mode: mode,
    employment_type: String(raw.employment_type || '').slice(0, 60),
    salary_text: String(raw.salary_text || '').slice(0, 160),
    description_html: normalize.safeHtml(raw.description_html),
    description_text: descText.slice(0, 60000),
    apply_url: String(raw.apply_url || '').slice(0, 600),
    apply_email: String(email || '').slice(0, 190),
    posted_at: normalize.date(raw.posted_at),
  };

  const { score: value, matched, pool } = score.rate(job, keywords, prefs);
  if (value < 0 || value < minScore) return 'skip';

  const fingerprint = normalize.fingerprint(job.company, job.title, raw.external_id || '', job.apply_url);
  const existing = db.get('SELECT id FROM jobs WHERE fingerprint = ?', [fingerprint]);

  const record = {
    ...job,
    source_id: src.id,
    source_type: src.type,
    source_label: src.label,
    external_id: String(raw.external_id || '').slice(0, 190),
    score: value,
    pool,
    matched_terms: JSON.stringify(matched),
    fetched_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };

  for (const term of matched) db.run('UPDATE keywords SET hits = hits + 1 WHERE term = ?', [term]);

  if (existing) {
    db.update('jobs', record, 'id = ?', [existing.id]);
    return 'update';
  }
  db.insert('jobs', { ...record, fingerprint });
  return 'insert';
}

/** Drops stale listings she never touched. Anything she acted on is kept for ever. */
function prune() {
  db.run(`DELETE FROM jobs WHERE status = 'new'
          AND id NOT IN (SELECT job_id FROM applications)
          AND fetched_at < datetime('now', '-45 days')`);
  db.run("DELETE FROM fetch_log WHERE at < datetime('now', '-60 days')");
}

module.exports = { runAll };
