/* Runs the parts that need neither Electron nor the network: node tests/smoke.js */
'use strict';
process.removeAllListeners('warning');

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
const group = (name) => console.log(`\n${name}`);
function ok(what, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${extra ? ` — ${extra}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobdesk-test-'));
const db = require('../src/main/db');
db.init(dir);

const normalize = require('../src/main/normalize');
const score = require('../src/main/score');
const claude = require('../src/main/claude');
const settings = require('../src/main/settings');
const seed = require('../src/main/seed');
const { buildScript } = require('../src/main/autofill-script');

/* ------------------------------------------------------------ normalize */
group('Reading messy feed data');
ok('remote from the title', normalize.workMode('Therapist (Remote)', '', '') === 'remote');
ok('hybrid beats remote', normalize.workMode('Counsellor', 'London', 'Hybrid, 3 days in office') === 'hybrid');
ok('on-site from the description', normalize.workMode('Counsellor', 'Pune', 'This is an on-site role') === 'onsite');
ok('the feed flag is honoured', normalize.workMode('C', 'Berlin', 'no hints', true) === 'remote');

let p = normalize.place('Bengaluru, Karnataka, India');
ok('full Indian address', p.city === 'Bengaluru' && p.region === 'Karnataka' && p.country === 'India');
ok('bare Indian city resolves to India', normalize.place('Vadodara').country === 'India');
ok('"Remote" is a place', normalize.place('Remote').country === 'Remote');
ok('UK address', normalize.place('London, United Kingdom').country === 'United Kingdom');

ok('html becomes readable text', normalize.text('<ul><li>One</li><li>Two</li></ul>') === '• One\n• Two');
ok('entities decode', normalize.text('<p>Caf&eacute; &amp; co</p>') === 'Café & co');
ok('scripts are stripped', !normalize.safeHtml('<p>hi</p><script>bad()</script>').includes('script'));
ok('inline handlers are stripped', !normalize.safeHtml('<a href="#" onclick="x()">y</a>').includes('onclick'));
ok('javascript: urls are stripped', !normalize.safeHtml('<a href="javascript:x()">y</a>').includes('javascript:'));
ok('safe links survive', normalize.safeHtml('<a href="https://x.test">y</a>').includes('https://x.test'));
ok('application address is found', normalize.findEmail('write to careers@acme.com') === 'careers@acme.com');
ok('noreply addresses are ignored', normalize.findEmail('noreply@acme.com') === '');
ok('the same role fingerprints the same',
  normalize.fingerprint('Acme', 'T', 'x1', '') === normalize.fingerprint('ACME', 'T', 'x1', ''));
ok('different roles fingerprint differently',
  normalize.fingerprint('Acme', 'T', 'x1', '') !== normalize.fingerprint('Acme', 'T', 'x2', ''));
ok('a malformed url does not throw', typeof normalize.fingerprint('A', 'B', '', 'not a url') === 'string');

/* ---------------------------------------------------------------- score */
group('Ranking roles');
const kws = [
  { term: 'counselling psychologist', kind: 'query', weight: 10, active: 1 },
  { term: 'CBT', kind: 'boost', weight: 6, active: 1 },
  { term: 'psychiatrist', kind: 'exclude', weight: 10, active: 1 },
];
const prefs = { work_mode_preference: { remote: 12, hybrid: 5, onsite: 0 }, preferred_countries: ['India'] };
const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

const strong = score.rate({ title: 'Counselling Psychologist', description_text: 'CBT based practice',
  work_mode: 'remote', country: 'India', posted_at: nowStr, apply_email: 'a@b.com' }, kws, prefs);
ok('a strong match scores high', strong.score >= 70, String(strong.score));
ok('the matching words are reported', strong.matched.includes('CBT'));
ok('the role is grouped as clinical', strong.pool === 'clinical', strong.pool);

ok('a blocked word kills the role',
  score.rate({ title: 'Consultant Psychiatrist', description_text: 'counselling psychologist' }, kws, prefs).score === -1);
ok('an irrelevant role scores nothing',
  score.rate({ title: 'Warehouse Operative', description_text: 'boxes' }, kws, prefs).score === 0);
ok('word boundaries are respected',
  score.rate({ title: 'CBTX Engineer', description_text: '' }, kws, prefs).score === 0);

const stale = score.rate({ title: 'Counselling Psychologist', description_text: 'CBT', work_mode: 'onsite',
  country: 'United States', posted_at: '2020-01-01 00:00:00' }, kws, prefs);
ok('remote and recent beats on-site and stale', strong.score > stale.score, `${strong.score} vs ${stale.score}`);
ok('an inactive word is ignored',
  score.rate({ title: 'Counselling Psychologist' },
    [{ term: 'counselling psychologist', kind: 'query', weight: 10, active: 0 }], prefs).score === 0);

/* ------------------------------------------------- anti-fabrication ---- */
group('Guarding against invented experience');
// A fictional CV fixture, shaped like a real one, committed to the repo — the
// real master CV is gitignored (see CLAUDE.md) and must never be required by
// a test, or CI would fail on every checkout.
const master = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.json'), 'utf8'));
const tampered = {
  name: 'Someone Else',
  contact: { email: 'attacker@example.com' },
  education: [{ degree: 'PhD Clinical Psychology', school: 'Invented University' }],
  experience: [
    { id: 'lighthouse', title: 'Head of Clinical', org: 'Lighthouse Global Inc', start: 'Jan 2018', end: 'Present', bullets: ['x'] },
    { id: 'ghost', title: 'Director', org: 'Fictional Health Ltd', start: '2010', end: '2014', bullets: ['y'] },
  ],
};
const dropped = claude.enforceTruth(master, tampered);
ok('an invented employer is deleted', tampered.experience.length === 1 && dropped.length === 1);
ok('real dates are restored',
  tampered.experience[0].start === 'Dec 2019' && tampered.experience[0].end === 'Mar 2023');
ok('the employer name is restored', tampered.experience[0].org === 'Lighthouse Wellness Group');
ok('a changed name is restored', tampered.name === 'Alex Rivera');
ok('changed contact details are restored', tampered.contact.email === 'alex.rivera@example.test');
ok('an invented degree is deleted', tampered.education[0].school === 'Rivertown State University');
ok('json survives a code fence', claude.extractJson('```json\n{"a":1}\n```')?.a === 1);
ok('json survives surrounding prose', claude.extractJson('here: {"a":2} ok')?.a === 2);
ok('garbage returns null', claude.extractJson('not json at all') === null);

/* ----------------------------------------------- working without a key */
group('Working with no API key');
seed.seedIfEmpty();
const templates = require('../src/main/templates');
const cvForTemplate = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.json'), 'utf8'));
const drafted = templates.draftApplication(cvForTemplate, {
  title: 'Senior Counselling Psychologist', company: '1to1help', score: 92,
  description_text: 'x'.repeat(600),
});
ok('an application can be drafted with no key', !!drafted.email_body && !!drafted.cover_letter);
ok('it is marked as a template, not as tailoring', drafted.mode === 'template');
ok('it sends the real master CV', drafted.resume.name === cvForTemplate.name);
ok('the subject names the role', drafted.email_subject.includes('Senior Counselling Psychologist'));
ok('it writes in the first person', drafted.email_body.includes('I am a counselling psychologist'));
ok('it does not pretend to have read the description',
  drafted.match_notes.some((n) => /template/i.test(n)));
ok('it leaves her one sentence to write', templates.hasPlaceholder(drafted.email_body));
ok('the placeholder is obvious', drafted.email_body.includes('['));
ok('a filled-in email passes the check',
  !templates.hasPlaceholder(drafted.email_body.replace(templates.PLACEHOLDER, 'Real sentence.')));
const fu = templates.draftFollowup(cvForTemplate, { title: 'X', company: 'Y' }, 9);
ok('a follow-up can be drafted with no key', fu.body.includes('9 days ago') && !!fu.subject);
ok('the follow-up has no placeholder to forget', !templates.hasPlaceholder(fu.body));
settings.set('template_email', 'Hi {{company}}, about {{title}}.');
ok('her own template is used', templates.draftApplication(cvForTemplate, { title: 'T', company: 'C' })
  .email_body === 'Hi C, about T.');
for (const [k, v] of Object.entries(templates.defaults())) settings.set(k, v);
ok('templates reset cleanly', templates.current().template_email.includes('Dear Hiring Team'));
const bare = templates.draftApplication({ name: 'A B', headline: 'Counsellor',
  competencies: { Specialisations: ['Anxiety', 'IVF Emotional Support'] } }, { title: 'T', company: 'C' });
ok('it copes with a CV that has no pitch line', bare.email_body.includes('Anxiety'));
ok('it does not mangle acronyms', bare.email_body.includes('IVF'));

/* -------------------------------------------------------------- budget */
group('The spending guard');
seed.seedIfEmpty();
const budget = require('../src/main/budget');
settings.set('claude_model', 'claude-sonnet-5');
settings.set('budget_usd_monthly', 10);
settings.set('spend_by_month', {});
ok('the default model is current', budget.model() === 'claude-sonnet-5', budget.model());
ok('an unknown model falls back safely',
  (settings.set('claude_model', 'nonsense-model'), budget.model()) === 'claude-sonnet-5');
settings.set('claude_model', 'claude-sonnet-5');
ok('a typical application costs a few cents',
  budget.typicalCost() > 0.02 && budget.typicalCost() < 0.12, budget.typicalCost().toFixed(4));
ok('haiku costs about half of sonnet',
  budget.typicalCost('claude-haiku-4-5') < budget.typicalCost('claude-sonnet-5') * 0.55);

let allowed = 0;
let stopMessage = '';
for (let i = 0; i < 400; i++) {
  try { budget.checkBeforeCall(); } catch (e) { stopMessage = e.message; break; }
  budget.record({ input_tokens: 8000, output_tokens: 4000 });
  allowed++;
}
ok('a $10 limit buys well over a hundred applications', allowed > 120, String(allowed));
ok('the limit actually stops it', stopMessage.includes('$10.00'), stopMessage.slice(0, 60));
ok('it never overspends the limit', budget.spentThisMonth() <= 10, budget.spentThisMonth().toFixed(2));
settings.set('budget_usd_monthly', 0);
let uncapped = true;
try { budget.checkBeforeCall(); } catch { uncapped = false; }
ok('zero means no limit', uncapped);
settings.set('budget_usd_monthly', 10);
settings.set('spend_by_month', {});

/* ------------------------------------------------------------- secrets */
group('Keeping credentials out of the open');
seed.seedIfEmpty();
settings.setSecret('anthropic_api_key', 'sk-ant-supersecret');
settings.setSecret('smtp_password', 'hunter2');
ok('a secret round-trips', settings.getSecret('anthropic_api_key') === 'sk-ant-supersecret');
const dump = JSON.stringify({ all: settings.all(), redacted: settings.redacted() });
ok('secrets never appear in settings', !dump.includes('supersecret') && !dump.includes('hunter2'));
ok('the app can still tell a key is set', settings.redacted().has_anthropic_key === true);
settings.setSecret('anthropic_api_key', '');
ok('clearing a secret works', settings.getSecret('anthropic_api_key') === null);

/* ----------------------------------------------------------- database */
group('The local database');
ok('the vocabulary is seeded', db.val('SELECT COUNT(*) AS n FROM keywords', [], 0) > 50);
ok('sources are seeded', db.val('SELECT COUNT(*) AS n FROM sources', [], 0) >= 8);
db.insert('jobs', { fingerprint: 'fp1', title: 'A', company: 'B', matched_terms: '[]' });
let threw = false;
try { db.insert('jobs', { fingerprint: 'fp1', title: 'A2', company: 'B', matched_terms: '[]' }); }
catch { threw = true; }
ok('the same role cannot be stored twice', threw);
const appId = db.insert('applications', { job_id: 1, subject: 'S', body_text: 'B' });
db.insert('followups', { application_id: appId, seq: 1, due_on: '2026-01-01' });
db.run('DELETE FROM jobs WHERE id = 1');
ok('deleting a role cleans up after itself',
  db.val('SELECT COUNT(*) AS n FROM applications', [], 0) === 0
  && db.val('SELECT COUNT(*) AS n FROM followups', [], 0) === 0);
ok('a backup can be taken', fs.existsSync(db.backup()));

/* -------------------------------------------------- what gets shipped */
group('What ends up inside the installer');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
ok('the real CV is excluded from the build',
  (pkg.build.files || []).includes('!resources/master-resume.json'));
ok('a blank example ships instead',
  fs.existsSync(path.join(__dirname, '..', 'resources', 'master-resume.example.json')));
const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'master-resume.example.json'), 'utf8'));
ok('the example is marked as a placeholder', example.placeholder === true);
ok('the example carries no real contact details',
  !JSON.stringify(example).includes('srishtisharma') && !JSON.stringify(example).includes('900-485'));
ok('a publish target is configured', !!pkg.build.publish?.[0]?.provider);
ok('the project has a licence', fs.existsSync(path.join(__dirname, '..', 'LICENSE')));
ok('the real CV is kept out of version control',
  fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')
    .includes('resources/master-resume.json'));
ok('the app is told where to look for updates',
  ['off', 'github-public', 'generic'].includes(pkg.updates?.channel));

/* --------------------------------------------- a brand new installation */
group('A brand new installation');
const masterMod = require('../src/main/master');
const exampleSrc = path.join(__dirname, '..', 'resources', 'master-resume.example.json');
const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobdesk-fresh-'));
fs.copyFileSync(exampleSrc, path.join(freshDir, 'master-resume.json'));
{
  // Point the CV loader at a fresh data folder by re-initialising the database.
  const realPaths = db.paths;
  const freshDb = require('../src/main/db');
  freshDb.init(freshDir);
  ok('a blank CV is recognised as a placeholder', masterMod.isPlaceholder() === true);
  const saved = masterMod.saveMaster({ name: 'Real Person', contact: { email: 'x@y.test' } });
  ok('saving a real CV clears the placeholder flag', saved.placeholder === undefined);
  ok('and the app then considers itself ready', masterMod.isPlaceholder() === false);
  ok('a corrupt CV explains itself', (() => {
    fs.writeFileSync(path.join(freshDir, 'master-resume.json'), '{ not json');
    try { masterMod.master(); return false; }
    catch (e) { return /could not be read|invalid JSON/i.test(e.message); }
  })());
  freshDb.init(realPaths.root);          // put the suite's own database back
}

/* ---------------------------------------------------------- autofill */
group('The form filler');
const src = buildScript({ firstName: 'Srishti', city: 'Vadodara' });
ok('the script is built', src.includes('Srishti') && src.length > 1000);
ok('it never presses submit', !/\.submit\(|click\(\)/.test(src));
ok('it embeds the details safely', src.includes('"firstName":"Srishti"'));

/* -------------------------------------------------------- documents */
group('Making the CV files');
(async () => {
  const pdfPath = path.join(dir, 'cv.pdf');
  const docxPath = path.join(dir, 'cv.docx');
  await require('../src/main/resume-pdf').render(master, pdfPath);
  await require('../src/main/resume-docx').render(master, docxPath);
  ok('a PDF is produced', fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 6000);
  ok('it is a real PDF', fs.readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-');
  ok('a Word file is produced', fs.existsSync(docxPath) && fs.statSync(docxPath).size > 5000);
  ok('it is a real docx', fs.readFileSync(docxPath).subarray(0, 2).toString() === 'PK');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
