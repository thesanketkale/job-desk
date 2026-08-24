'use strict';
/**
 * Rewrites the CV against one job description and drafts the email.
 * The prompt forbids invention; the code afterwards enforces it, because a
 * prompt is a request and a guard is a guarantee.
 */
const { postJson } = require('./http');
const settings = require('./settings');
const budget = require('./budget');

const API = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are helping a specific, real candidate apply for a specific, real job.
You rewrite her CV so it speaks to this job, and you draft the email she will send.

ABSOLUTE RULES — a violation makes the output unusable:
1. NEVER invent, inflate, or imply experience, employers, dates, degrees, licences,
   registrations, tools, or numbers that are not in the master CV.
2. Never claim a licence or registration to practise in a country she does not hold
   one for. If the job requires a licence she does not have, say so plainly in
   match_notes rather than papering over it.
3. Dates, employer names, degree names, institutions, and the session count are
   frozen. Copy them exactly.
4. You MAY: reorder sections and bullets, choose which bullets appear, rewrite the
   summary, re-word bullets to mirror the job's own vocabulary, drop irrelevant
   material, and re-title the competency groupings.
5. Keep every bullet a true restatement of a master bullet. If you cannot map a
   rewritten bullet back to a master bullet, delete it.
6. British/Indian English. No em dashes in the email. No exclamation marks. Never
   write "I am excited to" or "I am writing to express my interest".

The email must read as though she wrote it in four minutes: specific, warm, direct,
120-170 words, one concrete reason she fits this role, and a clear closing line.
Address a named person only if the job description names one.

Return ONLY a JSON object, no prose, no code fence:
{
  "resume": { ...same shape as the master CV JSON, tailored... },
  "cover_letter": "3-4 short paragraphs, plain text",
  "email_subject": "...",
  "email_body": "plain text email, no subject line, signed off with the candidate name",
  "match_score": 0-100,
  "match_notes": ["short factual observations: what matches, what is missing, any licence/visa/timezone blocker"]
}`;

const FOLLOWUP_SYSTEM = `You write a short, self-respecting follow-up email for a job
application that has had no reply. Rules: 90-130 words. Reference the role and roughly
when she applied. Add one genuinely useful sentence — a relevant detail from her
background that fits this role — rather than only asking for an update. No guilt, no
apologising for following up, no "just circling back", no exclamation marks, no em
dashes. British/Indian English. Sign off with the candidate's own name.

Return ONLY JSON: {"subject": "...", "body": "..."}`;

function keyOrThrow() {
  const key = settings.getSecret('anthropic_api_key', '');
  if (!key) throw new Error('No Claude API key yet. Add one in Settings — it takes two minutes.');
  return key;
}

const available = () => !!settings.getSecret('anthropic_api_key', '');

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function call(system, user, maxTokens = 8000) {
  budget.checkBeforeCall();               // refuse before spending, not after
  const model = budget.model();
  const res = await postJson(API, {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, {
    'x-api-key': keyOrThrow(),
    'anthropic-version': '2023-06-01',
  });

  if (res.error) {
    const m = res.error.message || 'the API refused the request';
    if (/credit|balance|quota/i.test(m)) throw new Error(`Claude account: ${m}`);
    if (/authentication|api[- ]key|invalid x-api-key/i.test(m)) {
      throw new Error('That Claude API key was rejected. Check it in Settings — keys start with "sk-ant-".');
    }
    if (/not_found|model/i.test(m)) {
      throw new Error(`The model "${model}" was not available. Pick a different one in Settings.`);
    }
    if (/rate.?limit|overloaded/i.test(m)) throw new Error('Claude is busy right now. Try that role again in a minute.');
    throw new Error(`Claude: ${m}`);
  }
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: res.usage || {}, model };
}

/**
 * Employers, dates, education and certifications are restored from the master
 * afterwards, whatever came back. Any employment block that cannot be traced to
 * a real one is deleted outright.
 */
function enforceTruth(master, cv) {
  cv.name = master.name;
  cv.contact = master.contact;
  for (const frozen of ['education', 'certifications']) {
    if (master[frozen]) cv[frozen] = master[frozen];
  }
  delete cv.notes_for_tailoring;

  const byId = new Map((master.experience || []).map((m) => [m.id, m]));
  const byOrg = new Map((master.experience || []).map((m) => [String(m.org || '').toLowerCase(), m]));

  const kept = [];
  const dropped = [];
  for (const job of cv.experience || []) {
    const m = byId.get(job.id) || byOrg.get(String(job.org || '').toLowerCase());
    if (!m) { dropped.push(job.org || job.title || 'an unnamed role'); continue; }
    kept.push({ ...job, id: m.id, org: m.org, start: m.start, end: m.end, location: m.location });
  }
  cv.experience = kept;
  return dropped;
}

async function tailor(master, job) {
  const jd = String(job.description_text || '').slice(0, 18000);
  const user = `MASTER CV (JSON, the only source of truth):\n${JSON.stringify(master, null, 2)}

---

THE JOB
Title: ${job.title || ''}
Company: ${job.company || ''}
Location: ${job.location_raw || ''} (${job.work_mode || ''})
Employment type: ${job.employment_type || ''}
Source: ${job.source_label || ''}

DESCRIPTION:
${jd}`;

  const { text, usage, model } = await call(SYSTEM, user);
  const spend = budget.record(usage, model, 'tailor');
  const out = extractJson(text);
  if (!out?.resume) throw new Error('Claude replied with something the app could not read. Try that role again.');

  const dropped = enforceTruth(master, out.resume);
  const notes = (out.match_notes || []).filter(Boolean).map(String);
  if (dropped.length) {
    notes.push(`The app removed ${dropped.length} experience entr${dropped.length === 1 ? 'y' : 'ies'} that did not match the master CV.`);
  }

  return {
    resume: out.resume,
    cover_letter: String(out.cover_letter || '').trim(),
    email_subject: String(out.email_subject || '').trim(),
    email_body: String(out.email_body || '').trim(),
    match_score: Math.max(0, Math.min(100, Number(out.match_score) || 0)),
    match_notes: notes,
    spend,
  };
}

async function followup({ job, application, daysSince, seq, cv = {} }) {
  const user = `ROLE: ${job.title} at ${job.company}
APPLIED: ${daysSince} days ago${seq > 1 ? ` (this is follow-up number ${seq})` : ''}
THE EMAIL SHE ORIGINALLY SENT:
${String(application.body_text || '').slice(0, 2000)}

THE CANDIDATE: ${cv.name || 'the candidate'}
BACKGROUND IN ONE LINE: ${cv.pitch || cv.summary || 'An experienced professional.'}`;

  const { text, usage, model } = await call(FOLLOWUP_SYSTEM, user, 1200);
  budget.record(usage, model, 'follow-up');
  const out = extractJson(text) || {};
  return {
    subject: String(out.subject || `Following up — ${job.title}`).trim(),
    body: String(out.body || '').trim(),
  };
}

/** A deliberately tiny request, so checking a key costs a fraction of a paisa. */
async function ping() {
  const { usage, model } = await call('Reply with the single word: ok', 'ping', 16);
  budget.record(usage, model, 'key check');
  return { ok: true, message: `The key works. Using ${budget.priceOf(model).label.split(' —')[0]}.` };
}

module.exports = { available, tailor, followup, enforceTruth, extractJson, ping };
