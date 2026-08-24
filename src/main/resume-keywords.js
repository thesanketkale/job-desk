'use strict';
/**
 * Builds the search vocabulary out of the CV, so the board is populated by what
 * the person has actually done rather than by a list someone else typed in.
 *
 * Three lists come out, matching the three the Keywords view already shows:
 *   query   — what the job sites are asked for. Job titles, kept deliberately
 *             tight, because a vague query fills the board with noise.
 *   boost   — not searched for, but pushes a role up when it appears. Skills,
 *             specialisations, and the terms the resume keeps returning to.
 *   exclude — left empty here. Knowing that a counselling psychologist should
 *             never see psychiatrist roles takes domain knowledge a word count
 *             does not have; `claude.js` suggests these when a key exists, and
 *             otherwise they stay the person's to add.
 */

/* Words that appear in every resume ever written and mean nothing as a search. */
const STOP = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by cannot could did do does doing down during each few for from
further had has have having he her here hers herself him himself his how i if in into is it its
itself me more most my myself nor not of off on once only or other ought our ours ourselves out
over own same she should so some such than that the their theirs them themselves then there these
they this those through to too under until up very was we were what when where which while who whom
why with would you your yours yourself yourselves
ability able across achieve achieved achievement achievements across added additional adept advanced
also always among approach approaches area areas assist assisted based basic best better build built
career client clients collaborate collaborated committed company complete completed comprehensive
conduct conducted consistently contribute contributed core create created cross current currently
day days deliver delivered delivering demonstrated depth design designed detail detailed develop
developed development diverse drive driven due effective efficiently ensure ensured ensuring
established etc excellent execute experience experienced expertise extensive facilitate facilitated
first focus focused following full gained general good group groups growth hands help helped high
highly hours implement implemented improve improved include included including increase increased
individual individuals industry initiative initiatives inside join key knowledge large lead leading
led level levels like maintain maintained major manage managed management managing many meet met
month months multiple new number numerous offer offered ongoing operate operations organisation
organization organisational organizational overall part participate participated particular partner
partners people per perform performed period plan planned position positions possible practice
practices prepare prepared present presented previous primary prior process processes professional
program programme programs programmes progress project projects proven provide provided providing
quality range recent record regular related relevant report reported responsible result results
review reviewed role roles run running seek senior service services set several significant skill
skills small solution solutions specific staff standard standards start started strong structured
subject successful successfully support supported supporting sustained system systems take team
teams technical three throughout time times today tool tools total track trained training two type
types use used using various week weeks well wide within work worked working works year years`
  .split(/\s+/).filter(Boolean));

/* Seniority and shape words that should not be part of a searchable job title. */
const TITLE_NOISE = /^(senior|snr|sr|junior|jnr|jr|lead|leading|principal|chief|head|deputy|assistant|associate|staff|executive|global|regional|national|freelance|independent|contract|part[- ]time|full[- ]time|interim|trainee|intern|consultant)$/i;

const clean = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[^a-z0-9'&+/\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* ---------------------------------------------------------------- titles -- */

/**
 * "Lead Counselling Psychologist & Performance Coach" becomes
 * ["counselling psychologist", "performance coach"] — two real things to search
 * for, with the seniority stripped so a mid-level advert still matches.
 */
function titlesFrom(raw) {
  const out = [];
  // Split on the separators first: `clean` flattens them to spaces, which would
  // fuse "Data Analyst • Business Intelligence" into one nonsense title.
  for (const chunk of String(raw || '').split(/\s*(?:&|\/|,|•|\||\band\b)\s*/i)) {
    const part = clean(chunk);
    const words = part.split(' ').filter(Boolean);
    while (words.length && TITLE_NOISE.test(words[0])) words.shift();
    while (words.length && /^(i|ii|iii|iv|1|2|3)$/i.test(words[words.length - 1])) words.pop();
    const term = words.join(' ').trim();
    if (term.length < 3 || term.length > 44) continue;
    if (words.length > 4) continue;
    if (words.every((w) => STOP.has(w))) continue;
    out.push(term);
  }
  return out;
}

/* ----------------------------------------------------------------- terms -- */

/**
 * Counts one- to three-word phrases.
 *
 * A phrase is kept only if every word in it carries meaning. Allowing filler in
 * the middle is what produces "dashboards and building" and "data into
 * decisions" — grammatical fragments that look like phrases and search like
 * noise. Real domain terms rarely need a joining word.
 */
function phraseCounts(text, counts = new Map()) {
  for (const sentence of clean(text).split(/[.\n]/)) {
    const words = sentence.split(' ').filter(Boolean);
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        if (gram.some((w) => STOP.has(w) || TITLE_NOISE.test(w))) continue;
        if (gram.some((w) => w.length < 3 && !/^(ai|hr|ux|qa|it)$/.test(w))) continue;
        const term = gram.join(' ');
        if (term.length < 4 || term.length > 40) continue;
        if (/^\d/.test(term)) continue;
        counts.set(term, (counts.get(term) || 0) + 1);
      }
    }
  }
  return counts;
}

/** A phrase already covered by a longer, more specific one is not worth keeping. */
function dropSubsumed(terms) {
  const kept = [];
  for (const t of terms) {
    const inside = kept.some((k) => k.term !== t.term
      && (` ${k.term} `).includes(` ${t.term} `) && k.weight >= t.weight);
    if (!inside) kept.push(t);
  }
  return kept;
}

/* ------------------------------------------------------------------ main -- */

const MAX_QUERY = 12;
const MAX_BOOST = 40;

/**
 * Returns {query, boost, exclude}, each an array of {term, weight, bucket}.
 * Weights land on the same 1–10 scale the Keywords view already edits.
 */
function fromCv(cv = {}) {
  const seen = new Set();
  const query = [];
  const boost = [];

  const add = (list, term, weight, bucket) => {
    const t = String(term).trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    list.push({ term: t, weight: Math.max(1, Math.min(10, Math.round(weight))), bucket });
  };

  /* The titles she has actually held are the strongest thing to search for. */
  const titles = [];
  for (const [i, job] of (cv.experience || []).entries()) {
    for (const t of titlesFrom(job.title)) titles.push({ term: t, rank: i });
  }
  for (const t of titlesFrom(cv.headline)) titles.push({ term: t, rank: -1 });

  for (const { term, rank } of titles) {
    // The current role matters more than one from ten years ago.
    add(query, term, rank <= 0 ? 10 : Math.max(6, 9 - rank), 'title');
    if (query.length >= MAX_QUERY) break;
  }

  /* Named skills are exactly what a boost list is for. */
  for (const [group, items] of Object.entries(cv.competencies || {})) {
    const heavier = /special|modalit|expert|focus/i.test(group);
    for (const item of Array.isArray(items) ? items : []) {
      const term = clean(item);
      if (term.length < 3 || term.length > 40) continue;
      if (STOP.has(term)) continue;
      add(boost, term, heavier ? 7 : 5, 'skill');
    }
  }

  /* Then whatever the resume itself keeps coming back to. */
  // `pitch` is the summary rewritten in the first person, so counting both would
  // make every phrase in it look twice as repeated as it is.
  const counts = new Map();
  phraseCounts(cv.summary || cv.pitch || '', counts);
  for (const job of cv.experience || []) phraseCounts((job.bullets || []).join('\n'), counts);
  for (const line of cv.impact || []) phraseCounts(line, counts);
  for (const line of cv.differentiators || []) phraseCounts(line, counts);

  // "demand" adds nothing once "demand forecasting" is already on the list.
  const covered = [...seen].filter((t) => t.includes(' '));
  const isCovered = (term) => covered.some((c) => (` ${c} `).includes(` ${term} `));

  const repeated = [...counts.entries()]
    .filter(([term, n]) => n >= 2 && !seen.has(term) && !isCovered(term))
    .map(([term, n]) => ({ term, weight: Math.min(6, 2 + n), bucket: 'term', n }))
    .sort((a, b) => b.n - a.n || b.term.length - a.term.length);

  for (const t of dropSubsumed(repeated)) {
    if (boost.length >= MAX_BOOST) break;
    add(boost, t.term, t.weight, t.bucket);
  }

  /* Where she is, and how she wants to work, are worth a nudge. */
  const country = cv.contact?.location ? String(cv.contact.location).split(',').pop().trim() : '';
  if (country && country.length < 30) add(boost, clean(country), 6, 'geography');
  add(boost, 'remote', 6, 'delivery');

  return {
    query: query.slice(0, MAX_QUERY),
    boost: boost.slice(0, MAX_BOOST),
    exclude: [],
  };
}

module.exports = { fromCv, titlesFrom, phraseCounts, STOP };
