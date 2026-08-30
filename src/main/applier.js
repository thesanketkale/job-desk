'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./settings');
const ai = require('./ai');
const templates = require('./templates');
const mailer = require('./mailer');
const pdf = require('./resume-pdf');
const docx = require('./resume-docx');
const { master, isPlaceholder } = require('./master');
const followups = require('./followups');

const SENT_STATES = ['sent', 'submitted', 'replied', 'interview', 'rejected', 'offer', 'withdrawn'];
const slug = (s, max = 46) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function get(id) {
  const a = db.get('SELECT * FROM applications WHERE id = ?', [id]);
  if (!a) return null;
  a.job = db.get('SELECT * FROM jobs WHERE id = ?', [a.job_id]) || {};
  try { a.match_notes = JSON.parse(a.match_notes || '[]'); } catch { a.match_notes = []; }
  try { a.automation_log = JSON.parse(a.automation_log || '[]'); } catch { a.automation_log = []; }
  a.followups = db.all('SELECT * FROM followups WHERE application_id = ? ORDER BY seq', [id]);
  a.files = {
    pdf: a.resume_pdf ? path.join(db.paths.resumes, a.resume_pdf) : null,
    docx: a.resume_docx ? path.join(db.paths.resumes, a.resume_docx) : null,
    aiPdf: a.ai_resume_pdf ? path.join(db.paths.resumes, a.ai_resume_pdf) : null,
    aiDocx: a.ai_resume_docx ? path.join(db.paths.resumes, a.ai_resume_docx) : null,
  };
  return a;
}

const byJob = (jobId) => {
  const row = db.get('SELECT id FROM applications WHERE job_id = ?', [jobId]);
  return row ? get(row.id) : null;
};

/**
 * Tailors the CV against a role and stores a draft. Regenerating is fine;
 * an application that already went out is left alone unless forced.
 */
async function prepare(jobId, { force = false, runOnline = (action) => action() } = {}) {
  const job = db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw new Error('That role is no longer in the list.');

  const existing = db.get('SELECT * FROM applications WHERE job_id = ?', [jobId]);
  if (existing && SENT_STATES.includes(existing.status) && !force) {
    throw new Error('This one has already gone out. Open it from Applications to see what was sent.');
  }

  if (isPlaceholder()) {
    throw new Error('The CV is still the blank example. Open Settings and put a real one in — '
      + 'everything else is ready.');
  }
  const cv = master();
  let tailored;
  if (ai.available()) {
    try {
      tailored = { mode: 'ai', ...await runOnline(() => ai.tailor(cv, job)) };
    } catch (err) {
      tailored = templates.draftApplication(cv, job, {
        aiUnavailable: true,
        reason: String(err.message || err).slice(0, 300),
      });
    }
  } else {
    tailored = templates.draftApplication(cv, job);
  }

  const stamp = now().replace(/[- :]/g, '').slice(0, 15);
  const base = `${slug(cv.name, 30)}_${slug(`${job.company || 'company'}_${job.title}`)}_${stamp}`;
  const pdfPath = path.join(db.paths.resumes, `${base}.pdf`);
  const docxPath = path.join(db.paths.resumes, `${base}.docx`);
  await pdf.render(tailored.resume, pdfPath);
  await docx.render(tailored.resume, docxPath);

  const to = job.apply_email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(job.apply_email) ? job.apply_email : '';

  const record = {
    job_id: jobId,
    status: 'draft',
    method: to ? 'email' : 'form',
    to_email: to,
    subject: (tailored.email_subject || `Application — ${job.title}`).slice(0, 255),
    body_text: tailored.email_body,
    cover_letter: tailored.cover_letter,
    resume_json: JSON.stringify(tailored.resume),
    resume_pdf: path.basename(pdfPath),
    resume_docx: path.basename(docxPath),
    match_score: tailored.match_score,
    match_notes: JSON.stringify(tailored.match_notes),
    mode: tailored.mode,
    automation_log: JSON.stringify([{ ...tailored.provenance, at: now() }]),
    resume_archived_at: null,
    resume_choice: '',
    ai_resume_json: null,
    ai_resume_pdf: '',
    ai_resume_docx: '',
    error: null,
    updated_at: now(),
  };

  let id;
  if (existing) {
    db.update('applications', record, 'id = ?', [existing.id]);
    id = existing.id;
  } else {
    id = db.insert('applications', record);
  }
  db.update('jobs', { status: 'applied' }, 'id = ?', [jobId]);

  const usedAi = tailored.mode === 'ai';
  db.logActivity(usedAi ? 'tailored' : 'drafted',
    `${job.company} - ${job.title}${usedAi ? ` (match ${tailored.match_score})` : ' (original CV and templates)'}`,
    { jobId, applicationId: id });

  const out = get(id);
  out.spend = tailored.spend || null;      // so the interface can warn at 80%
  return out;
}

/**
 * Adds a preparation event to one application's permanent history.
 * @param id Application database identifier.
 * @param entry Provider, model, and actions performed.
 * @return Updated application object.
 */
function appendAutomation(id, entry) {
  const a = get(id);
  if (!a) throw new Error('Application not found.');
  const log = Array.isArray(a.automation_log) ? a.automation_log : [];
  log.push({ ...entry, at: entry.at || now() });
  db.update('applications', { automation_log: JSON.stringify(log), updated_at: now() }, 'id = ?', [id]);
  return get(id);
}

function archiveFile(id, relativePath) {
  if (!relativePath) return null;
  const source = path.resolve(db.paths.resumes, relativePath);
  const root = `${path.resolve(db.paths.resumes)}${path.sep}`;
  if (!source.startsWith(root) || !fs.existsSync(source)) return null;
  if (source.startsWith(`${path.resolve(db.paths.submittedResumes)}${path.sep}`)) {
    return { absolute: source, relative: path.relative(db.paths.resumes, source) };
  }
  const filename = `${id}_${path.basename(relativePath)}`;
  const target = path.join(db.paths.submittedResumes, filename);
  if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return { absolute: target, relative: path.relative(db.paths.resumes, target) };
}

/**
 * Creates immutable copies of the exact CV files used for submission.
 * @param id Application database identifier.
 * @return Archived PDF and Word paths as an Object.
 */
function archiveForSubmission(id) {
  const a = get(id);
  if (!a) throw new Error('Application not found.');
  const pdfFile = archiveFile(id, a.resume_pdf);
  const docxFile = archiveFile(id, a.resume_docx);
  if (!pdfFile) throw new Error('The CV PDF is missing, so the application cannot be submitted safely.');
  db.update('applications', {
    resume_pdf: pdfFile.relative,
    resume_docx: docxFile?.relative || '',
    resume_archived_at: now(),
    updated_at: now(),
  }, 'id = ?', [id]);
  return { application: get(id), pdf: pdfFile.absolute, docx: docxFile?.absolute || null };
}

/**
 * Swaps which CV is attached to a not-yet-sent application, between the
 * AI-tailored draft and the untouched master CV. Switching to 'original'
 * stashes the AI files (once) in ai_resume_* before overwriting the
 * attached copy, so the AI-tailored CV is never lost and switching back to
 * 'ai' just restores those pointers — nothing is regenerated twice.
 */
async function switchResume(id, choice) {
  if (!['original', 'ai'].includes(choice)) throw new Error('Unknown CV choice.');
  let a = get(id);
  if (!a) throw new Error('Application not found.');
  if (SENT_STATES.includes(a.status)) {
    throw new Error('This one has already been sent — the CV attached to it cannot change now.');
  }
  if (a.mode !== 'ai') throw new Error('There is no AI-tailored CV on this application to switch from.');
  const already = choice === (a.resume_choice === 'original' ? 'original' : 'ai');
  if (already) return a;

  if (choice === 'original') {
    if (!a.ai_resume_pdf) {
      db.update('applications', {
        ai_resume_json: a.resume_json, ai_resume_pdf: a.resume_pdf, ai_resume_docx: a.resume_docx,
      }, 'id = ?', [id]);
    }
    const cv = master();
    const stamp = now().replace(/[- :]/g, '').slice(0, 15);
    const base = `${slug(cv.name, 30)}_${slug(`${a.job.company || 'company'}_${a.job.title}`)}_${stamp}_original`;
    const pdfPath = path.join(db.paths.resumes, `${base}.pdf`);
    const docxPath = path.join(db.paths.resumes, `${base}.docx`);
    await pdf.render(cv, pdfPath);
    await docx.render(cv, docxPath);
    db.update('applications', {
      resume_json: JSON.stringify(cv),
      resume_pdf: path.basename(pdfPath),
      resume_docx: path.basename(docxPath),
      resume_choice: 'original',
      updated_at: now(),
    }, 'id = ?', [id]);
  } else {
    db.update('applications', {
      resume_json: a.ai_resume_json,
      resume_pdf: a.ai_resume_pdf,
      resume_docx: a.ai_resume_docx,
      resume_choice: '',
      updated_at: now(),
    }, 'id = ?', [id]);
  }

  a = appendAutomation(id, {
    kind: 'user_choice',
    detail: choice === 'original'
      ? 'Chose to send the original CV instead of the AI-tailored version for this role. '
        + 'The AI-tailored CV stays saved and can be switched back to at any time before sending.'
      : 'Switched back to the AI-tailored CV.',
  });
  db.logActivity('cv_choice',
    `${a.job.company} - ${a.job.title}: switched to ${choice === 'original' ? 'the original CV' : 'the AI-tailored CV'}`,
    { jobId: a.job_id, applicationId: id });
  return a;
}

function save(id, fields) {
  const a = db.get('SELECT * FROM applications WHERE id = ?', [id]);
  if (!a) throw new Error('Application not found.');
  const to = String(fields.to_email || '').trim();
  if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('That does not look like an email address.');
  db.update('applications', {
    to_email: to,
    to_name: String(fields.to_name || a.to_name || '').slice(0, 140),
    method: to ? 'email' : (a.method === 'email' ? 'form' : a.method),
    subject: String(fields.subject ?? a.subject).slice(0, 255),
    body_text: String(fields.body_text ?? a.body_text),
    notes: String(fields.notes ?? a.notes).slice(0, 4000),
    updated_at: now(),
  }, 'id = ?', [id]);
  return get(id);
}

/**
 * How many more messages — applications or follow-ups — may go out today.
 *
 * Both count against the same cap: it exists to protect one mailbox from
 * sending too much in a day, and a follow-up is exactly as much an email as
 * an application is. Follow-ups used to send with no cap at all, so a day
 * that used up the application limit could still send an unbounded number of
 * follow-ups on top of it — the one rail CLAUDE.md says everything that can
 * send must go through, quietly not applying to half of what can send.
 *
 * 'localtime' matters here: SQLite's bare date('now') is UTC, so a cap meant
 * to reset once a day was actually resetting at 05:30 IST, mid-afternoon for
 * anyone in India — the exact audience this app is built for.
 */
function remainingToday() {
  const cap = Number(settings.get('max_sends_per_day', 12));
  const usedApplications = db.val(
    `SELECT COUNT(*) AS n FROM applications
     WHERE status IN (${SENT_STATES.map(() => '?').join(',')}) AND date(sent_at, 'localtime') = date('now', 'localtime')`,
    SENT_STATES, 0);
  const usedFollowups = db.val(
    `SELECT COUNT(*) AS n FROM followups
     WHERE status = 'sent' AND date(sent_at, 'localtime') = date('now', 'localtime')`,
    [], 0);
  return Math.max(0, cap - Number(usedApplications) - Number(usedFollowups));
}

/** Every rail lives here, not in the interface, so nothing can route around them. */
function checkRails(a) {
  const problems = [];
  if (SENT_STATES.includes(a.status)) problems.push('This application has already been sent.');
  if (!a.to_email) problems.push('There is no email address to send to — this one goes through the company form.');
  if (remainingToday() <= 0) {
    problems.push(`Today's limit of ${settings.get('max_sends_per_day', 12)} applications is used up.`);
  }
  const cooldown = Number(settings.get('company_cooldown_days', 30));
  if (cooldown > 0 && a.job?.company) {
    const recent = db.val(
      `SELECT COUNT(*) AS n FROM applications ap JOIN jobs j ON j.id = ap.job_id
       WHERE ap.status IN (${SENT_STATES.map(() => '?').join(',')}) AND ap.id <> ?
         AND j.company = ? AND ap.sent_at > datetime('now', ?)`,
      [...SENT_STATES, a.id, a.job.company, `-${cooldown} days`], 0);
    if (Number(recent) > 0) {
      problems.push(`You already applied to ${a.job.company} in the last ${cooldown} days.`);
    }
  }
  return problems;
}

async function send(id) {
  let a = get(id);
  if (!a) throw new Error('Application not found.');
  const problems = checkRails(a);
  if (problems.length) throw new Error(problems[0]);
  if (templates.hasPlaceholder(a.body_text)) {
    throw new Error('The email still has the placeholder line in it. Replace it with one sentence about '
      + 'this role, then send.');
  }

  const archived = archiveForSubmission(id);
  a = archived.application;

  db.update('applications', { status: 'queued', attempts: a.attempts + 1, updated_at: now() }, 'id = ?', [id]);

  let cvName = 'CV';
  try { cvName = slug(master().name, 30) || 'CV'; } catch { /* keep the default */ }
  const attachments = [];
  if (a.files.pdf && fs.existsSync(a.files.pdf)) {
    attachments.push({ path: a.files.pdf, filename: `${cvName}_CV.pdf` });
  }

  try {
    await mailer.send({
      to: a.to_email,
      toName: a.to_name,
      subject: a.subject,
      text: a.body_text,
      attachments,
      bcc: settings.get('bcc_self', true) ? settings.secrets().smtp.from_email : null,
    });
  } catch (err) {
    db.update('applications', { status: 'failed', error: String(err.message).slice(0, 500), updated_at: now() },
      'id = ?', [id]);
    db.logActivity('send_failed', `${a.job.company}: ${err.message}`, { applicationId: id });
    throw err;
  }

  db.update('applications', { status: 'sent', sent_at: now(), error: null, updated_at: now() }, 'id = ?', [id]);
  followups.scheduleFor(id);
  db.logActivity('sent', `${a.job.company} — ${a.job.title} to ${a.to_email}`,
    { jobId: a.job_id, applicationId: id });
  return get(id);
}

/** Used after she submits a company form inside the app's browser. */
function markSubmitted(id, note = '') {
  const archived = archiveForSubmission(id);
  const a = archived.application;
  if (!a) throw new Error('Application not found.');
  db.update('applications', {
    status: 'submitted', method: 'form', sent_at: now(), error: null,
    notes: note || a.notes, updated_at: now(),
  }, 'id = ?', [id]);
  followups.scheduleFor(id);
  db.logActivity('submitted', `${a.job.company} — ${a.job.title} via the company form`,
    { jobId: a.job_id, applicationId: id });
  return get(id);
}

const STATUSES = ['draft', 'queued', 'sent', 'submitted', 'failed', 'replied', 'interview', 'rejected', 'offer', 'withdrawn'];

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status.');
  const a = get(id);
  if (!a) throw new Error('Application not found.');
  db.update('applications', { status, updated_at: now() }, 'id = ?', [id]);
  // A reply means the follow-up chase should stop.
  if (['replied', 'interview', 'rejected', 'offer', 'withdrawn'].includes(status)) {
    db.run("UPDATE followups SET status = 'cancelled' WHERE application_id = ? AND status = 'scheduled'", [id]);
  }
  db.logActivity('status', `${a.job.company} — ${a.job.title} → ${status}`, { applicationId: id });
  return get(id);
}

module.exports = { prepare, save, send, get, byJob, setStatus, markSubmitted, remainingToday,
  checkRails, appendAutomation, archiveForSubmission, switchResume, STATUSES, SENT_STATES };
