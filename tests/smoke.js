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
const claude = require('../src/main/ai');
const settings = require('../src/main/settings');
const updater = require('../src/main/updater');
const network = require('../src/main/network');
const seed = require('../src/main/seed');
const { buildScript, buildFileInputMatchScript,
  buildCollectQuestionsScript, buildApplyAnswersScript } = require('../src/main/autofill-script');
const { pickResumeTargets } = require('../src/main/apply-browser');

group('Handling internet connection errors');
const offlineStatus = network.checkInternet(() => false);
ok('the common check reports a definite offline state',
  offlineStatus.online === false && offlineStatus.code === network.INTERNET_ERROR_CODE);
ok('the common check allows a possible connection', network.checkInternet(() => true).online === true);
let offlineError = null;
try { network.requireInternet(() => false); } catch (err) { offlineError = err; }
ok('internet-only work stops with a structured error',
  offlineError?.code === network.INTERNET_ERROR_CODE && /check/i.test(offlineError.message));
const fetchError = new TypeError('fetch failed', { cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }) });
const friendlyFetchError = network.normaliseInternetError(fetchError);
ok('low-level fetch failures become a useful connection error',
  friendlyFetchError.code === network.INTERNET_ERROR_CODE && !/fetch failed/i.test(friendlyFetchError.message));
ok('Chromium page-load failures use the same connection error',
  network.normaliseInternetError(new Error('ERR_INTERNET_DISCONNECTED loading page')).code
    === network.INTERNET_ERROR_CODE);
const providerError = new Error('That API key was rejected.');
ok('service errors are not mislabelled as internet failures',
  network.normaliseInternetError(providerError) === providerError);

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
const unavailableDraft = templates.draftApplication(cvForTemplate,
  { title: 'T', company: 'C' }, { aiUnavailable: true, reason: 'all providers failed' });
ok('an AI outage explicitly records that the original CV was used',
  unavailableDraft.provenance.kind === 'template'
    && unavailableDraft.provenance.actions.includes('original_cv')
    && unavailableDraft.match_notes.some((n) => /AI services were unavailable/.test(n)));

/* -------------------------------------------------------------- budget */
group('The spending guard');
seed.seedIfEmpty();
const budget = require('../src/main/budget');
const providers = require('../src/main/providers');

/* Gemini is the default because its free tier is the only one that lets
   somebody try tailoring without paying. Anthropic stays a first-class choice. */
settings.set('ai_provider', 'gemini');
settings.set('ai_model', '');
settings.set('budget_usd_monthly', 10);
settings.set('spend_by_month', {});

ok('a brand new install defaults to the free-tier provider',
  budget.providerId() === 'gemini', budget.providerId());
ok('and to that provider\'s own default model',
  budget.model() === providers.get('gemini').defaultModel, budget.model());
ok('an unknown model falls back inside the same provider',
  (settings.set('ai_model', 'nonsense-model'), budget.model()) === providers.get('gemini').defaultModel,
  budget.model());
settings.set('ai_model', '');

ok('a model from another provider is not silently accepted',
  (settings.set('ai_model', 'claude-sonnet-5'), budget.model()) !== 'claude-sonnet-5', budget.model());
settings.set('ai_model', '');

/* An install that already had a Claude key must keep using it: changing
   somebody's provider underneath them changes what their applications cost. */
settings.set('ai_provider', '');
settings.setSecret('anthropic_api_key', 'sk-ant-existing-install');
ok('an install with a Claude key already keeps Claude', budget.providerId() === 'anthropic',
  budget.providerId());
ok('and keeps a Claude default model', budget.model() === 'claude-sonnet-5', budget.model());
settings.setSecret('anthropic_api_key', '');

/* Costs, per provider. */
settings.set('ai_provider', 'anthropic');
settings.set('ai_model', 'claude-sonnet-5');
ok('a tailored application on Claude costs a few cents',
  budget.typicalCost() > 0.02 && budget.typicalCost() < 0.12, budget.typicalCost().toFixed(4));
ok('haiku costs about half of sonnet',
  budget.typicalCost('claude-haiku-4-5') < budget.typicalCost('claude-sonnet-5') * 0.55);

settings.set('ai_provider', 'anthropic');
settings.set('ai_model', 'claude-sonnet-5');
const onClaude = budget.typicalCost();
settings.set('ai_provider', 'gemini');
settings.set('ai_model', '');
// Compared against Claude rather than a hard-coded ceiling. The ceiling used to
// be $0.02, which only passed because the Gemini table under-priced its own
// default fivefold — so the test went green off the back of the bug it should
// have caught. A figure copied from a provider's pricing page is exactly the
// kind of thing that goes stale; the relationship between the two does not.
ok('the same application on Gemini costs less than on Claude',
  budget.typicalCost() < onClaude, `${budget.typicalCost().toFixed(4)} vs ${onClaude.toFixed(4)}`);

/* The cap has to stop it whatever the per-call price is. */
settings.set('ai_provider', 'anthropic');
settings.set('ai_model', 'claude-sonnet-5');
settings.set('spend_by_month', {});
let allowed = 0;
let stopMessage = '';
for (let i = 0; i < 4000; i++) {
  try { budget.checkBeforeCall(); } catch (e) { stopMessage = e.message; break; }
  budget.record({ input_tokens: 8000, output_tokens: 4000 });
  allowed++;
}
// 120 was tuned to Sonnet 5's introductory $2/$10, which ended on 2026-08-31.
// At the list price of $3/$15 the same $10 buys 118. The point of the check is
// that the cap is not tripping absurdly early, not the exact count.
ok('a $10 limit buys a hundred applications or more', allowed >= 100, String(allowed));
ok('the limit actually stops it', stopMessage.includes('$10.00'), stopMessage.slice(0, 60));
ok('it never overspends the limit', budget.spentThisMonth() <= 10, budget.spentThisMonth().toFixed(2));
settings.set('budget_usd_monthly', 0);
let uncapped = true;
try { budget.checkBeforeCall(); } catch { uncapped = false; }
ok('zero means no limit', uncapped);
settings.set('budget_usd_monthly', 10);
settings.set('spend_by_month', {});
settings.set('ai_provider', 'gemini');
settings.set('ai_model', '');

/* --------------------------------------------------- the provider table */
group('The provider table itself');
{
  const providers = require('../src/main/providers');

  // A wrong price costs money and shows up in the ledger eventually. A wrong
  // model id costs the whole feature and shows up as "that key does not work",
  // which is much harder to trace back to a table nobody can see go stale.
  // Two dead OpenRouter ids shipped for months without anything noticing.
  for (const id of providers.ids()) {
    const p = providers.get(id);
    ok(`${id}: its default model is one it lists`, !!p.models[p.defaultModel], p.defaultModel);
    ok(`${id}: only explicitly free models are priced at zero`,
      Object.entries(p.models).every(([, m]) => m.free ? m.in === 0 && m.out === 0 : m.in > 0 && m.out > 0),
      Object.entries(p.models).filter(([, m]) => !m.in || !m.out).map(([k]) => k).join(',') || 'all priced');
  }

  // Every wire thinks before answering unless told not to, and thinking is
  // spent out of max_tokens. The key check asks for one word in a small
  // budget, so without this the whole budget goes on invisible reasoning, no
  // text comes back, and a working key is rejected as broken. Different
  // OpenAI-compatible backends spell "turn it down" differently — a flat
  // reasoning_effort field on Gemini's own endpoint, a nested reasoning
  // object on OpenRouter's (confirmed live 2026-08-26: OpenRouter silently
  // ignores the flat field rather than erroring, so a request built for
  // Gemini's shape looks fine and quietly keeps billing full reasoning on
  // every OpenRouter call) — cheapReasoningPatch merges whichever shape a
  // given provider actually needs, rather than assuming one field fits all.
  //
  // This only checks the request SHAPE, not whether the provider accepts the
  // patch's contents — and that gap is exactly what broke a real key check
  // live once already: the value was 'minimal', a test asserted 'minimal',
  // and it stayed green while Gemini 3.7 Flash rejected 'minimal' outright
  // the moment the default model moved to it. A unit test cannot catch a
  // provider rejecting a literal value — only a live call can — so treat
  // every cheapReasoningPatch as needing re-verification against the real
  // API whenever a default model changes.
  const thinkingOff = (id) => {
    const p = providers.get(id);
    const b = providers.buildRequest(id, { model: p.defaultModel, system: 's', user: 'u',
      maxTokens: 300, key: 'k', cheap: true }).body;
    if (p.wire === 'anthropic') return b.thinking?.type === 'disabled';
    const patch = p.cheapReasoningPatch || {};
    return Object.keys(patch).every((k) => JSON.stringify(b[k]) === JSON.stringify(patch[k]));
  };
  ok('the key check turns thinking off on Claude', thinkingOff('anthropic'));
  ok('the key check turns thinking off on Gemini', thinkingOff('gemini'));
  ok('the key check turns thinking off on OpenRouter, in OpenRouter\'s own shape',
    thinkingOff('openrouter'));
  ok('gemini\'s cheap reasoning patch is not the value confirmed broken live (2026-08-26)',
    providers.get('gemini').cheapReasoningPatch.reasoning_effort !== 'minimal');
  ok('openrouter is not sent Gemini\'s flat field — confirmed live to be silently ignored, not an error',
    !('reasoning_effort' in providers.buildRequest('openrouter',
      { model: 'x', system: 's', user: 'u', maxTokens: 300, key: 'k', cheap: true }).body));

  // ...and leaves it alone for the work that actually needs it.
  const tailorBody = providers.buildRequest('anthropic', { model: 'claude-sonnet-5', system: 's',
    user: 'u', maxTokens: 8000, key: 'k' }).body;
  ok('tailoring still gets to think', tailorBody.thinking === undefined);
  ok('OpenRouter Free is explicit and cannot incur token charges',
    providers.get('openrouter').models['openrouter/free'].free === true
      && budget.cost({ input_tokens: 100000, output_tokens: 100000 }, 'openrouter/free', 'openrouter') === 0);
}

/* A reply cut off mid-JSON almost always fails to parse anyway — the point of
   carrying stopReason through is a specific, actionable message ("cut off,
   try again or use a stronger model") instead of a generic "could not read
   the reply", which used to look identical to a model that just replied with
   nonsense. */
group('Telling a cut-off reply apart from a genuinely unreadable one');
{
  const anthropicCutOff = providers.parseResponse('anthropic', {
    content: [{ type: 'text', text: '{"resume": {"name": "incomplete' }],
    usage: { input_tokens: 100, output_tokens: 8000 },
    stop_reason: 'max_tokens',
  });
  ok('Anthropic: a max_tokens stop is reported', anthropicCutOff.stopReason === 'max_tokens');

  const anthropicFinished = providers.parseResponse('anthropic', {
    content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  });
  ok('Anthropic: a normal finish is reported too, not mistaken for a cut-off',
    anthropicFinished.stopReason === 'end_turn');

  const openaiCutOff = providers.parseResponse('gemini', {
    choices: [{ message: { content: '{"resume": {"name": "incomplete' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 100, completion_tokens: 8000 },
  });
  ok('the OpenAI-compatible wire reports "length" the same way', openaiCutOff.stopReason === 'length');
}

/* electron-builder deletes the whole `build` block when it packages the app, so
   anything the updater needs must come from a key that survives that. This is the
   packaged shape: no build, only updates. Getting {} here is what made every
   check on the private repository run unauthenticated. */
group('Update feed');
{
  // The packaged shape: electron-builder deletes the whole `build` block, so
  // only `updates` survives. Resolving to nothing here is what made every check
  // on the private repository run unauthenticated, against releases.atom.
  const packaged = { updates: { channel: 'github-public',
    releasesPage: 'https://github.com/thesanketkale/job-desk/releases' } };
  const t1 = updater.githubTarget(packaged);
  ok('the repository resolves once build.publish is stripped away',
    t1.owner === 'thesanketkale' && t1.repo === 'job-desk', JSON.stringify(t1));

  const checkout = { build: { publish: [{ provider: 'github', owner: 'someone', repo: 'thing' }] } };
  const t2 = updater.githubTarget(checkout);
  ok('a checkout with no releases page still falls back to build.publish',
    t2.owner === 'someone' && t2.repo === 'thing', JSON.stringify(t2));

  const t3 = updater.githubTarget();
  ok('this repository resolves to a real owner and repo as it ships', !!(t3.owner && t3.repo),
    JSON.stringify(t3));
}

group('Baked build keys');
{
  // Exercises the real gitignored file, not a mock: writes it exactly the
  // way scripts/write-baked-keys.mjs does, forces settings.js to re-require
  // it, then restores whatever was there (nothing, in every normal checkout).
  const bakedPath = path.join(__dirname, '..', 'src', 'main', 'baked-keys.js');
  const settingsPath = require.resolve('../src/main/settings');
  const hadFile = fs.existsSync(bakedPath);
  const original = hadFile ? fs.readFileSync(bakedPath, 'utf8') : null;

  fs.writeFileSync(bakedPath, "module.exports = { gemini_api_key: 'baked-test-key',"
    + " jooble: { api_key: 'baked-jooble-key' } };\n");
  delete require.cache[settingsPath];
  const s = require('../src/main/settings');

  try {
    ok('a key with nothing saved falls back to the baked one',
      s.getSecret('gemini_api_key', '') === 'baked-test-key');
    ok('an object-shaped baked key round-trips whole',
      s.getSecret('jooble', {}).api_key === 'baked-jooble-key');
    ok('a key with no baked value and nothing saved still falls to the caller’s fallback',
      s.getSecret('smtp_password', 'none') === 'none');

    s.setSecret('gemini_api_key', 'her-own-key');
    ok('a key she saves herself wins over the baked one',
      s.getSecret('gemini_api_key', '') === 'her-own-key');

    s.setSecret('gemini_api_key', '');
    ok('clearing her own key falls back to the baked one again',
      s.getSecret('gemini_api_key', '') === 'baked-test-key');

    db.run("UPDATE sources SET active = 0 WHERE type = 'jooble'");
    s.activateSourcesWithKeys();
    ok('a baked job-source key switches its source on',
      db.get("SELECT active FROM sources WHERE type = 'jooble'")?.active === 1);
  } finally {
    if (hadFile) fs.writeFileSync(bakedPath, original); else fs.unlinkSync(bakedPath);
    s.setSecret('gemini_api_key', '');
    delete require.cache[settingsPath];
    require('../src/main/settings');   // put the real (empty) module back for later tests
  }
}

/* electron-updater's getLatestVersionInfo() wraps ANY failure in the same
   "Unable to find latest version on GitHub ... please ensure a production
   release exists" framing before the real HttpError — confirmed live with a
   revoked token: the wrapped message contains both that generic not-found
   phrasing AND the literal "401"/"Bad credentials" from the real cause, in
   the same string. Checking not-found before auth used to tell someone with
   a bad token to go check the repository instead of the token. */
group('Telling a rejected GitHub token apart from a genuine 404');
{
  // The exact shape confirmed live (see updater.js's comment on friendlyUpdateError).
  const revokedTokenError = 'Unable to find latest version on GitHub '
    + '(https://api.github.com/repos/thesanketkale/job-desk/releases/latest), please ensure a '
    + 'production release exists: HttpError: 401 "message": "Bad credentials", "status": "401"';
  const genuineNotFoundError = 'Unable to find latest version on GitHub '
    + '(https://api.github.com/repos/x/y/releases/latest), please ensure a production release '
    + 'exists: HttpError: 404 "message": "Not Found", "status": "404"';

  ok('a revoked/wrong token is reported as a rejected token, not a missing release',
    /rejected/i.test(updater.friendlyUpdateError(revokedTokenError)),
    updater.friendlyUpdateError(revokedTokenError));
  ok('a genuine 404 is still reported as a missing release, not a token problem',
    /release/i.test(updater.friendlyUpdateError(genuineNotFoundError))
    && !/rejected/i.test(updater.friendlyUpdateError(genuineNotFoundError)),
    updater.friendlyUpdateError(genuineNotFoundError));

  /* The one that cost hours to find: the version check succeeds, then the
     download dies because latest.yml names "JobDesk-Setup-1.2.4.exe" while the
     asset GitHub actually holds is "Job.Desk.Setup.1.2.4.exe" — GitHub rewrites
     spaces in an uploaded asset's name to dots, so an installer built with
     spaces in its name can never be found again. nsis.artifactName below is
     space-free to keep both sides identical; this asserts the error a
     mismatch produces is at least legible rather than raw electron-updater. */
  const assetMissing = Object.assign(
    new Error('Cannot find asset "Job-Desk-Setup-1.2.4.exe" in: [{"name":"Job.Desk.Setup.1.2.4.exe"}]'),
    { code: 'ERR_UPDATER_ASSET_NOT_FOUND' });
  ok('a release whose latest.yml disagrees with its assets says so in plain language',
    /missing the file/i.test(updater.friendlyUpdateError(assetMissing)),
    updater.friendlyUpdateError(assetMissing));

  const pkg = require('../package.json');
  ok('the installer filename has no spaces, so GitHub cannot rename it on upload',
    !/\s/.test(pkg.build.nsis.artifactName || ''),
    `nsis.artifactName = ${pkg.build.nsis.artifactName}`);
}

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

/* A secret encrypted under one Windows account cannot be decrypted under
   another — copying a portable install's data folder to a different machine
   or user is the ordinary way this happens. hasSecret() still says "yes,
   saved" (the row is genuinely there); deadSecrets() is what tells the two
   situations apart, so the interface can say "re-enter this" instead of a
   provider failing later for what looks like an unrelated reason. Simulated
   here rather than through real safeStorage, which needs Electron: a row
   claiming OS encryption that this plain-Node test process cannot possibly
   decrypt reproduces the same failure this is guarding against. */
db.run("INSERT INTO settings (k, v, updated_at) VALUES (?, ?, datetime('now')) "
  + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ['secret:test_dead_key', JSON.stringify({ enc: 'os', data: 'not-a-real-encrypted-blob' })]);
ok('a secret that exists but cannot be decrypted still reports as saved',
  settings.hasSecret('test_dead_key'));
ok('reading it back fails safely instead of throwing',
  settings.getSecret('test_dead_key', 'FALLBACK') === 'FALLBACK');
ok('and it is flagged as unreadable on this computer',
  settings.deadSecrets().includes('test_dead_key'));
settings.setSecret('smtp_password', 'a-working-password');
settings.getSecret('smtp_password');
ok('a secret that reads back fine is never flagged', !settings.deadSecrets().includes('smtp_password'));

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

/* ------------------------------------------- resumes that are laid out badly */
group('Resume layouts that differ from the tidy one');

/* Every one of these broke the parser when it was first written. They cover the
   ways real resumes actually vary: where the dates sit, whether the employer is
   above or beside the title, piped contact lines, headings with a qualifier in
   front, numeric dates, and countries outside the original hard-coded handful. */
const LAYOUTS = [
  {
    what: 'dates tab-aligned to the right',
    text: `Michael O'Brien
michael.obrien@example.ie
+353 1 234 5678
Dublin, Ireland

Work Experience
Product Manager\tNovaTech\tJan 2020 – Present
• Owned the payments roadmap.
Business Analyst\tCorePay\tJun 2017 – Dec 2019
• Ran discovery for the merchant portal.`,
    name: "Michael O'Brien",
    phone: '35312345678',
    country: 'Ireland',
    roles: 2,
    firstTitle: 'Product Manager',
    firstOrg: 'NovaTech',
  },
  {
    what: 'the employer on the line above the title',
    text: `Priya Raghavan
priya.raghavan@example.in
+91 98200 12345
Mumbai, Maharashtra, India

Professional Experience

Infosys Limited
Senior Consultant
August 2019 — Present
- Led SAP migration for three clients.`,
    name: 'Priya Raghavan',
    phone: '919820012345',
    country: 'India',
    roles: 1,
  },
  {
    what: 'contact details on one piped line',
    text: `Wei Zhang | Software Architect
wei.zhang@example.com | +65 8123 4567 | Singapore | linkedin.com/in/weizhang

EXPERIENCE
Principal Engineer | Grab | Feb 2018 - Present
• Designed the driver allocation service.

TECHNICAL SKILLS
Languages: Java, Go, Rust`,
    name: 'Wei Zhang',
    phone: '6581234567',
    country: 'Singapore',
    roles: 1,
  },
  {
    what: 'a qualifier in front of the heading, and "Curriculum Vitae" on top',
    text: `CURRICULUM VITAE

Dr Amara Okafor
Research Scientist
amara.okafor@example.org
+234 803 123 4567
Lagos, Nigeria

RESEARCH EXPERIENCE
Research Scientist, Nigerian Institute of Medical Research
January 2018 - Present
• Led malaria vaccine trials.`,
    name: 'Dr Amara Okafor',
    phone: '2348031234567',
    country: 'Nigeria',
    roles: 1,
  },
  {
    what: 'numeric dates and a country outside the original list',
    text: `ANA GARCIA LOPEZ
Marketing Manager
ana.garcia@example.es
+34 612 345 678
Madrid, Spain

EMPLOYMENT
Marketing Manager, Zara Home
03/2020 - Present
• Ran the European campaign calendar.`,
    name: 'Ana Garcia Lopez',
    phone: '34612345678',
    country: 'Spain',
    roles: 1,
  },
];

for (const c of LAYOUTS) {
  const got = resumeParse.parseResume(c.text);
  const prof = resumeParse.profileFrom(got.cv);
  ok(`the name survives ${c.what}`, got.cv.name === c.name, got.cv.name);
  ok(`the phone number survives ${c.what}`,
    got.cv.contact.phone.replace(/\D/g, '') === c.phone, got.cv.contact.phone);
  ok(`the country survives ${c.what}`, prof.profile_country === c.country, prof.profile_country);
  ok(`the roles survive ${c.what}`, got.cv.experience.length === c.roles,
    String(got.cv.experience.length));
  if (c.firstTitle) {
    ok('a tab splits the title from the employer',
      got.cv.experience[0].title === c.firstTitle && got.cv.experience[0].org === c.firstOrg,
      `${got.cv.experience[0].title} / ${got.cv.experience[0].org}`);
  }
  // The headline becomes a search word, so an address landing there would have
  // the app asking job boards for "Mumbai" and "Ireland" as though they were roles.
  const terms = resumeKeywords.fromCv(got.cv).query.map((k) => k.term).join(' ');
  ok(`no place name becomes a search word with ${c.what}`,
    !new RegExp(c.country.toLowerCase()).test(terms), terms);
}

ok('a country outside the original handful is recognised',
  normalize.place('Madrid, Spain').country === 'Spain');
ok('and another', normalize.place('São Paulo, Brazil').country === 'Brazil');
ok('a heading with content after the colon is a list, not a section',
  Object.keys(resumeParse.sectionise('SKILLS\nLanguages: Python, R')).includes('skills'));

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

// A PDF with no text in it is a scan. Saying so is the whole point: the
// alternative is handing back an empty CV as though it had been read.
ok('a PDF with no text in it says so, rather than returning nothing', (() => {
  fs.writeFileSync(path.join(dir, 'scan.pdf'),
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');
  try { resumeRead.readResumeFile(path.join(dir, 'scan.pdf')); return false; }
  catch (e) { return /scan|photograph|no text/i.test(e.message); }
})());
ok('a password-protected PDF explains itself', (() => {
  fs.writeFileSync(path.join(dir, 'locked.pdf'),
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n');
  try { resumeRead.readResumeFile(path.join(dir, 'locked.pdf')); return false; }
  catch (e) { return /password protected/i.test(e.message); }
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

/* The rule table matched any substring, so 'address' inside "Email address"
   beat 'email' on length and put her city in the employer's email box, and
   'city' inside "Ethnicity" put it in a protected demographic field. Both
   were found by running this script against a real form, not by reading it. */
{
  const vm = require('node:vm');
  const PROFILE = {
    firstName: 'Srishti', lastName: 'Sharma', fullName: 'Srishti Sharma',
    email: 'hi@example.test', phone: '+91 90000 00000', linkedin: 'https://li/x',
    website: '', city: 'Pune', state: 'Maharashtra', country: 'India',
    location: 'Pune, Maharashtra, India', noticePeriod: '1 month',
    yearsExperience: '6', currentSalary: '', expectedSalary: '',
    coverLetter: 'A letter.',
  };

  /** Runs the real generated script over one fake text input per label.
   *  `seed` may pre-fill nodes, to prove the script leaves those alone. */
  const fillLabels = (labels, seed = null) => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`
      globalThis.HTMLInputElement = class { constructor(){ this._v=''; } };
      Object.defineProperty(HTMLInputElement.prototype,'value',
        { get(){ return this._v; }, set(v){ this._v = v; }, configurable: true });
      globalThis.HTMLTextAreaElement = class extends HTMLInputElement {};
      globalThis.Event = class { constructor(t){ this.type = t; } };
      globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    `, ctx);

    const nodes = labels.map((label) => {
      const el = new ctx.HTMLInputElement();
      Object.assign(el, {
        name: '', id: '', placeholder: '', disabled: false, readOnly: false,
        labels: null, style: {},
        getAttribute: (a) => (a === 'aria-label' ? label : null),
        setAttribute: () => {}, closest: () => null,
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
        dispatchEvent: () => true,
      });
      return el;
    });
    if (seed) seed(nodes);
    ctx.document = {
      querySelectorAll: (sel) => (sel.includes('input[type=file]') || sel === 'select' ? [] : nodes),
    };
    const out = vm.runInContext(buildScript(PROFILE), ctx);
    return { out, values: nodes.map((n) => n.value) };
  };

  const email = fillLabels(['Email address']);
  ok('"Email address" gets the email, not the city she lives in',
    email.values[0] === 'hi@example.test', email.values[0]);

  const ethnicity = fillLabels(['Ethnicity']);
  ok('an ethnicity field is left alone rather than filled with her city',
    ethnicity.values[0] === '' && ethnicity.out.skipped.length === 1, ethnicity.values[0]);

  const demographic = fillLabels(['Gender', 'Do you have a disability?', 'Veteran status',
    'Nationality', 'Marital status']);
  ok('no protected demographic question is ever answered by the rule table',
    demographic.values.every((v) => v === ''), demographic.values.join('|'));

  const substrings = fillLabels(['Personal statement', 'Supporting statement', 'Hometown']);
  ok('a key only matches a whole word, so "statement" is not "state"',
    substrings.values.every((v) => v === ''), substrings.values.join('|'));

  const stillWorks = fillLabels(['First name', 'Email', 'Mobile number',
    'Current location (City, State, Country)', 'Home address', 'Town/City', 'Country']);
  ok('the fields that did work still work',
    stillWorks.values.join('|')
      === ['Srishti', 'hi@example.test', '+91 90000 00000', 'Pune, Maharashtra, India',
        'Pune, Maharashtra, India', 'Pune', 'India'].join('|'),
    stillWorks.values.join('|'));

  const kept = fillLabels(['First name'], (nodes) => { nodes[0].value = 'Typed by her'; });
  ok('a field the person already typed into is never overwritten',
    kept.values[0] === 'Typed by her', kept.values[0]);
}

/* attachResume() used to attach the CV to every file input on the page —
   harmless on a form with one upload field, wrong on any form with a
   separate cover-letter or portfolio field, which received the CV too. */
group('Choosing which file field the CV belongs in');
{
  const vm = require('node:vm');
  const fakeFileInput = (label = '', name = '') => ({
    name, id: '', placeholder: '',
    getAttribute: (attr) => (attr === 'aria-label' ? label : null),
    closest: () => null,
  });

  const runMatcher = (inputs) => {
    const context = { document: { querySelectorAll: (sel) => (sel === 'input[type=file]' ? inputs : []) } };
    vm.createContext(context);
    return vm.runInContext(buildFileInputMatchScript(), context);
  };

  const result = runMatcher([
    fakeFileInput('', 'resume'),
    fakeFileInput('Cover Letter'),
    fakeFileInput('Portfolio link (optional)'),
    fakeFileInput('Attachment'),
  ]);
  ok('a field literally named "resume" is recognised', result[0].resume === true, JSON.stringify(result[0]));
  ok('a cover-letter field is excluded, not mistaken for the resume field',
    result[1].resume === false && result[1].exclude === true, JSON.stringify(result[1]));
  ok('a portfolio field is excluded too', result[2].exclude === true, JSON.stringify(result[2]));
  ok('a field with no signal either way is neither', !result[3].resume && !result[3].exclude,
    JSON.stringify(result[3]));

  // pickResumeTargets() is what turns that per-field read into which CDP
  // nodeIds actually get the file — one clear resume field wins outright,
  // even with other, non-excluded fields also present.
  ok('the CV goes only to the field that reads as the résumé one',
    JSON.stringify(pickResumeTargets([10, 20, 30, 40], result)) === JSON.stringify([10]));
  ok('with no CV-labelled field, cover-letter and portfolio fields are skipped, the plain one is not',
    JSON.stringify(pickResumeTargets([20, 30, 40], result.slice(1))) === JSON.stringify([40]));
  ok('a mismatched match count falls back to every field, same as before this existed',
    JSON.stringify(pickResumeTargets([1, 2, 3], [])) === JSON.stringify([1, 2, 3]));
  ok('every field excluded still attaches somewhere rather than nowhere',
    JSON.stringify(pickResumeTargets([1, 2], [{ exclude: true }, { exclude: true }])) === JSON.stringify([1, 2]));
}

/* The AI pass answers the dropdowns and screening questions the rule table
   cannot. It types into a real employer's form under the candidate's name,
   so what it is NOT allowed to answer matters more than what it is. */
group('Answering form questions with AI, and the guards on it');
{
  const vm = require('node:vm');
  const fakeSelect = (label, optionTexts, selectedIndex = 0) => {
    const options = optionTexts.map((t) => ({ text: t, value: t }));
    return {
      __select: true, name: '', id: '', placeholder: '', options, selectedIndex,
      value: '', disabled: false, readOnly: false,
      getAttribute: (a) => (a === 'aria-label' ? label : null),
      setAttribute: () => {}, closest: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      dispatchEvent: () => true,
      style: {},
    };
  };

  const collect = (selects) => {
    const context = {
      document: {
        querySelectorAll: (sel) => (sel === 'select' ? selects : []),
        getElementById: () => null,
      },
      getComputedStyle: () => ({ visibility: 'visible' }),
      HTMLTextAreaElement: function HTMLTextAreaElement() {},
    };
    vm.createContext(context);
    return vm.runInContext(buildCollectQuestionsScript(), context);
  };

  const asked = collect([
    fakeSelect('Do you require visa sponsorship?', ['Select...', 'Yes', 'No']),
    fakeSelect('Country', ['Select...', 'India', 'United Kingdom'], 2),
  ]);
  ok('an unanswered dropdown is collected with its real options',
    asked.length === 1 && asked[0].kind === 'select'
    && asked[0].options.join(',') === 'Select...,Yes,No', JSON.stringify(asked));
  ok('a dropdown the person already chose is left alone',
    !asked.some((f) => f.label.includes('country')), JSON.stringify(asked.map((f) => f.label)));

  // Equal-opportunities questions are the candidate's alone to answer. The
  // prompt forbids them; this is the guard that does not depend on the model
  // having obeyed it — same reasoning as enforceTruth().
  const PROTECTED = claude.PROTECTED_QUESTION;
  for (const q of ['Do you have a disability?', 'Gender', 'Veteran status', 'Ethnicity',
    'Expected CTC', 'I agree to the terms', 'Please certify the above']) {
    ok(`refuses to answer: "${q}"`, PROTECTED.test(q.toLowerCase()));
  }
  for (const q of ['Do you require visa sponsorship?', 'Notice period', 'Why do you want this role?']) {
    ok(`still answers: "${q}"`, !PROTECTED.test(q.toLowerCase()));
  }

  // An answer that is not one of the options the page offers must not be
  // forced in — checked in ai.js AND again page-side against the live element.
  const applySrc = buildApplyAnswersScript([
    { index: 0, value: 'Maybe' },      // not an option
    { index: 1, value: 'No' },         // a real one
  ]);
  const target = fakeSelect('q', ['Select...', 'Yes', 'No']);
  const other = fakeSelect('q2', ['Select...', 'Yes', 'No']);
  // instanceof HTMLSelectElement has to be true for the fakes inside the
  // sandbox. Symbol.hasInstance is non-writable on a plain function, so it is
  // defined rather than assigned.
  const FakeSelectClass = function HTMLSelectElement() {};
  Object.defineProperty(FakeSelectClass, Symbol.hasInstance, { value: (o) => !!(o && o.__select) });
  const applyCtx = {
    document: {
      querySelector: (sel) => (sel.includes('"0"') ? target : sel.includes('"1"') ? other : null),
    },
    Event: function Event() {},
    HTMLSelectElement: FakeSelectClass,
  };
  vm.createContext(applyCtx);
  const applied = vm.runInContext(applySrc, applyCtx);
  ok('an answer the dropdown does not offer is dropped, not forced in',
    target.value === '' , JSON.stringify(target.value));
  ok('an answer that is a real option is applied', other.value === 'No', JSON.stringify(other.value));
  ok('only the applicable answer is counted', applied.filled === 1, JSON.stringify(applied));
}

/* pdfkit's unembedded standard fonts can only encode Windows-1252 — anything
   else used to come out as a silently different, wrong-looking character
   with no error anywhere, in a document that goes to a real employer. */
group('Making sure the PDF never renders a character it cannot encode');
{
  const { sanitizeForPdf } = require('../src/main/resume-pdf');
  ok('plain ASCII is untouched', sanitizeForPdf('Software Engineer, 8 years') === 'Software Engineer, 8 years');
  ok('an accented Latin-1 letter survives', sanitizeForPdf('Café') === 'Café');
  ok('an em dash survives — it is in WinAnsi\'s extra range',
    sanitizeForPdf('2019—2023') === '2019—2023');
  ok('a rupee sign is transliterated, not garbled', sanitizeForPdf('₹50,000') === 'Rs. 50,000');
  ok('a script this font cannot draw becomes a visible placeholder, not a wrong character',
    sanitizeForPdf('नमस्ते') === '??????');
  ok('an emoji (a surrogate pair) becomes exactly one placeholder, not two',
    sanitizeForPdf('CV 😀') === 'CV ?');
  ok('empty and missing input do not throw', sanitizeForPdf('') === '' && sanitizeForPdf(undefined) === '');
}

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

  group('Retrying internet actions without losing the original action');
  let availabilityChecks = 0;
  let actionRuns = 0;
  let retryPrompts = 0;
  const retriedResult = await network.runWithInternet(async () => {
    actionRuns++;
    return 'completed';
  }, {
    onlineCheck: () => ++availabilityChecks > 1,
    ask: async () => { retryPrompts++; return 'retry'; },
  });
  ok('Retry checks connectivity again and runs the original action',
    retriedResult === 'completed' && availabilityChecks === 2 && actionRuns === 1 && retryPrompts === 1);

  let failedActionRuns = 0;
  const replayedResult = await network.runWithInternet(async () => {
    failedActionRuns++;
    if (failedActionRuns === 1) {
      const error = new Error('socket closed');
      error.code = 'ECONNRESET';
      throw error;
    }
    return 'replayed';
  }, {
    onlineCheck: () => true,
    ask: async () => 'retry',
  });
  ok('Retry replays an action that failed during its network request',
    replayedResult === 'replayed' && failedActionRuns === 2);

  let cancelledActionRuns = 0;
  let cancelledError = null;
  try {
    await network.runWithInternet(async () => { cancelledActionRuns++; }, {
      onlineCheck: () => false,
      ask: async () => 'cancel',
    });
  } catch (error) { cancelledError = error; }
  ok('Cancel leaves the original action untouched and suppresses duplicate errors',
    cancelledActionRuns === 0 && cancelledError?.popupShown === true);

  group('Archiving the exact submitted CV');
  const sourcePdf = path.join(db.paths.resumes, 'archive-source.pdf');
  const sourceDocx = path.join(db.paths.resumes, 'archive-source.docx');
  fs.copyFileSync(pdfPath, sourcePdf);
  fs.copyFileSync(docxPath, sourceDocx);
  const archiveJobId = db.insert('jobs', {
    fingerprint: 'archive-test-job', title: 'Archive Test Role', company: 'Archive Test Company',
  });
  const archiveAppId = db.insert('applications', {
    job_id: archiveJobId,
    status: 'draft',
    resume_pdf: path.basename(sourcePdf),
    resume_docx: path.basename(sourceDocx),
  });
  const applierForArchive = require('../src/main/applier');
  const archived = applierForArchive.archiveForSubmission(archiveAppId);
  ok('submission makes an immutable PDF copy',
    archived.application.resume_pdf.startsWith(`submitted${path.sep}`)
      && fs.existsSync(archived.pdf), archived.application.resume_pdf);
  ok('submission makes an immutable Word copy',
    archived.application.resume_docx.startsWith(`submitted${path.sep}`)
      && fs.existsSync(archived.docx), archived.application.resume_docx);
  ok('the application records when its CV was archived', !!archived.application.resume_archived_at);
  ok('the archived PDF is byte-for-byte the prepared PDF',
    fs.readFileSync(archived.pdf).equals(fs.readFileSync(sourcePdf)));
  applierForArchive.appendAutomation(archiveAppId, {
    kind: 'local', actions: ['form_autofill'], detail: 'Saved details were used.',
  });
  ok('preparation provenance remains attached to the application',
    applierForArchive.get(archiveAppId).automation_log.some((e) => e.actions.includes('form_autofill')));

  group('Preparing an application during a complete AI outage');
  masterMod.saveMaster(master);
  const outageJobId = db.insert('jobs', {
    fingerprint: 'outage-fallback-job',
    title: 'Outage Fallback Role',
    company: 'Fallback Company',
    description_text: 'A role that should still be prepared when every AI service is unavailable.',
    apply_email: 'jobs@fallback.test',
    score: 72,
  });
  const realTailor = claude.tailor;
  settings.setSecret('gemini_api_key', 'gemini-test-key-value');
  claude.tailor = async () => { throw new Error('all configured AI services failed'); };
  let outageApplication;
  try {
    outageApplication = await applierForArchive.prepare(outageJobId);
  } finally {
    claude.tailor = realTailor;
    settings.setSecret('gemini_api_key', '');
  }
  ok('an AI outage still produces a ready application',
    outageApplication.mode === 'template' && fs.existsSync(outageApplication.files.pdf));
  ok('the outage application explicitly records the original CV and local templates',
    outageApplication.automation_log.some((e) => e.kind === 'template'
      && e.actions.includes('original_cv') && /All available AI services failed/.test(e.detail)));

  group('Choosing to send the original CV instead of the AI-tailored one');
  const swapJobId = db.insert('jobs', { fingerprint: 'swap-test-job', title: 'Swap Test Role', company: 'Swap Test Co' });
  const swapAppId = db.insert('applications', {
    job_id: swapJobId, status: 'draft', mode: 'ai',
    resume_json: JSON.stringify({ name: 'AI Tailored Person' }),
    resume_pdf: 'ai-swap-source.pdf', resume_docx: 'ai-swap-source.docx',
  });
  const switched = await applierForArchive.switchResume(swapAppId, 'original');
  ok('switching to the original CV points the application at a freshly rendered master CV',
    switched.resume_choice === 'original' && switched.mode === 'ai' && fs.existsSync(switched.files.pdf));
  ok('the AI-tailored CV is kept, not overwritten',
    switched.ai_resume_pdf === 'ai-swap-source.pdf' && switched.files.aiPdf.endsWith('ai-swap-source.pdf'));
  ok('the switch is recorded as the applicant\'s own choice',
    switched.automation_log.some((e) => e.kind === 'user_choice' && /original CV/.test(e.detail)));

  const switchedBack = await applierForArchive.switchResume(swapAppId, 'ai');
  ok('switching back restores the AI-tailored CV pointer without regenerating it',
    switchedBack.resume_choice === '' && switchedBack.resume_pdf === 'ai-swap-source.pdf');

  let noAiError = null;
  try { await applierForArchive.switchResume(archiveAppId, 'original'); } catch (err) { noAiError = err; }
  ok('an application that was never AI-tailored refuses to switch',
    noAiError && /no AI-tailored CV/i.test(noAiError.message));

  const sentJobId = db.insert('jobs', { fingerprint: 'swap-sent-job', title: 'Sent Role', company: 'Sent Co' });
  const sentAppId = db.insert('applications', {
    job_id: sentJobId, status: 'sent', mode: 'ai', resume_pdf: 'x.pdf', resume_docx: 'x.docx',
  });
  let sentGuardError = null;
  try { await applierForArchive.switchResume(sentAppId, 'original'); } catch (err) { sentGuardError = err; }
  ok('a sent application cannot have its CV swapped after the fact',
    sentGuardError && /already been sent/i.test(sentGuardError.message));

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

  /* The PDF the app just wrote is a real PDF — content streams, FlateDecode,
     WinAnsi-encoded fonts — so reading it back tests the extractor against a
     genuine file rather than a hand-made sample. */
  group('Reading back a real PDF');
  const fromPdf = resumeRead.readResumeFile(pdfPath);
  ok('the PDF is read without a parser dependency', fromPdf.kind === 'pdf');
  ok('the name survives the round trip',
    fromPdf.text.toLowerCase().includes(master.name.toLowerCase()), fromPdf.text.slice(0, 60));
  ok('the email survives it', fromPdf.text.includes(master.contact.email));
  ok('an employer survives it', fromPdf.text.includes(master.experience[0].org));
  ok('the institution survives it', fromPdf.text.includes(master.education[0].school));
  ok('no PDF operators leak into the text', !/\bTJ\b|\bTf\b|\bendstream\b/.test(fromPdf.text));
  // WinAnsi maps 0x96 to an en dash. Getting this wrong turns "Dec 2019 – Mar
  // 2023" into something that no longer reads as a date range, and every job
  // on the CV stops being recognised.
  ok('an en dash comes back as an en dash, not a control code',
    fromPdf.text.includes('–') && !/[\x80-\x9F]/.test(fromPdf.text));

  const fromPdfCv = resumeParse.parseResume(fromPdf.text).cv;
  ok('the PDF parses back into the same person', fromPdfCv.name === master.name, fromPdfCv.name);
  ok('with every role found', fromPdfCv.experience.length === master.experience.length,
    `${fromPdfCv.experience.length} of ${master.experience.length}`);
  ok('with the employer read correctly, not split on a hyphen',
    fromPdfCv.experience.some((j) => j.org === 'Self-Employed'),
    fromPdfCv.experience.map((j) => j.org).join(' | '));
  ok('and both qualifications, not one per line',
    fromPdfCv.education.length === master.education.length,
    String(fromPdfCv.education.length));

  /* ---------------------------------------------------- sending rails ---- */
  group('The daily send cap covers follow-ups, not just applications');
  {
    const applier = require('../src/main/applier');
    const followupsMod = require('../src/main/followups');

    const jobId = db.insert('jobs', {
      fingerprint: `rails-test-${Date.now()}`, title: 'Rails Test Role', company: 'Rails Test Co',
    });
    const appId = db.insert('applications', {
      job_id: jobId, status: 'draft', to_email: 'someone@example.com',
    });
    const fuId = db.insert('followups', {
      application_id: appId, seq: 1, due_on: '2020-01-01', status: 'scheduled',
      subject: 'Following up', body_text: 'A real follow-up body.',
    });
    const sqlNow = () => db.val("SELECT datetime('now') AS x", [], '');

    settings.set('max_sends_per_day', 5);
    ok('a fresh day has the full cap available', applier.remainingToday() === 5, String(applier.remainingToday()));

    db.update('applications', { status: 'sent', sent_at: sqlNow() }, 'id = ?', [appId]);
    ok('a sent application counts against the cap', applier.remainingToday() === 4, String(applier.remainingToday()));

    // A sent follow-up used to count for nothing at all — the actual bug:
    // followups.send() called mailer.send() directly, bypassing every rail in
    // applier.js, so the daily cap could be exhausted by applications and then
    // sailed straight through by an unlimited number of follow-ups on top.
    db.insert('followups', {
      application_id: appId, seq: 2, due_on: '2020-01-01', status: 'sent', sent_at: sqlNow(),
      subject: 'x', body_text: 'x',
    });
    ok('a sent follow-up also counts against the same cap',
      applier.remainingToday() === 3, String(applier.remainingToday()));

    // Exhaust the cap, then prove followups.send() refuses before it ever
    // reaches the mailbox. No SMTP is configured anywhere in this test file,
    // so a check that let the send through would fail with mailer's "no
    // outgoing mail server" error instead of a cap message — the two are
    // distinguishable, which is what makes this a real test of ordering, not
    // just of the final outcome.
    settings.set('max_sends_per_day', 0);
    let capMessage = '';
    try { await followupsMod.send(fuId); } catch (err) { capMessage = err.message; }
    ok('an exhausted cap blocks a follow-up before it reaches the mailbox',
      /limit/i.test(capMessage), capMessage);

    // Raise the cap back and confirm the guard only blocks when it should —
    // the send now proceeds far enough to reach the mailbox, which then fails
    // for the unrelated reason of there being no mailbox configured, proving
    // the cap check discriminates rather than always refusing. smtp_host is
    // cleared first and on purpose: an earlier group's seedMailboxFromCv()
    // already populated it from the fixture CV's .test address, and this
    // machine's network resolves and answers that host — npm test is meant
    // to need no network at all, so this forces mailer's local, offline
    // "no mailbox configured" error rather than a real connection attempt.
    settings.set('smtp_host', '');
    settings.set('max_sends_per_day', 50);
    let pastCapMessage = '';
    try { await followupsMod.send(fuId); } catch (err) { pastCapMessage = err.message; }
    ok('a cap with room left does not block the send',
      /outgoing mail server/i.test(pastCapMessage), pastCapMessage);

    settings.set('max_sends_per_day', 12);
  }

  group('Sending the exact application PDF');
  const mailerForAttachment = require('../src/main/mailer');
  const realMailerSend = mailerForAttachment.send;
  let sentPayload = null;
  mailerForAttachment.send = async (payload) => {
    sentPayload = payload;
    return { ok: true, messageId: 'test-message' };
  };
  settings.set('company_cooldown_days', 0);
  applierForArchive.save(outageApplication.id, {
    to_email: 'jobs@fallback.test',
    subject: outageApplication.subject,
    body_text: outageApplication.body_text.replace(templates.PLACEHOLDER,
      'I am particularly interested in this role and its stated responsibilities.'),
  });
  try {
    await applierForArchive.send(outageApplication.id);
  } finally {
    mailerForAttachment.send = realMailerSend;
    settings.set('company_cooldown_days', 30);
  }
  ok('email applications attach only the archived PDF',
    sentPayload?.attachments?.length === 1
      && sentPayload.attachments[0].path.includes(`${path.sep}submitted${path.sep}`)
      && sentPayload.attachments[0].filename.endsWith('.pdf'),
    JSON.stringify(sentPayload?.attachments || []));

  /* ------------------------------------------------ checking an API key ---- */
  group('Checking an API key before saving it');
  // Each service has its own key shape, and the wrong one is caught locally —
  // before a request is made, and before anything is stored.
  const KEY_CASES = [
    // Google issues more than one valid key shape — a real key tested live
    // against this app did not start with "AIza", the only prefix most
    // documentation mentions, and would have been wrongly rejected by an
    // earlier version of this check. Two "good" shapes guard against that
    // regression recurring: the documented one and the one actually observed.
    { provider: 'gemini', says: 'aistudio.google.com', good: `AIza${'x'.repeat(35)}`,
      // Same shape as a real key seen during manual testing (a "AQ." prefix,
      // not "AIza"), but not a real credential — this must never make a
      // network call that could succeed, or npm test would need network
      // access and a live secret would end up committed to the repo.
      good2: `AQ.${'x'.repeat(50)}`,
      bad: ['', 'sk-ant-abcdefghijklmnopqrst', 'nope'] },
    { provider: 'anthropic', says: 'sk-ant-', good: `sk-ant-${'x'.repeat(40)}`,
      bad: ['', `AIza${'x'.repeat(35)}`, 'sk-ant-abc'] },
    { provider: 'openrouter', says: 'sk-or-', good: `sk-or-v1-${'x'.repeat(40)}`,
      bad: ['', 'sk-ant-abcdefghijklmnopqrst'] },
  ];
  for (const c of KEY_CASES) {
    for (const bad of c.bad) {
      let msg = '';
      try { await claude.validateKey(bad, c.provider); } catch (e) { msg = e.message; }
      ok(`${c.provider} refuses "${bad.slice(0, 12) || '(empty)'}" without a request`,
        !!msg, msg.slice(0, 60));
      ok(`${c.provider} refuses it in plain language`,
        !/undefined|\[object|TypeError|ECONN/.test(msg), msg.slice(0, 60));
    }
    ok(`${c.provider} says what a real key looks like`, await (async () => {
      try { await claude.validateKey('nope', c.provider); return false; }
      catch (e) { return e.message.includes(c.says); }
    })());
    // Whether a well-shaped key gets past the local check is tested against
    // keyLooksWrong directly, not through validateKey — that falls through to
    // ping(), a real network call to the provider's real API, which npm test
    // must never depend on (see CLAUDE.md: no network needed) and which one
    // run of this exact case took over two minutes to return from.
    const shapeCheck = providers.get(c.provider).keyLooksWrong;
    ok(`${c.provider} lets a well-formed key past the shape check`,
      !shapeCheck(c.good), shapeCheck(c.good));
    if (c.good2) ok(`${c.provider} lets a differently-shaped real key past it too`,
      !shapeCheck(c.good2), shapeCheck(c.good2));
  }

  group('Free-first AI failover');
  settings.setSecret('gemini_api_key', 'gemini-test-key-value');
  settings.setSecret('openrouter_api_key', `sk-or-v1-${'x'.repeat(40)}`);
  settings.setSecret('anthropic_api_key', `sk-ant-${'x'.repeat(40)}`);
  settings.set('budget_usd_monthly', 0);

  const plan = claude.buildAttemptPlan();
  ok('the chain starts with the three direct Gemini models in order',
    plan.slice(0, 3).map((a) => a.model).join(',')
      === 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash',
    plan.map((a) => a.model).join(','));
  ok('OpenRouter Free follows Gemini and Claude is last',
    plan[3].id === 'openrouter' && plan[3].model === 'openrouter/free'
      && plan[4].id === 'anthropic',
    JSON.stringify(plan.map(({ id, model }) => ({ id, model }))));
  ok('no paid OpenRouter model is present in the automatic chain',
    !plan.some((a) => a.id === 'openrouter' && a.model !== 'openrouter/free'));
  ok('free routes are never blocked by the paid fallback budget',
    plan.slice(0, 4).every((a) => a.free) && plan[4].free === false);

  const attemptedModels = [];
  const geminiFailover = await claude.call('SYS', 'USER', 100, {
    deadlineMs: 30000,
    sleep: async () => {},
    accept: () => true,
    transport: async (_url, body) => {
      attemptedModels.push(body.model);
      if (body.model === 'gemini-3.7-flash') {
        return { ok: false, status: 503, retryAfter: '',
          data: { error: { message: 'high demand' } } };
      }
      return { ok: true, status: 200, retryAfter: '',
        data: { model: body.model, choices: [{ message: { content: '{"ok":true}' } }] } };
    },
  });
  ok('a busy Gemini 3.7 falls through to Gemini 3.6',
    geminiFailover.model === 'gemini-3.6-flash'
      && attemptedModels.join(',') === 'gemini-3.7-flash,gemini-3.7-flash,gemini-3.6-flash',
    attemptedModels.join(','));

  const providerAttempts = [];
  const claudeFailover = await claude.call('SYS', 'USER', 100, {
    deadlineMs: 30000,
    sleep: async () => {},
    accept: () => true,
    transport: async (url, body) => {
      const id = url.includes('openrouter') ? 'openrouter'
        : url.includes('anthropic') ? 'anthropic' : 'gemini';
      providerAttempts.push(`${id}:${body.model}`);
      if (id !== 'anthropic') {
        return { ok: false, status: 503, retryAfter: '',
          data: { error: { message: 'temporarily unavailable' } } };
      }
      return { ok: true, status: 200, retryAfter: '',
        data: { model: body.model, content: [{ type: 'text', text: '{"ok":true}' }] } };
    },
  });
  ok('Claude is reached only after Gemini and OpenRouter Free fail',
    claudeFailover.providerId === 'anthropic'
      && providerAttempts.some((a) => a === 'openrouter:openrouter/free')
      && providerAttempts.at(-1).startsWith('anthropic:'),
    providerAttempts.join(','));

  const networkAttempts = [];
  const networkFailover = await claude.call('SYS', 'USER', 100, {
    deadlineMs: 30000,
    sleep: async () => {},
    accept: () => true,
    transport: async (url, body) => {
      const id = url.includes('openrouter') ? 'openrouter'
        : url.includes('anthropic') ? 'anthropic' : 'gemini';
      networkAttempts.push(`${id}:${body.model}`);
      if (id === 'gemini') throw new Error('network socket failed');
      return { ok: true, status: 200, retryAfter: '',
        data: { model: body.model, choices: [{ message: { content: '{"ok":true}' } }] } };
    },
  });
  ok('a provider-level network failure skips its sibling models and reaches the next service',
    networkFailover.providerId === 'openrouter'
      && networkAttempts.join(',') === 'gemini:gemini-3.7-flash,openrouter:openrouter/free',
    networkAttempts.join(','));

  settings.setSecret('gemini_api_key', '');
  settings.setSecret('openrouter_api_key', '');
  settings.setSecret('anthropic_api_key', '');
  settings.set('budget_usd_monthly', 10);
  settings.set('spend_by_month', {});

  /* --------------------------------------------- one shape, many services -- */
  group('Talking to more than one service');
  for (const id of providers.ids()) {
    const p = providers.get(id);
    const req = providers.buildRequest(id,
      { model: 'm', system: 'SYS', user: 'USER', maxTokens: 99, key: 'KEY' });
    ok(`${id} is given a real endpoint`, /^https:\/\//.test(req.url), req.url);
    ok(`${id} carries the key in the header its API expects`,
      p.wire === 'anthropic' ? req.headers['x-api-key'] === 'KEY'
        : req.headers.Authorization === 'Bearer KEY', JSON.stringify(req.headers));
    ok(`${id} sends the system prompt where its API looks for it`,
      p.wire === 'anthropic' ? req.body.system === 'SYS'
        : req.body.messages[0].role === 'system' && req.body.messages[0].content === 'SYS');
    ok(`${id} sends the question`, JSON.stringify(req.body.messages).includes('USER'));
  }

  // Whatever the wire format, everything above providers.js sees one shape.
  const fromAnthropic = providers.parseResponse('anthropic', {
    content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 11, output_tokens: 22 },
  });
  const fromOpenai = providers.parseResponse('gemini', {
    choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 11, completion_tokens: 22 },
  });
  ok('both wire formats yield the same text',
    fromAnthropic.text === 'hello' && fromOpenai.text === 'hello');
  ok('and the same token names the ledger already speaks',
    fromOpenai.usage.input_tokens === 11 && fromOpenai.usage.output_tokens === 22,
    JSON.stringify(fromOpenai.usage));
  ok('an error is surfaced, not swallowed',
    providers.parseResponse('gemini', { error: { message: 'nope' } }).error === 'nope');
  ok('a reply with no answer in it is an error, not empty text',
    !!providers.parseResponse('gemini', { choices: [] }).error);
  ok('content returned as parts is joined',
    providers.parseResponse('gemini',
      { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }).text === 'ab');
  ok('the live model list is read from whatever the service calls it',
    providers.parseModelList('gemini', { data: [{ id: 'models/gemini-3.5-flash' }] })[0]
      === 'gemini-3.5-flash');
  ok('the truth guard does not care which service replied',
    typeof claude.enforceTruth === 'function' && typeof claude.enforceResumeTruth === 'function');

  /* ------------------------------------------------------------- sources -- */
  group('Spending API quota carefully');
  const sources = require('../src/main/sources');
  const { budgetedQueries } = sources;
  const qs = ['a', 'b', 'c', 'd', 'e'];
  ok('a short list is untouched', budgetedQueries(['a', 'b'], 3, 0).length === 2);
  ok('a long list is trimmed', budgetedQueries(qs, 3, 0).length === 3);
  ok('the window moves each refresh',
    budgetedQueries(qs, 3, 0).join() !== budgetedQueries(qs, 3, 1).join());
  ok('every keyword is used within a full rotation', (() => {
    const seen = new Set();
    for (let i = 0; i < qs.length; i++) budgetedQueries(qs, 3, i).forEach((q) => seen.add(q));
    return seen.size === qs.length;
  })());
  ok('a negative seed does not crash', budgetedQueries(qs, 2, -3).length === 2);

  group('Credentials the app will accept');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
  for (const k of ['adzuna', 'jooble', 'jsearch', 'activejobsdb', 'ycjobs']) {
    ok(`${k} is storable`, ipcSrc.includes(`'${k}'`) && !!settings.secrets()[k]);
  }

  group('Reading the new job feeds');
  // JSON.parse already rounded the fixture's .id the same way the real adapter's
  // JSON.parse would — this is genuinely what mapJoobleJob receives at runtime.
  const joobleFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'jooble-response.json'), 'utf8'));
  const jj = sources.mapJoobleJob(joobleFixture);
  ok('jooble: a title survives', !!jj.title);
  ok('jooble: an apply link survives', /^https?:\/\//.test(jj.apply_url));
  ok('jooble: every field the pipeline needs exists',
    ['external_id', 'title', 'company', 'location_raw', 'description_html', 'apply_url', 'posted_at']
      .every((k) => k in jj));
  ok('jooble: the external id keeps the link\'s full precision, not the rounded JSON number',
    jj.external_id.includes('3005239523946378831'), jj.external_id);
  ok('jooble: it does not carry the rounded numeric id instead',
    !jj.external_id.includes('3005239523946379000'), jj.external_id);

  ok('jooble: the location parses', typeof normalize.place(jj.location_raw).country === 'string');
  ok('jooble: it can be scored', typeof score.rate({
    title: jj.title, description_text: normalize.text(jj.description_html),
    work_mode: 'unknown', company: jj.company }, kws, prefs).score === 'number');

  const jsearchFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'jsearch-response.json'), 'utf8'));
  const js = sources.mapJSearchJob(jsearchFixture);
  ok('jsearch: a title survives', !!js.title);
  ok('jsearch: an apply link survives', /^https?:\/\//.test(js.apply_url));
  ok('jsearch: every field the pipeline needs exists',
    ['external_id', 'title', 'company', 'location_raw', 'description_html', 'apply_url', 'posted_at']
      .every((k) => k in js));
  ok('jsearch: a real boolean remote flag is honoured, not coerced from a truthy string',
    js.remote_flag === false, String(js.remote_flag));

  ok('jsearch: the location parses', typeof normalize.place(js.location_raw).country === 'string');
  ok('jsearch: it can be scored', typeof score.rate({
    title: js.title, description_text: normalize.text(js.description_html),
    work_mode: 'unknown', company: js.company }, kws, prefs).score === 'number');

  const ajdFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'active-jobs-db-response.json'), 'utf8'));
  const ajd = sources.mapActiveJobsDbJob(ajdFixture);
  ok('active jobs db: a title survives', !!ajd.title);
  ok('active jobs db: an apply link survives', /^https?:\/\//.test(ajd.apply_url));
  ok('active jobs db: every field the pipeline needs exists',
    ['external_id', 'title', 'company', 'location_raw', 'description_html', 'apply_url', 'posted_at']
      .every((k) => k in ajd));
  ok('active jobs db: the apply link points at the employer\'s own ATS, not a platform reseller',
    ajd.apply_url.includes('zohorecruit.com'), ajd.apply_url);
  ok('active jobs db: the location parses', typeof normalize.place(ajd.location_raw).country === 'string');
  ok('active jobs db: it can be scored', typeof score.rate({
    title: ajd.title, description_text: normalize.text(ajd.description_html),
    work_mode: 'unknown', company: ajd.company }, kws, prefs).score === 'number');

  const ycFixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'yc-jobs-response.json'), 'utf8'));
  const yc = sources.mapYcJob(ycFixture);
  ok('yc jobs: a title survives', !!yc.title);
  ok('yc jobs: an apply link survives', /^https?:\/\//.test(yc.apply_url));
  ok('yc jobs: every field the pipeline needs exists',
    ['external_id', 'title', 'company', 'location_raw', 'description_html', 'apply_url', 'posted_at']
      .every((k) => k in yc));
  ok('yc jobs: a missing description does not crash the pipeline',
    yc.description_html === '' && typeof normalize.text(yc.description_html) === 'string');
  ok('yc jobs: a real boolean remote flag is honoured',
    yc.remote_flag === false, String(yc.remote_flag));
  ok('yc jobs: the location parses', typeof normalize.place(yc.location_raw).country === 'string');
  ok('yc jobs: it can be scored', typeof score.rate({
    title: yc.title, description_text: normalize.text(yc.description_html),
    work_mode: 'unknown', company: yc.company }, kws, prefs).score === 'number');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  // Windows keeps an open SQLite file locked, so close it before removing the folder.
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* a leftover temp folder is not a test failure */ }
  process.exit(fail ? 1 : 0);
})();
