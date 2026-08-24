'use strict';
/**
 * Everything that follows from "here is my resume".
 *
 * One file owns the whole consequence of importing a CV — the document itself,
 * the facts pulled out of it, the mailbox, and the search vocabulary — because
 * these have to move together. A CV saved without its keywords rebuilt leaves
 * the board answering the previous career.
 */
const db = require('./db');
const settings = require('./settings');
const masterCv = require('./master');
const resumeRead = require('./resume-read');
const resumeParse = require('./resume-parse');
const resumeKeywords = require('./resume-keywords');

/* -------------------------------------------------------------- reading --- */

/**
 * Reads a resume without saving anything. The interface shows what came out and
 * the person confirms it, because a heuristic parse that is wrong and silent is
 * worse than one that is wrong and visible.
 */
async function preview({ filePath, text }) {
  let raw = text;
  let file = '';
  let kind = 'text';

  if (filePath) {
    const read = resumeRead.readResumeFile(filePath);
    // An exported Job Desk CV needs no parsing — it is already the right shape.
    if (read.cv) {
      return {
        cv: read.cv,
        confidence: fullConfidence(read.cv),
        keywords: resumeKeywords.fromCv(read.cv),
        profile: resumeParse.profileFrom(read.cv),
        file: read.file,
        kind: 'json',
        aiUsed: false,
      };
    }
    raw = read.text;
    file = read.file;
    kind = read.kind;
  }

  if (!String(raw || '').trim()) {
    throw new Error('There was nothing to read. Choose a file, or paste the text of your resume.');
  }

  const parsed = resumeParse.parseResume(raw);
  let cv = parsed.cv;
  let aiUsed = false;

  // A key makes this markedly better, but the app never depends on one.
  const ai = require('./ai');
  if (ai.available()) {
    try {
      cv = await ai.structureResume(raw, cv);
      aiUsed = true;
    } catch { /* the heuristic parse stands */ }
  }

  return {
    cv,
    confidence: parsed.confidence,
    keywords: resumeKeywords.fromCv(cv),
    profile: resumeParse.profileFrom(cv),
    file,
    kind,
    aiUsed,
  };
}

const fullConfidence = (cv) => ({
  name: cv.name ? 'high' : 'missing',
  email: cv.contact?.email ? 'high' : 'missing',
  phone: cv.contact?.phone ? 'high' : 'missing',
  location: cv.contact?.location ? 'high' : 'missing',
  experience: cv.experience?.length ? 'high' : 'missing',
  education: cv.education?.length ? 'high' : 'missing',
  skills: Object.keys(cv.competencies || {}).length ? 'high' : 'missing',
});

/* --------------------------------------------------------------- saving --- */

/**
 * Commits a reviewed CV: the document, the facts, the mailbox, the vocabulary.
 * `rebuildKeywords: false` saves the CV alone, which is what a small edit in
 * Settings wants.
 */
function apply({ cv, rebuildKeywords = true }) {
  if (!cv || !cv.name || !String(cv.name).trim()) {
    throw new Error('The CV needs a name on it — that is what goes on every document.');
  }
  const saved = masterCv.saveMaster(cv);
  syncProfile(saved);
  require('./seed').seedMailboxFromCv();

  const keywords = rebuildKeywords ? rebuild(saved) : null;
  settings.set('resume_imported_at', new Date().toISOString());
  db.logActivity('resume_imported',
    `${saved.name} — ${(saved.experience || []).length} roles`
    + (keywords ? `, ${keywords.added} keywords` : ''));

  return { cv: saved, profile: current(), keywords };
}

/** The flat facts, mirrored into settings so every screen can reach them cheaply. */
function syncProfile(cv) {
  const facts = resumeParse.profileFrom(cv);
  for (const [k, v] of Object.entries(facts)) {
    // Never blank out something the person typed by hand with an empty parse.
    if (v === '' && settings.get(k, '')) continue;
    settings.set(k, v);
  }
  return facts;
}

/** What the app knows about the person, for the header, forms and letters. */
function current() {
  const keys = ['profile_name', 'profile_email', 'profile_phone', 'profile_linkedin',
    'profile_website', 'profile_location', 'profile_city', 'profile_state',
    'profile_country', 'profile_headline', 'profile_years'];
  const out = {};
  for (const k of keys) out[k] = settings.get(k, '');
  out.resume_imported_at = settings.get('resume_imported_at', null);
  return out;
}

/* ----------------------------------------------------------- vocabulary --- */

/**
 * Rebuilds the resume-derived vocabulary.
 *
 * Anything the person added or edited by hand carries `source = 'user'` and is
 * left exactly where it is; only rows this function wrote last time are cleared.
 * A term that exists as theirs is never duplicated or overwritten — their weight
 * wins, because they chose it and the resume did not.
 */
function rebuild(cv = masterCv.master()) {
  const generated = resumeKeywords.fromCv(cv);

  const before = db.val("SELECT COUNT(*) AS n FROM keywords WHERE source = 'resume'", [], 0);
  db.run("DELETE FROM keywords WHERE source = 'resume'");

  let added = 0;
  let kept = 0;
  for (const kind of ['query', 'boost', 'exclude']) {
    for (const { term, weight, bucket } of generated[kind] || []) {
      const mine = db.get('SELECT id FROM keywords WHERE term = ? AND kind = ?', [term, kind]);
      if (mine) { kept++; continue; }               // theirs, and theirs stays
      try {
        db.insert('keywords', { term, kind, weight, bucket, source: 'resume', active: 1 });
        added++;
      } catch { /* raced with a manual add; theirs wins */ }
    }
  }

  const userHeld = db.val("SELECT COUNT(*) AS n FROM keywords WHERE source <> 'resume'", [], 0);
  return { added, removed: Number(before), keptYours: Number(userHeld), alreadyYours: kept };
}

/** Marks a keyword as the person's, so a later rebuild leaves it alone. */
const claimForUser = (id) => db.run("UPDATE keywords SET source = 'user' WHERE id = ?", [id]);

module.exports = { preview, apply, rebuild, syncProfile, current, claimForUser };
