'use strict';
/**
 * Returned as a string and evaluated inside the application page.
 * It fills fields; it never clicks submit. A mis-parsed field that gets sent
 * cannot be recalled, so the last click stays human.
 */

/**
 * Shared by every script in this file: works out what a field is asking for
 * from its name, id, placeholder, aria attributes, associated <label>, and
 * the surrounding wrapper's text. Interpolated as source rather than called,
 * since these strings are evaluated inside the page, not in this process.
 */
const LABEL_FOR_SRC = `
  const labelFor = (el) => {
    const bits = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid')];
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\\s+/)) {
        const n = document.getElementById(id);
        if (n) bits.push(n.innerText);
      }
    }
    if (el.labels) for (const l of el.labels) bits.push(l.innerText);
    const wrap = el.closest('label, .field, [class*="field"], [class*="question"], [class*="form-group"]');
    if (wrap) bits.push((wrap.innerText || '').slice(0, 200));
    return bits.filter(Boolean).join(' ').toLowerCase();
  };
`;

function buildScript(profile) {
  const source = `(() => {
  const P = ${JSON.stringify(profile)};

  const RULES = [
    { keys: ['first name','first_name','firstname','given name','forename'], v: P.firstName },
    { keys: ['last name','last_name','lastname','surname','family name'],    v: P.lastName },
    { keys: ['full name','your name','candidate name'],                      v: P.fullName },
    { keys: ['name'],                                                        v: P.fullName, weak: true },
    { keys: ['email','e-mail'],                                              v: P.email },
    { keys: ['phone','mobile','telephone','contact number'],                 v: P.phone },
    { keys: ['linkedin'],                                                    v: P.linkedin },
    { keys: ['github','portfolio','website','personal site','blog'],         v: P.website },
    { keys: ['city','town'],                                                 v: P.city },
    { keys: ['state','province','region'],                                   v: P.state },
    { keys: ['country'],                                                     v: P.country },
    { keys: ['location','where are you based','current location'],           v: P.location },
    // 'address' is its own weak rule, not a location key. "Email address" is
    // the commonest spelling of an email field on a job form, and 'address'
    // (7) beat 'email' (5) on length alone — so her city went into the
    // employer's email box on most forms she would ever see. Weak means it
    // still fills "Home address" or "Street address", where nothing else matches.
    { keys: ['address'],                                                     v: P.location, weak: true },
    { keys: ['notice period','availability','when can you start'],           v: P.noticePeriod },
    { keys: ['years of experience','total experience','years experience'],   v: P.yearsExperience },
    { keys: ['current salary','current ctc'],                                v: P.currentSalary },
    { keys: ['expected salary','salary expectation','expected ctc','desired salary'], v: P.expectedSalary },
    { keys: ['pronoun'],                                                     v: '' },
    { keys: ['cover letter','why do you want','tell us about yourself','motivation','why are you interested','additional information'],
      v: P.coverLetter, long: true },
  ];

  ${LABEL_FOR_SRC}

  const setValue = (el, value) => {
    if (!value || String(el.value || '').trim()) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));                       // survives React's value tracking
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    el.style.outline = '2px solid #3f5d4b';
    el.style.outlineOffset = '1px';
    el.setAttribute('data-jobdesk-filled', '1');
    return true;
  };

  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const inputs = [...document.querySelectorAll(
    'input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type]), textarea'
  )].filter(visible);

  // Questions that are the candidate's alone to answer, so the rule table never
  // writes into one. The same principle as ai.js#PROTECTED_QUESTION guarding the
  // AI pass — kept separate and narrower on purpose, because this pass fills
  // salary and notice period from what she saved herself, which the AI pass
  // must not do. Demographic fields are the ones where a confident wrong answer
  // does real harm, and 'Ethnicity' contains 'city', which is not a hypothetical:
  // it put "Pune" in an ethnicity box.
  const NEVER_FILL = /disab|gender|\\bsex\\b|ethnic|\\brace\\b|racial|veteran|nationality|religio|orientation|marital|pregnan|criminal|conviction/i;

  // A key has to match whole words, not any substring. Plain includes() made
  // 'city' match "Ethni-city", 'state' match "Personal state-ment" and 'town'
  // match "Home-town" — each quietly writing the wrong value into a real field
  // on a real form. buildFileInputMatchScript() below already matched on \\b
  // boundaries for exactly this reason; this is the same rule applied here.
  const wordRe = (k) => new RegExp(\`\\\\b\${k.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')}\\\\b\`, 'i');

  // Pick the rule whose matching phrase is longest, not whichever comes first:
  // a label reading "Current location (City, State, Country)" must win 'location'
  // over 'city', even though 'city' is also present in it.
  const bestRule = (hay, isLong) => {
    let best = null;
    let bestLen = -Infinity;
    for (const rule of RULES) {
      if (!!rule.long !== isLong) continue;
      for (const k of rule.keys) {
        if (!wordRe(k).test(hay)) continue;
        const len = k.length - (rule.weak ? 100 : 0);   // weak rules only win by default
        if (len > bestLen) { bestLen = len; best = { rule, key: k }; }
      }
    }
    return best;
  };

  const filled = [];
  const skipped = [];
  for (const el of inputs) {
    const hay = labelFor(el);
    if (NEVER_FILL.test(hay)) { skipped.push(hay.slice(0, 40)); continue; }
    const match = bestRule(hay, el instanceof HTMLTextAreaElement);
    if (match && setValue(el, match.rule.v)) filled.push(match.key);
  }

  const fileFields = [...document.querySelectorAll('input[type=file]')].filter(visible).length;
  const selects = [...document.querySelectorAll('select')].filter(visible).length;

  return { filled, skipped, fileFields, selects, total: inputs.length };
})()`;
  return source;
}

/**
 * Returned as a string and evaluated after buildScript() has done what plain
 * keyword matching can. Reports the fields it could not answer — the dropdowns
 * and the free-text screening questions ("why do you want to work here",
 * "do you need visa sponsorship") that a fixed rule table has no way to read.
 *
 * Each field is stamped with `data-jobdesk-q="<index>"` as it is collected, so
 * the answers can be written back to exactly the same elements afterwards even
 * if the page re-orders or re-renders in between. Radio and checkbox groups
 * are deliberately not collected: they are frequently the legally-loaded
 * questions (disability, veteran status, gender), and a wrong guess there is
 * worse than an unanswered one.
 */
function buildCollectQuestionsScript() {
  return `(() => {
  ${LABEL_FOR_SRC}
  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const out = [];
  let index = 0;

  const textish = [...document.querySelectorAll(
    'input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type]), textarea'
  )].filter(visible).filter((el) => !String(el.value || '').trim());
  for (const el of textish) {
    el.setAttribute('data-jobdesk-q', String(index));
    out.push({
      index, kind: el instanceof HTMLTextAreaElement ? 'long' : 'short',
      label: labelFor(el).slice(0, 300), options: [],
    });
    index++;
  }

  const selects = [...document.querySelectorAll('select')].filter(visible);
  for (const el of selects) {
    // An untouched dropdown usually sits on a placeholder ("Select...", "--")
    // rather than on an empty value, so selectedIndex is the honest test.
    const chosen = el.options[el.selectedIndex];
    const alreadyAnswered = el.selectedIndex > 0 && chosen && String(chosen.value || '').trim();
    if (alreadyAnswered) continue;
    el.setAttribute('data-jobdesk-q', String(index));
    out.push({
      index, kind: 'select', label: labelFor(el).slice(0, 300),
      options: [...el.options].map((o) => (o.text || o.value || '').trim()).filter(Boolean).slice(0, 40),
    });
    index++;
  }

  return out;
})()`;
}

/**
 * Writes the model's answers back. Values are matched against the element's
 * real options for a dropdown — an answer that is not one of the choices the
 * page actually offers is dropped rather than forced in, which is the same
 * principle as ai.js#enforceTruth: the model proposes, the code decides what
 * is allowed through.
 */
function buildApplyAnswersScript(answers) {
  return `(() => {
  const ANSWERS = ${JSON.stringify(answers)};
  let filled = 0;

  const fire = (el) => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    el.style.outline = '2px solid #3f5d4b';
    el.style.outlineOffset = '1px';
    el.setAttribute('data-jobdesk-filled', '1');
  };

  for (const a of ANSWERS) {
    const el = document.querySelector('[data-jobdesk-q="' + a.index + '"]');
    if (!el || !String(a.value || '').trim()) continue;
    if (String(el.value || '').trim()) continue;          // someone typed in it meanwhile

    if (el instanceof HTMLSelectElement) {
      const want = String(a.value).trim().toLowerCase();
      const match = [...el.options].find((o) => (o.text || '').trim().toLowerCase() === want)
        || [...el.options].find((o) => (o.value || '').trim().toLowerCase() === want);
      if (!match) continue;                               // not on offer — leave it alone
      el.value = match.value;
      fire(el);
      filled++;
      continue;
    }

    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(a.value));
    fire(el);
    filled++;
  }
  return { filled };
})()`;
}

/**
 * Returned as a string and evaluated ahead of attaching the CV. Reports, for
 * every file-upload field on the page in document order, whether its label
 * reads as the resume/CV field and whether it reads as clearly something
 * else (a cover letter, a portfolio, a photo). apply-browser.js#attachResume
 * used to put the CV into every file input on a page indiscriminately —
 * harmless on the common one-upload form, wrong on any form with a separate
 * cover-letter or portfolio field, which then received the CV file too.
 */
function buildFileInputMatchScript() {
  return `(() => {
  ${LABEL_FOR_SRC}
  const RESUME_RE = /\\bresume\\b|\\bcv\\b|curriculum vitae/i;
  const EXCLUDE_RE = /cover\\s*letter|portfolio|writing sample|transcript|photo|headshot|video/i;
  return [...document.querySelectorAll('input[type=file]')].map((el) => {
    const hay = labelFor(el);
    return { resume: RESUME_RE.test(hay), exclude: EXCLUDE_RE.test(hay) };
  });
})()`;
}

/** Marks the fields the app touched, so she can see them at a glance. */
const HIGHLIGHT_CSS = `
  [data-jobdesk-filled] { background-color: rgba(63,93,75,.06) !important; }
`;

module.exports = { buildScript, buildCollectQuestionsScript, buildApplyAnswersScript,
  buildFileInputMatchScript, HIGHLIGHT_CSS };
