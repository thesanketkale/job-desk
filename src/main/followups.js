'use strict';
/**
 * Follow-ups. When an application goes out, the chase is scheduled straight
 * away — otherwise it never happens. Each one waits for her to press send.
 */
const db = require('./db');
const settings = require('./settings');

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function scheduleFor(applicationId) {
  if (!settings.get('followups_enabled', true)) return [];
  const days = settings.get('followup_days', [7, 16]);
  db.run("DELETE FROM followups WHERE application_id = ? AND status = 'scheduled'", [applicationId]);
  const made = [];
  days.forEach((d, i) => {
    made.push(db.insert('followups', { application_id: applicationId, seq: i + 1, due_on: addDays(Number(d)) }));
  });
  return made;
}

/** Due today or overdue, and the application has not had a reply. */
function due() {
  return db.all(
    `SELECT f.*, a.subject AS original_subject, a.body_text AS original_body, a.to_email, a.to_name,
            a.status AS application_status, a.sent_at, a.resume_pdf, a.resume_docx,
            j.title, j.company, j.location_raw, j.work_mode, j.apply_url
     FROM followups f
     JOIN applications a ON a.id = f.application_id
     JOIN jobs j ON j.id = a.job_id
     WHERE f.status = 'scheduled' AND f.due_on <= ?
       AND a.status IN ('sent', 'submitted')
     ORDER BY f.due_on ASC, f.seq ASC`, [today()]);
}

function upcoming(limit = 30) {
  return db.all(
    `SELECT f.*, j.title, j.company, a.status AS application_status
     FROM followups f
     JOIN applications a ON a.id = f.application_id
     JOIN jobs j ON j.id = a.job_id
     WHERE f.status = 'scheduled' AND f.due_on > ? AND a.status IN ('sent','submitted')
     ORDER BY f.due_on ASC LIMIT ?`, [today(), limit]);
}

const history = (limit = 60) => db.all(
  `SELECT f.*, j.title, j.company FROM followups f
   JOIN applications a ON a.id = f.application_id
   JOIN jobs j ON j.id = a.job_id
   WHERE f.status IN ('sent','skipped') ORDER BY COALESCE(f.sent_at, f.due_on) DESC LIMIT ?`, [limit]);

/** Writes the follow-up text and stores it as a draft on the follow-up row. */
async function draft(followupId) {
  const ai = require('./ai');
  const templates = require('./templates');
  const { master } = require('./master');
  const f = db.get('SELECT * FROM followups WHERE id = ?', [followupId]);
  if (!f) throw new Error('That follow-up is no longer scheduled.');
  const a = db.get('SELECT * FROM applications WHERE id = ?', [f.application_id]);
  const job = db.get('SELECT * FROM jobs WHERE id = ?', [a.job_id]);

  const sentAt = a.sent_at ? new Date(`${a.sent_at.replace(' ', 'T')}Z`).getTime() : Date.now();
  const daysSince = Math.max(1, Math.round((Date.now() - sentAt) / 86400000));

  let out;
  if (ai.available()) {
    try {
      out = await ai.followup({ job, application: a, daysSince, seq: f.seq, cv: master() });
    } catch {
      out = templates.draftFollowup(master(), job, daysSince);
    }
  } else {
    out = templates.draftFollowup(master(), job, daysSince);
  }
  db.update('followups', { subject: out.subject.slice(0, 255), body_text: out.body }, 'id = ?', [followupId]);
  return db.get('SELECT * FROM followups WHERE id = ?', [followupId]);
}

async function send(followupId, overrides = {}) {
  const mailer = require('./mailer');
  // Lazy for the same reason draft()'s requires are lazy: applier.js requires
  // this file at the top of its own module, so requiring applier back at the
  // top of this one would hand it an empty, not-yet-populated exports object.
  const applier = require('./applier');
  const f = db.get('SELECT * FROM followups WHERE id = ?', [followupId]);
  if (!f) throw new Error('That follow-up is no longer scheduled.');
  if (f.status !== 'scheduled') throw new Error('That follow-up has already been dealt with.');

  // The one rail this used to skip entirely: a follow-up is exactly as much an
  // email as an application is, and applier.remainingToday() counts both
  // against the same daily cap — see the comment there.
  if (applier.remainingToday() <= 0) {
    throw new Error(`Today's limit of ${settings.get('max_sends_per_day', 12)} messages is used up.`);
  }

  const a = db.get('SELECT * FROM applications WHERE id = ?', [f.application_id]);
  const job = db.get('SELECT * FROM jobs WHERE id = ?', [a.job_id]);
  const to = overrides.to_email || a.to_email;
  if (!to) throw new Error('There is no address to follow up with — this one was submitted through a form.');

  const subject = overrides.subject || f.subject || `Following up — ${job.title}`;
  const body = overrides.body_text || f.body_text;
  if (!body?.trim()) throw new Error('Write the follow-up first, or press Draft it for me.');

  await mailer.send({
    to, toName: a.to_name, subject, text: body,
    bcc: settings.get('bcc_self', true) ? settings.secrets().smtp.from_email : null,
  });

  db.update('followups', { status: 'sent', sent_at: now(), subject, body_text: body }, 'id = ?', [followupId]);
  db.logActivity('followup_sent', `${job.company} — ${job.title} (follow-up ${f.seq})`,
    { jobId: job.id, applicationId: a.id });
  return db.get('SELECT * FROM followups WHERE id = ?', [followupId]);
}

function skip(followupId) {
  db.update('followups', { status: 'skipped' }, 'id = ?', [followupId]);
  return true;
}

function snooze(followupId, days = 7) {
  db.update('followups', { due_on: addDays(Number(days) || 7) }, 'id = ?', [followupId]);
  return db.get('SELECT * FROM followups WHERE id = ?', [followupId]);
}

module.exports = { scheduleFor, due, upcoming, history, draft, send, skip, snooze };
