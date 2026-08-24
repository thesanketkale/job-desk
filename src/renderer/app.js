'use strict';
/* Job Desk — interface. No framework: every view is a function that renders
   into its own <section>. State lives in the main process, not here. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Unwraps the {ok, data|error} envelope every channel returns. */
async function call(fn, payload) {
  const res = await fn(payload);
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
  return res.data;
}

function toast(message, kind = 'ok', ms = 5000) {
  const el = document.createElement('div');
  el.className = `flash flash--${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}
const oops = (err) => toast(err?.message || String(err), 'bad', 9000);

/* ---------------------------------------------------------------- dates */

function ago(ts) {
  if (!ts) return 'date unknown';
  const t = new Date(String(ts).includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).getTime();
  if (!t) return 'date unknown';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) {
    const hours = Math.floor((Date.now() - t) / 3600000);
    return hours <= 1 ? 'just now' : `${hours} hours ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dueLabel(dateStr) {
  const due = new Date(`${dateStr}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return { text: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`, over: true };
  if (days === 0) return { text: 'due today', over: false };
  if (days === 1) return { text: 'due tomorrow', over: false };
  return { text: `due in ${days} days`, over: false };
}

const MODE_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', unknown: 'Mode unclear' };

/* --------------------------------------------------------------- drawer */

let restoreFocus = null;

function openDrawer(title, sub) {
  restoreFocus = document.activeElement;
  $('#drawer-title').textContent = title || '';
  $('#drawer-sub').textContent = sub || '';
  $('#drawer-body').innerHTML = '<p class="muted small"><span class="spin"></span> Loading…</p>';
  $('#drawer-foot').innerHTML = '';
  $('#drawer').setAttribute('data-open', '');
  $('#scrim').setAttribute('data-open', '');
  $('#drawer-close').focus();
}
function closeDrawer() {
  $('#drawer').removeAttribute('data-open');
  $('#scrim').removeAttribute('data-open');
  if (restoreFocus?.isConnected) restoreFocus.focus();
}
$('#scrim').addEventListener('click', closeDrawer);
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#drawer').hasAttribute('data-open')) closeDrawer();
});

/* Keeps focus inside the drawer while it is open. */
$('#drawer').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', $('#drawer'))
    .filter((el) => el.offsetParent !== null && !el.disabled);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* --------------------------------------------------------------- router */

const VIEWS = {};
let currentRoute = '';

function go(route) {
  if (!VIEWS[route]) route = 'today';
  currentRoute = route;
  $$('.view').forEach((v) => v.removeAttribute('data-active'));
  $(`#view-${route}`).setAttribute('data-active', '');
  $$('#nav a').forEach((a) => {
    a.toggleAttribute('aria-current', a.getAttribute('href') === `#/${route}`);
  });
  $('#body').scrollTop = 0;
  VIEWS[route]().catch(oops);
}

window.addEventListener('hashchange', () => go((location.hash || '#/today').slice(2)));

/* -------------------------------------------------------------- refresh */

let refreshing = false;

async function runRefresh() {
  if (refreshing) { toast('Already looking — give it a moment.'); return; }
  try { await call(window.api.refresh.run, {}); }
  catch (err) { oops(err); }
}

function wireRefreshButtons() {
  for (const id of ['#btn-refresh', '#btn-refresh-2']) $(id)?.addEventListener('click', runRefresh);

  window.api.refresh.onStart(() => {
    refreshing = true;
    $('#refresh-progress').classList.remove('hidden');
    $$('#btn-refresh, #btn-refresh-2').forEach((b) => {
      b.disabled = true;
      b.dataset.label = b.textContent;
      b.innerHTML = '<span class="spin"></span> Looking…';
    });
  });

  window.api.refresh.onProgress(({ index, total, label }) => {
    $('#refresh-progress').firstElementChild.style.width = `${Math.round(((index + 1) / total) * 100)}%`;
    $('#refresh-progress').title = `Checking ${label}`;
  });

  const finish = () => {
    refreshing = false;
    $('#refresh-progress').classList.add('hidden');
    $('#refresh-progress').firstElementChild.style.width = '0%';
    $$('#btn-refresh, #btn-refresh-2').forEach((b) => {
      b.disabled = false;
      b.textContent = b.dataset.label || 'Find new jobs';
    });
  };

  window.api.refresh.onDone((s) => {
    finish();
    const found = s.inserted
      ? `${s.inserted} new role${s.inserted === 1 ? '' : 's'} found.`
      : 'Nothing new this time.';
    toast(s.errors?.length ? `${found} ${s.errors.length} source(s) had trouble — see Sources.` : found,
      s.errors?.length ? 'warn' : 'ok');
    if (['board', 'today'].includes(currentRoute)) go(currentRoute);
    refreshChrome();
  });

  window.api.refresh.onError((e) => { finish(); oops(e); });
}

/* ------------------------------------------------------- shared chrome */

let cvName = null;

async function refreshChrome() {
  try {
    const d = await call(window.api.dashboard.get, {});
    if (!d.cvReady && currentRoute !== 'welcome' && currentRoute !== 'settings') {
      location.hash = '#/welcome';
    }
    $('#nav').classList.toggle('hidden', !d.cvReady);
    $('#capacity').classList.toggle('hidden', !d.cvReady);
    // Read from the stored profile every time rather than cached once: importing
    // a different resume changes the name, and the header has to follow it.
    // Blank until a real resume is in: the placeholder CV's "Your Name" in the
    // header would read as though the app had already been set up.
    const shownName = d.cvReady ? (d.profileName || '') : '';
    if (shownName !== cvName) {
      cvName = shownName;
      $('#wordmark-name').textContent = cvName;
    }
    const dots = Array.from({ length: Math.max(1, d.dailyCap) },
      (_, i) => `<span class="capacity__dot${i < d.remainingToday ? ' capacity__dot--on' : ''}"></span>`).join('');
    $('#capacity').innerHTML =
      `<span class="capacity__dots">${dots}</span><span>${d.remainingToday} of ${d.dailyCap} sends left today</span>`;
    const badge = $('#fu-badge');
    badge.classList.toggle('hidden', !d.followupsDue);
    badge.textContent = d.followupsDue;
    return d;
  } catch { return null; }
}

/* ================================================================ BOARD */

const boardState = {
  search: '', mode: '', country: '', city: '', pools: [], minScore: 0,
  source: '', sort: 'score', page: 1, unappliedOnly: false,
};

function jobCard(j) {
  const applied = j.application_status && j.application_status !== 'draft';
  const drafted = j.application_status === 'draft';
  const low = j.score < 45;
  const place = [j.city, j.region, j.country].filter(Boolean).join(', ') || j.location_raw || '—';
  const terms = (j.matched_terms || []).slice(0, 7)
    .map((t) => `<i>${esc(t)}</i>`).join('')
    + ((j.matched_terms || []).length > 7 ? `<i>+${j.matched_terms.length - 7} more</i>` : '');

  const action = applied
    ? `<button class="btn btn--sm" data-open-app="${j.application_id}">See what was sent</button>`
    : drafted
      ? `<button class="btn btn--primary btn--sm" data-open-app="${j.application_id}">Finish the draft</button>`
      : `<button class="btn btn--primary btn--sm" data-apply="${j.id}">Tailor &amp; apply</button>`;

  return `<article class="card${low ? ' card--low' : ''}${applied ? ' card--applied' : ''}"
      style="--rail-h:${Math.max(14, Math.min(88, j.score))}%">
    <div class="card__top">
      <div style="flex:1;min-width:0">
        <h3 class="card__title">${esc(j.title)}</h3>
        <p class="card__org"><b>${esc(j.company || 'Unnamed employer')}</b> · ${esc(place)}</p>
      </div>
      <div class="score${low ? ' score--low' : ''}"><b>${j.score}</b><span>match</span></div>
    </div>
    <div class="meta">
      ${applied ? '<span class="tag tag--applied">Applied</span>' : ''}
      <span class="tag tag--${esc(j.work_mode)}">${esc(MODE_LABEL[j.work_mode] || 'Mode unclear')}</span>
      ${j.employment_type ? `<span>${esc(j.employment_type)}</span>` : ''}
      ${j.salary_text ? `<span>${esc(j.salary_text)}</span>` : ''}
      <span>${esc(ago(j.posted_at))}</span>
      <span>via ${esc(j.source_label || j.source_type)}</span>
      ${j.apply_email ? '<span title="This one can be applied to by email">direct email</span>' : ''}
    </div>
    ${terms ? `<div class="kw">${terms}</div>` : ''}
    ${j.description_text ? `<p class="card__excerpt">${esc(j.description_text.slice(0, 300))}…</p>` : ''}
    <div class="card__foot">
      ${action}
      <button class="btn btn--sm" data-view="${j.id}">Read the role</button>
      <span class="spacer"></span>
      <button class="btn btn--ghost btn--sm" data-hide="${j.id}">Not relevant</button>
    </div>
  </article>`;
}

let boardTimer = null;
const reloadBoard = () => {
  boardState.page = 1;
  clearTimeout(boardTimer);
  boardTimer = setTimeout(() => loadBoard(false), 220);
};

async function loadBoard(append = false) {
  const cards = $('#cards');
  if (!append) {
    cards.style.opacity = '.45';
    if (!cards.children.length) {
      cards.innerHTML = Array.from({ length: 3 },
        () => '<div class="skeleton" style="height:186px"></div>').join('');
    }
  }
  try {
    const d = await call(window.api.jobs.list, boardState);
    const html = d.rows.map(jobCard).join('') || `<div class="empty">
        <h3>Nothing matches that</h3>
        <p>Either loosen the filters on the left, or add a search word on the Keywords page and look again.</p>
      </div>`;
    cards.innerHTML = append ? cards.innerHTML + d.rows.map(jobCard).join('') : html;
    $('#board-count').textContent = d.total === 1 ? '1 role' : `${d.total.toLocaleString()} roles`;
    $('#btn-more').classList.toggle('hidden', !d.hasMore);
  } catch (err) { oops(err); }
  cards.style.opacity = '';
}

VIEWS.board = async function board() {
  const facets = await call(window.api.jobs.facets, {});
  const country = $('#f-country');
  if (country.options.length <= 1) {
    country.innerHTML = '<option value="">Anywhere</option>'
      + facets.countries.map((c) => `<option value="${esc(c.country)}">${esc(c.country)} (${c.n})</option>`).join('');
    $('#f-source').innerHTML = '<option value="">Every source</option>'
      + facets.sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }
  const status = await call(window.api.refresh.status, {});
  $('#board-sub').textContent = status.lastAt
    ? `Ranked against the words on the Keywords page. Last looked ${ago(status.lastAt)}.`
    : 'Ranked against the words on the Keywords page. Press "Find new jobs" to fill the board.';
  await loadBoard(false);
};

function wireBoard() {
  $('#f-q').addEventListener('input', (e) => { boardState.search = e.target.value.trim(); reloadBoard(); });
  $('#f-city').addEventListener('input', (e) => { boardState.city = e.target.value.trim(); reloadBoard(); });
  $('#f-country').addEventListener('change', (e) => { boardState.country = e.target.value; reloadBoard(); });
  $('#f-source').addEventListener('change', (e) => { boardState.source = e.target.value; reloadBoard(); });
  $('#f-sort').addEventListener('change', (e) => { boardState.sort = e.target.value; reloadBoard(); });
  $('#f-unapplied').addEventListener('change', (e) => { boardState.unappliedOnly = e.target.checked; reloadBoard(); });

  $('#f-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    $$('#f-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    boardState.mode = b.dataset.mode;
    reloadBoard();
  });
  $('#f-pool').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pool]');
    if (!b) return;
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    boardState.pools = $$('#f-pool [aria-pressed=true]').map((x) => x.dataset.pool);
    reloadBoard();
  });
  $('#f-score').addEventListener('input', (e) => {
    boardState.minScore = Number(e.target.value);
    $('#f-score-out').textContent = boardState.minScore ? `${boardState.minScore} and above` : 'Any match';
    reloadBoard();
  });
  $('#f-reset').addEventListener('click', () => {
    Object.assign(boardState, { search: '', mode: '', country: '', city: '', pools: [], minScore: 0,
      source: '', page: 1, unappliedOnly: false });
    $('#f-q').value = ''; $('#f-city').value = ''; $('#f-country').value = '';
    $('#f-source').value = ''; $('#f-score').value = 0; $('#f-unapplied').checked = false;
    $('#f-score-out').textContent = 'Any match';
    $$('#f-mode button').forEach((x, i) => x.setAttribute('aria-pressed', String(i === 0)));
    $$('#f-pool .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    loadBoard(false);
  });
  $('#btn-more').addEventListener('click', () => { boardState.page += 1; loadBoard(true); });

  $('#cards').addEventListener('click', async (e) => {
    const hide = e.target.closest('[data-hide]');
    const view = e.target.closest('[data-view]');
    const apply = e.target.closest('[data-apply]');
    const openApp = e.target.closest('[data-open-app]');

    if (hide) {
      const card = hide.closest('.card');
      card.style.opacity = '.3';
      try { await call(window.api.jobs.setStatus, { id: Number(hide.dataset.hide), status: 'hidden' }); card.remove(); }
      catch (err) { card.style.opacity = ''; oops(err); }
      return;
    }
    if (view) return showJob(Number(view.dataset.view));
    if (apply) return startApply(Number(apply.dataset.apply));
    if (openApp) return showApplication(Number(openApp.dataset.openApp));
  });
}

async function showJob(jobId) {
  openDrawer('Loading…', '');
  try {
    const job = await call(window.api.jobs.get, { id: jobId });
    $('#drawer-title').textContent = job.title;
    $('#drawer-sub').textContent = `${job.company} · ${job.location_raw || '—'}`;
    $('#drawer-body').innerHTML = `<div class="jd">${
      job.description_html || '<p class="muted">The feed did not publish a description for this one.</p>'}</div>`;
    $('#drawer-foot').innerHTML = `
      ${job.application
        ? `<button class="btn btn--primary" data-open-app="${job.application.id}">Open the application</button>`
        : `<button class="btn btn--primary" data-apply="${job.id}">Tailor &amp; apply</button>`}
      ${job.apply_url ? `<button class="btn" data-external="${esc(job.apply_url)}">Open the posting in my browser</button>` : ''}`;
  } catch (err) {
    $('#drawer-body').innerHTML = `<p class="flash flash--bad">${esc(err.message)}</p>`;
  }
}

/* ============================================================ APPLYING */

async function startApply(jobId) {
  openDrawer('Preparing the application',
    'Reading the job description, rewriting the CV against it, drafting the email.');
  $('#drawer-body').innerHTML = `<div class="panel">
      <p class="row" style="margin:0"><span class="spin"></span>
      <span>This takes about twenty seconds. Nothing is sent until you say so.</span></p>
    </div>`;
  try {
    const a = await call(window.api.apply.prepare, { jobId });
    renderApplication(a);
    if (a.spend?.warning) toast(a.spend.warning, 'warn', 9000);
    if (currentRoute === 'board') loadBoard(false);
    refreshChrome();
  } catch (err) {
    $('#drawer-body').innerHTML = `<p class="flash flash--bad">${esc(err.message)}</p>`;
    const needsSettings = /API key|spending limit|limit of|model/i.test(err.message);
    $('#drawer-foot').innerHTML = needsSettings
      ? '<button class="btn btn--primary" data-goto="settings">Open Settings</button>' : '';
  }
}

async function showApplication(id) {
  openDrawer('Loading…', '');
  try { renderApplication(await call(window.api.apply.get, { id })); }
  catch (err) { $('#drawer-body').innerHTML = `<p class="flash flash--bad">${esc(err.message)}</p>`; }
}

function renderApplication(a) {
  const j = a.job || {};
  const sent = ['sent', 'submitted', 'replied', 'interview', 'offer'].includes(a.status);
  $('#drawer-title').textContent = j.title || 'Application';
  $('#drawer-sub').textContent = `${j.company || ''} · ${j.location_raw || ''}`;

  const template = a.mode !== 'ai';
  const WARN = /\bnot\b|\bno\b|lack|requir|licen|visa|missing|unlikely|blocker|removed|stretch|template|keyword/i;
  const notes = (a.match_notes || []).map((n) =>
    `<li class="${WARN.test(n) ? 'warn' : ''}">${esc(n)}</li>`).join('')
    || '<li>No notes came back for this one.</li>';

  const fileRow = `<div class="row" style="margin-top:var(--s3);flex-wrap:wrap">
      <button class="btn btn--sm" data-file="open:pdf">Open the PDF</button>
      <button class="btn btn--sm" data-file="open:docx">Open the Word version</button>
      <button class="btn btn--sm" data-file="saveAs:pdf">Save a copy…</button>
      <button class="btn btn--ghost btn--sm" data-file="reveal:pdf">Show me the file</button>
    </div>`;

  $('#drawer-body').innerHTML = `
    ${sent ? `<p class="flash flash--ok">Sent ${esc(ago(a.sent_at))}${
      a.to_email ? ` to ${esc(a.to_email)}` : ' through the company form'}. This is exactly what went out.</p>` : ''}

    <div class="panel">
      <div class="ring">
        <div class="ring__dial" style="--pct:${a.match_score || 0}"><i>${a.match_score || 0}</i></div>
        <div style="flex:1">
          <h3 style="margin-bottom:var(--s2)">${template ? 'How this scored' : 'How well this actually fits'}</h3>
          <ul class="notes">${notes}</ul>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head"><h3>${template ? 'Your CV' : 'The tailored CV'}</h3>
        ${template ? '<span class="pill pill--draft">master copy</span>'
    : '<span class="pill pill--sent">rewritten for this role</span>'}</div>
      <p class="small muted">${template
    ? 'Your full CV, exactly as it is on the Settings page. With a Claude key it would be rewritten for this particular job — reordered, reworded, and trimmed to what this employer asked for.'
    : 'Rewritten for this role. Dates, employers, degrees and the session count are locked to the master CV and cannot be changed by the rewrite.'}</p>
      ${fileRow}
      ${template ? `<p class="inline-note" style="margin-top:var(--s3)">
        <a href="#" data-goto="settings">See what a key adds</a> — it is optional, and everything else here works without one.</p>` : ''}
    </div>

    <div class="panel">
      <div class="panel__head"><h3>${sent ? 'The email that went out' : 'The email you will send'}</h3></div>
      <label class="field" style="margin-bottom:var(--s4)"><span>To</span>
        <input type="email" id="a-to" value="${esc(a.to_email)}" ${sent ? 'readonly' : ''}
          placeholder="No address was published — add one, or use the company form"></label>
      <label class="field" style="margin-bottom:var(--s4)"><span>Subject</span>
        <input type="text" id="a-subject" value="${esc(a.subject)}" ${sent ? 'readonly' : ''}></label>
      <label class="field"><span>Message</span>
        <textarea id="a-body" rows="13" ${sent ? 'readonly' : ''}>${esc(a.body_text)}</textarea></label>
      ${template && !sent ? `<p class="flash flash--warn" style="margin:var(--s3) 0 0">
        Replace the line in square brackets with one sentence about why this role — then it is ready.
        That sentence is the part a template cannot write for you.</p>` : ''}
    </div>

    <details class="panel">
      <summary style="cursor:pointer"><b>Covering letter</b>
        <span class="muted small">— for forms that ask for one separately</span></summary>
      <pre class="selectable" style="white-space:pre-wrap;font:inherit;margin-top:var(--s4);color:var(--body)">${esc(a.cover_letter)}</pre>
      <button class="btn btn--sm" style="margin-top:var(--s3)" data-copy="cover">Copy it</button>
    </details>

    ${a.followups?.length ? `<div class="panel">
      <div class="panel__head"><h3>Follow-ups</h3></div>
      ${a.followups.map((f) => {
    const d = dueLabel(f.due_on);
    return `<div class="row small" style="gap:var(--s3);padding:var(--s2) 0">
          <span class="pill pill--${f.status === 'sent' ? 'sent' : 'draft'}">${esc(f.status)}</span>
          <span>Follow-up ${f.seq}</span><span class="spacer"></span>
          <span class="muted">${f.status === 'sent' ? esc(ago(f.sent_at)) : esc(d.text)}</span>
        </div>`;
  }).join('')}
    </div>` : ''}

    ${a.error ? `<p class="flash flash--bad">${esc(a.error)}</p>` : ''}`;

  const canEmail = !!a.to_email;
  $('#drawer-foot').innerHTML = sent
    ? `<span class="pill pill--${esc(a.status)}">${esc(a.status)}</span>
       <select id="a-status" style="width:auto">
         ${['sent', 'submitted', 'replied', 'interview', 'rejected', 'offer', 'withdrawn']
    .map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
       </select>
       <span class="spacer"></span><button class="btn" id="a-done">Close</button>`
    : `<button class="btn btn--primary" id="a-send" ${canEmail ? '' : 'aria-disabled="true" title="No address was published for this role"'}>Send it now</button>
       ${j.apply_url ? '<button class="btn" id="a-form">Fill in the company form</button>' : ''}
       <button class="btn btn--ghost" id="a-save">Save as a draft</button>
       <span class="spacer"></span><span class="small muted">Application #${a.id}</span>`;

  const collect = () => ({
    id: a.id,
    to_email: $('#a-to').value.trim(),
    subject: $('#a-subject').value.trim(),
    body_text: $('#a-body').value,
  });

  $('#drawer-body').addEventListener('click', async (e) => {
    const file = e.target.closest('[data-file]');
    const copy = e.target.closest('[data-copy]');
    if (copy) { navigator.clipboard.writeText(a.cover_letter || ''); toast('Copied.'); return; }
    if (!file) return;
    const [action, which] = file.dataset.file.split(':');
    try {
      if (action === 'saveAs') {
        const to = await call(window.api.files.saveAs, { applicationId: a.id, which });
        if (to) toast('Saved.');
      } else {
        await call(window.api.files[action], { applicationId: a.id, which });
      }
    } catch (err) { oops(err); }
  }, { once: false });

  $('#a-save')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await call(window.api.apply.save, collect()); toast('Saved as a draft.'); }
    catch (err) { oops(err); }
    e.currentTarget.disabled = false;
  });

  $('#a-status')?.addEventListener('change', async (e) => {
    try {
      await call(window.api.apply.setStatus, { id: a.id, status: e.target.value });
      toast('Updated.');
      if (currentRoute === 'applications') go('applications');
      refreshChrome();
    } catch (err) { oops(err); }
  });

  $('#a-done')?.addEventListener('click', closeDrawer);

  $('#a-form')?.addEventListener('click', async () => {
    try {
      await call(window.api.apply.save, collect());
      await call(window.api.browser.open, { applicationId: a.id });
      closeDrawer();
    } catch (err) { oops(err); }
  });

  $('#a-send')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const to = $('#a-to').value.trim();

    if ($('#a-body').value.includes('[One sentence on why this role')) {
      toast('The placeholder line is still in the email. Replace it first.', 'warn', 8000);
      $('#a-body').focus();
      return;
    }

    const rails = await call(window.api.apply.rails, { id: a.id });
    const blocking = rails.problems.filter((p) => !/no email address/i.test(p));
    if (blocking.length) { oops(new Error(blocking[0])); return; }

    if (!confirmSend(to, j.company)) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Sending…';
    try {
      await call(window.api.apply.save, collect());
      await call(window.api.apply.send, { id: a.id });
      toast(`Sent to ${to}. It is logged on the Applications page, and the follow-ups are scheduled.`);
      closeDrawer();
      refreshChrome();
      if (currentRoute === 'board') loadBoard(false);
      if (currentRoute === 'applications') go('applications');
    } catch (err) {
      oops(err);
      btn.disabled = false;
      btn.textContent = 'Send it now';
    }
  });
}

function confirmSend(to, company) {
  // eslint-disable-next-line no-alert
  return window.confirm(`Send this application to ${to}${company ? ` at ${company}` : ''} now?\n\n`
    + 'It cannot be unsent once it goes.');
}

/* ============================================================== WELCOME */

/* ------------------------------------------------------------- welcome */

/** What was read from the resume, held here until it is confirmed. */
let pendingImport = null;

const CONFIDENCE_NOTE = {
  missing: 'not found — please add it',
  low: 'only partly read — worth checking',
};

/** The facts worth showing back: the ones the app leans on constantly. */
const REVIEW_FIELDS = [
  ['name', 'Name', (cv) => cv.name, 'name'],
  ['headline', 'Job title', (cv) => cv.headline, null],
  ['email', 'Email', (cv) => cv.contact?.email, 'email'],
  ['phone', 'Phone', (cv) => cv.contact?.phone, 'phone'],
  ['location', 'Where you are', (cv) => cv.contact?.location, 'location'],
  ['linkedin', 'LinkedIn', (cv) => cv.contact?.linkedin, null],
  ['website', 'Website', (cv) => cv.contact?.website, null],
];

function renderReview(result) {
  pendingImport = result;
  const { cv, confidence, keywords } = result;

  $('#w-source').textContent = result.aiUsed
    ? `Read from ${result.file || 'the text'} with Claude`
    : `Read from ${result.file || 'the text you pasted'}`;

  $('#w-fields').innerHTML = REVIEW_FIELDS.map(([key, label, pick, conf]) => {
    const note = conf ? CONFIDENCE_NOTE[confidence?.[conf]] : '';
    return `<label class="field"><span>${esc(label)}${note
      ? ` <em class="small muted">— ${esc(note)}</em>` : ''}</span>
      <input type="text" data-cv="${key}" value="${esc(pick(cv) || '')}"></label>`;
  }).join('');

  const counts = [
    [(cv.experience || []).length, 'role'],
    [(cv.education || []).length, 'qualification'],
    [Object.values(cv.competencies || {}).flat().length, 'skill'],
  ].map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ');

  $('#w-fields').insertAdjacentHTML('beforeend',
    `<p class="inline-note" style="margin-top:var(--s4)">Also read: ${esc(counts)}.
     You can go through all of it in Settings once you are in.</p>`);

  const chips = (list, kind) => (list.length
    ? list.map((k) => `<span class="chip" title="weight ${k.weight}">${esc(k.term)}</span>`).join('')
    : `<span class="small muted">No ${kind} found — you can add your own in Keywords.</span>`);

  $('#w-keywords').innerHTML = `
    <p class="small"><b>Searched for</b></p>
    <div class="chips">${chips(keywords.query, 'job titles')}</div>
    <p class="small" style="margin-top:var(--s4)"><b>Raises a role's score</b></p>
    <div class="chips">${chips(keywords.boost, 'skills')}</div>`;

  $('#w-step-import').classList.add('hidden');
  $('#w-step-review').classList.remove('hidden');
}

/** The edits made on the review screen belong to the CV, not just the boxes. */
function collectEdits() {
  const cv = JSON.parse(JSON.stringify(pendingImport.cv));
  cv.contact ||= {};
  for (const input of $$('#w-fields [data-cv]')) {
    const v = input.value.trim();
    if (input.dataset.cv === 'name') cv.name = v;
    else if (input.dataset.cv === 'headline') cv.headline = v;
    else cv.contact[input.dataset.cv] = v;
  }
  return cv;
}

/**
 * The Settings version of the review step. Replacing a resume is a bigger event
 * than the first import — there is already a CV, already a vocabulary, and
 * already applications sent against them — so it asks about the keywords
 * separately rather than assuming.
 */
function renderResumeReplacement(read) {
  const box = $('#s-resume-review');
  const { cv } = read;
  const rows = REVIEW_FIELDS
    .map(([, label, pick]) => [label, pick(cv)])
    .filter(([, v]) => v)
    .map(([label, v]) => `<div class="timeline__row"><span class="timeline__dot"></span>
      <span>${esc(label)}</span><span class="small">${esc(v)}</span></div>`).join('');

  box.innerHTML = `
    <div class="panel__head"><h3>Read from ${esc(read.file || 'the file')}</h3></div>
    <div class="timeline">${rows}</div>
    <p class="inline-note" style="margin-top:var(--s3)">
      ${(cv.experience || []).length} roles, ${(cv.education || []).length} qualifications.
      Saving replaces your CV; the version you have now is kept as a backup.</p>
    <label class="row" style="margin-top:var(--s4);gap:var(--s2);align-items:center">
      <input type="checkbox" id="s-resume-rebuild" checked>
      <span class="small">Work out my search words again from this resume</span></label>
    <div class="row" style="margin-top:var(--s3)">
      <button class="btn btn--primary btn--sm" id="s-resume-apply">Use this resume</button>
      <button class="btn btn--sm" id="s-resume-cancel">Cancel</button>
    </div>`;
  box.classList.remove('hidden');

  $('#s-resume-cancel').onclick = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  $('#s-resume-apply').onclick = async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.innerHTML = '<span class="spin"></span> Saving…';
    try {
      const out = await call(window.api.resume.apply, {
        cv, rebuildKeywords: $('#s-resume-rebuild').checked,
      });
      box.classList.add('hidden');
      box.innerHTML = '';
      toast(out.keywords
        ? `Resume replaced. ${out.keywords.added} search words rebuilt, ${out.keywords.keptYours} of yours kept.`
        : 'Resume replaced. Your search words were left as they are.');
      go('settings');                      // redraw with the new details in place
    } catch (err) { oops(err); e.currentTarget.disabled = false; }
  };
}

VIEWS.welcome = async function welcome() {
  const busy = (btn, label) => {
    btn.disabled = true;
    btn.dataset.was = btn.textContent;
    btn.innerHTML = `<span class="spin"></span> ${label}`;
  };
  const done = (btn) => { btn.disabled = false; btn.textContent = btn.dataset.was || btn.textContent; };

  // `e.currentTarget` is null once the handler has awaited — the event has
  // finished dispatching by then — so the button is captured up front.
  $('#w-choose').onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, 'Reading…');
    try {
      const result = await call(window.api.resume.choose, {});
      if (result) renderReview(result);          // null means it was cancelled
    } catch (err) { oops(err); }
    done(btn);
  };

  $('#w-read-text').onclick = async (e) => {
    const btn = e.currentTarget;
    const text = $('#w-text').value.trim();
    if (!text) { toast('Paste the text of your resume first.', 'warn'); return; }
    busy(btn, 'Reading…');
    try { renderReview(await call(window.api.resume.preview, { text })); }
    catch (err) { oops(err); }
    done(btn);
  };

  $('#w-back').onclick = () => {
    pendingImport = null;
    $('#w-step-review').classList.add('hidden');
    $('#w-step-import').classList.remove('hidden');
  };

  $('#w-save').onclick = async (e) => {
    const btn = e.currentTarget;
    if (!pendingImport) return;
    const cv = collectEdits();
    if (!cv.name) { toast('A name is needed — it goes on every document.', 'warn'); return; }
    busy(btn, 'Setting up…');
    try {
      const out = await call(window.api.resume.apply, { cv, rebuildKeywords: true });
      const n = out.keywords?.added || 0;
      toast(`Set up for ${out.cv.name} — ${n} search word${n === 1 ? '' : 's'} from your resume.`);
      pendingImport = null;
      location.hash = '#/today';
    } catch (err) { oops(err); done(btn); }
  };
};

/* ================================================================ TODAY */

VIEWS.today = async function today() {
  const d = await refreshChrome() || await call(window.api.dashboard.get, {});
  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  $('#setup-banner').innerHTML = !d.canSendEmail ? `
    <div class="panel" style="margin-bottom:var(--s6);border-color:var(--accent-line);background:var(--accent-tint)">
      <div class="panel__head"><h3>One thing to set up</h3></div>
      <p class="small">Finding jobs, ranking them, generating your CV and filling in company forms all work
        already. To send applications by email from your own address, add the mailbox password — two minutes, once.</p>
      <button class="btn btn--primary" style="margin-top:var(--s3)" data-goto="settings">Add the mailbox</button>
    </div>`
    : (!d.aiEnabled && !localStorage.getItem('jd-ai-dismissed') ? `
    <div class="panel" style="margin-bottom:var(--s6)">
      <div class="panel__head"><h3>Everything here is working</h3>
        <button class="btn btn--ghost btn--sm" id="dismiss-ai">Hide this</button></div>
      <p class="small muted">You are applying with your full CV and a template letter, which is a perfectly
        respectable way to apply. Adding a Claude key would rewrite the CV for each role and write each
        email from the job description — about ₹5 an application, and entirely optional.</p>
      <button class="btn btn--sm" style="margin-top:var(--s3)" data-goto="settings">See what it adds</button>
    </div>` : '');

  $('#dismiss-ai')?.addEventListener('click', (e) => {
    try { localStorage.setItem('jd-ai-dismissed', '1'); } catch { /* private mode */ }
    e.target.closest('.panel').remove();
  });

  const tiles = [
    { n: d.followupsDue, label: 'Follow-ups due', go: 'followups', urgent: d.followupsDue > 0 },
    { n: d.jobsAvailable, label: 'Roles on the board', go: 'board', note: d.freshToday ? `${d.freshToday} new` : '' },
    { n: d.sent, label: 'Applications sent', go: 'applications' },
    { n: d.interviews, label: 'At interview', go: 'applications' },
    { n: `${d.replyRate}%`, label: 'Reply rate', go: 'applications' },
  ];
  $('#today-tiles').innerHTML = tiles.map((t) => `
    <button class="tile${t.urgent ? ' tile--urgent' : ''}" data-goto="${t.go}">
      <b>${esc(t.n)}</b><span>${esc(t.label)}</span>${t.note ? `<em>${esc(t.note)}</em>` : ''}
    </button>`).join('');

  $('#today-sub').textContent = d.lastRefresh
    ? `Last looked for new roles ${ago(d.lastRefresh)}.`
    : 'No jobs pulled in yet — press "Find new jobs" to fill the board.';

  const { rows: drafts } = await call(window.api.applications.list, { status: 'draft' });
  const fu = await call(window.api.followups.list, {});

  const items = [];
  for (const f of fu.due.slice(0, 5)) {
    const d2 = dueLabel(f.due_on);
    items.push(`<div class="timeline__row">
      <span class="timeline__dot"></span>
      <span><b>Follow up</b> with ${esc(f.company)} on ${esc(f.title)}</span>
      <span class="${d2.over ? 'due due--over' : 'due'}">${esc(d2.text)}</span></div>`);
  }
  for (const a of drafts.slice(0, 5)) {
    items.push(`<div class="timeline__row">
      <span class="timeline__dot"></span>
      <span><b>Finish the draft</b> for ${esc(a.company)} — ${esc(a.title)}</span>
      <span class="small muted">${esc(ago(a.created_at))}</span></div>`);
  }

  $('#today-actions').innerHTML = items.length
    ? `<div class="timeline">${items.join('')}</div>
       <div class="row" style="margin-top:var(--s4)">
         ${fu.due.length ? '<button class="btn btn--primary btn--sm" data-goto="followups">Go to follow-ups</button>' : ''}
         ${drafts.length ? '<button class="btn btn--sm" data-goto="applications">Go to drafts</button>' : ''}
       </div>`
    : `<p class="muted small" style="margin:0">Nothing waiting. ${
      d.jobsAvailable ? 'The board has roles ready when you are.' : 'Press "Find new jobs" to fill the board.'}</p>
       <button class="btn btn--sm" style="margin-top:var(--s3)" data-goto="board">Open the board</button>`;

  $('#today-activity').innerHTML = d.activity.length
    ? d.activity.map((a) => `<div class="timeline__row">
        <span class="timeline__dot timeline__dot--${a.kind === 'sent' || a.kind === 'submitted' ? 'sent'
    : a.kind === 'send_failed' ? 'fail' : ''}"></span>
        <span>${esc(a.detail)}</span>
        <span class="small muted">${esc(ago(a.at))}</span></div>`).join('')
    : '<p class="muted small" style="margin:0">Nothing has happened yet.</p>';
};

/* ========================================================= APPLICATIONS */

const appFilter = { status: '', search: '' };

VIEWS.applications = async function applications() {
  const d = await call(window.api.applications.list, appFilter);
  const c = d.counts;
  const sent = (c.sent || 0) + (c.submitted || 0) + (c.replied || 0) + (c.interview || 0) + (c.offer || 0);
  const replies = (c.replied || 0) + (c.interview || 0) + (c.offer || 0);
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  $('#app-stats').innerHTML = [
    [total, 'Applications'], [sent, 'Actually sent'], [c.interview || 0, 'At interview'],
    [sent ? `${Math.round((replies / sent) * 100)}%` : '0%', 'Reply rate'],
  ].map(([n, l]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('');

  const ORDER = ['draft', 'queued', 'sent', 'submitted', 'failed', 'replied', 'interview', 'rejected', 'offer', 'withdrawn'];
  $('#app-filters').innerHTML = `<button class="chip" data-filter="" ${appFilter.status ? '' : 'aria-pressed="true"'}>All (${total})</button>`
    + ORDER.filter((s) => c[s]).map((s) =>
      `<button class="chip" data-filter="${s}" ${appFilter.status === s ? 'aria-pressed="true"' : ''}>${
        s[0].toUpperCase() + s.slice(1)} (${c[s]})</button>`).join('');

  $('#app-list').innerHTML = d.rows.length ? `<table class="table">
      <thead><tr><th>Role</th><th>Where it went</th><th>Match</th><th>Status</th><th>When</th><th></th></tr></thead>
      <tbody>${d.rows.map(appRow).join('')}</tbody></table>`
    : `<div class="empty"><h3>Nothing here yet</h3>
        <p>When you apply from the board, the tailored CV, the email that went out, and where it stands all land here.</p>
        <p style="margin-top:var(--s4)"><button class="btn btn--primary" data-goto="board">Open the board</button></p></div>`;
};

function appRow(a) {
  const notes = (a.match_notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  const nextFu = (a.followups || []).find((f) => f.status === 'scheduled');
  return `<tr>
    <td>
      <div class="t-title">${esc(a.title)}</div>
      <div class="rowline small muted" style="margin-top:var(--s2)">
        <span>${esc(a.company)}</span><span class="sep">·</span>
        <span>${esc(a.location_raw || '—')}</span>
        <span class="tag tag--${esc(a.work_mode)}">${esc(MODE_LABEL[a.work_mode] || '—')}</span>
      </div>
      ${notes ? `<details style="margin-top:var(--s2)">
        <summary class="small muted" style="cursor:pointer">Fit notes</summary>
        <ul class="notes" style="margin-top:var(--s2)">${notes}</ul></details>` : ''}
    </td>
    <td>
      ${a.to_email
    ? `<div class="small">${esc(a.to_email)}</div><div class="small muted" style="margin-top:2px">${esc(a.subject)}</div>`
    : '<span class="muted small">Company form</span>'}
      ${a.error ? `<div class="small" style="color:var(--clay);margin-top:var(--s2)">${esc(a.error)}</div>` : ''}
      ${nextFu ? `<div class="inline-note">Follow-up ${nextFu.seq} ${esc(dueLabel(nextFu.due_on).text)}</div>` : ''}
    </td>
    <td><strong style="font-variant-numeric:tabular-nums">${a.match_score}</strong></td>
    <td><span class="pill pill--${esc(a.status)}">${esc(a.status)}</span></td>
    <td class="small muted">${esc(ago(a.sent_at || a.created_at))}</td>
    <td><button class="btn btn--sm" data-open-app="${a.id}">Open</button></td>
  </tr>`;
}

function wireApplications() {
  $('#app-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    appFilter.status = b.dataset.filter;
    go('applications');
  });
  let t = null;
  $('#app-search').addEventListener('input', (e) => {
    clearTimeout(t);
    appFilter.search = e.target.value;
    t = setTimeout(() => go('applications'), 240);
  });
  $('#app-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open-app]');
    if (b) showApplication(Number(b.dataset.openApp));
  });
  window.api.onApplicationsChanged(() => {
    if (currentRoute === 'applications') go('applications');
    refreshChrome();
  });
}

/* =========================================================== FOLLOW-UPS */

VIEWS.followups = async function followupsView() {
  const d = await call(window.api.followups.list, {});

  $('#fu-due').innerHTML = d.due.length ? `<div class="fu">${d.due.map(fuCard).join('')}</div>`
    : `<div class="empty"><h3>Nothing to chase today</h3>
        <p>Follow-ups appear here on the day they are due. They are scheduled automatically
           when an application goes out.</p></div>`;

  $('#fu-upcoming').innerHTML = d.upcoming.length
    ? `<div class="timeline">${d.upcoming.map((f) => `<div class="timeline__row">
        <span class="timeline__dot"></span>
        <span>${esc(f.company)} — ${esc(f.title)}</span>
        <span class="small muted">${esc(dueLabel(f.due_on).text)}</span></div>`).join('')}</div>`
    : '<p class="muted small" style="margin:0">Nothing scheduled.</p>';

  $('#fu-history').innerHTML = d.history.length
    ? `<div class="timeline">${d.history.map((f) => `<div class="timeline__row">
        <span class="timeline__dot timeline__dot--${f.status === 'sent' ? 'sent' : ''}"></span>
        <span>${esc(f.company)} — follow-up ${f.seq}</span>
        <span class="small muted">${f.status === 'sent' ? esc(ago(f.sent_at)) : 'skipped'}</span></div>`).join('')}</div>`
    : '<p class="muted small" style="margin:0">None sent yet.</p>';
};

function fuCard(f) {
  const d = dueLabel(f.due_on);
  const applied = ago(f.sent_at);
  return `<article class="fu__card" ${d.over ? 'data-overdue' : ''} data-fu="${f.id}">
    <div class="fu__head">
      <div style="flex:1;min-width:0">
        <h3 style="font-size:var(--t-lg)">${esc(f.company)} — ${esc(f.title)}</h3>
        <p class="small muted" style="margin:var(--s1) 0 0">
          Applied ${esc(applied)} · follow-up ${f.seq}${f.to_email ? ` · ${esc(f.to_email)}` : ''}</p>
      </div>
      <span class="${d.over ? 'due due--over' : 'due'}">${esc(d.text)}</span>
    </div>
    ${f.to_email ? `
      <label class="field" style="margin-bottom:var(--s3)"><span>Subject</span>
        <input type="text" data-fu-subject value="${esc(f.subject || `Following up — ${f.title}`)}"></label>
      <label class="field"><span>Message</span>
        <textarea rows="7" data-fu-body placeholder="Press ‘Write it for me’, or type it yourself.">${esc(f.body_text)}</textarea></label>
      <div class="row" style="margin-top:var(--s4);flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" data-fu-send>Send the follow-up</button>
        <button class="btn btn--sm" data-fu-draft>Write it for me</button>
        <span class="spacer"></span>
        <button class="btn btn--ghost btn--sm" data-fu-snooze="7">Remind me in a week</button>
        <button class="btn btn--ghost btn--sm" data-fu-skip>Skip this one</button>
      </div>`
    : `<p class="small muted">This one was submitted through a company form, so there is no address to
        follow up with. Check the portal for an update.</p>
      <div class="row" style="margin-top:var(--s3)">
        ${f.apply_url ? `<button class="btn btn--sm" data-external="${esc(f.apply_url)}">Open the portal</button>` : ''}
        <button class="btn btn--ghost btn--sm" data-fu-snooze="14">Remind me in two weeks</button>
        <button class="btn btn--ghost btn--sm" data-fu-skip>Mark as done</button>
      </div>`}
  </article>`;
}

function wireFollowups() {
  $('#fu-due').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-fu]');
    if (!card) return;
    const id = Number(card.dataset.fu);
    const btn = e.target.closest('button');
    if (!btn) return;

    try {
      if (btn.hasAttribute('data-fu-draft')) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> Writing…';
        const f = await call(window.api.followups.draft, { id });
        card.querySelector('[data-fu-subject]').value = f.subject;
        card.querySelector('[data-fu-body]').value = f.body_text;
        btn.disabled = false;
        btn.textContent = 'Write it again';
        return;
      }
      if (btn.hasAttribute('data-fu-send')) {
        const subject = card.querySelector('[data-fu-subject]').value.trim();
        const body = card.querySelector('[data-fu-body]').value.trim();
        if (!body) { toast('Write the message first, or press “Write it for me”.', 'warn'); return; }
        // eslint-disable-next-line no-alert
        if (!window.confirm('Send this follow-up now?')) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> Sending…';
        await call(window.api.followups.send, { id, subject, body_text: body });
        toast('Follow-up sent.');
        go('followups');
        refreshChrome();
        return;
      }
      if (btn.hasAttribute('data-fu-skip')) {
        await call(window.api.followups.skip, { id });
        go('followups');
        refreshChrome();
        return;
      }
      const snooze = btn.getAttribute('data-fu-snooze');
      if (snooze) {
        await call(window.api.followups.snooze, { id, days: Number(snooze) });
        toast(`Moved on by ${snooze} days.`);
        go('followups');
        refreshChrome();
      }
    } catch (err) {
      oops(err);
      $$('button', card).forEach((b) => { b.disabled = false; });
      if (btn.hasAttribute('data-fu-draft')) btn.textContent = 'Write it for me';
      if (btn.hasAttribute('data-fu-send')) btn.textContent = 'Send the follow-up';
    }
  });
}

/* ============================================================= KEYWORDS */

const KW_COPY = {
  query: ['Search words',
    'These are what the app asks the job sites for. They decide what turns up at all. '
    + 'Keep the list tight — vague words flood the board with things you would never apply to.'],
  boost: ['Things that raise the score',
    'Never searched for. When one of these turns up in a role, the match score goes up — '
    + 'three times as much if it is in the job title. This is how the ranking gets sharper without adding noise.'],
  exclude: ['Never show me these',
    'If one of these appears in a job title, the role is thrown away before it reaches the board. '
    + 'Use it for jobs that look similar but need a different profession or licence.'],
};

VIEWS.keywords = async function keywords() {
  const d = await call(window.api.keywords.list, {});
  $('#kw-cols').innerHTML = ['query', 'boost', 'exclude'].map((kind) => {
    const [title, blurb] = KW_COPY[kind];
    const rows = d[kind];
    return `<section class="panel" data-kind="${kind}">
      <div class="panel__head"><h3>${esc(title)}</h3><span class="pill pill--draft">${rows.length}</span></div>
      <p class="small muted">${esc(blurb)}</p>
      <form class="row" style="margin:var(--s4) 0;gap:var(--s2)" data-kw-add>
        <input type="text" name="term" placeholder="Add a word…" required style="flex:1" autocomplete="off">
        <input type="number" name="weight" value="${kind === 'exclude' ? 10 : 6}" min="1" max="10"
               title="How much weight it carries, 1 to 10" style="width:64px">
        <button class="btn btn--primary btn--sm" type="submit">Add</button>
      </form>
      <div class="stack" style="gap:var(--s2)">
        ${rows.map((k) => `<div class="row" style="gap:var(--s2);padding:var(--s2) var(--s3);
            border:1px solid var(--n100);border-radius:var(--r-md);
            background:${k.active ? 'var(--surface)' : 'var(--n50)'}">
          <label class="row" style="gap:var(--s2);flex:1;min-width:0;cursor:pointer">
            <input type="checkbox" ${k.active ? 'checked' : ''} data-kw-toggle="${k.id}">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${
  k.active ? '' : ';opacity:.5'}">${esc(k.term)}</span>
          </label>
          <span class="small muted" title="How many roles this word has matched">${k.hits}</span>
          <span class="small muted" title="Weight">w${k.weight}</span>
          <button class="btn btn--ghost btn--sm btn--danger" data-kw-del="${k.id}"
                  data-term="${esc(k.term)}" title="Remove">×</button>
        </div>`).join('') || '<p class="small muted">Nothing on this list yet.</p>'}
      </div>
    </section>`;
  }).join('');
};

function wireKeywords() {
  $('#kw-cols').addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-kw-add]');
    if (!form) return;
    e.preventDefault();
    const kind = form.closest('[data-kind]').dataset.kind;
    try {
      await call(window.api.keywords.add, {
        kind, term: form.term.value.trim(), weight: Number(form.weight.value),
      });
      toast('Added. It will be used the next time it looks for jobs.');
      go('keywords');
    } catch (err) { oops(err); }
  });

  $('#kw-cols').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-kw-del]');
    if (!del) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove “${del.dataset.term}”?`)) return;
    try { await call(window.api.keywords.remove, { id: Number(del.dataset.kwDel) }); go('keywords'); }
    catch (err) { oops(err); }
  });

  $('#kw-cols').addEventListener('change', async (e) => {
    const t = e.target.closest('[data-kw-toggle]');
    if (!t) return;
    try { await call(window.api.keywords.toggle, { id: Number(t.dataset.kwToggle) }); }
    catch (err) { oops(err); }
  });
}

/* =============================================================== SOURCES */

VIEWS.sources = async function sourcesView() {
  const d = await call(window.api.sources.list, {});
  $('#src-wrap').innerHTML = `
    <section>
      <table class="table">
        <thead><tr><th>Source</th><th>Last checked</th><th>Found</th><th></th></tr></thead>
        <tbody>${d.rows.map((s) => `<tr>
          <td>
            <div class="t-title">${esc(s.label)}</div>
            <div class="small muted">${esc(s.type)}${s.slug ? ` · ${esc(s.slug)}` : ''}</div>
            ${s.last_error ? `<div class="small" style="color:var(--clay);margin-top:var(--s1)">${esc(s.last_error)}</div>` : ''}
          </td>
          <td class="small muted">${s.last_run_at ? esc(ago(s.last_run_at)) : 'never'}</td>
          <td><span class="pill pill--${s.last_status === 'ok' ? 'sent' : s.last_status ? 'failed' : 'draft'}">${s.last_count}</span></td>
          <td>
            <label class="row small" style="gap:var(--s2)">
              <input type="checkbox" ${s.active ? 'checked' : ''} data-src-toggle="${s.id}"> on</label>
            <div class="row" style="margin-top:var(--s2);gap:var(--s1)">
              <button class="btn btn--sm" data-src-test="${s.id}">Test</button>
              <button class="btn btn--ghost btn--sm btn--danger" data-src-del="${s.id}" data-label="${esc(s.label)}">×</button>
            </div>
          </td></tr>`).join('')}
        </tbody>
      </table>
      <div class="panel" style="margin-top:var(--s5)">
        <div class="panel__head"><h3>Recent checks</h3></div>
        <div class="timeline">${d.recent.map((r) => `<div class="timeline__row">
          <span class="timeline__dot timeline__dot--${r.ok ? 'sent' : 'fail'}"></span>
          <span>${esc(r.label)} — ${r.found} found, ${r.inserted} new${r.error ? ` · ${esc(r.error)}` : ''}</span>
          <span class="small muted">${esc(ago(r.at))}</span></div>`).join('')
    || '<p class="small muted" style="margin:0">No checks recorded yet.</p>'}</div>
      </div>
    </section>

    <section>
      <div class="panel">
        <div class="panel__head"><h3>Add a company's career page</h3></div>
        <p class="small muted">Most employers publish their openings through Greenhouse, Lever, Ashby or
          Workable. Give it the company's name from its careers web address — it is checked against the
          real thing before it is saved.</p>
        <form id="src-form" class="stack" style="margin-top:var(--s4)">
          <label class="field"><span>Kind</span>
            <select name="type">${Object.entries(d.types).map(([k, v]) =>
    `<option value="${esc(k)}" ${k === 'greenhouse' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          <label class="field"><span>Company name</span><input name="label" placeholder="Lyra Health" required></label>
          <label class="field"><span>Board name or feed address</span><input name="slug" placeholder="lyrahealth"></label>
          <div class="row">
            <button class="btn" type="button" id="src-test">Check it first</button>
            <button class="btn btn--primary" type="submit">Add it</button>
          </div>
        </form>
        <div id="src-out" style="margin-top:var(--s4)"></div>
      </div>
      ${d.suggested?.length ? `<div class="panel" style="margin-top:var(--s5)">
        <div class="panel__head"><h3>Worth trying</h3></div>
        <p class="small muted">Employers who hire into your field. Company names change when a company
          switches systems, so each one is checked before it is added.</p>
        <div class="chips" style="margin-top:var(--s4)">
          ${d.suggested.map((b) => `<button class="chip" data-suggest='${esc(JSON.stringify(b))}'>${esc(b[1])}</button>`).join('')}
        </div></div>` : ''}
    </section>`;

  const form = $('#src-form');
  const out = $('#src-out');

  const test = async () => {
    out.innerHTML = '<p class="small muted"><span class="spin"></span> Asking that board what it has open…</p>';
    try {
      const r = await call(window.api.sources.probe, { type: form.type.value, slug: form.slug.value.trim() });
      out.innerHTML = r.ok
        ? `<div class="flash flash--ok">${r.count} openings found.${
          r.samples.length ? `<ul class="notes" style="margin-top:var(--s2)">${
            r.samples.map((s) => `<li>${esc(s.title)}${s.location ? ` — ${esc(s.location)}` : ''}</li>`).join('')}</ul>` : ''}</div>`
        : `<div class="flash flash--bad">${esc(r.error || 'That board did not reply.')}</div>`;
    } catch (err) { out.innerHTML = `<div class="flash flash--bad">${esc(err.message)}</div>`; }
  };

  $('#src-test').addEventListener('click', test);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call(window.api.sources.add, {
        type: form.type.value, label: form.label.value.trim(), slug: form.slug.value.trim(),
      });
      toast('Added.');
      go('sources');
    } catch (err) { out.innerHTML = `<div class="flash flash--bad">${esc(err.message)}</div>`; }
  });
  $$('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
    const [type, label, slug] = JSON.parse(b.dataset.suggest);
    form.type.value = type; form.label.value = label; form.slug.value = slug;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    test();
  }));

  $('#src-wrap').addEventListener('change', async (e) => {
    const t = e.target.closest('[data-src-toggle]');
    if (t) { try { await call(window.api.sources.toggle, { id: Number(t.dataset.srcToggle) }); } catch (err) { oops(err); } }
  });
  $('#src-wrap').addEventListener('click', async (e) => {
    const test2 = e.target.closest('[data-src-test]');
    const del = e.target.closest('[data-src-del]');
    if (test2) {
      const row = d.rows.find((r) => r.id === Number(test2.dataset.srcTest));
      test2.disabled = true;
      test2.innerHTML = '<span class="spin"></span>';
      try {
        const r = await call(window.api.sources.probe, { type: row.type, slug: row.slug });
        toast(r.ok ? `${row.label}: ${r.count} openings found.` : `${row.label}: ${r.error}`, r.ok ? 'ok' : 'bad');
      } catch (err) { oops(err); }
      test2.disabled = false;
      test2.textContent = 'Test';
    }
    if (del) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Remove ${del.dataset.label}?`)) return;
      try { await call(window.api.sources.remove, { id: Number(del.dataset.srcDel) }); go('sources'); }
      catch (err) { oops(err); }
    }
  });
};

/* ============================================================== SETTINGS */

VIEWS.settings = async function settingsView() {
  const s = await call(window.api.settings.get, {});
  const b = s.budget || { pricing: {}, model: '', cap: 0, spent: 0, percent: 0, capped: false,
    perApplication: 0, modelLabel: '', remaining: 0 };

  $('#settings-wrap').innerHTML = `
  <div class="grid-2">

    <section class="panel">
      <div class="panel__head"><h3>Claude — optional</h3>
        <span class="pill pill--${s.aiEnabled ? 'sent' : 'draft'}">${s.aiEnabled ? 'on' : 'off — app still works'}</span>
      </div>
      <p class="small muted">The app is fully usable without this. A key changes three things:</p>
      <ul class="notes" style="margin:var(--s3) 0 var(--s4)">
        <li><b>The CV is rewritten for each role</b> — reordered, reworded to the employer's own language,
          and trimmed to what they asked for, instead of sending the same master CV every time.</li>
        <li><b>The email is written from the job description</b> — specific to that role, instead of a
          template with one sentence for you to fill in.</li>
        <li><b>An honest read on whether you qualify</b> — including blockers like a licence you do
          not hold, which keyword matching cannot see.</li>
      </ul>
      <p class="small muted">Follow-up notes get written for you too. Billed per use against a prepaid
        balance — separate from any Claude subscription, which this app cannot touch.
        <a href="#" data-external="https://console.anthropic.com/settings/keys">Get a key</a>.</p>

      <label class="field" style="margin-top:var(--s4)"><span>API key</span>
        <input type="password" id="s-claude" placeholder="${s.has_anthropic_key ? '•••••••••••••••• (already saved)' : 'sk-ant-… — leave empty to keep using templates'}"
               autocomplete="off" spellcheck="false"></label>
      <div class="row" style="margin-top:var(--s3)">
        <button class="btn btn--primary btn--sm" id="s-claude-save">Save the key</button>
        <button class="btn btn--sm" id="s-claude-test" ${s.has_anthropic_key ? '' : 'disabled'}>Check it works</button>
        ${s.has_anthropic_key ? '<button class="btn btn--ghost btn--sm btn--danger" id="s-claude-clear">Remove it</button>' : ''}
      </div>

      <label class="field" style="margin-top:var(--s5)"><span>Which model to use</span>
        <select id="s-model">
          ${Object.entries(b.pricing).map(([id, p]) =>
    `<option value="${esc(id)}" ${id === b.model ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select>
        <span class="inline-note">Sonnet is the sensible default. Haiku costs about half and is still
          perfectly good for this — worth trying if the bill matters more than the last 5% of polish.</span>
      </label>
    </section>

    <section class="panel">
      <div class="panel__head"><h3>Spending limit</h3>
        <span class="pill pill--${b.capped ? (b.percent >= 80 ? 'queued' : 'sent') : 'draft'}">
          ${b.capped ? `${b.percent}% used` : 'no limit'}</span>
      </div>
      <p class="small muted">A hard stop, checked before every single request. When the month's limit is
        reached the app simply refuses to tailor anything else until it is raised or the month turns over.
        It cannot be exceeded by accident.</p>

      <label class="field" style="margin-top:var(--s4)"><span>Most to spend in a month (US dollars)</span>
        <input type="number" id="s-budget" min="0" max="500" step="1" value="${b.cap}">
        <span class="inline-note">Set it to 0 to remove the limit entirely.</span></label>

      ${b.capped ? `<div style="margin-top:var(--s4)">
        <div class="progress" style="height:6px"><i style="width:${b.percent}%;background:${
  b.percent >= 80 ? 'var(--amber)' : 'var(--accent)'}"></i></div>
        <p class="inline-note" style="margin-top:var(--s2)">
          $${b.spent.toFixed(2)} of $${b.cap.toFixed(2)} used this month.
          About $${(b.remaining || 0).toFixed(2)} left — roughly
          ${Math.floor((b.remaining || 0) / (b.perApplication || 1))} more applications.
          Resets on the 1st.</p></div>` : ''}

      <div class="row" style="margin-top:var(--s5);gap:var(--s4)">
        <div class="stat" style="flex:1"><b>$${(b.perApplication || 0).toFixed(3)}</b><span>Per application</span></div>
        <div class="stat" style="flex:1"><b>${s.tailor_count || 0}</b><span>Tailored so far</span></div>
        <div class="stat" style="flex:1"><b>$${(s.spend_usd || 0).toFixed(2)}</b><span>Spent, all time</span></div>
      </div>
      <p class="inline-note" style="margin-top:var(--s3)">That is roughly
        ₹${Math.round((b.perApplication || 0) * 88)} per tailored application on ${esc(b.modelLabel.split(' —')[0])}.
        Follow-up drafts cost a fraction of that.</p>
    </section>

    <section class="panel">
      <div class="panel__head"><h3>Your mailbox — for sending</h3>
        <span class="pill pill--${s.has_smtp_password ? 'sent' : 'draft'}">${s.has_smtp_password ? 'set up' : 'not set'}</span>
      </div>
      <p class="small muted">Applications go out from your own address, so replies come back to your
        normal inbox. These are the same details your mail program uses.</p>
      <div class="row" style="margin-top:var(--s4);gap:var(--s3);align-items:flex-start">
        <label class="field" style="flex:2"><span>Mail server</span>
          <input type="text" id="s-host" value="${esc(s.smtp_host)}"></label>
        <label class="field" style="flex:0 0 90px"><span>Port</span>
          <input type="number" id="s-port" value="${s.smtp_port}"></label>
      </div>
      <label class="field" style="margin-top:var(--s3)"><span>Username</span>
        <input type="text" id="s-user" value="${esc(s.smtp_user)}" autocomplete="off"></label>
      <label class="field" style="margin-top:var(--s3)"><span>Password</span>
        <input type="password" id="s-pass" placeholder="${s.has_smtp_password ? '•••••••••••• (already saved)' : 'mailbox password'}"
               autocomplete="off"></label>
      <div class="row" style="margin-top:var(--s3);gap:var(--s3)">
        <label class="field" style="flex:1"><span>Send as (name)</span>
          <input type="text" id="s-fromname" value="${esc(s.smtp_from_name)}"></label>
        <label class="field" style="flex:1"><span>Send as (address)</span>
          <input type="email" id="s-fromemail" value="${esc(s.smtp_from_email)}"></label>
      </div>
      <div class="row" style="margin-top:var(--s4);flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" id="s-mail-save">Save</button>
        <button class="btn btn--sm" id="s-mail-test">Check it works</button>
        <button class="btn btn--sm" id="s-mail-send">Send myself a test</button>
      </div>
      <label class="row small" style="margin-top:var(--s4);gap:var(--s2)">
        <input type="checkbox" id="s-bcc" ${s.bcc_self ? 'checked' : ''}>
        Keep a copy of every application in your own inbox</label>
      ${s.encryption_available ? '' : `<p class="flash flash--warn" style="margin-top:var(--s4)">
        Windows would not give the app its secure store, so these passwords are saved in plain text in
        the data folder. Everything still works — just keep that folder to herself.</p>`}
    </section>

    <section class="panel">
      <div class="panel__head"><h3>How the board behaves</h3></div>
      <label class="field"><span>Throw away roles scoring below</span>
        <input type="number" id="s-minscore" min="0" max="90" value="${s.min_score_to_show}">
        <span class="inline-note">Raise this if the board feels noisy. Anything under it is never stored.</span></label>
      <div class="row" style="margin-top:var(--s4);gap:var(--s3)">
        <label class="field"><span>Remote</span><input type="number" id="s-w-remote" value="${s.work_mode_preference.remote}"></label>
        <label class="field"><span>Hybrid</span><input type="number" id="s-w-hybrid" value="${s.work_mode_preference.hybrid}"></label>
        <label class="field"><span>On-site</span><input type="number" id="s-w-onsite" value="${s.work_mode_preference.onsite}"></label>
      </div>
      <span class="inline-note">How much each working pattern adds to a role's score.</span>
      <label class="field" style="margin-top:var(--s4)"><span>Countries you would take a job in</span>
        <input type="text" id="s-countries" value="${esc((s.preferred_countries || []).join(', '))}"></label>
      <label class="field" style="margin-top:var(--s4)"><span>Look for new jobs every</span>
        <select id="s-refresh">
          ${[['0', 'Only when I ask'], ['3', '3 hours'], ['6', '6 hours'], ['12', '12 hours'], ['24', 'day']]
    .map(([v, l]) => `<option value="${v}" ${String(s.refresh_every_hours) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <label class="row small" style="margin-top:var(--s4);gap:var(--s2)">
        <input type="checkbox" id="s-launch" ${s.refresh_on_launch ? 'checked' : ''}>
        Check for new jobs when the app opens</label>
    </section>

    <section class="panel">
      <div class="panel__head"><h3>Sending and follow-ups</h3></div>
      <label class="field"><span>Most applications to send in one day</span>
        <input type="number" id="s-cap" min="1" max="50" value="${s.max_sends_per_day}">
        <span class="inline-note">A brake, not a target. Applying to forty roles in an afternoon reads
          badly to anyone who notices.</span></label>
      <label class="field" style="margin-top:var(--s4)"><span>Do not apply to the same employer twice within</span>
        <input type="number" id="s-cooldown" min="0" max="180" value="${s.company_cooldown_days}">
        <span class="inline-note">Days.</span></label>
      <label class="row small" style="margin-top:var(--s4);gap:var(--s2)">
        <input type="checkbox" id="s-fu" ${s.followups_enabled ? 'checked' : ''}>
        Schedule follow-ups automatically</label>
      <label class="field" style="margin-top:var(--s3)"><span>Follow up after (days)</span>
        <input type="text" id="s-fudays" value="${esc((s.followup_days || []).join(', '))}">
        <span class="inline-note">Two rounds is usually right. A third rarely helps.</span></label>
    </section>

    <section class="panel">
      <div class="panel__head"><h3>Your details for application forms</h3></div>
      <p class="small muted">What the app types into company forms. Name, email, phone and links come
        from the CV.</p>
      <div class="row" style="margin-top:var(--s4);gap:var(--s3)">
        <label class="field" style="flex:1"><span>City</span><input type="text" id="s-city" value="${esc(s.profile_city || 'Vadodara')}"></label>
        <label class="field" style="flex:1"><span>State</span><input type="text" id="s-state" value="${esc(s.profile_state || 'Gujarat')}"></label>
        <label class="field" style="flex:1"><span>Country</span><input type="text" id="s-country" value="${esc(s.profile_country || 'India')}"></label>
      </div>
      <div class="row" style="margin-top:var(--s3);gap:var(--s3)">
        <label class="field" style="flex:1"><span>Notice period</span><input type="text" id="s-notice" value="${esc(s.profile_notice || 'Immediate')}"></label>
        <label class="field" style="flex:1"><span>Years of experience</span><input type="text" id="s-years" value="${esc(s.profile_years || '8')}"></label>
      </div>
      <label class="field" style="margin-top:var(--s3)"><span>Salary expectation (optional)</span>
        <input type="text" id="s-salary" value="${esc(s.profile_expected_salary || '')}" placeholder="Leave empty to skip the question"></label>
    </section>

    <section class="panel">
      <div class="panel__head"><h3>Job sites that need a key</h3></div>
      <p class="small muted">Adzuna is free and is where most of the Indian listings come from. Without
        it the board leans heavily towards remote-first companies abroad.
        Sign up at <a href="#" data-external="https://developer.adzuna.com/">developer.adzuna.com</a>.</p>
      <div class="row" style="margin-top:var(--s4);gap:var(--s3)">
        <label class="field" style="flex:1"><span>App ID</span>
          <input type="text" id="s-adz-id" placeholder="${s.has_adzuna ? '•••• (saved)' : ''}" autocomplete="off"></label>
        <label class="field" style="flex:1"><span>App key</span>
          <input type="password" id="s-adz-key" placeholder="${s.has_adzuna ? '•••• (saved)' : ''}" autocomplete="off"></label>
      </div>
      <button class="btn btn--primary btn--sm" style="margin-top:var(--s3)" id="s-adz-save">Save the Adzuna keys</button>
    </section>

    <section class="panel" style="grid-column:1/-1">
      <div class="panel__head"><h3>Letter templates</h3>
        <span class="pill pill--${s.aiEnabled ? 'draft' : 'sent'}">${s.aiEnabled ? 'fallback only' : 'in use'}</span>
        <button class="btn btn--ghost btn--sm" id="s-tpl-reset">Reset to the originals</button>
      </div>
      <p class="small muted">${s.aiEnabled
    ? 'Used only if the Claude key stops working, so applications never come to a halt.'
    : 'These are what you are sending now. Anything in double braces is filled in automatically — {{title}}, {{company}}, {{credentials}}, {{signature}}, {{days}}.'}</p>
      <div class="grid-3" style="margin-top:var(--s4)">
        <label class="field"><span>Application email</span>
          <textarea id="s-tpl-email" class="mono" spellcheck="false" style="min-height:260px">${esc(s.templates?.template_email || '')}</textarea></label>
        <label class="field"><span>Covering letter</span>
          <textarea id="s-tpl-cover" class="mono" spellcheck="false" style="min-height:260px">${esc(s.templates?.template_cover || '')}</textarea></label>
        <label class="field"><span>Follow-up</span>
          <textarea id="s-tpl-followup" class="mono" spellcheck="false" style="min-height:260px">${esc(s.templates?.template_followup || '')}</textarea></label>
      </div>
      <div class="row" style="margin-top:var(--s3)">
        <button class="btn btn--primary btn--sm" id="s-tpl-save">Save the templates</button>
        <span class="small muted" id="s-tpl-status"></span>
      </div>
    </section>

    <section class="panel" style="grid-column:1/-1">
      <div class="panel__head"><h3>Your resume</h3>
        <span class="spacer"></span>
        <span class="small muted">${s.resume_imported_at
    ? `Last read ${esc(ago(s.resume_imported_at))}` : 'Entered by hand'}</span>
      </div>
      <p class="small muted">Replacing it reads a new file and updates your details. Your search
        words are left alone until you ask for them to be worked out again — so a small correction
        never quietly rewrites the board.</p>
      <div class="row" style="margin-top:var(--s4);gap:var(--s3);flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" id="s-resume-new">Replace my resume…</button>
        <button class="btn btn--sm" id="s-resume-keywords">Work out my search words again</button>
        <span class="small muted" id="s-resume-status"></span>
      </div>
      <div id="s-resume-review" class="hidden" style="margin-top:var(--s4)"></div>
    </section>

    <section class="panel" style="grid-column:1/-1">
      <div class="panel__head"><h3>Your CV, in detail</h3>
        <button class="btn btn--sm" id="s-cv-preview">See the PDF</button>
        <button class="btn btn--sm" id="s-cv-word">See the Word version</button>
      </div>
      <p class="small muted">Every tailored CV is built from this. The rewrite may reorder it, reword it,
        and leave things out — it can never add anything that is not here. Keep it complete;
        the trimming happens per role.</p>
      <label class="field" style="margin-top:var(--s4)"><span>CV contents</span>
        <textarea id="s-cv" class="mono" spellcheck="false" style="min-height:440px"></textarea></label>
      <div class="row" style="margin-top:var(--s3)">
        <button class="btn btn--primary btn--sm" id="s-cv-save">Save the CV</button>
        <span class="small muted" id="s-cv-status"></span>
      </div>
    </section>

    <section class="panel" style="grid-column:1/-1">
      <div class="panel__head"><h3>Where everything is kept</h3></div>
      <p class="small">Nothing leaves this computer except the job searches, the CV tailoring, and the
        emails you choose to send.</p>
      <p class="small mono selectable" style="color:var(--muted);word-break:break-all">${esc(s.dataDir)}</p>
      <div class="row" style="margin-top:var(--s3);flex-wrap:wrap">
        <button class="btn btn--sm" id="s-folder">Open that folder</button>
        <button class="btn btn--sm" id="s-backup">Back everything up now</button>
        <button class="btn btn--sm" id="s-update">Check for updates</button>
        <span class="spacer"></span>
        <span class="small muted">Job Desk ${esc(s.version)}</span>
      </div>
      <p class="inline-note" id="s-update-note" style="margin-top:var(--s3)"></p>
    </section>
  </div>`;

  $('#s-cv').value = JSON.stringify(await call(window.api.cv.get, {}), null, 2);

  const patch = async (obj, msg = 'Saved.') => {
    try { await call(window.api.settings.set, { patch: obj }); toast(msg); }
    catch (err) { oops(err); }
  };
  const num = (id) => Number($(id).value);

  $('#s-model').addEventListener('change', async (e) => {
    await patch({ claude_model: e.target.value }, 'Model changed.');
    go('settings');
  });
  $('#s-budget').addEventListener('change', async (e) => {
    const cap = Math.max(0, Number(e.target.value) || 0);
    await patch({ budget_usd_monthly: cap, budget_warned_month: '' },
      cap ? `Limit set to $${cap} a month.` : 'Spending limit removed.');
    go('settings');
  });

  $('#s-claude-save').addEventListener('click', async () => {
    const v = $('#s-claude').value.trim();
    if (!v) { toast('Paste the key first.', 'warn'); return; }
    try {
      await call(window.api.settings.setSecret, { key: 'anthropic_api_key', value: v });
      toast('Key saved.');
      go('settings');
    } catch (err) { oops(err); }
  });
  $('#s-claude-test').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.innerHTML = '<span class="spin"></span> Checking…';
    try { await call(window.api.settings.testClaude, {}); toast('The key works.'); }
    catch (err) { oops(err); }
    e.currentTarget.disabled = false;
    e.currentTarget.textContent = 'Check it works';
  });

  $('#s-mail-save').addEventListener('click', async () => {
    await patch({
      smtp_host: $('#s-host').value.trim(),
      smtp_port: num('#s-port'),
      smtp_secure: num('#s-port') === 465,
      smtp_user: $('#s-user').value.trim(),
      smtp_from_name: $('#s-fromname').value.trim(),
      smtp_from_email: $('#s-fromemail').value.trim(),
      bcc_self: $('#s-bcc').checked,
    }, 'Mailbox saved.');
    const pass = $('#s-pass').value;
    if (pass) {
      try { await call(window.api.settings.setSecret, { key: 'smtp_password', value: pass }); go('settings'); }
      catch (err) { oops(err); }
    }
  });
  $('#s-mail-test').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.innerHTML = '<span class="spin"></span> Checking…';
    try {
      const r = await call(window.api.settings.testMail, {});
      toast(r.message, r.ok ? 'ok' : 'bad', r.ok ? 5000 : 12000);
    } catch (err) { oops(err); }
    e.currentTarget.disabled = false;
    e.currentTarget.textContent = 'Check it works';
  });
  $('#s-mail-send').addEventListener('click', async (e) => {
    const to = $('#s-fromemail').value.trim();
    if (!to) { toast('Fill in the send-as address first.', 'warn'); return; }
    e.currentTarget.disabled = true;
    try { await call(window.api.settings.sendTestEmail, { to }); toast(`Test sent to ${to}. Check the inbox.`); }
    catch (err) { oops(err); }
    e.currentTarget.disabled = false;
  });

  const boardInputs = ['#s-minscore', '#s-w-remote', '#s-w-hybrid', '#s-w-onsite', '#s-countries',
    '#s-refresh', '#s-launch', '#s-cap', '#s-cooldown', '#s-fu', '#s-fudays',
    '#s-city', '#s-state', '#s-country', '#s-notice', '#s-years', '#s-salary', '#s-bcc'];
  for (const id of boardInputs) {
    $(id).addEventListener('change', () => patch({
      min_score_to_show: num('#s-minscore'),
      work_mode_preference: { remote: num('#s-w-remote'), hybrid: num('#s-w-hybrid'), onsite: num('#s-w-onsite') },
      preferred_countries: $('#s-countries').value.split(',').map((x) => x.trim()).filter(Boolean),
      refresh_every_hours: num('#s-refresh'),
      refresh_on_launch: $('#s-launch').checked,
      max_sends_per_day: num('#s-cap'),
      company_cooldown_days: num('#s-cooldown'),
      followups_enabled: $('#s-fu').checked,
      followup_days: $('#s-fudays').value.split(',').map((x) => Number(x.trim())).filter((n) => n > 0),
      bcc_self: $('#s-bcc').checked,
      profile_city: $('#s-city').value.trim(),
      profile_state: $('#s-state').value.trim(),
      profile_country: $('#s-country').value.trim(),
      profile_notice: $('#s-notice').value.trim(),
      profile_years: $('#s-years').value.trim(),
      profile_expected_salary: $('#s-salary').value.trim(),
    }));
  }

  $('#s-adz-save').addEventListener('click', async () => {
    const id = $('#s-adz-id').value.trim();
    const key = $('#s-adz-key').value.trim();
    if (!id || !key) { toast('Both the App ID and the App key are needed.', 'warn'); return; }
    try {
      await call(window.api.settings.setSecret, { key: 'adzuna', value: { app_id: id, app_key: key } });
      toast('Adzuna keys saved. Press "Find new jobs" to use them.');
      go('settings');
    } catch (err) { oops(err); }
  });

  $('#s-claude-clear')?.addEventListener('click', async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove the key? The app carries on with template letters.')) return;
    try {
      await call(window.api.settings.setSecret, { key: 'anthropic_api_key', value: '' });
      toast('Key removed. Applications will use the templates.');
      go('settings');
    } catch (err) { oops(err); }
  });

  $('#s-tpl-save').addEventListener('click', async () => {
    await patch({
      template_email: $('#s-tpl-email').value,
      template_cover: $('#s-tpl-cover').value,
      template_followup: $('#s-tpl-followup').value,
    }, 'Templates saved.');
    $('#s-tpl-status').textContent = 'Saved.';
  });
  $('#s-tpl-reset').addEventListener('click', async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Put the original wording back?')) return;
    try { await call(window.api.templates.reset, {}); go('settings'); }
    catch (err) { oops(err); }
  });

  $('#s-cv-save').addEventListener('click', async () => {
    try {
      const data = JSON.parse($('#s-cv').value);
      await call(window.api.cv.save, { data });
      $('#s-cv-status').textContent = 'Saved.';
      toast('CV saved. The previous version was kept as a backup.');
    } catch (err) {
      $('#s-cv-status').textContent = '';
      oops(err instanceof SyntaxError ? new Error(`The CV has a formatting error: ${err.message}`) : err);
    }
  });
  $('#s-cv-preview').addEventListener('click', () => call(window.api.cv.preview, { which: 'pdf' }).catch(oops));
  $('#s-cv-word').addEventListener('click', () => call(window.api.cv.preview, { which: 'docx' }).catch(oops));

  /* Replacing the resume shows what was read before anything is written, for the
     same reason onboarding does: a silent wrong parse is worse than a visible one. */
  $('#s-resume-new').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Reading…';
    try {
      const read = await call(window.api.resume.choose, {});
      if (read) renderResumeReplacement(read);
    } catch (err) { oops(err); }
    btn.disabled = false;
    btn.textContent = 'Replace my resume…';
  });

  $('#s-resume-keywords').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Working them out…';
    try {
      const r = await call(window.api.keywords.refreshFromResume, {});
      $('#s-resume-status').textContent =
        `${r.added} search word${r.added === 1 ? '' : 's'} from your resume`
        + `, ${r.keptYours} of your own kept.`;
      toast('Search words rebuilt. Press Find new jobs to search on them.');
    } catch (err) { oops(err); }
    btn.disabled = false;
    btn.textContent = 'Work out my search words again';
  });
  $('#s-folder').addEventListener('click', () => call(window.api.shell.openDataFolder, {}).catch(oops));
  $('#s-update').addEventListener('click', async (e) => {
    const btn = e.currentTarget;          // null after the first await
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Checking…';
    try {
      const r = await call(window.api.app.checkUpdates, {});
      $('#s-update-note').textContent = r.message;
    } catch (err) { oops(err); }
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  });

  $('#s-backup').addEventListener('click', async () => {
    try { const f = await call(window.api.app.backup, {}); toast(`Backed up to ${f}`, 'ok', 9000); }
    catch (err) { oops(err); }
  });
};

/* ================================================================= boot */

document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) { location.hash = `#/${goto.dataset.goto}`; return; }
  const ext = e.target.closest('[data-external]');
  if (ext) {
    e.preventDefault();
    call(window.api.shell.openExternal, { url: ext.dataset.external }).catch(oops);
  }
});

window.addEventListener('error', (e) => {
  toast(`Something went wrong: ${e.message}`, 'bad', 10000);
});
window.addEventListener('unhandledrejection', (e) => {
  toast(`Something went wrong: ${e.reason?.message || e.reason}`, 'bad', 10000);
});

wireRefreshButtons();
wireBoard();
wireApplications();
wireFollowups();
wireKeywords();

(async () => {
  let start = (location.hash || '#/today').slice(2);
  try {
    const d = await call(window.api.dashboard.get, {});
    if (!d.cvReady) start = 'welcome';
  } catch { /* show the board and let the error surface there */ }
  go(start);
  refreshChrome();
})();
setInterval(refreshChrome, 60000);
