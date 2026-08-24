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

const SENT_STATES = ['sent', 'submitted', 'replied', 'interview', 'offer'];
const slug = (s, max = 46) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function get(id) {
  const a = db.get('SELECT * FROM applications WHERE id = ?', [id]);
  if (!a) return null;
  a.job = db.get('SELECT * FROM jobs WHERE id = ?', [a.job_id]) || {};
  try { a.match_notes = JSON.parse(a.match_notes || '[]'); } catch { a.match_notes = []; }
  a.followups = db.all('SELECT * FROM followups WHERE application_id = ? ORDER BY seq', [id]);
  a.files = {
    pdf: a.resume_pdf ? path.join(db.paths.resumes, a.resume_pdf) : null,
    docx: a.resume_docx ? path.join(db.paths.resumes, a.resume_docx) : null,
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
async function prepare(jobId, { force = false } = {}) {
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
  // With a key, the CV is rewritten for this role. Without one, the app still
  // works: the master CV goes out with a template letter she can edit.
  const useAi = ai.available();
  const tailored = useAi
    ? { mode: 'ai', ...await ai.tailor(cv, job) }
    : templates.draftApplication(cv, job);

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

  db.logActivity(useAi ? 'tailored' : 'drafted',
    `${job.company} — ${job.title}${useAi ? ` (match ${tailored.match_score})` : ' (template)'}`,
    { jobId, applicationId: id });

  const out = get(id);
  out.spend = tailored.spend || null;      // so the interface can warn at 80%
  return out;
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

/** How many more applications may go out today. */
function remainingToday() {
  const cap = Number(settings.get('max_sends_per_day', 12));
  const used = db.val(
    `SELECT COUNT(*) AS n FROM applications
     WHERE status IN (${SENT_STATES.map(() => '?').join(',')}) AND date(sent_at) = date('now')`,
    SENT_STATES, 0);
  return Math.max(0, cap - Number(used));
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
  const a = get(id);
  if (!a) throw new Error('Application not found.');
  const problems = checkRails(a);
  if (problems.length) throw new Error(problems[0]);
  if (templates.hasPlaceholder(a.body_text)) {
    throw new Error('The email still has the placeholder line in it. Replace it with one sentence about '
      + 'this role, then send.');
  }

  db.update('applications', { status: 'queued', attempts: a.attempts + 1, updated_at: now() }, 'id = ?', [id]);

  let cvName = 'CV';
  try { cvName = slug(master().name, 30) || 'CV'; } catch { /* keep the default */ }
  const attachments = [];
  if (a.files.pdf && fs.existsSync(a.files.pdf)) {
    attachments.push({ path: a.files.pdf, filename: `${cvName}_CV.pdf` });
  }
  if (a.files.docx && fs.existsSync(a.files.docx)) {
    attachments.push({ path: a.files.docx, filename: `${cvName}_CV.docx` });
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
  const a = get(id);
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

module.exports = { prepare, save, send, get, byJob, setStatus, markSubmitted, remainingToday, checkRails, STATUSES, SENT_STATES };
