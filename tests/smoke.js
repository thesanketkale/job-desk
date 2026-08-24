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
ok('no vocabulary is invented for a new user',
  db.val('SELECT COUNT(*) AS n FROM keywords', [], 0) === 0);
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

/* ------------------------------------------------------ reading a resume */
group('Reading a resume');
const resumeParse = require('../src/main/resume-parse');
const resumeKeywords = require('../src/main/resume-keywords');
const resumeRead = require('../src/main/resume-read');

const SAMPLE = `SARAH CHEN
Senior Data Analyst  |  Business Intelligence

sarah.chen@example.com | +44 7700 900123
London, United Kingdom
linkedin.com/in/sarahchen-data | www.sarahchen.dev

PROFESSIONAL SUMMARY
An experienced data analyst with over seven years turning operational data into decisions
leadership uses. Specialises in retail demand forecasting and executive dashboards.

WORK EXPERIENCE

Senior Data Analyst, Northwind Retail Group
Mar 2021 - Present
• Built the demand forecasting model now used across 240 stores, cutting stockouts by 18%.
• Own the executive dashboard suite in Power BI, used daily by the leadership team.

Data Analyst | Brightpath Consulting
Jun 2018 – Feb 2021
• Delivered customer segmentation analysis for twelve retail and logistics clients.

EDUCATION
MSc Data Science, University of Edinburgh, 2015 - 2016

SKILLS
Languages: Python, SQL, R
Specialisations: Demand Forecasting, Customer Segmentation`;

const read = resumeParse.parseResume(SAMPLE);
const rcv = read.cv;

ok('the name is found', rcv.name === 'Sarah Chen', rcv.name);
ok('a shouty name is not left shouting', rcv.name !== rcv.name.toUpperCase());
ok('the job title under the name is the headline',
  /Senior Data Analyst/.test(rcv.headline) && !/SARAH/i.test(rcv.headline), rcv.headline);
ok('the email is found', rcv.contact.email === 'sarah.chen@example.com', rcv.contact.email);
ok('the phone number is found', rcv.contact.phone.replace(/\D/g, '') === '447700900123', rcv.contact.phone);
ok('a year is not mistaken for a phone number', !/^20\d\d$/.test(rcv.contact.phone));
ok('linkedin is found', rcv.contact.linkedin.includes('linkedin.com/in/sarahchen'));
ok('the personal site is found, not linkedin again', rcv.contact.website.includes('sarahchen.dev'));
ok('the location is found', rcv.contact.location === 'London, United Kingdom', rcv.contact.location);

ok('every role is found', rcv.experience.length === 2, String(rcv.experience.length));
ok('the title and employer are split',
  rcv.experience[0].title === 'Senior Data Analyst' && rcv.experience[0].org === 'Northwind Retail Group',
  `${rcv.experience[0].title} / ${rcv.experience[0].org}`);
ok('an open-ended role reads as Present', rcv.experience[0].end === 'Present', rcv.experience[0].end);
ok('dates are kept as written', rcv.experience[0].start === 'Mar 2021', rcv.experience[0].start);
ok('bullets belong to their own role', rcv.experience[0].bullets.length === 2,
  String(rcv.experience[0].bullets.length));
ok('the next role does not bleed into the last bullet',
  !rcv.experience[0].bullets.join(' ').includes('Brightpath'));
ok('an en-dash date range is read too', rcv.experience[1].end === 'Feb 2021', rcv.experience[1].end);

ok('education is found', rcv.education.length === 1 && rcv.education[0].degree === 'MSc Data Science',
  JSON.stringify(rcv.education[0]));
ok('the institution is split out', rcv.education[0].school === 'University of Edinburgh');

ok('grouped skills keep their groups', !!rcv.competencies.Languages && !!rcv.competencies.Specialisations,
  Object.keys(rcv.competencies).join(','));
ok('a one-letter skill survives', rcv.competencies.Languages.includes('R'),
  JSON.stringify(rcv.competencies.Languages));
ok('a labelled list is not mistaken for a section heading',
  rcv.competencies.Languages.includes('Python'));

ok('the summary is kept in the third person', /^An experienced/.test(rcv.summary), rcv.summary.slice(0, 30));
ok('the pitch is turned into the first person', /^I am an experienced/.test(rcv.pitch), rcv.pitch.slice(0, 30));
ok('what could not be read is reported honestly',
  read.confidence.name === 'high' && read.confidence.email === 'high');

/* --------------------------------------------------- the profile facts */
group('The facts kept for quick access');
const facts = resumeParse.profileFrom(rcv);
ok('the name is stored', facts.profile_name === 'Sarah Chen');
ok('the email is stored', facts.profile_email === 'sarah.chen@example.com');
ok('the phone number is stored', facts.profile_phone.includes('7700'));
ok('the city is split out of the location', facts.profile_city === 'London', facts.profile_city);
ok('the country is split out too', facts.profile_country === 'United Kingdom', facts.profile_country);
ok('years of experience are counted from the earliest role',
  Number(facts.profile_years) >= 8, facts.profile_years);
ok('nothing personal is invented when the CV is empty',
  resumeParse.profileFrom({}).profile_name === '');

/* ------------------------------------------- keywords out of the resume */
group('Working out the search words');
const gen = resumeKeywords.fromCv(rcv);
const qterms = gen.query.map((k) => k.term);
const bterms = gen.boost.map((k) => k.term);

ok('job titles become search words', qterms.includes('data analyst'), qterms.join(', '));
ok('a separated headline is split, not fused',
  qterms.includes('business intelligence') && !qterms.some((t) => t.includes('analyst business')),
  qterms.join(', '));
ok('seniority is stripped so mid-level adverts still match',
  !qterms.some((t) => /^(senior|junior|lead)\b/.test(t)), qterms.join(', '));
ok('the name never becomes a search word',
  !qterms.includes('sarah chen') && !bterms.includes('sarah chen'));
ok('the query list is kept tight', gen.query.length <= 12, String(gen.query.length));

ok('named skills become boosts', bterms.includes('python') && bterms.includes('sql'),
  bterms.join(', '));
ok('specialisations are weighted above ordinary skills',
  gen.boost.find((k) => k.term === 'demand forecasting').weight
  > gen.boost.find((k) => k.term === 'python').weight);
ok('where she lives is a boost', bterms.includes('united kingdom'));
ok('filler phrases are left out',
  !bterms.some((t) => / (and|the|into|with|of) /.test(t)), bterms.join(', '));
ok('a word already inside a longer term is not repeated',
  !bterms.includes('demand') && !bterms.includes('forecasting'), bterms.join(', '));
ok('nothing is excluded without being asked for', gen.exclude.length === 0);
ok('an empty CV produces no keywords rather than throwing',
  resumeKeywords.fromCv({}).query.length === 0);

/* ------------------------------------ replacing and refreshing the list */
group('Refreshing the words when the resume changes');
const profileMod = require('../src/main/profile');

db.run('DELETE FROM keywords');
db.insert('keywords', { term: 'my own word', kind: 'boost', weight: 9, bucket: 'custom', source: 'user' });
db.insert('keywords', { term: 'data analyst', kind: 'query', weight: 3, bucket: 'custom', source: 'user' });

const first = profileMod.rebuild(rcv);
ok('the resume fills the list', first.added > 5, String(first.added));
ok('a word she added by hand is kept',
  !!db.get("SELECT 1 AS x FROM keywords WHERE term = 'my own word'"));
ok('her weight wins over the resume\'s',
  db.get("SELECT weight FROM keywords WHERE term = 'data analyst' AND kind = 'query'").weight === 3);
ok('her rows are counted back to her', first.keptYours === 2, String(first.keptYours));

const generatedNow = db.val("SELECT COUNT(*) AS n FROM keywords WHERE source = 'resume'", [], 0);
const second = profileMod.rebuild({
  name: 'Sarah Chen',
  headline: 'Product Manager',
  contact: { location: 'Berlin, Germany' },
  experience: [{ title: 'Product Manager', org: 'Acme', start: 'Jan 2022', end: 'Present', bullets: [] }],
  competencies: { Skills: ['Roadmapping'] },
});
ok('a new resume clears what the old one produced', second.removed === Number(generatedNow),
  `${second.removed} vs ${generatedNow}`);
ok('and puts the new career in its place',
  !!db.get("SELECT 1 AS x FROM keywords WHERE term = 'product manager'"));
ok('the old career is gone',
  !db.get("SELECT 1 AS x FROM keywords WHERE term = 'business intelligence'"));
ok('her own words survive a second rebuild',
  !!db.get("SELECT 1 AS x FROM keywords WHERE term = 'my own word'"));
ok('touching a keyword makes it hers', (() => {
  const row = db.get("SELECT id FROM keywords WHERE source = 'resume' LIMIT 1");
  profileMod.claimForUser(row.id);
  return db.get('SELECT source FROM keywords WHERE id = ?', [row.id]).source === 'user';
})());

/* ----------------------------------------------- reading the file itself */
group('Opening a resume file');
const txtPath = path.join(dir, 'resume.txt');
fs.writeFileSync(txtPath, SAMPLE);
ok('a text file is read', resumeRead.readResumeFile(txtPath).text.includes('SARAH CHEN'));
ok('the kind is reported', resumeRead.readResumeFile(txtPath).kind === 'text');

const jsonPath = path.join(dir, 'cv.json');
fs.writeFileSync(jsonPath, JSON.stringify(master));
ok('an exported CV comes back whole, not re-parsed',
  resumeRead.readResumeFile(jsonPath).cv.name === master.name);

ok('a PDF says what to do instead', (() => {
  fs.writeFileSync(path.join(dir, 'cv.pdf'), '%PDF-1.4 stub');
  try { resumeRead.readResumeFile(path.join(dir, 'cv.pdf')); return false; }
  catch (e) { return /Save as/i.test(e.message) && /docx/i.test(e.message); }
})());
ok('the old Word format explains itself', (() => {
  fs.writeFileSync(path.join(dir, 'cv.doc'), 'stub');
  try { resumeRead.readResumeFile(path.join(dir, 'cv.doc')); return false; }
  catch (e) { return /Save as/i.test(e.message); }
})());
ok('a missing file does not throw a stack trace at her', (() => {
  try { resumeRead.readResumeFile(path.join(dir, 'nope.txt')); return false; }
  catch (e) { return /could not be found/i.test(e.message); }
})());
ok('markup in a Word file becomes paragraphs, not tags',
  resumeRead.docxXmlToText('<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>')
    .trim() === 'One\nTwo');
ok('entities inside a Word file decode',
  resumeRead.docxXmlToText('<w:p><w:t>Caf&#233; &amp; co</w:t></w:p>').trim() === 'Café & co');

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
  // Sized for the fixture CV, which is deliberately shorter than a real one.
  ok('a PDF is produced', fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 3000,
    fs.existsSync(pdfPath) ? `${fs.statSync(pdfPath).size} bytes` : 'missing');
  ok('it is a real PDF', fs.readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-');
  ok('a Word file is produced', fs.existsSync(docxPath) && fs.statSync(docxPath).size > 5000);
  ok('it is a real docx', fs.readFileSync(docxPath).subarray(0, 2).toString() === 'PK');

  /* The Word file the app just wrote is a real .docx, so reading it back proves
     the importer against genuine Word markup rather than a hand-made sample. */
  group('Reading back a real Word file');
  const back = resumeRead.readResumeFile(docxPath);
  ok('the Word file is read without a parser dependency', back.kind === 'docx');
  // The document lays the name out in capitals, exactly as the PDF does.
  ok('the name survives the round trip',
    back.text.toLowerCase().includes(master.name.toLowerCase()), back.text.slice(0, 60));
  ok('an employer survives the round trip', back.text.includes(master.experience[0].org));
  ok('no XML tags leak into the text', !/<w:|<\/w:/.test(back.text));
  const reparsed = resumeParse.parseResume(back.text);
  ok('and it parses back into the same person', reparsed.cv.name === master.name, reparsed.cv.name);
  ok('with the email intact', reparsed.cv.contact.email === master.contact.email,
    reparsed.cv.contact.email);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  // Windows keeps an open SQLite file locked, so close it before removing the folder.
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* a leftover temp folder is not a test failure */ }
  process.exit(fail ? 1 : 0);
})();
