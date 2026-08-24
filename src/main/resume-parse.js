'use strict';
/**
 * Reads a plain-text resume into the CV shape the rest of the app already uses.
 *
 * This is the no-key path, and it is honest about what it is: heuristics over
 * layout conventions, not comprehension. It is reliable for the facts that are
 * unambiguous in almost every resume — the email address, the phone number, the
 * headings — and best-effort for the rest. Nothing it produces is ever saved
 * without the person seeing it first, which is what makes a good-enough parse
 * good enough.
 *
 * `claude.js` can do this far better when a key exists; both return the same
 * shape, exactly as `templates.js` and `claude.js` already do for applications.
 */
const { place, decodeEntities } = require('./normalize');

/* ------------------------------------------------------------- contact ---- */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Long enough to be a phone number, not a year, a PIN code or a session count. */
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,4}[\s.-]?\d{0,4}/g;

function findEmail(text) {
  const all = String(text).match(EMAIL_RE) || [];
  // A resume sometimes lists a referee or a previous employer; hers comes first.
  const own = all.find((e) => !/^(?:info|hr|careers|jobs|admin|support|noreply)@/i.test(e));
  return (own || all[0] || '').toLowerCase();
}

function findPhone(text) {
  // Only look where phone numbers live, so a date or a statistic cannot win.
  const head = String(text).split('\n').slice(0, 15).join('\n');
  const candidates = (head.match(PHONE_RE) || [])
    .map((s) => s.trim())
    .filter((s) => {
      const digits = s.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) return false;
      if (/^(19|20)\d{2}$/.test(digits)) return false;         // a year
      return true;
    });
  return candidates[0] || '';
}

function findLink(text, host) {
  const re = new RegExp(`(?:https?://)?(?:www\\.)?${host}[^\\s,;|)<>"']*`, 'i');
  const m = String(text).match(re);
  return m ? m[0].replace(/^https?:\/\//i, '').replace(/[.,;]$/, '') : '';
}

function findWebsite(text, email) {
  const head = String(text).split('\n').slice(0, 15).join('\n');
  const domain = (email.split('@')[1] || '').toLowerCase();
  const all = head.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?[^\s,;|)<>"']*/gi) || [];
  for (const raw of all) {
    const url = raw.replace(/^https?:\/\//i, '').replace(/[.,;]$/, '');
    const low = url.toLowerCase();
    if (low.includes('@')) continue;
    if (/(linkedin|github|twitter|x)\.com/.test(low)) continue;
    if (/\.(png|jpe?g|pdf|docx?)$/.test(low)) continue;
    // Her own domain, if the email is on it, is the strongest possible signal.
    if (domain && low.startsWith(domain)) return url;
    if (/^(www\.)?[a-z0-9-]+\.(com|net|org|in|co|io|me|dev)/.test(low)) return url;
  }
  return '';
}

/* ---------------------------------------------------------------- name ---- */

const NOT_A_NAME = /\b(curriculum vitae|resume|r[ée]sum[ée]|profile|contact|phone|email|address|linkedin)\b/i;

/**
 * The name is almost always the first line that reads like one: a few words, no
 * digits, no punctuation that belongs to an address.
 */
function findName(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);
  for (const line of lines) {
    if (line.length > 60 || line.length < 3) continue;
    if (line.includes('@') || /\d/.test(line)) continue;
    if (NOT_A_NAME.test(line)) continue;
    if (/[|/\\]/.test(line)) continue;
    const words = line.replace(/[,.]/g, '').split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 5) continue;
    // Every word starts upper case, or the whole line is upper case.
    const titled = words.every((w) => /^[A-Z]/.test(w));
    const shouty = line === line.toUpperCase();
    if (!titled && !shouty) continue;
    if (!/^[A-Za-z\s'`.\-]+$/.test(line)) continue;
    return shouty ? titleCase(line) : line.replace(/[,.]$/, '');
  }
  return '';
}

const titleCase = (s) => String(s).toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------ location ---- */

/**
 * Reuses the feed-side place parser, so a resume and a job advert are read by
 * exactly the same rules and therefore compare correctly.
 */
function findLocation(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 15);
  for (const line of lines) {
    if (line.includes('@') || line.length > 80) continue;
    const candidate = line.replace(/^(address|location|based in)\s*[:\-–]\s*/i, '');
    if (!/,/.test(candidate) && !/\b(india|remote)\b/i.test(candidate)) continue;
    if (/\d{4,}/.test(candidate)) continue;                 // a postcode or a year
    const p = place(candidate);
    if (p.country && p.country !== 'Unknown') {
      return { location: candidate.replace(/[|•]/g, '').trim(), ...p };
    }
  }
  return { location: '', city: '', region: '', country: '' };
}

/* -------------------------------------------------------------- sections -- */

const HEADINGS = [
  ['summary',        /^(professional\s+)?(summary|profile|objective|about( me)?|overview)\b/i],
  ['experience',     /^(work\s+|professional\s+|relevant\s+|employment\s+)?(experience|history|employment)\b/i],
  ['education',      /^(education|academic|qualifications?)\b/i],
  ['skills',         /^(skills?|competenc(y|ies)|areas? of expertise|specialisations?|specializations?|technical skills)\b/i],
  ['certifications', /^(certifications?|licen[cs]es?|training|courses?|accreditations?)\b/i],
  ['achievements',   /^(achievements?|accomplishments?|impact|highlights|awards?)\b/i],
  ['projects',       /^(projects?|portfolio|publications?)\b/i],
  ['languages',      /^(languages?)\b/i],
  ['interests',      /^(interests?|hobbies|activities)\b/i],
];

/** A heading is short, unpunctuated, and matches one of the names above. */
function headingOf(line) {
  const raw = line.trim();
  // "Languages: Python, SQL" is a labelled list inside a section, not a heading
  // for one — the content after the colon is what gives it away.
  if (/:\s*\S/.test(raw)) return null;
  const s = raw.replace(/[:•\-–—_]+$/, '').trim();
  if (!s || s.length > 44) return null;
  if (/[.!?]$/.test(s)) return null;
  const words = s.split(/\s+/);
  if (words.length > 5) return null;
  for (const [name, re] of HEADINGS) if (re.test(s)) return name;
  return null;
}

/** Splits the resume into named blocks, keeping anything before the first heading. */
function sectionise(text) {
  const out = { header: [] };
  let current = 'header';
  for (const line of String(text).split('\n')) {
    const h = headingOf(line);
    if (h) { current = h; if (!out[current]) out[current] = []; continue; }
    (out[current] ||= []).push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

/* ------------------------------------------------------------ experience -- */

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const WHEN = `(?:${MONTH}\\s*,?\\s*\\d{4}|\\d{1,2}/\\d{4}|\\d{4}|present|current|to date|now)`;
const RANGE_RE = new RegExp(`(${WHEN})\\s*(?:-|–|—|to|until)\\s*(${WHEN})`, 'i');

const BULLET_RE = /^\s*[•▪◦‣·*+\-–—]\s+/;

const tidyWhen = (s) => {
  const t = String(s).trim().replace(/\.$/, '');
  if (/^(present|current|to date|now)$/i.test(t)) return 'Present';
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
};

/**
 * Walks the experience section looking for date ranges, and treats everything
 * between one range and the next as a single job. It is the one structural rule
 * that nearly every resume layout obeys, whatever else it does.
 */
function parseExperience(block) {
  if (!block) return [];
  const lines = block.split('\n');
  const jobs = [];
  let current = null;

  const flush = () => { if (current) { jobs.push(current); current = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const m = line.match(RANGE_RE);
    if (m) {
      flush();
      // The title and employer sit on the date line, or just above it.
      const rest = line.replace(RANGE_RE, '').replace(/[|•,\-–—]+\s*$/, '').replace(/^\s*[|•,\-–—]+/, '').trim();
      const above = (lines[i - 1] || '').trim();
      const source = rest || (BULLET_RE.test(above) ? '' : above);
      const [title, org] = splitTitleOrg(source);
      current = {
        id: '', title, org, location: '',
        start: tidyWhen(m[1]), end: tidyWhen(m[2]), bullets: [],
      };
      continue;
    }

    if (!current) continue;

    // A line immediately above the next date range belongs to the next job, not
    // to this one's last bullet.
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (next && RANGE_RE.test(next) && !BULLET_RE.test(line)) continue;

    if (BULLET_RE.test(line)) {
      current.bullets.push(line.replace(BULLET_RE, '').trim());
    } else if (current.bullets.length) {
      // A wrapped bullet, rather than a new one.
      current.bullets[current.bullets.length - 1] += ` ${line}`;
    } else if (!current.title) {
      const [title, org] = splitTitleOrg(line);
      current.title = title; current.org = org || current.org;
    } else if (!current.org && line.length < 70) {
      current.org = line;
    } else {
      current.bullets.push(line);
    }
  }
  flush();

  return jobs
    .filter((j) => j.title || j.org)
    .map((j, i) => ({
      ...j,
      id: slugId(j.org || j.title, i),
      title: j.title || 'Role',
      org: j.org || 'Employer',
      bullets: j.bullets.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
    }))
    .slice(0, 12);
}

/** "Senior Therapist at Acme" / "Senior Therapist, Acme" / "Senior Therapist | Acme" */
function splitTitleOrg(line) {
  const s = String(line || '').replace(/\s+/g, ' ').trim();
  if (!s) return ['', ''];
  const m = s.match(/^(.+?)\s*(?:\bat\b|[|,–—-])\s*(.+)$/i);
  if (m && m[1].length > 1 && m[2].length > 1 && m[2].length < 60) {
    return [m[1].trim(), m[2].trim()];
  }
  return [s, ''];
}

const slugId = (s, i) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || `role${i + 1}`);

/* ------------------------------------------------------------- education -- */

function parseEducation(block) {
  if (!block) return [];
  const out = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(BULLET_RE, '').trim();
    if (!line || line.length < 6) continue;
    const years = line.match(new RegExp(`${WHEN}\\s*(?:-|–|—|to)\\s*${WHEN}|\\b(19|20)\\d{2}\\b`, 'i'));
    const withoutYears = line.replace(years ? years[0] : '', '').replace(/[|,\-–—]\s*$/, '').trim();
    const [degree, school] = splitTitleOrg(withoutYears);
    if (!degree) continue;
    out.push({ degree, school: school || '', years: years ? tidyWhen(years[0]) : '', detail: '' });
    if (out.length >= 8) break;
  }
  return out;
}

/* ---------------------------------------------------------------- skills -- */

/** Skills arrive as comma lists, bullet lists, or "Label: a, b, c" groups. */
function parseSkills(block) {
  if (!block) return {};
  const groups = {};
  const loose = [];

  for (const raw of block.split('\n')) {
    const line = raw.replace(BULLET_RE, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z &/'-]{2,34}):\s*(.+)$/);
    if (m) {
      const items = splitList(m[2]);
      if (items.length) groups[titleCase(m[1].trim())] = items;
    } else {
      loose.push(...splitList(line));
    }
  }
  if (loose.length) {
    groups.Skills = [...new Set([...(groups.Skills || []), ...loose])].slice(0, 30);
  }
  return groups;
}

const splitList = (s) => String(s)
  .split(/[,;|•·]/)
  .map((x) => x.replace(/\.$/, '').trim())
  // "R", "C" and "C#" are real skills; a stray lower-case letter is not.
  .filter((x) => (x.length > 1 || /^[A-Z][+#]?$/.test(x)) && x.length < 44)
  .slice(0, 30);

/* ------------------------------------------------------------------ CV ---- */

/**
 * The whole parse. Returns the CV in the app's own shape plus a `confidence`
 * report, so the review screen can point at what it is least sure about rather
 * than presenting every field as equally trustworthy.
 */
function parseResume(rawText) {
  const text = decodeEntities(String(rawText || '')).replace(/\r\n?/g, '\n');
  const sections = sectionise(text);

  const email = findEmail(text);
  const name = findName(text);
  const loc = findLocation(text);

  const experience = parseExperience(sections.experience);
  const education = parseEducation(sections.education);
  const competencies = parseSkills(sections.skills);

  const summary = firstParagraph(sections.summary) || firstParagraph(sections.header, name, email);
  const headline = findHeadline(sections.header, name) || (experience[0]?.title || '');

  const cv = {
    name: name || '',
    headline,
    contact: {
      phone: findPhone(text),
      email,
      linkedin: findLink(text, 'linkedin\\.com'),
      website: findWebsite(text, email),
      location: loc.location,
    },
    summary,
    pitch: summary ? toFirstPerson(summary) : '',
    competencies,
    experience,
    impact: bulletsOf(sections.achievements).slice(0, 8),
    education,
    certifications: sections.certifications
      ? { Certifications: bulletsOf(sections.certifications).slice(0, 20) }
      : {},
    differentiators: [],
    additional: additionalOf(sections),
    notes_for_tailoring: 'Facts that must never be altered — dates, employers, qualifications.',
  };

  const confidence = {
    name: name ? 'high' : 'missing',
    email: email ? 'high' : 'missing',
    phone: cv.contact.phone ? 'high' : 'missing',
    location: loc.country ? 'high' : 'missing',
    experience: experience.length ? (experience.length > 1 ? 'high' : 'low') : 'missing',
    education: education.length ? 'high' : 'missing',
    skills: Object.keys(competencies).length ? 'high' : 'missing',
  };

  return { cv, confidence, sections, text };
}

function firstParagraph(block, ...drop) {
  if (!block) return '';
  const skip = new Set(drop.filter(Boolean).map((s) => String(s).toLowerCase()));
  const lines = block.split('\n').map((l) => l.replace(BULLET_RE, '').trim())
    .filter((l) => l && !skip.has(l.toLowerCase()) && !l.includes('@') && l.length > 40);
  return lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim().slice(0, 900);
}

/** The line under the name, when it is a job title rather than an address. */
function findHeadline(header, name) {
  if (!header) return '';
  const lines = header.split('\n').map((l) => l.trim()).filter(Boolean);
  // The name may have been title-cased out of a shouty line, so match loosely.
  const low = String(name || '').toLowerCase();
  const start = name ? lines.findIndex((l) => l.toLowerCase() === low) + 1 : 0;
  for (const line of lines.slice(start, start + 3)) {
    if (!line || line.length > 90 || line.length < 4) continue;
    if (line.includes('@') || /\d{4}/.test(line) || /https?:|www\./i.test(line)) continue;
    if (/^\+?\d/.test(line)) continue;
    return line.replace(/\s*[|•]\s*/g, '  •  ');
  }
  return '';
}

/** A third-person summary reads wrong in a letter; templates.js needs first person. */
function toFirstPerson(summary) {
  const s = String(summary).trim();
  if (!s || /^I\b/.test(s)) return s;
  // "An experienced analyst who…" -> "I am an experienced analyst who…"
  const article = s.match(/^(An?|The)\s+/i);
  if (article) return `I am ${article[1].toLowerCase()} ${s.slice(article[0].length)}`;
  // "Experienced analyst who…" -> "I am an experienced analyst who…"
  if (/^[A-Z][a-z]+ed\b|^[A-Z][a-z]+ing\b/.test(s)) {
    const an = /^[aeiou]/i.test(s) ? 'an' : 'a';
    return `I am ${an} ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  }
  return s;
}

const bulletsOf = (block) => (block ? block.split('\n')
  .map((l) => l.replace(BULLET_RE, '').trim())
  .filter((l) => l.length > 8) : []);

function additionalOf(sections) {
  const out = {};
  if (sections.languages) out.Languages = sections.languages.replace(/\n/g, ', ').slice(0, 200);
  if (sections.interests) out.Interests = sections.interests.replace(/\n/g, ', ').slice(0, 200);
  return out;
}

/* ---------------------------------------------------------- the profile --- */

/**
 * The flat facts the app wants at hand constantly — the form filler, the mailer,
 * the letter templates — pulled out of the CV once so nothing re-derives them.
 */
function profileFrom(cv) {
  const c = (cv && cv.contact) || {};
  const p = place(c.location || '');
  const years = yearsOfExperience(cv);
  return {
    profile_name: cv?.name || '',
    profile_email: c.email || '',
    profile_phone: c.phone || '',
    profile_linkedin: c.linkedin || '',
    profile_website: c.website || '',
    profile_location: c.location || '',
    profile_city: p.city || '',
    profile_state: p.region || '',
    profile_country: p.country && p.country !== 'Unknown' ? p.country : '',
    profile_headline: cv?.headline || '',
    ...(years ? { profile_years: String(years) } : {}),
  };
}

/** Earliest start year in the experience list to now, which is what forms ask for. */
function yearsOfExperience(cv) {
  const years = (cv?.experience || [])
    .map((j) => Number((String(j.start).match(/(19|20)\d{2}/) || [])[0]))
    .filter((n) => n >= 1950 && n <= new Date().getFullYear());
  if (!years.length) return 0;
  return Math.max(0, new Date().getFullYear() - Math.min(...years));
}

module.exports = {
  parseResume, profileFrom, sectionise, parseExperience, parseEducation, parseSkills,
  findName, findEmail, findPhone, findLocation, yearsOfExperience,
};
