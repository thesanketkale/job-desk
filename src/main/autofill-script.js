'use strict';
/**
 * Returned as a string and evaluated inside the application page.
 * It fills fields; it never clicks submit. A mis-parsed field that gets sent
 * cannot be recalled, so the last click stays human.
 */
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
    { keys: ['location','where are you based','current location','address'], v: P.location },
    { keys: ['notice period','availability','when can you start'],           v: P.noticePeriod },
    { keys: ['years of experience','total experience','years experience'],   v: P.yearsExperience },
    { keys: ['current salary','current ctc'],                                v: P.currentSalary },
    { keys: ['expected salary','salary expectation','expected ctc','desired salary'], v: P.expectedSalary },
    { keys: ['pronoun'],                                                     v: '' },
    { keys: ['cover letter','why do you want','tell us about yourself','motivation','why are you interested','additional information'],
      v: P.coverLetter, long: true },
  ];

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

  // Pick the rule whose matching phrase is longest, not whichever comes first:
  // a label reading "Current location (City, State, Country)" must win 'location'
  // over 'city', even though 'city' is also present in it.
  const bestRule = (hay, isLong) => {
    let best = null;
    let bestLen = -Infinity;
    for (const rule of RULES) {
      if (!!rule.long !== isLong) continue;
      for (const k of rule.keys) {
        if (!hay.includes(k)) continue;
        const len = k.length - (rule.weak ? 100 : 0);   // weak rules only win by default
        if (len > bestLen) { bestLen = len; best = { rule, key: k }; }
      }
    }
    return best;
  };

  const filled = [];
  for (const el of inputs) {
    const match = bestRule(labelFor(el), el instanceof HTMLTextAreaElement);
    if (match && setValue(el, match.rule.v)) filled.push(match.key);
  }

  const fileFields = [...document.querySelectorAll('input[type=file]')].filter(visible).length;
  const selects = [...document.querySelectorAll('select')].filter(visible).length;

  return { filled, fileFields, selects, total: inputs.length };
})()`;
  return source;
}

/** Marks the fields the app touched, so she can see them at a glance. */
const HIGHLIGHT_CSS = `
  [data-jobdesk-filled] { background-color: rgba(63,93,75,.06) !important; }
`;

module.exports = { buildScript, HIGHLIGHT_CSS };
