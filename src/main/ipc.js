'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, shell, dialog, app } = require('electron');

const db = require('./db');
const settings = require('./settings');
const applier = require('./applier');
const followups = require('./followups');
const claude = require('./claude');
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
  const { getMainWindow, runRefresh, isRefreshing, scheduleAutoRefresh, applyBrowser } = ctx;

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

  handle('refresh:run', ({ sourceId }) => (sourceId
    ? require('./ingest').runAll({ sourceId })
    : runRefresh('button')));
  handle('refresh:status', () => ({ running: isRefreshing(), lastAt: settings.get('last_refresh_at', null) }));

  /* -------------------------------------------------- applications ----- */

  handle('apply:prepare', ({ jobId, force }) => applier.prepare(jobId, { force }));
  handle('apply:mode', () => ({ ai: claude.available() }));
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
  handle('sources:probe', ({ type, slug }) => sources.probe(type, slug, settings.secrets()));
  handle('sources:add', async ({ type, label, slug }) => {
    if (!sources.TYPES[type]) throw new Error('Unknown kind of source.');
    if (!String(label || '').trim()) throw new Error('Give the source a name.');
    const probe = await sources.probe(type, slug, settings.secrets());
    if (!probe.ok) throw new Error(`That board did not respond: ${probe.error}`);
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
    aiEnabled: claude.available(),
    templates: templates.current(),
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
    if ('refresh_every_hours' in (patch || {})) scheduleAutoRefresh();
    return settings.redacted();
  });
  handle('settings:setSecret', ({ key, value }) => {
    if (!['anthropic_api_key', 'smtp_password', 'adzuna', 'usajobs'].includes(key)) {
      throw new Error('Unknown credential.');
    }
    settings.setSecret(key, value);
    return settings.redacted();
  });
  handle('settings:testMail', () => mailer.verify());
  handle('settings:testClaude', () => claude.ping());
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
        { name: 'Resume', extensions: ['docx', 'txt', 'md', 'json'] },
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

  /* --------------------------------------------- the apply browser ----- */

  handle('browser:open', async ({ applicationId }) => {
    const a = applier.get(applicationId);
    if (!a) throw new Error('Application not found.');
    if (!a.job?.apply_url) throw new Error('This role has no application page to open.');
    const cv = masterCv.master();
    const [firstName, ...rest] = String(cv.name).split(' ');
    applyBrowser.open({
      applicationId,
      matchScore: a.match_score,
      pdfPath: a.files.pdf,
      docxPath: a.files.docx,
      job: a.job,
      profile: {
        firstName,
        lastName: rest.join(' '),
        fullName: cv.name,
        email: cv.contact?.email || '',
        phone: cv.contact?.phone || '',
        linkedin: cv.contact?.linkedin ? `https://${String(cv.contact.linkedin).replace(/^https?:\/\//, '')}` : '',
        website: cv.contact?.website ? `https://${String(cv.contact.website).replace(/^https?:\/\//, '')}` : '',
        city: settings.get('profile_city', 'Vadodara'),
        state: settings.get('profile_state', 'Gujarat'),
        country: settings.get('profile_country', 'India'),
        location: cv.contact?.location || '',
        noticePeriod: settings.get('profile_notice', 'Immediate'),
        yearsExperience: settings.get('profile_years', '8'),
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
      activity: db.all('SELECT * FROM activity ORDER BY at DESC LIMIT 12'),
      cvReady: !masterCv.isPlaceholder(),
      profileName: settings.get('profile_name', '') || (() => {
        try { return masterCv.master().name; } catch { return ''; }
      })(),
      canSendEmail: settings.hasSecret('smtp_password') && !!settings.get('smtp_user', ''),
      aiEnabled: claude.available(),
      onboarded: !!settings.get('onboarded', false),
    };
  });

  handle('app:reseed', () => { seedIfEmpty(); return true; });
  handle('app:backup', () => db.backup());
  handle('app:checkUpdates', () => updater.checkNow());
  handle('app:updateStatus', () => ({ enabled: updater.enabled(), ...updater.config(), version: app.getVersion() }));
}

module.exports = { register };
