'use strict';
/**
 * Rewrites the CV against one job description and drafts the email.
 * The prompt forbids invention; the code afterwards enforces it, because a
 * prompt is a request and a guard is a guarantee.
 *
 * Which service answers is `providers.js`'s business, not this file's. Every
 * guard here — the truth enforcement most of all — runs on the reply whatever
 * produced it, so a cheaper or free provider is never a weaker one on the point
 * that matters.
 */
const { postJson, getJson } = require('./http');
const settings = require('./settings');
const budget = require('./budget');
const providers = require('./providers');

const SYSTEM = `You are helping a specific, real candidate apply for a specific, real job.
You rewrite their CV so it speaks to this job, and you draft the email they will send.

The candidate may be of any gender. Nothing in the CV states it and you must not
guess: write the email in the first person and never use a third-person pronoun
for the candidate anywhere in the output.

ABSOLUTE RULES — a violation makes the output unusable:
1. NEVER invent, inflate, or imply experience, employers, dates, degrees, licences,
   registrations, tools, or numbers that are not in the master CV.
2. Never claim a licence or registration to practise in a country they do not hold
   one for. If the job requires a licence they do not have, say so plainly in
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

The email must read as though the candidate wrote it in four minutes: specific, warm,
direct, 120-170 words, one concrete reason they fit this role, and a clear closing line.
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
application that has had no reply. It is written in the first person, by the candidate.
Rules: 90-130 words. Reference the role and roughly when they applied. Add one genuinely
useful sentence — a relevant detail from their own background that fits this role —
rather than only asking for an update. Never use a third-person pronoun for the
candidate; their gender is not stated and must not be guessed. No guilt, no
apologising for following up, no "just circling back", no exclamation marks, no em
dashes. British/Indian English. Sign off with the candidate's own name.

Return ONLY JSON: {"subject": "...", "body": "..."}`;

const RESUME_SYSTEM = `You convert the plain text of a resume into structured JSON.

This is transcription, not writing. The person's own resume is the only source.

ABSOLUTE RULES:
1. NEVER invent, infer, or embellish. No employer, date, degree, certification,
   skill, or number may appear that is not in the text you were given.
2. If a field is genuinely not in the text, use an empty string or an empty array.
   An empty field is correct; a plausible guess is a fabrication.
3. Copy names, employers, institutions, dates and numbers exactly as written.
4. Bullets stay in the person's own words. Fix obvious line-break damage and
   spelling only.
5. "summary" is third person, as it reads on a CV. "pitch" is the same content in
   the first person, as it would read in an email. If the resume has no summary,
   write both from the material actually present, and nothing beyond it.
6. British/Indian English spelling.

Return ONLY a JSON object, no prose, no code fence:
{
  "name": "", "headline": "",
  "contact": {"phone": "", "email": "", "linkedin": "", "website": "", "location": ""},
  "summary": "", "pitch": "",
  "competencies": {"Group name": ["item", "..."]},
  "experience": [{"id": "shortslug", "title": "", "org": "", "location": "",
                  "start": "Mon YYYY", "end": "Mon YYYY or Present", "bullets": ["..."]}],
  "impact": ["..."],
  "education": [{"degree": "", "school": "", "years": "", "detail": ""}],
  "certifications": {"Group name": ["..."]},
  "differentiators": ["..."],
  "additional": {"Languages": "", "Availability": ""}
}`;

/** The key for whichever provider is selected. */
function storedKey(id = budget.providerId()) {
  return settings.getSecret(providers.get(id).secret, '') || '';
}

function keyOrThrow() {
  const p = budget.provider();
  const key = storedKey(p.id);
  if (!key) {
    throw new Error(`No ${p.label} key yet. Add one in Settings — it takes two minutes.`);
  }
  return key;
}

const available = () => !!storedKey();

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function call(system, user, maxTokens = 8000, opts = {}) {
  budget.checkBeforeCall();               // refuse before spending, not after
  const id = opts.provider || budget.providerId();
  const p = providers.get(id);
  const model = opts.model || budget.model();
  // An explicit key is passed only when checking one that is not saved yet.
  const key = opts.key || keyOrThrow();

  const req = providers.buildRequest(id, { model, system, user, maxTokens, key });
  const raw = await postJson(req.url, req.body, req.headers);
  const out = providers.parseResponse(id, raw);

  if (out.error) throw new Error(friendlyError(out.error, p, model));
  if (!out.text) throw new Error(`${p.label} replied with nothing usable. Try that role again.`);
  return { text: out.text, usage: out.usage || {}, model };
}

/** The provider's complaint, turned into something worth reading. */
function friendlyError(message, p, model) {
  const m = String(message);
  if (/credit|balance|quota|billing|insufficient/i.test(m)) {
    return `${p.label} says the account is out of credit: ${m}`;
  }
  if (/api[- ]?key|authenticat|unauthor|permission|invalid.*key|401|403/i.test(m)) {
    return `That ${p.label} key was rejected. Check it in Settings. ${p.keyHint}`;
  }
  if (/not.?found|model|unsupported|does not exist|404/i.test(m)) {
    return `The model "${model}" was not available on ${p.label}. Pick a different one in Settings.`;
  }
  if (/rate.?limit|overloaded|resource.?exhausted|429|too many/i.test(m)) {
    return p.freeTier
      ? `${p.label} is rate limiting the free tier right now. Wait a minute and try that role again.`
      : `${p.label} is busy right now. Try that role again in a minute.`;
  }
  return `${p.label}: ${m}`;
}

/** The live model list, so the stale table in providers.js is never the only source. */
async function listModels(id = budget.providerId(), key = null) {
  const p = providers.get(id);
  if (!p.modelsUrl) return [];
  const headers = p.wire === 'anthropic'
    ? { 'x-api-key': key || storedKey(id), 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key || storedKey(id)}` };
  try {
    return providers.parseModelList(id, await getJson(p.modelsUrl, headers));
  } catch { return []; }          // a missing list is not worth failing a save over
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

/**
 * The same principle as `enforceTruth`, applied to an import: nothing may appear
 * in the structured CV that is not somewhere in the resume it came from. There
 * is no master CV to check against yet, so the source text is the authority.
 */
function enforceResumeTruth(rawText, cv) {
  const hay = String(rawText).toLowerCase().replace(/\s+/g, ' ');
  const digits = String(rawText).replace(/\D/g, '');
  const has = (v) => {
    const s = String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return s.length < 3 || hay.includes(s);
  };

  const c = cv.contact || (cv.contact = {});
  if (c.email && !hay.includes(String(c.email).toLowerCase())) c.email = '';
  if (c.phone && !digits.includes(String(c.phone).replace(/\D/g, ''))) c.phone = '';
  for (const k of ['linkedin', 'website', 'location']) if (c[k] && !has(c[k])) c[k] = '';

  const dropped = [];
  cv.experience = (cv.experience || []).filter((job) => {
    if (has(job.org) && has(job.title)) return true;
    dropped.push(job.org || job.title || 'an unnamed role');
    return false;
  });
  cv.education = (cv.education || []).filter((ed) => has(ed.school) && has(ed.degree));

  return dropped;
}

/**
 * Reads a resume into the CV shape. `fallback` is the heuristic parse, used
 * whenever the model returns something unusable — the import never fails just
 * because the key does.
 */
async function structureResume(rawText, fallback = null) {
  const text = String(rawText || '').slice(0, 24000);
  const { text: reply, usage, model } = await call(RESUME_SYSTEM, `RESUME:\n${text}`, 8000);
  budget.record(usage, model, 'resume import');

  const out = extractJson(reply);
  if (!out || !out.name) {
    if (fallback) return fallback;
    throw new Error(`${budget.provider().label} could not read that resume. `
      + 'Check the text, or edit the details by hand.');
  }
  enforceResumeTruth(text, out);
  if (!out.name && fallback) out.name = fallback.name;
  return out;
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
  if (!out?.resume) {
    // Weaker and free models are markedly worse at returning clean JSON, so this
    // says which service produced the mess rather than blaming the app.
    throw new Error(`${budget.provider().label} replied with something the app could not read. `
      + 'Try that role again, or pick a stronger model in Settings.');
  }

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
THE EMAIL ORIGINALLY SENT:
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
async function ping(opts = {}) {
  const id = opts.provider || budget.providerId();
  const { usage, model } = await call('Reply with the single word: ok', 'ping', 16,
    { ...opts, provider: id });
  budget.record(usage, model, 'key check');
  return {
    ok: true,
    provider: id,
    model,
    message: `The key works. Using ${providers.get(id).label} on ${model}.`,
  };
}

/**
 * Checks a key that has not been saved yet, so a rejected one is never stored.
 * The obvious shape mistakes are caught locally, before spending anything.
 */
async function validateKey(key, providerId = budget.providerId()) {
  const p = providers.get(providerId);
  const k = String(key || '').trim();
  if (!k) throw new Error(`Paste the key first. ${p.keyHint}`);
  const wrong = p.keyLooksWrong ? p.keyLooksWrong(k) : '';
  if (wrong) throw new Error(wrong);          // caught locally, before spending
  return ping({ key: k, provider: providerId });
}

module.exports = { available, tailor, followup, enforceTruth, extractJson, ping, validateKey,
  structureResume, enforceResumeTruth, listModels, storedKey };
