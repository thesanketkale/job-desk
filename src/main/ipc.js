'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, shell, dialog, app } = require('electron');

const db = require('./db');
const settings = require('./settings');
const applier = require('./applier');
const followups = require('./followups');
const ai = require('./ai');
const budget = require('./budget');
const mailer = require('./mailer');
const sources = require('./sources');
const masterCv = require('./master');
const pdf = require('./resume-pdf');
const docx = require('./resume-docx');
const { seedIfEmpty } = require('./seed');
const templates = require('./templates');
const updater = require('./updater');
const profile = require('./profile');
const resumeRead = require('./resume-read');
const providers = require('./providers');

/** Human labels for settings.deadSecrets()' raw keys, so a banner can say what
 *  needs re-entering rather than showing a database column name. */
const SECRET_LABELS = {
  anthropic_api_key: 'Claude API key',
  gemini_api_key: 'Google Gemini API key',
  openrouter_api_key: 'OpenRouter API key',
  smtp_password: 'Mailbox password',
  github_pat: 'GitHub access token',
  adzuna: 'Adzuna keys',
  jooble: 'Jooble key',
  jsearch: 'JSearch key',
  activejobsdb: 'Active Jobs DB key',
  ycjobs: 'Free Y Combinator Jobs API key',
};
const deadSecretLabels = () => settings.checkSecretsHealth().map((k) => SECRET_LABELS[k] || k);

/**
 * Today's "Recent activity" is meant to answer "what happened with my job
 * search" — where she applied, and when. Every db.logActivity() call writes
 * to the same table regardless of kind, which used to mean an AI key check
 * ($0.0002 on gemini-3.7-flash, one row per call), a key being saved, and a
 * raw update-checker error (a 404 against the unauthenticated releases feed,
 * expected until a GitHub token is added — see updater.js) all landed on the
 * home screen next to "sent to Acme Corp". Today now shows only the kinds a
 * person applying for jobs actually cares about; everything the table holds,
 * technical entries included, is still there in Settings for troubleshooting.
 */
const TODAY_ACTIVITY_KINDS = ['tailored', 'drafted', 'sent', 'submitted', 'send_failed', 'status', 'followup_sent', 'refresh'];

/** Every handler returns {ok:true, data} or {ok:false, error} — the interface
 *  never has to guess whether something threw. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

function register(ctx) {
  const { getMainWindow, runRefresh, isRefreshing, applyBrowser } = ctx;

  /* ---------------------------------------------------------- board ---- */

  handle('jobs:list', (q) => {
    const where = ["j.status IN ('new','saved','applied')"];
    const args = [];

    if (q.search?.trim()) {
      where.push('(j.title LIKE ? OR j.company LIKE ? OR j.description_text LIKE ?)');
      const like = `%${q.search.trim()}%`;
      args.push(like, like, like);
    }
    if (['remote', 'hybrid', 'onsite'].includes(q.mode)) { where.push('j.work_mode = ?'); args.push(q.mode); }
    if (q.country) { where.push('j.country = ?'); args.push(q.country); }
    if (q.city?.trim()) {
      where.push('(j.city LIKE ? OR j.region LIKE ? OR j.location_raw LIKE ?)');
      const like = `%${q.city.trim()}%`;
      args.push(like, like, like);
    }
    if (q.source) { where.push('j.source_label = ?'); args.push(q.source); }
    if (Number(q.minScore) > 0) { where.push('j.score >= ?'); args.push(Number(q.minScore)); }
    if (q.pools?.length) {
      where.push(`j.pool IN (${q.pools.map(() => '?').join(',')})`);
      args.push(...q.pools);
    }
    if (q.unappliedOnly) where.push("j.status <> 'applied'");

    const order = q.sort === 'date' ? 'j.posted_at DESC, j.fetched_at DESC'
      : q.sort === 'company' ? 'j.company ASC, j.score DESC'
        : 'j.score DESC, j.posted_at DESC';

    const page = Math.max(1, Number(q.page) || 1);
    const per = 25;
    const clause = `FROM jobs j WHERE ${where.join(' AND ')}`;
    const total = Number(db.val(`SELECT COUNT(*) AS n ${clause}`, args, 0));
    const rows = db.all(
      `SELECT j.*, a.id AS application_id, a.status AS application_status, a.match_score
       ${clause.replace('FROM jobs j', 'FROM jobs j LEFT JOIN applications a ON a.job_id = j.id')}
       ORDER BY ${order} LIMIT ${per} OFFSET ${(page - 1) * per}`, args);

    for (const r of rows) {
      try { r.matched_terms = JSON.parse(r.matched_terms || '[]'); } catch { r.matched_terms = []; }
    }
    return { rows, total, page, hasMore: page * per < total };
  });

  handle('jobs:get', ({ id }) => {
    const job = db.get('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!job) throw new Error('That role is no longer in the list.');
    try { job.matched_terms = JSON.parse(job.matched_terms || '[]'); } catch { job.matched_terms = []; }
    job.application = applier.byJob(id);
    return job;
  });

  handle('jobs:setStatus', ({ id, status }) => {
    if (!['new', 'saved', 'hidden', 'applied'].includes(status)) throw new Error('Unknown status.');
    db.update('jobs', { status }, 'id = ?', [id]);
    return true;
  });

  handle('jobs:facets', () => ({
    countries: db.all(`SELECT country, COUNT(*) AS n FROM jobs
                       WHERE status <> 'hidden' AND country <> ''
                       GROUP BY country ORDER BY n DESC LIMIT 24`),
    sources: db.all(`SELECT DISTINCT source_label FROM jobs WHERE source_label <> ''
                     ORDER BY source_label`).map((r) => r.source_label),
  }));

  /* ------------------------------------------------------- refresh ----- */

  // A single-source refresh used to call ingest.runAll() directly, bypassing
  // the `refreshing` mutex runRefresh() guards with — it could run at the
  // same time as a full refresh, racing the same fetch_rotation counter and
  // writing overlapping fetch_log rows. Routing it through runRefresh() the
  // same as every other refresh closes that gap.
  handle('refresh:run', ({ sourceId }) => runRefresh('button', sourceId || null));
  handle('refresh:status', () => ({ running: isRefreshing(), lastAt: settings.get('last_refresh_at', null) }));

  /* -------------------------------------------------- applications ----- */

  handle('apply:prepare', ({ jobId, force }) => applier.prepare(jobId, { force }));
  handle('apply:mode', () => ({ ai: ai.available() }));
  handle('apply:save', ({ id, ...fields }) => applier.save(id, fields));
  handle('apply:send', ({ id }) => applier.send(id));
  handle('apply:get', ({ id }) => applier.get(id));
  handle('apply:setStatus', ({ id, status }) => applier.setStatus(id, status));
  handle('apply:markSubmitted', ({ id, note }) => applier.markSubmitted(id, note));
  handle('apply:rails', ({ id }) => {
    const a = applier.get(id);
    return { problems: a ? applier.checkRails(a) : ['Application not found.'], remaining: applier.remainingToday() };
  });

  handle('applications:list', ({ status, search } = {}) => {
    const where = [];
    const args = [];
    if (status) { where.push('a.status = ?'); args.push(status); }
    if (search?.trim()) {
      where.push('(j.title LIKE ? OR j.company LIKE ?)');
      args.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }
    const rows = db.all(
      `SELECT a.*, j.title, j.company, j.location_raw, j.work_mode, j.apply_url, j.source_label
       FROM applications a JOIN jobs j ON j.id = a.job_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(a.sent_at, a.created_at) DESC LIMIT 400`, args);
    for (const r of rows) {
      try { r.match_notes = JSON.parse(r.match_notes || '[]'); } catch { r.match_notes = []; }
      r.followups = db.all('SELECT id, seq, due_on, status, sent_at FROM followups WHERE application_id = ? ORDER BY seq', [r.id]);
    }
    const counts = {};
    for (const c of db.all('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')) counts[c.status] = c.n;
    return { rows, counts, remainingToday: applier.remainingToday() };
  });

  /* ---------------------------------------------------- follow-ups ----- */

  handle('followups:list', () => ({
    due: followups.due(),
    upcoming: followups.upcoming(),
    history: followups.history(),
  }));
  handle('followups:draft', ({ id }) => followups.draft(id));
  handle('followups:send', ({ id, ...overrides }) => followups.send(id, overrides));
  handle('followups:skip', ({ id }) => followups.skip(id));
  handle('followups:snooze', ({ id, days }) => followups.snooze(id, days));

  /* ------------------------------------------------------ keywords ----- */

  handle('keywords:list', () => {
    const rows = db.all('SELECT * FROM keywords ORDER BY weight DESC, term');
    return { query: rows.filter((r) => r.kind === 'query'),
      boost: rows.filter((r) => r.kind === 'boost'),
      exclude: rows.filter((r) => r.kind === 'exclude') };
  });
  handle('keywords:add', ({ term, kind, weight }) => {
    const t = String(term || '').trim();
    if (!t || t.length > 120) throw new Error('Give it a term between 1 and 120 characters.');
    if (!['query', 'boost', 'exclude'].includes(kind)) throw new Error('Unknown list.');
    if (db.get('SELECT 1 AS x FROM keywords WHERE term = ? AND kind = ?', [t, kind])) {
      throw new Error('That term is already on this list.');
    }
    return db.insert('keywords', { term: t, kind, weight: Math.max(1, Math.min(10, Number(weight) || 6)),
      bucket: 'custom', source: 'user' });
  });
  // Touching a keyword makes it the person's own, so refreshing from an updated
  // resume leaves it alone rather than reverting their decision.
  handle('keywords:toggle', ({ id }) => {
    const changes = db.run('UPDATE keywords SET active = 1 - active WHERE id = ?', [id]).changes;
    profile.claimForUser(id);
    return changes;
  });
  handle('keywords:weight', ({ id, weight }) => {
    const out = db.update('keywords', { weight: Math.max(1, Math.min(10, Number(weight) || 6)) }, 'id = ?', [id]);
    profile.claimForUser(id);
    return out;
  });
  handle('keywords:delete', ({ id }) => db.run('DELETE FROM keywords WHERE id = ?', [id]).changes);

  /* -------------------------------------------------------- sources ---- */

  handle('sources:list', () => ({
    rows: db.all('SELECT * FROM sources ORDER BY type, label'),
    types: sources.TYPES,
    suggested: settings.get('suggested_boards', []),
    recent: db.all('SELECT * FROM fetch_log ORDER BY at DESC LIMIT 12'),
  }));
  handle('sources:probe', async ({ type, slug, id }) => {
    const r = await sources.probe(type, slug, settings.secrets());
    // Testing a saved source is a real check, not a throwaway — the row it
    // tests should show what the test found, the same as a scheduled refresh
    // would, or the table looks unchanged and a fixed key still looks broken.
    if (id) {
      db.update('sources', {
        last_run_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        last_status: r.ok ? 'ok' : 'error',
        last_count: r.count,
        last_error: r.ok ? null : r.error,
      }, 'id = ?', [id]);
    }
    return r;
  });
  handle('sources:add', async ({ type, label, slug }) => {
    if (!sources.TYPES[type]) throw new Error('Unknown kind of source.');
    if (!String(label || '').trim()) throw new Error('Give the source a name.');
    const probe = await sources.probe(type, slug, settings.secrets());
    if (!probe.ok) throw new Error(probe.error || 'That board did not respond.');
    return db.insert('sources', { type, label: label.trim(), slug: String(slug || '').trim(), config: '{}', active: 1 });
  });
  handle('sources:toggle', ({ id }) => db.run('UPDATE sources SET active = 1 - active WHERE id = ?', [id]).changes);
  handle('sources:delete', ({ id }) => db.run('DELETE FROM sources WHERE id = ?', [id]).changes);

  /* ------------------------------------------------------- settings ---- */

  handle('settings:get', () => ({
    ...settings.redacted(),
    dataDir: db.paths.root,
    resumeDir: db.paths.resumes,
    version: app.getVersion(),
    spend_usd: Number(settings.get('spend_usd', 0)),
    tailor_count: Number(settings.get('tailor_count', 0)),
    budget: budget.status(),
    aiEnabled: ai.available(),
    templates: templates.current(),
    deadSecrets: deadSecretLabels(),
  }));
  handle('templates:reset', () => {
    for (const [k, v] of Object.entries(templates.defaults())) settings.set(k, v);
    return templates.current();
  });
  handle('budget:status', () => budget.status());
  handle('settings:set', ({ patch }) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k.startsWith('secret:')) continue;
      settings.set(k, v);
    }
    return settings.redacted();
  });
  handle('settings:setSecret', ({ key, value }) => {
    if (!['anthropic_api_key', 'gemini_api_key', 'openrouter_api_key',
      'smtp_password', 'adzuna', 'jooble', 'jsearch',
      'activejobsdb', 'ycjobs', 'github_pat'].includes(key)) {
      throw new Error('Unknown credential.');
    }
    settings.setSecret(key, value);
    // Sources added after first install (see seed.js#seedNewSources) ship
    // active: 0 because a source with no key would fail loudly on the very
    // next refresh. Flip it on the moment its key is first saved, so saving
    // a key is the only step, not saving-then-remembering-the-Sources-page.
    // The same helper runs at launch too, so a baked-in build key (see
    // settings.js) activates its source without anyone having to save anything.
    settings.activateSourcesWithKeys();
    // Saving or clearing the token changes which GitHub provider electron-updater
    // uses (public vs. authenticated) — see updater.js#applyFeed. Re-apply it
    // immediately rather than waiting for the next launch. A token that was
    // just saved also gets an immediate check rather than waiting for the
    // next launch's background one — the point of pasting a token in is
    // usually "does this let me update right now", not "in eight seconds,
    // maybe, if I happen to still be looking". Not awaited: the network
    // round trip should not hold up the settings save, and checkNow() itself
    // never throws — a rejected/expired token just becomes a message in the
    // Activity log and Settings, the same as the periodic check.
    if (key === 'github_pat') {
      updater.applyFeed();
      if (value) updater.checkNow().catch(() => {});
    }
    return settings.redacted();
  });
  handle('settings:testMail', () => mailer.verify());
  handle('settings:testClaude', () => ai.ping());

  /** Everything the interface needs to draw the provider picker. */
  handle('ai:providers', () => ({
    providers: providers.catalogue().map((p) => ({
      ...p,
      // hasSecret, not getSecret: this decides "(key saved)" in the picker and
      // whether switching providers demands a key first — same reasoning as
      // settings.js#redacted, a baked key has no row to warn her is missing.
      hasKey: settings.hasSecret(providers.get(p.id).secret),
      // budget.modelsFor() is the one place that merges the provider's own live
      // catalogue into the hard-coded table. This used to keep a second copy of
      // that logic, and the two disagreed: the copy priced an unlisted model at
      // zero, which made it the cheapest thing in the list and had the setup
      // screen quote tailoring as costing nothing.
      models: budget.modelsFor(p.id),
    })),
    current: budget.providerId(),
    model: budget.model(),
  }));

  /**
   * Checks a typed key against the real API and saves it only if it works, so a
   * rejected key never ends up stored and silently failing later. Switching
   * provider is part of the same action — a key is meaningless without one.
   */
  handle('settings:validateClaudeKey', async ({ key, provider: wanted }) => {
    const id = wanted && providers.PROVIDERS[wanted] ? wanted : budget.providerId();
    const result = await ai.validateKey(key, id);

    settings.setSecret(providers.get(id).secret, String(key).trim());
    settings.set('ai_provider', id);
    // A model chosen for the old provider means nothing to the new one.
    if (wanted && wanted !== budget.providerId()) settings.set('ai_model', '');

    // Ask the provider what it actually offers, so the picker is never stale.
    const live = await ai.listModels(id, String(key).trim());
    if (live.length) settings.set(`ai_models_${id}`, live.slice(0, 200));

    db.logActivity('ai_key_added', `The ${providers.get(id).label} key was checked and saved.`);
    return { ...result, models: live };
  });

  /** Switching provider without retyping a key that is already stored. */
  handle('ai:setProvider', ({ provider: wanted, model }) => {
    if (!providers.PROVIDERS[wanted]) throw new Error('Unknown provider.');
    settings.set('ai_provider', wanted);
    if (model !== undefined) {
      settings.set('ai_model', String(model || ''));
      settings.set('ai_model_custom', !!model && !providers.get(wanted).models[model]);
    } else {
      settings.set('ai_model', '');
    }
    return { provider: budget.providerId(), model: budget.model(), aiEnabled: ai.available() };
  });

  handle('ai:setModel', ({ model }) => {
    const id = budget.providerId();
    settings.set('ai_model', String(model || ''));
    settings.set('ai_model_custom', !!model && !providers.get(id).models[model]);
    return { model: budget.model() };
  });
  handle('settings:sendTestEmail', async ({ to }) => {
    const cvPath = path.join(db.paths.resumes, 'master-preview.pdf');
    await pdf.render(masterCv.master(), cvPath);
    await mailer.send({
      to,
      subject: 'Job Desk test',
      text: 'If this arrived with the CV attached, sending works.',
      attachments: [{ path: cvPath, filename: 'CV.pdf' }],
    });
    return { ok: true };
  });

  /* -------------------------------------------------------- the CV ----- */

  handle('cv:get', () => masterCv.master());
  handle('cv:save', ({ data }) => {
    // A hand edit in Settings keeps the vocabulary as it is; rebuilding it is a
    // separate, deliberate button, so a typo fix never rewrites the board.
    const saved = masterCv.saveMaster(data);
    profile.syncProfile(saved);
    return saved;
  });
  /* -------------------------------------------------- the resume ------- */

  /** Opens the file picker. Kept in the main process — the renderer has no disk. */
  handle('resume:choose', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose your resume',
      properties: ['openFile'],
      filters: [
        { name: 'Resume', extensions: ['pdf', 'docx', 'txt', 'md', 'json'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word document', extensions: ['docx'] },
        { name: 'Plain text', extensions: ['txt', 'md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths?.length) return null;
    return profile.preview({ filePath: filePaths[0] });
  });

  /** Reads without saving, so the person can check it before it becomes theirs. */
  handle('resume:preview', ({ filePath, text }) => profile.preview({ filePath, text }));

  /** Commits a reviewed resume: CV, profile facts, mailbox and vocabulary. */
  handle('resume:apply', ({ cv, rebuildKeywords = true }) => {
    const result = profile.apply({ cv, rebuildKeywords });
    settings.set('onboarded', true);
    return result;
  });

  handle('resume:formats', () => ({ supported: resumeRead.SUPPORTED }));
  handle('profile:get', () => profile.current());

  /** The Settings button: build the vocabulary again from the CV as it stands. */
  handle('keywords:refreshFromResume', () => profile.rebuild());

  handle('cv:preview', async ({ which = 'pdf' }) => {
    const cv = masterCv.master();
    const out = path.join(db.paths.resumes, `master-preview.${which === 'docx' ? 'docx' : 'pdf'}`);
    await (which === 'docx' ? docx.render(cv, out) : pdf.render(cv, out));
    await shell.openPath(out);
    return out;
  });

  /* --------------------------------------------------------- files ----- */

  handle('file:open', ({ applicationId, which }) => {
    const a = applier.get(applicationId);
    if (!a) throw new Error('Application not found.');
    const p = which === 'docx' ? a.files.docx : a.files.pdf;
    if (!p || !fs.existsSync(p)) throw new Error('That file is not on disk any more.');
    return shell.openPath(p);
  });
  handle('file:reveal', ({ applicationId, which }) => {
    const a = applier.get(applicationId);
    if (!a) throw new Error('Application not found.');
    const p = which === 'docx' ? a.files.docx : a.files.pdf;
    if (!p || !fs.existsSync(p)) throw new Error('That file is not on disk any more.');
    shell.showItemInFolder(p);
    return true;
  });
  handle('file:saveAs', async ({ applicationId, which }) => {
    const a = applier.get(applicationId);
    if (!a) throw new Error('Application not found.');
    const from = which === 'docx' ? a.files.docx : a.files.pdf;
    if (!from || !fs.existsSync(from)) throw new Error('That file is not on disk any more.');
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: path.basename(from),
      filters: [{ name: which === 'docx' ? 'Word document' : 'PDF', extensions: [which === 'docx' ? 'docx' : 'pdf'] }],
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(from, filePath);
    return filePath;
  });
  handle('shell:openExternal', ({ url }) => {
    if (!/^https?:/i.test(url)) throw new Error('Only web links can be opened.');
    return shell.openExternal(url);
  });
  handle('shell:openDataFolder', () => shell.openPath(db.paths.root));

  /** The full, unfiltered log — everything Today's "Recent activity" leaves
   *  out (AI spend, key checks, update-checker errors) alongside what it
   *  shows, for troubleshooting from Settings rather than the home screen. */
  handle('activity:list', () => db.all('SELECT * FROM activity ORDER BY at DESC LIMIT 300'));

  /* --------------------------------------------- the apply browser ----- */

  handle('browser:open', async ({ applicationId }) => {
    const a = applier.get(applicationId);
    if (!a) throw new Error('Application not found.');
    if (!a.job?.apply_url) throw new Error('This role has no application page to open.');
    const cv = masterCv.master();
    const [firstName, ...rest] = String(cv.name).split(' ');
    // The CV as actually tailored for this role, so the AI pass in
    // apply-browser.js#fillForm answers screening questions from the same
    // document the employer is about to receive rather than the master CV.
    let tailoredCv = cv;
    try { tailoredCv = JSON.parse(a.resume_json) || cv; } catch { /* keep the master */ }

    applyBrowser.open({
      applicationId,
      matchScore: a.match_score,
      pdfPath: a.files.pdf,
      docxPath: a.files.docx,
      job: a.job,
      cv: tailoredCv,
      profile: {
        firstName,
        lastName: rest.join(' '),
        fullName: cv.name,
        email: cv.contact?.email || '',
        phone: cv.contact?.phone || '',
        linkedin: cv.contact?.linkedin ? `https://${String(cv.contact.linkedin).replace(/^https?:\/\//, '')}` : '',
        website: cv.contact?.website ? `https://${String(cv.contact.website).replace(/^https?:\/\//, '')}` : '',
        // No fallback beyond empty here on purpose. These used to default to one
        // real person's actual city, state, notice period and years of
        // experience — harmless-looking placeholder text that was in fact her
        // details, shipping in every installer regardless of who runs it,
        // typed straight into someone else's company-form fields until they
        // set their own in Settings. `profile.syncProfile()` already fills
        // city/state/country from the CV at import time when the CV has them;
        // an empty box the person notices and fills in beats a wrong answer
        // that looks plausible enough to send.
        city: settings.get('profile_city', ''),
        state: settings.get('profile_state', ''),
        country: settings.get('profile_country', ''),
        location: cv.contact?.location || '',
        noticePeriod: settings.get('profile_notice', ''),
        yearsExperience: settings.get('profile_years', ''),
        currentSalary: '',
        expectedSalary: settings.get('profile_expected_salary', ''),
        coverLetter: a.cover_letter || '',
      },
    }, getMainWindow());
    return true;
  });
  handle('browser:fill', () => applyBrowser.fillForm());
  handle('browser:attach', ({ which }) => applyBrowser.attachResume(which));
  handle('browser:reveal', ({ which }) => applyBrowser.revealResume(which));
  handle('browser:nav', ({ action }) => applyBrowser.nav(action));
  handle('browser:close', () => applyBrowser.close());
  handle('browser:context', () => applyBrowser.publicContext());
  handle('browser:submitted', async ({ applicationId, note }) => {
    const confirmed = await applyBrowser.confirmSubmitted(getMainWindow());
    if (!confirmed) return null;
    const result = applier.markSubmitted(applicationId, note || 'Submitted through the company form.');
    applyBrowser.close();
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('applications:changed');
    return result;
  });

  /* ----------------------------------------------------- dashboard ----- */

  handle('dashboard:get', () => {
    const counts = {};
    for (const c of db.all('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')) counts[c.status] = c.n;
    const sent = (counts.sent || 0) + (counts.submitted || 0) + (counts.replied || 0)
      + (counts.interview || 0) + (counts.offer || 0);
    const replies = (counts.replied || 0) + (counts.interview || 0) + (counts.offer || 0);
    return {
      jobsAvailable: Number(db.val("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('new','saved')", [], 0)),
      freshToday: Number(db.val("SELECT COUNT(*) AS n FROM jobs WHERE fetched_at > datetime('now','-2 days')", [], 0)),
      applications: Number(db.val('SELECT COUNT(*) AS n FROM applications', [], 0)),
      sent,
      replies,
      replyRate: sent ? Math.round((replies / sent) * 100) : 0,
      interviews: counts.interview || 0,
      followupsDue: followups.due().length,
      budget: budget.status(),
      remainingToday: applier.remainingToday(),
      dailyCap: Number(settings.get('max_sends_per_day', 12)),
      lastRefresh: settings.get('last_refresh_at', null),
      activity: db.all(`SELECT * FROM activity WHERE kind IN (${TODAY_ACTIVITY_KINDS.map(() => '?').join(',')})
        ORDER BY at DESC LIMIT 12`, TODAY_ACTIVITY_KINDS),
      cvReady: !masterCv.isPlaceholder(),
      profileName: settings.get('profile_name', '') || (() => {
        try { return masterCv.master().name; } catch { return ''; }
      })(),
      canSendEmail: settings.hasSecret('smtp_password') && !!settings.get('smtp_user', ''),
      aiEnabled: ai.available(),
      onboarded: !!settings.get('onboarded', false),
      deadSecrets: deadSecretLabels(),
    };
  });

  handle('app:reseed', () => { seedIfEmpty(); return true; });
  handle('app:backup', () => db.backup());
  handle('app:checkUpdates', () => updater.checkNow());
  handle('app:updateStatus', () => ({
    enabled: updater.enabled(), ...updater.config(), version: app.getVersion(),
    hasToken: updater.hasToken(), lastCheck: updater.lastCheck,
  }));
}

module.exports = { register };
