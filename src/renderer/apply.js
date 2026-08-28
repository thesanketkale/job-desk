'use strict';
/* Toolbar for the in-app application form. The page itself lives in a view
   below this bar, sandboxed and with no access to any of this. */

const $ = (s) => document.querySelector(s);
let ctx = null;

const say = (text, bad = false) => {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('status--bad', !!bad);
};

async function run(fn, busyText, done) {
  try {
    if (busyText) say(busyText);
    const res = await fn();
    if (!res?.ok) throw new Error(res?.error || 'That did not work.');
    if (done) done(res.data);
    return res.data;
  } catch (err) {
    say(err.message, true);
    return null;
  }
}

function applyContext(c) {
  ctx = c;
  if (!c) return;
  $('#role-title').textContent = c.job.title || '';
  $('#role-sub').textContent = [c.job.company, c.job.location_raw].filter(Boolean).join(' · ');
  $('#attach').disabled = !c.hasPdf;
  $('#attach').textContent = `Attach the ${c.resumeLabel || 'CV'}`;
  $('#reveal').textContent = `Preview the ${c.resumeLabel || 'CV'}`;
  $('#copy-cover').disabled = !c.coverLetter;
  say(`${c.resumeLabel === 'original CV' ? 'The original CV will be used.' : 'An AI-tailored CV will be used.'} You press Submit.`);
}

window.applyApi.onContext(applyContext);
window.applyApi.onNav(({ loading, url, canGoBack }) => {
  if (url) $('#url').textContent = url;
  $('#back').disabled = !canGoBack;
  if (loading) say('Loading the page…');
  else if ($('#status').textContent === 'Loading the page…') {
    say('Ready. Fill in your details, then check every field before submitting.');
  }
});
window.applyApi.onLoadError(({ desc }) => say(`The page would not load (${desc}).`, true));

$('#back').addEventListener('click', () => window.applyApi.nav('back'));
$('#reload').addEventListener('click', () => window.applyApi.nav('reload'));
$('#close').addEventListener('click', () => window.applyApi.close());

$('#fill').addEventListener('click', () => run(
  () => window.applyApi.fill(),
  'Filling what it recognises…',
  (r) => {
    const total = r.filled.length + (r.aiFilled || 0);
    if (!total) {
      say('Nothing on this page looked like a form field. It may still be loading, or behind a login.', true);
      return;
    }
    const parts = [`Filled ${total} field${total === 1 ? '' : 's'} (outlined in green).`];
    if (r.aiFilled) parts.push(`${r.aiFilled} of them were answered by AI from your CV.`);
    else parts.push('Saved details were used; AI did not add any form answers.');
    if (r.fileFields) parts.push('Now attach the CV.');
    // Only worth mentioning the dropdowns still left if some genuinely are.
    const selectsLeft = Math.max(0, (r.selects || 0) - (r.aiFilled || 0));
    if (selectsLeft) parts.push(`${selectsLeft} dropdown${selectsLeft === 1 ? '' : 's'} may still need you.`);
    parts.push('Check everything before submitting.');
    say(parts.join(' '));
  },
));

$('#attach').addEventListener('click', () => run(
  () => window.applyApi.attach('pdf'),
  'Attaching the application CV...',
  (r) => say(`Attached ${r.file}. Check the upload field shows it, then submit.`),
));

$('#reveal').addEventListener('click', () => run(() => window.applyApi.reveal('pdf'), null,
  () => say('Opened the folder — drag the file into the upload box.')));

$('#copy-cover').addEventListener('click', async () => {
  if (!ctx?.coverLetter) return;
  await navigator.clipboard.writeText(ctx.coverLetter);
  say('Covering letter copied. Paste it into the box that asks for one.');
});

$('#submitted').addEventListener('click', async () => {
  if (!ctx) return;
  const res = await window.applyApi.markSubmitted(ctx.applicationId);
  if (res?.ok && res.data) say('Logged. Follow-ups are scheduled.');
});

window.applyApi.context().then((r) => applyContext(r?.data ?? r));
