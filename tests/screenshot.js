/* Boots the real app, seeds believable data, and photographs each screen. */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.SHOT_DIR || '/tmp/jd-shots';
fs.mkdirSync(OUT, { recursive: true });

const db = require('../src/main/db');
const settings = require('../src/main/settings');
const seed = require('../src/main/seed');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function fixtures() {
  const jobs = [
    ['Senior Counselling Psychologist — Employee Assistance', '1to1help', 'Bengaluru', 'Karnataka', 'India',
      'Bengaluru, Karnataka, India', 'remote', 'Full time', 'INR 9,00,000–14,00,000', 92, 'eap', 1,
      'careers@1to1help.example', ['EAP counsellor', 'employee wellbeing', 'workplace mental health', 'CBT', 'remote', 'india', 'clinical supervision'],
      'We are looking for an experienced counselling psychologist to deliver EAP sessions to corporate employees across India. You will carry an individual caseload, run wellbeing workshops, and supervise associate counsellors. M.Sc. or M.Phil in Counselling or Clinical Psychology required, with at least five years of applied practice.', 'Adzuna — India'],
    ['Psychology Domain Expert — Model Behaviour', 'Anthropic', '', '', 'Remote',
      'Remote — Global', 'remote', 'Contract', 'USD 60–95 / hour', 84, 'ai_expert', 3, '',
      ['psychology expert', 'model behaviour', 'domain expert', 'AI safety', 'remote', 'evaluation'],
      'Work alongside researchers to shape how our models respond in emotionally sensitive conversations. You will write and review reference dialogues, design evaluation rubrics for wellbeing-related behaviour, and red-team responses to distress disclosures. A graduate qualification in psychology and real clinical hours are essential.', 'Anthropic'],
    ['Clinical Content Lead — Perinatal Mental Health', 'Amaha', 'Mumbai', 'Maharashtra', 'India',
      'Mumbai, Maharashtra, India', 'remote', 'Full time', '', 78, 'content', 2, 'people@amaha.example',
      ['postpartum', 'perinatal', 'psychoeducation', 'curriculum', 'CBT', 'india'],
      'Own the clinical accuracy of our perinatal programme — psychoeducation modules, therapist scripts, and outcome measures. You will work with a small team of psychologists and content designers.', 'Amaha'],
    ['Student Wellbeing Counsellor (Hybrid)', 'GEMS Education', 'Dubai', '', 'United Arab Emirates',
      'Dubai, United Arab Emirates', 'hybrid', 'Full time', '', 71, 'education', 6, '',
      ['school counsellor', 'student wellbeing', 'adolescent', 'crisis intervention'],
      'Support students across senior school with individual counselling, group programmes, and parent workshops. Three days on campus, two remote. Experience with adolescents and examination stress is strongly preferred.', 'Adzuna — UK'],
    ['Wellbeing Programme Facilitator', 'Workplace Options', '', '', 'Remote',
      'Remote — Asia Pacific', 'remote', 'Part time', '', 63, 'eap', 11, 'apac.talent@wpo.example',
      ['corporate wellness', 'workshop facilitation', 'trainer', 'asia pacific'],
      'Deliver live wellbeing workshops to corporate audiences across time zones — stress management, resilience, and manager training.', 'Remotive'],
    ['Counsellor — Addiction Recovery Programme', 'CARE Foundation', 'Ahmedabad', 'Gujarat', 'India',
      'Ahmedabad, Gujarat, India', 'onsite', 'Full time', '', 41, 'clinical', 19, '',
      ['counselling psychologist', 'india'],
      'Residential rehabilitation centre seeking a full-time counsellor for group and individual work with clients in recovery.', 'Adzuna — India'],
  ];

  jobs.forEach((j, i) => {
    const [title, company, city, region, country, loc, mode, type, salary, score, pool, days, email, terms, desc, source] = j;
    db.insert('jobs', {
      fingerprint: `fx${i}`, source_type: 'fixture', source_label: source, external_id: `fx${i}`,
      title, company, city, region, country, location_raw: loc, work_mode: mode,
      employment_type: type, salary_text: salary, description_text: desc,
      description_html: `<p>${desc}</p>`, apply_url: 'https://example.com/apply',
      apply_email: email, posted_at: ago(days), score, pool,
      matched_terms: JSON.stringify(terms),
      status: [3].includes(i) ? 'new' : i === 2 ? 'applied' : 'new',
    });
  });

  const apps = [
    [3, 'interview', 'people@amaha.example', 'Clinical Content Lead — application from Srishti Sharma', 78, 6,
      ['Perinatal and postpartum work is her strongest single specialisation.',
        'The role wants outcome measures — her SMHRT/TISS work covers that.',
        'No supervision requirement, so the "lead" framing is a stretch but defensible.']],
    [1, 'sent', 'careers@1to1help.example', 'Senior Counselling Psychologist — application from Srishti Sharma', 92, 9,
      ['She already works with this employer as an affiliate counsellor.',
        'Six years of EAP delivery maps onto the caseload described.']],
    [2, 'draft', '', '', 84, 0,
      ['No published application address — this one goes through the company form.',
        'No licensure gate: the role is research, not clinical practice.']],
    [5, 'rejected', 'apac.talent@wpo.example', 'Wellbeing Programme Facilitator — application from Srishti Sharma', 63, 22,
      ['Part-time and workshop-led, which fits, but the posting asks for APAC time-zone cover.']],
  ];

  const emailBody = `Dear Hiring Team,

I am applying for the Senior Counselling Psychologist role on your EAP team. I worked as an EAP counsellor at 1to1help between 2019 and 2020 and have been an affiliate counsellor with you since May 2024, so the caseload you describe is familiar ground rather than a new setting.

Across six years of specialised practice I have delivered over 4,000 sessions, most of them with working professionals navigating workplace stress, anxiety, and relationship difficulty. At PeakMind I supervised junior counsellors and used the SMHRT tool from TISS to track outcomes, which lines up with the measurement and supervision parts of this role.

My CV is attached. I would welcome a conversation about how the team is structured and what the caseload looks like day to day.

Warm regards,
Srishti Sharma`;

  apps.forEach(([jobId, status, to, subject, score, days, notes]) => {
    const id = db.insert('applications', {
      job_id: jobId, status, method: to ? 'email' : 'form', to_email: to,
      subject: subject || 'Psychology Domain Expert — application from Srishti Sharma',
      body_text: emailBody, cover_letter: emailBody, match_score: score,
      match_notes: JSON.stringify(notes), resume_pdf: 'x.pdf', resume_docx: 'x.docx',
      sent_at: status === 'draft' ? null : ago(days),
      created_at: ago(days || 0),
    });
    db.update('jobs', { status: 'applied' }, 'id = ?', [jobId]);
    if (status !== 'draft' && status !== 'rejected') {
      db.insert('followups', { application_id: id, seq: 1, due_on: day(status === 'sent' ? -2 : 1) });
      db.insert('followups', { application_id: id, seq: 2, due_on: day(9) });
    }
  });

  for (const [kind, detail, d] of [
    ['sent', '1to1help — Senior Counselling Psychologist to careers@1to1help.example', 9],
    ['status', 'Amaha — Clinical Content Lead → interview', 3],
    ['tailored', 'Anthropic — Psychology Domain Expert (match 84)', 0],
    ['refresh', '14 new, 62 updated, from 8 sources', 0],
  ]) db.insert('activity', { kind, detail, at: ago(d) });

  settings.set('onboarded', true);
  settings.set('spend_usd', 3.92);
  settings.set('tailor_count', 68);
  settings.set('budget_usd_monthly', 10);
  settings.set('claude_model', 'claude-sonnet-5');
  settings.set('spend_by_month', { [new Date().toISOString().slice(0, 7)]: 3.92 });
  settings.set('last_refresh_at', new Date(Date.now() - 7200000).toISOString());
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jdshot-'));
  db.init(dir);
  seed.seedIfEmpty();
  fixtures();
  settings.setSecret('anthropic_api_key', 'sk-ant-fixture');
  settings.setSecret('smtp_password', 'fixture');

  require('../src/main/ipc').register({
    getMainWindow: () => win,
    runRefresh: async () => ({ sources: 0, found: 0, inserted: 0, updated: 0, errors: [] }),
    isRefreshing: () => false,
    applyBrowser: require('../src/main/apply-browser'),
  });

  const win = new BrowserWindow({
    width: 1400, height: 940, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) console.log('RENDERER ERROR:', e.message);
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(1600);
  // Freeze animation so the offscreen capture never catches a half-open drawer.
  await win.webContents.insertCSS('*,*::before,*::after{transition:none !important;animation:none !important}');

  for (const route of ['settings', 'today', 'board']) {
    await win.webContents.executeJavaScript(`location.hash = '#/${route}'`);
    await wait(route === 'settings' ? 1400 : 900);
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, `${route}.png`), img.toPNG());
    console.log('shot', route);
  }

  app.quit();
  return;
  // eslint-disable-next-line no-unreachable
  // The apply drawer, opened on a real application row.
  await win.webContents.executeJavaScript(`location.hash = '#/applications'`);
  await wait(700);
  await win.webContents.executeJavaScript(`document.querySelector('[data-open-app]').click()`);
  await wait(1400);
  fs.writeFileSync(path.join(OUT, 'apply-drawer.png'), (await win.capturePage()).toPNG());
  console.log('shot apply-drawer');

  // The in-app application form, with its toolbar wired to the real handlers.
  const cvPath = path.join(db.paths.resumes, 'fixture.pdf');
  await require('../src/main/resume-pdf').render(require('../src/main/master').master(), cvPath);
  db.update('applications', { resume_pdf: 'fixture.pdf', resume_docx: 'fixture.pdf' }, 'id = ?', [3]);
  db.update('jobs', { apply_url: 'file:///tmp/fakeats/form.html' }, 'id = ?', [2]);
  await win.webContents.executeJavaScript(
    `window.api.browser.open({applicationId:3})`);
  await wait(2600);
  const applyWin = BrowserWindow.getAllWindows().find((w) => w !== win);
  if (applyWin) {
    applyWin.show();
    await wait(700);
    fs.writeFileSync(path.join(OUT, 'apply-browser.png'), (await applyWin.capturePage()).toPNG());
    console.log('shot apply-browser');
  }

  app.quit();
});
