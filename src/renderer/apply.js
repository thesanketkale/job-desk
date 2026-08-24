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
  $('#copy-cover').disabled = !c.coverLetter;
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
    if (!r.filled.length) {
      say('Nothing on this page looked like a form field. It may still be loading, or behind a login.', true);
      return;
    }
    const parts = [`Filled ${r.filled.length} field${r.filled.length === 1 ? '' : 's'} (outlined in green).`];
    if (r.fileFields) parts.push('Now attach the CV.');
    if (r.selects) parts.push(`${r.selects} dropdown${r.selects === 1 ? '' : 's'} still need you.`);
    parts.push('Check everything before submitting.');
    say(parts.join(' '));
  },
));

$('#attach').addEventListener('click', () => run(
  () => window.applyApi.attach('pdf'),
  'Attaching the tailored CV…',
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
