'use strict';
/**
 * The no-API-key path. Everything here is generated locally from the master CV,
 * so the app is completely usable — and completely free — before any key exists.
 *
 * These are honest starting drafts, not pretend tailoring. They say what is true
 * of her in general and then hand her one sentence to make it specific, which is
 * the only part a template genuinely cannot write.
 */
const settings = require('./settings');

/** She is warned before sending while this is still in the text. */
const PLACEHOLDER = '[One sentence on why this role in particular — please replace this line.]';

/**
 * The standing paragraph, in her own voice. It comes from the CV's `pitch`
 * field so that editing the CV updates every future email; the CV summary is
 * written in third person and reads wrong in a letter, so it is only a fallback.
 */
function credentials(cv) {
  if (cv.pitch) return String(cv.pitch).trim();   // hers to write, used verbatim

  const c = cv.competencies || {};
  const role = String(cv.headline || 'counselling psychologist').split('•')[0].trim().toLowerCase();
  const areas = (c.Specialisations || []).slice(0, 4).join(', ');
  const modalities = (c.Modalities || []).slice(0, 3).join(', ');
  let out = `I am a ${role}.`;
  if (areas) out += ` My work covers ${areas}.`;
  if (modalities) out += ` I work primarily from ${modalities}.`;
  return out;
}

function signature(cv) {
  const c = cv.contact || {};
  const line = [c.email, c.phone].filter(Boolean).join('  |  ');
  return `Warm regards,\n${cv.name}${line ? `\n${line}` : ''}`;
}

const DEFAULT_EMAIL = `Dear Hiring Team,

I am writing to apply for the {{title}} role at {{company}}.

{{credentials}}

{{placeholder}}

My CV is attached. I would welcome the chance to talk about the role in more detail.

{{signature}}`;

const DEFAULT_COVER = `Dear Hiring Team,

I am applying for the {{title}} role at {{company}}.

{{credentials}}

{{placeholder}}

I have attached my CV, which sets out my qualifications, the settings I have worked in, and the areas I specialise in. I would be glad to talk through any of it.

{{signature}}`;

const DEFAULT_FOLLOWUP = `Dear Hiring Team,

I applied for the {{title}} role at {{company}} about {{days}} days ago, and I wanted to check whether the position is still open.

I remain very interested, and I am happy to send anything further that would be useful — references, or more detail on any part of my background.

{{signature}}`;

function fill(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (full, key) =>
    (values[key] !== undefined ? values[key] : full)).replace(/\n{3,}/g, '\n\n').trim();
}

/** Mirrors what ai.tailor() returns, so the rest of the app cannot tell them apart. */
function draftApplication(cv, job, options = {}) {
  const values = {
    title: job.title || 'the advertised role',
    company: job.company || 'your organisation',
    credentials: credentials(cv),
    placeholder: PLACEHOLDER,
    signature: signature(cv),
  };

  const notes = [
    'Written from a template — the CV attached is her full master CV, not a version rewritten for this role.',
    'The score beside this role comes from keyword matching, not from reading the description.',
  ];
  if (options.aiUnavailable) {
    notes.unshift('AI services were unavailable, so the original CV is attached without AI edits.');
  }
  if (job.description_text && job.description_text.length > 400) {
    notes.push('Worth reading the description before sending: a template cannot tell you what it asks for.');
  }

  return {
    mode: 'template',
    resume: cv,                      // the master CV, untouched
    cover_letter: fill(settings.get('template_cover', DEFAULT_COVER), values),
    email_subject: `${job.title || 'Application'} — application from ${cv.name}`,
    email_body: fill(settings.get('template_email', DEFAULT_EMAIL), values),
    match_score: Number(job.score) || 0,
    match_notes: notes,
    spend: null,
    provenance: {
      kind: 'template',
      provider: '',
      provider_id: '',
      model: '',
      actions: ['original_cv', 'email_template', 'cover_letter_template'],
      reason: options.aiUnavailable ? String(options.reason || 'AI services were unavailable.') : '',
      detail: options.aiUnavailable
        ? 'All available AI services failed. The original CV and local email templates were used.'
        : 'The original CV and local email templates were used. No AI key was available.',
    },
  };
}

function draftFollowup(cv, job, daysSince) {
  const values = {
    title: job.title || 'the role',
    company: job.company || 'your organisation',
    days: daysSince,
    credentials: credentials(cv),
    placeholder: '',
    signature: signature(cv),
  };
  return {
    subject: `Following up — ${job.title || 'my application'}`,
    body: fill(settings.get('template_followup', DEFAULT_FOLLOWUP), values),
  };
}

const hasPlaceholder = (text) => String(text || '').includes(PLACEHOLDER);

const defaults = () => ({
  template_email: DEFAULT_EMAIL,
  template_cover: DEFAULT_COVER,
  template_followup: DEFAULT_FOLLOWUP,
});

const current = () => ({
  template_email: settings.get('template_email', DEFAULT_EMAIL),
  template_cover: settings.get('template_cover', DEFAULT_COVER),
  template_followup: settings.get('template_followup', DEFAULT_FOLLOWUP),
});

module.exports = { draftApplication, draftFollowup, hasPlaceholder, PLACEHOLDER, defaults, current, fill };
