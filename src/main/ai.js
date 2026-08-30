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
const { postJsonResult, getJson } = require('./http');
const settings = require('./settings');
const budget = require('./budget');
const providers = require('./providers');

const SYSTEM = `You are helping a specific, real candidate apply for a specific, real job.
You rewrite their CV so it speaks to this job, and you draft the email they will send.
Your goal is a complete, credible, tailored CV that gives this candidate the best
realistic chance of an interview — not a shortened summary of their career.

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
4. Every employer in the master CV's "experience" array must appear in your
   "resume.experience" array, using the exact same "id" value the master CV gives
   it — never invent a new id, merge two master entries into one, or leave an id
   out. A role that is irrelevant to this job is trimmed down to its single most
   defensible bullet, never removed outright: an employer entry missing from the
   CV reads as a career gap, which hurts the candidate far more than one
   unremarkable line does.
5. You MAY: reorder bullets within a role, choose which bullets appear, rewrite the
   summary, re-word bullets to mirror the job's own vocabulary, drop irrelevant
   bullets, and re-title the competency groupings. Keep the experience entries
   themselves in the master CV's own order (reverse chronological) — reordering a
   work history reads as evasive to a recruiter.
6. Keep every bullet a true restatement of a master bullet. If you cannot map a
   rewritten bullet back to a master bullet, delete it.
7. "impact" follows the same rule as bullets: trim it to the outcomes most
   relevant to this role, but never return it empty when the master CV has
   entries — an empty outcomes section undersells a candidate with real results.
8. British/Indian English. No em dashes in the email. No exclamation marks. Never
   write "I am excited to" or "I am writing to express my interest".

A tailored CV is not a shortened CV. For a candidate with several roles and years of
experience, the result should still read as a full career history — close to the
master CV's own length — with the emphasis shifted toward what this job asks for,
not the substance cut away. What actually gets someone an interview is a reader
seeing the whole, real picture of someone who obviously fits, not a thin summary
that undersells them.

For match_notes and the email, read the job description for its actual stated
requirements — qualifications, modalities, licensing, client groups, tools,
schedule — and name the specific ones the master CV genuinely supports. A generic
"strong fit" is worth less than naming the two or three concrete things that make
this candidate right for this particular role.

The email must read as though the candidate wrote it in four minutes: specific, warm,
direct, 120-170 words, one concrete reason they fit this role, and a clear closing line.
Address a named person only if the job description names one.

Return ONLY a JSON object, no prose, no code fence:
{
  "resume": {
    "name": "", "headline": "",
    "contact": {"phone": "", "email": "", "linkedin": "", "website": "", "location": ""},
    "summary": "", "pitch": "",
    "competencies": {"Group name": ["item", "..."]},
    "experience": [{"id": "<same id as the matching master CV entry>", "title": "", "org": "",
                    "location": "", "start": "", "end": "", "bullets": ["..."]}],
    "impact": ["..."],
    "education": [ ...copied from the master CV, unchanged... ],
    "certifications": { ...copied from the master CV, unchanged... },
    "differentiators": ["..."],
    "additional": {"Languages": "", "Interests": "", "Availability": ""}
  },
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

const FORM_SYSTEM = `You are filling in one job application form on behalf of a real candidate,
using only their CV and the job advert. Your answers are typed into the employer's own form.

ABSOLUTE RULES — a violation makes the output unusable:
1. NEVER invent, inflate, or imply anything not supported by the CV. No employer, date,
   qualification, licence, registration, tool, salary, or number may appear that is not in it.
2. If the CV does not answer a question, return an empty string for it. An unanswered field the
   candidate fills in themselves is correct; a plausible guess typed into an employer's form is
   a lie told in their name.
3. For a question offering options, answer with EXACTLY one of the option strings given, copied
   character for character. If none is truthful, return an empty string.
4. Never answer a question about disability, gender, ethnicity, veteran status, or any other
   protected characteristic. Return an empty string for those, always — they are the candidate's
   alone to answer.
5. Never agree to terms, consent, or declarations on the candidate's behalf. Empty string.
6. Never state a salary figure the CV does not give. Empty string.
7. First person, British/Indian English. A "short" answer is a few words. A "long" answer is
   2-4 short paragraphs, specific to this role, warm and direct, no exclamation marks, no em
   dashes, and never "I am excited to" or "I am writing to express my interest".

Return ONLY a JSON object, no prose, no code fence:
{"answers": [{"index": <the question's index>, "value": "<your answer, or an empty string>"}]}`;

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

const available = () => ['gemini', 'openrouter', 'anthropic'].some((id) => !!storedKey(id));

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const GEMINI_APPLICATION_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

/**
 * Builds the fixed free-first inference order used for application work.
 * @param opts Optional explicit provider details used by API key checks.
 * @return Ordered attempt objects as an Array.
 */
function buildAttemptPlan(opts = {}) {
  if (opts.provider || opts.key || opts.cheap) {
    const id = opts.provider || budget.providerId();
    const model = opts.model || providers.get(id).defaultModel;
    return [{ id, model, key: opts.key || storedKey(id) || keyOrThrow(),
      free: id === 'gemini' || model === 'openrouter/free' }];
  }

  const attempts = [];
  const geminiKey = storedKey('gemini');
  if (geminiKey) {
    for (const model of GEMINI_APPLICATION_MODELS) {
      attempts.push({ id: 'gemini', model, key: geminiKey, free: true });
    }
  }
  const openRouterKey = storedKey('openrouter');
  if (openRouterKey) {
    attempts.push({ id: 'openrouter', model: 'openrouter/free', key: openRouterKey, free: true });
  }
  const anthropicKey = storedKey('anthropic');
  if (anthropicKey) {
    attempts.push({ id: 'anthropic', model: providers.get('anthropic').defaultModel,
      key: anthropicKey, free: false });
  }
  return attempts;
}

function retryable(status, message) {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return !status && /timed out|timeout|request failed|fetch failed|network|socket/i.test(String(message || ''));
}

function retryDelay(retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(10000, seconds * 1000);
  const retryAt = Date.parse(String(retryAfter || ''));
  if (Number.isFinite(retryAt)) return Math.max(250, Math.min(10000, retryAt - Date.now()));
  return 900 + Math.floor(Math.random() * 500);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls the free-first model chain and returns the first usable response.
 * @param system System instructions for the model.
 * @param user User content for the model.
 * @param maxTokens Maximum output token budget.
 * @param opts Validation, transport, and request metadata.
 * @return Normalized response details as an Object.
 */
async function call(system, user, maxTokens = 8000, opts = {}) {
  const attempts = buildAttemptPlan(opts);
  if (!attempts.length) throw new Error('No AI key is available.');

  const transport = opts.transport || postJsonResult;
  const sleeper = opts.sleep || wait;
  const deadline = Date.now() + Math.max(1000, Number(opts.deadlineMs) || 180000);
  let lastErr = null;
  let totalSpend = 0;
  let warning = null;
  const disabledProviders = new Set();

  for (const attempt of attempts) {
    const { id, model, key, free } = attempt;
    if (disabledProviders.has(id)) continue;
    const p = providers.get(id);
    if (!free) {
      try {
        budget.checkBeforeCall(model, id);
      } catch (err) {
        lastErr = err;
        continue;
      }
    }

    for (let retry = 0; retry < 2; retry++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const req = providers.buildRequest(id, {
        model,
        system,
        user,
        maxTokens,
        key,
        cheap: !!opts.cheap,
        json: !!opts.json,
      });

      let response;
      try {
        response = await transport(req.url, req.body, req.headers, Math.min(45000, remaining), 0);
      } catch (err) {
        lastErr = err;
        const status = Number(err.status || 0);
        if (status === 401 || status === 403 || !status) {
          disabledProviders.add(id);
        }
        if (status && retry === 0 && retryable(status, err.message)) {
          await sleeper(retryDelay(''));
          continue;
        }
        break;
      }

      const out = providers.parseResponse(id, response.data);
      if (out.error || !response.ok) {
        const message = out.error || `HTTP ${response.status}`;
        lastErr = new Error(friendlyError(message, p, model));
        if (response.status === 401 || response.status === 403) disabledProviders.add(id);
        if (retry === 0 && retryable(response.status, message)) {
          await sleeper(retryDelay(response.retryAfter));
          continue;
        }
        break;
      }

      if (!free && out.usage && (out.usage.input_tokens || out.usage.output_tokens)) {
        const recorded = budget.record(out.usage, model, opts.kind || 'AI request', id);
        totalSpend += recorded.spend;
        warning = warning || recorded.warning;
      }

      const usable = out.text && (!opts.accept || opts.accept(out.text, out));
      if (!usable) {
        lastErr = new Error(`${p.label} replied with nothing usable.`);
        break;
      }

      return {
        text: out.text,
        usage: out.usage || {},
        model: out.model || model,
        requestedModel: model,
        providerId: id,
        providerLabel: p.label,
        stopReason: out.stopReason,
        spend: { spend: totalSpend, warning },
      };
    }
  }

  throw lastErr || new Error('No AI service was available.');
}

/** 'max_tokens' (Anthropic) and 'length' (the OpenAI-compatible wire) both
 *  mean the same thing: the reply stopped because it ran out of room, not
 *  because it was finished. Text cut off mid-JSON usually still fails to
 *  parse, which is what made this worth telling apart from a genuinely
 *  unreadable reply — the fix is more room or a stronger model, not a retry
 *  of the same request. */
const wasTruncated = (stopReason) => stopReason === 'max_tokens' || stopReason === 'length';

/** The provider's complaint, turned into something worth reading. */
function friendlyError(message, p, model) {
  const m = String(message);
  if (/credit|balance|quota|billing|insufficient/i.test(m)) {
    return `${p.label} says the account is out of credit: ${m}`;
  }
  if (/api[- ]?key|authenticat|unauthor|permission|invalid.*key|401|403/i.test(m)) {
    return `That ${p.label} key was rejected. Check it in Settings. ${p.keyHint}`;
  }
  // Deliberately narrow. A bare "model" or "unsupported" used to be enough to
  // match here, and a provider's error about something else entirely — a
  // parameter value it did not like — happened to contain the word "model"
  // too ("Thinking level MINIMAL is not supported for this model"), so it
  // was shown to the user as "the model was not available", which was not
  // what actually happened and sent them hunting for a different model to
  // fix a problem that had nothing to do with which one was chosen.
  if (/not.?found|does not exist|no longer available|unknown model|invalid model|404/i.test(m)) {
    return `The model "${model}" was not available on ${p.label}. Pick a different one in Settings.`;
  }
  if (/rate.?limit|overloaded|high.?demand|resource.?exhausted|429|too many/i.test(m)) {
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

/** Employer names carry punctuation and suffixes ("PeakMind.in", "1To1Help.Net",
 *  "Lighthouse Wellness Group Pvt Ltd") that a model paraphrases freely even while
 *  keeping the identity clear to a person. Comparing on letters and digits only
 *  means that paraphrasing doesn't cost the entry its match. */
const normalizeOrg = (s) => String(s || '').toLowerCase()
  .replace(/\.(in|net|com|org|io|co)\b/g, '')
  .replace(/\b(pvt|private|ltd|limited|llp|inc|llc|corp)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, '');

function findMasterMatch(job, byId, byOrg) {
  if (job?.id && byId.has(job.id)) return byId.get(job.id);
  const norm = normalizeOrg(job?.org);
  if (!norm) return null;
  if (byOrg.has(norm)) return byOrg.get(norm);
  for (const [key, m] of byOrg) {
    if (key && (key.includes(norm) || norm.includes(key))) return m;
  }
  return null;
}

/**
 * Employers, dates, education and certifications are restored from the master
 * afterwards, whatever came back. An invented employer that cannot be traced to
 * a real one is deleted outright — but a REAL one that the model simply dropped
 * or renamed past recognition is restored in its original wording rather than
 * silently vanishing from the CV. Losing a genuine job to a matching failure
 * used to be indistinguishable from the model correctly leaving out an invented
 * one; this way the CV can never end up thinner than the truth, only than the
 * model's best tailoring of it.
 */
function enforceTruth(master, cv) {
  cv.name = master.name;
  cv.contact = master.contact;
  for (const frozen of ['education', 'certifications']) {
    if (master[frozen]) cv[frozen] = master[frozen];
  }
  delete cv.notes_for_tailoring;

  const masterList = master.experience || [];
  const byId = new Map(masterList.map((m) => [m.id, m]));
  const byOrg = new Map(masterList.map((m) => [normalizeOrg(m.org), m]));

  const tailoredById = new Map();
  for (const job of cv.experience || []) {
    const m = findMasterMatch(job, byId, byOrg);
    if (m) tailoredById.set(m.id, { ...job, id: m.id, org: m.org, start: m.start, end: m.end, location: m.location });
  }

  const keptOriginal = [];
  cv.experience = masterList.map((m) => {
    const tailored = tailoredById.get(m.id);
    if (!tailored) keptOriginal.push(m.org || m.title || 'an unnamed role');
    return tailored || m;
  });
  cv.impact = (Array.isArray(cv.impact) && cv.impact.length) ? cv.impact : (master.impact || []);

  return keptOriginal;
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
  const result = await call(RESUME_SYSTEM, `RESUME:\n${text}`, 8000, {
    kind: 'resume import',
    json: true,
    accept: (reply) => !!extractJson(reply)?.name,
  });
  const { text: reply, providerId, stopReason } = result;

  const out = extractJson(reply);
  if (!out || !out.name) {
    if (fallback) return fallback;
    throw new Error(wasTruncated(stopReason)
      ? `${providers.get(providerId).label} cut its reply off before it finished reading that resume - it may be `
        + 'unusually long. Try again, or edit the details by hand.'
      : `${providers.get(providerId).label} could not read that resume. `
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

  // 16000 rather than the usual 8000: a tailored CV plus cover letter plus
  // email is already a substantial JSON reply, and Claude 5 / Gemini 3.x think
  // before answering by default — that reasoning is spent out of the same
  // budget, so 8000 left too little room for the actual output on a long CV
  // or a long job description, cutting the reply off mid-JSON. It still
  // always fails to parse when that happens; the point is to say so
  // specifically rather than blame the app for "something unreadable".
  const result = await call(SYSTEM, user, 16000, {
    kind: 'tailor',
    json: true,
    accept: (reply) => !!extractJson(reply)?.resume,
  });
  const { text, model, providerId, providerLabel, stopReason, spend } = result;
  const out = extractJson(text);
  if (!out?.resume) {
    // Weaker and free models are markedly worse at returning clean JSON, so this
    // says which service produced the mess rather than blaming the app.
    throw new Error(wasTruncated(stopReason)
      ? `${providers.get(providerId).label} cut the reply off before it finished - the CV or job description may `
        + 'be unusually long. Try that role again, or pick a stronger model in Settings.'
      : `${providers.get(providerId).label} replied with something the app could not read. `
        + 'Try that role again, or pick a stronger model in Settings.');
  }

  const keptOriginal = enforceTruth(master, out.resume);
  settings.set('tailor_count', Number(settings.get('tailor_count', 0)) + 1);
  const notes = (out.match_notes || []).filter(Boolean).map(String);
  if (keptOriginal.length) {
    notes.push(`${keptOriginal.length} role${keptOriginal.length === 1 ? '' : 's'} `
      + `${keptOriginal.length === 1 ? 'was' : 'were'} kept in its original wording rather than rewritten for this role.`);
  }
  // The person should know a stand-in answered, same as any other place this
  // app shows what it did rather than doing it silently - not just for
  // curiosity, but because a weaker fallback model is exactly when the CV is
  // worth a closer read before sending.
  notes.push(`AI edited the CV and drafted the email and covering letter using ${providerLabel} (${model}).`);

  return {
    resume: out.resume,
    cover_letter: String(out.cover_letter || '').trim(),
    email_subject: String(out.email_subject || '').trim(),
    email_body: String(out.email_body || '').trim(),
    match_score: Math.max(0, Math.min(100, Number(out.match_score) || 0)),
    match_notes: notes,
    spend,
    provenance: {
      kind: 'ai',
      provider: providerLabel,
      provider_id: providerId,
      model,
      actions: ['cv_tailoring', 'email_draft', 'cover_letter_draft'],
    },
  };
}

/**
 * Answers the application-form questions plain keyword matching could not —
 * the dropdowns and the free-text screening questions. Returns only answers
 * that survive the guards below; the page-side script then drops anything
 * that is not a real option on the element it belongs to, so a wrong answer
 * has to get past both to reach an employer's form.
 */
async function answerFormFields({ fields, cv, job }) {
  const asked = (fields || []).filter((f) => f && f.label);
  if (!asked.length) return { answers: [], provenance: null };

  const user = `THE CANDIDATE'S CV (JSON, the only source of truth):
${JSON.stringify(cv, null, 2)}

---

THE JOB
Title: ${job?.title || ''}
Company: ${job?.company || ''}
Location: ${job?.location_raw || ''}

---

QUESTIONS ON THE FORM (answer by index):
${JSON.stringify(asked.map((f) => ({
    index: f.index,
    question: f.label,
    answer_type: f.kind,
    ...(f.options?.length ? { must_be_one_of: f.options } : {}),
  })), null, 2)}`;

  const result = await call(FORM_SYSTEM, user, 4000, {
    kind: 'form answers',
    json: true,
    accept: (reply) => Array.isArray(extractJson(reply)?.answers),
  });
  const { text, model, providerId, providerLabel } = result;

  const parsed = extractJson(text);
  const byIndex = new Map(asked.map((f) => [f.index, f]));
  const out = [];
  for (const a of parsed?.answers || []) {
    const field = byIndex.get(Number(a?.index));
    const value = String(a?.value ?? '').trim();
    if (!field || !value) continue;
    // A question offering options may only be answered with one of them. The
    // page-side script checks this again against the live element; doing it
    // here too means a model that ignores the instruction never even reaches it.
    if (field.options?.length
      && !field.options.some((o) => o.toLowerCase() === value.toLowerCase())) continue;
    if (PROTECTED_QUESTION.test(field.label)) continue;    // never ours to answer — see FORM_SYSTEM rule 4
    out.push({ index: field.index, value });
  }
  return {
    answers: out,
    provenance: {
      kind: 'ai',
      provider: providerLabel,
      provider_id: providerId,
      model,
      actions: ['form_answers'],
    },
  };
}

/**
 * Questions that stay unanswered whatever the model returns. These are asked
 * for equal-opportunities monitoring and are the candidate's alone; they are
 * also the ones where a confident wrong answer does real harm. The prompt
 * forbids them and this drops them anyway, because a prompt is a request and
 * a guard is a guarantee — the same reason enforceTruth() exists.
 */
const PROTECTED_QUESTION = /disab|gender|sex\b|ethnic|race\b|racial|veteran|nationality|religio|orientation|marital|pregnan|criminal|conviction|salary|compensation|ctc|consent|agree to|declaration|certify/i;

async function followup({ job, application, daysSince, seq, cv = {} }) {
  const user = `ROLE: ${job.title} at ${job.company}
APPLIED: ${daysSince} days ago${seq > 1 ? ` (this is follow-up number ${seq})` : ''}
THE EMAIL ORIGINALLY SENT:
${String(application.body_text || '').slice(0, 2000)}

THE CANDIDATE: ${cv.name || 'the candidate'}
BACKGROUND IN ONE LINE: ${cv.pitch || cv.summary || 'An experienced professional.'}`;

  const { text } = await call(FOLLOWUP_SYSTEM, user, 1200, {
    kind: 'follow-up',
    json: true,
    accept: (reply) => !!extractJson(reply)?.body,
  });
  const out = extractJson(text) || {};
  return {
    subject: String(out.subject || `Following up — ${job.title}`).trim(),
    body: String(out.body || '').trim(),
  };
}

/**
 * A deliberately tiny request, so checking a key costs a fraction of a paisa.
 *
 * Confirmed live against Gemini: a reasoning model can spend an entire small
 * token budget on invisible "thinking" and return nothing, which reads as a
 * broken key rather than a request that was simply too stingy. `cheap: true`
 * turns thinking off — see `providers.js#buildRequest`, which now does it on
 * both wires, because Claude's current models think by default too.
 *
 * The budget is the same 300 on either wire. It used to be 16 on Anthropic,
 * from when Claude answered without thinking first; 300 tokens of Sonnet is
 * about a tenth of a paisa and leaves no room for that assumption to rot again.
 */
async function ping(opts = {}) {
  const id = opts.provider || budget.providerId();
  const requestedModel = opts.model
    || (id === 'openrouter' ? 'openrouter/free' : providers.get(id).defaultModel);
  const { model } = await call('Reply with the single word: ok', 'ping', 300,
    { ...opts, provider: id, model: requestedModel, cheap: true, kind: 'key check' });
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
  structureResume, enforceResumeTruth, listModels, storedKey, answerFormFields, PROTECTED_QUESTION,
  buildAttemptPlan, call };
