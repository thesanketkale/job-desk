'use strict';
/** First-run vocabulary and sources. All of it is editable in the app. */
const db = require('./db');
const settings = require('./settings');

const KEYWORDS = [
  ['counselling psychologist', 'query', 10, 'clinical'],
  ['counseling psychologist', 'query', 10, 'clinical'],
  ['psychologist', 'query', 8, 'clinical'],
  ['therapist', 'query', 8, 'clinical'],
  ['psychotherapist', 'query', 8, 'clinical'],
  ['mental health counsellor', 'query', 8, 'clinical'],
  ['employee assistance programme', 'query', 9, 'eap'],
  ['EAP counsellor', 'query', 9, 'eap'],
  ['corporate wellness', 'query', 7, 'eap'],
  ['workplace wellbeing', 'query', 7, 'eap'],
  ['school counsellor', 'query', 7, 'education'],
  ['student wellbeing', 'query', 6, 'education'],
  ['behavioural health', 'query', 6, 'clinical'],
  ['psychology expert', 'query', 8, 'ai'],
  ['AI trainer psychology', 'query', 7, 'ai'],
  ['human data psychology', 'query', 6, 'ai'],

  ['CBT', 'boost', 6, 'modality'],
  ['cognitive behavioural therapy', 'boost', 6, 'modality'],
  ['mindfulness', 'boost', 4, 'modality'],
  ['grief', 'boost', 4, 'modality'],
  ['couples therapy', 'boost', 5, 'modality'],
  ['family therapy', 'boost', 5, 'modality'],
  ['postpartum', 'boost', 6, 'specialisation'],
  ['perinatal', 'boost', 5, 'specialisation'],
  ['fertility', 'boost', 4, 'specialisation'],
  ['suicide prevention', 'boost', 6, 'specialisation'],
  ['crisis intervention', 'boost', 5, 'specialisation'],
  ['adolescent', 'boost', 4, 'specialisation'],
  ['teletherapy', 'boost', 6, 'delivery'],
  ['telehealth', 'boost', 5, 'delivery'],
  ['remote', 'boost', 6, 'delivery'],
  ['work from home', 'boost', 5, 'delivery'],
  ['india', 'boost', 6, 'geography'],
  ['asia pacific', 'boost', 3, 'geography'],
  ['workshop facilitation', 'boost', 5, 'delivery'],
  ['trainer', 'boost', 3, 'delivery'],
  ['employee wellbeing', 'boost', 6, 'eap'],
  ['workplace mental health', 'boost', 6, 'eap'],
  ['organisational psychology', 'boost', 5, 'eap'],
  ['clinical supervision', 'boost', 4, 'eap'],
  ['red team', 'boost', 6, 'ai'],
  ['model behaviour', 'boost', 7, 'ai'],
  ['model behavior', 'boost', 7, 'ai'],
  ['RLHF', 'boost', 5, 'ai'],
  ['human feedback', 'boost', 5, 'ai'],
  ['domain expert', 'boost', 5, 'ai'],
  ['subject matter expert', 'boost', 5, 'ai'],
  ['trust and safety', 'boost', 5, 'ai'],
  ['AI safety', 'boost', 6, 'ai'],
  ['curriculum', 'boost', 4, 'content'],
  ['instructional design', 'boost', 4, 'content'],
  ['psychoeducation', 'boost', 5, 'content'],

  ['psychiatrist', 'exclude', 10, 'wrong-profession'],
  ['nurse', 'exclude', 10, 'wrong-profession'],
  ['nurse practitioner', 'exclude', 10, 'wrong-profession'],
  ['BCBA', 'exclude', 10, 'wrong-credential'],
  ['board certified behavior analyst', 'exclude', 10, 'wrong-credential'],
  ['LCSW', 'exclude', 10, 'wrong-credential'],
  ['LMFT', 'exclude', 10, 'wrong-credential'],
  ['speech therapist', 'exclude', 10, 'wrong-profession'],
  ['physical therapist', 'exclude', 10, 'wrong-profession'],
  ['occupational therapist', 'exclude', 10, 'wrong-profession'],
  ['massage', 'exclude', 10, 'wrong-profession'],
  ['software engineer', 'exclude', 8, 'wrong-field'],
  ['sales representative', 'exclude', 8, 'wrong-field'],
  ['account executive', 'exclude', 8, 'wrong-field'],
  ['warehouse', 'exclude', 8, 'wrong-field'],
  ['driver', 'exclude', 8, 'wrong-field'],
];

const SOURCES = [
  ['adzuna', 'Adzuna — India, UK, US, SG, AU, CA', '', { countries: ['in', 'gb', 'us', 'sg', 'au', 'ca'], pages: 2 }, 1],
  ['remotive', 'Remotive — remote roles', '', {}, 1],
  ['remoteok', 'RemoteOK — remote roles', '', {}, 1],
  ['himalayas', 'Himalayas — remote roles', '', {}, 1],
  ['arbeitnow', 'Arbeitnow — EU/UK feed', '', {}, 1],
  ['greenhouse', 'Anthropic', 'anthropic', {}, 1],
  ['greenhouse', 'Scale AI', 'scaleai', {}, 1],
  ['ashby', 'OpenAI', 'openai', {}, 1],
];

/** Offered in the app as one-click "test and add". Not enabled by default. */
const SUGGESTED = [
  ['ashby', 'Mercor', 'mercor'],
  ['ashby', 'Surge AI', 'surge'],
  ['ashby', 'Perplexity', 'perplexity'],
  ['greenhouse', 'Lyra Health', 'lyrahealth'],
  ['greenhouse', 'Spring Health', 'springhealth'],
  ['greenhouse', 'Headspace', 'headspace'],
  ['greenhouse', 'Talkspace', 'talkspace'],
  ['greenhouse', 'Modern Health', 'modernhealth'],
  ['greenhouse', 'Calm', 'calm'],
  ['greenhouse', 'BetterUp', 'betterup'],
  ['greenhouse', 'Included Health', 'includedhealth'],
  ['lever', 'Sama', 'samasource'],
  ['lever', 'Turing', 'turing'],
  ['workable', 'Amaha', 'amaha'],
  ['workable', 'YourDOST', 'yourdost'],
];

function seedIfEmpty() {
  if (db.val('SELECT COUNT(*) AS n FROM keywords', [], 0) === 0) {
    for (const [term, kind, weight, bucket] of KEYWORDS) {
      try { db.insert('keywords', { term, kind, weight, bucket }); } catch { /* already there */ }
    }
  }
  if (db.val('SELECT COUNT(*) AS n FROM sources', [], 0) === 0) {
    for (const [type, label, slug, config, active] of SOURCES) {
      db.insert('sources', { type, label, slug, config: JSON.stringify(config), active });
    }
  }
  settings.set('suggested_boards', SUGGESTED);
  for (const [k, v] of Object.entries(settings.DEFAULTS)) {
    if (db.get('SELECT 1 AS x FROM settings WHERE k = ?', [k]) === null) settings.set(k, v);
  }
  seedMailboxFromCv();
}

/**
 * Pre-fills the mailbox from whatever CV is loaded, so she does not retype what
 * the app already knows and no address is baked into the installer.
 */
function seedMailboxFromCv() {
  if (settings.get('smtp_from_email', '')) return;
  let cv;
  try { cv = require('./master').master(); } catch { return; }
  const email = cv && cv.contact && cv.contact.email;
  if (!email || !email.includes('@')) return;

  settings.set('smtp_host', 'mail.' + email.split('@')[1]);
  settings.set('smtp_port', 465);
  settings.set('smtp_secure', true);
  settings.set('smtp_user', email);
  settings.set('smtp_from_email', email);
  settings.set('smtp_from_name', cv.name || '');
}

module.exports = { seedIfEmpty, seedMailboxFromCv, SUGGESTED };
