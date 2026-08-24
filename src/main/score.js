'use strict';
/**
 * Ranks a role against the keyword vocabulary she controls plus her stated
 * preferences. Deliberately simple and inspectable — the board shows exactly
 * which words earned each role its place.
 */
const POOLS = {
  ai_expert: ['ai trainer','ai tutor','model behavior','model behaviour','red team','red-team','rlhf',
    'human data','domain expert','subject matter expert','annotator','data annotation','ai safety',
    'alignment','llm','prompt engineer','evaluator','expert contributor','psychology expert',
    'behavioral scientist','behavioural scientist','trust and safety'],
  eap: ['eap','employee assistance','corporate wellness','workplace wellbeing','workplace mental health',
    'employee wellbeing','organizational psychology','organisational psychology'],
  clinical: ['therapist','counsellor','counselor','psychologist','clinical','psychotherapist',
    'teletherapy','telehealth','licensed'],
  education: ['school counsellor','school counselor','student wellness','student wellbeing',
    'academic counselling','academic counseling','career counsellor','career counselor','campus'],
  content: ['curriculum','content writer','instructional design','training manager','facilitator',
    'programme design','program design','coach','wellbeing content','psychoeducation'],
};

const isWord = (term) => !/[^a-z0-9 ]/.test(term) && !term.includes(' ');

function has(hay, needle) {
  if (!hay || !needle) return false;
  if (!isWord(needle)) return hay.includes(needle);
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u').test(hay);
}

function pickPool(title, body, company) {
  const hay = `${title} ${body.slice(0, 3000)} ${company}`;
  let best = 'general';
  let bestHits = 0;
  for (const [name, terms] of Object.entries(POOLS)) {
    let hits = 0;
    for (const t of terms) {
      if (title.includes(t)) hits += 3;
      else if (hay.includes(t)) hits += 1;
    }
    if (hits > bestHits) { bestHits = hits; best = name; }
  }
  return best;
}

/** @returns {{score:number, matched:string[], pool:string}} score -1 means "excluded". */
function rate(job, keywords, prefs) {
  const title = String(job.title || '').toLowerCase();
  const body = String(job.description_text || '').slice(0, 12000).toLowerCase();
  const company = String(job.company || '').toLowerCase();

  const matched = [];
  let score = 0;

  for (const kw of keywords) {
    if (!kw.active) continue;
    const term = String(kw.term || '').trim().toLowerCase();
    if (!term) continue;

    const inTitle = has(title, term);
    const inBody = has(body, term);

    if (kw.kind === 'exclude') {
      if (inTitle) return { score: -1, matched: [`excluded: ${kw.term}`], pool: 'excluded' };
      continue;
    }
    if (!inTitle && !inBody) continue;
    score += inTitle ? kw.weight * 3 : kw.weight;
    matched.push(kw.term);
  }

  if (score <= 0) return { score: 0, matched: [], pool: 'general' };

  score += Number(prefs.work_mode_preference?.[job.work_mode] || 0);
  if (job.country && (prefs.preferred_countries || []).includes(job.country)) score += 8;

  if (job.posted_at) {
    const days = (Date.now() - new Date(`${job.posted_at.replace(' ', 'T')}Z`).getTime()) / 86400000;
    if (days <= 3) score += 10;
    else if (days <= 7) score += 6;
    else if (days <= 14) score += 2;
    else if (days > 45) score -= 10;
  }

  // A published application address is worth a lot: it is the only route the
  // app can carry all the way to "sent".
  if (job.apply_email) score += 6;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    matched: [...new Set(matched)],
    pool: pickPool(title, body, company),
  };
}

module.exports = { rate, POOLS };
