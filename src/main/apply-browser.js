'use strict';
/**
 * The application form, opened inside the app.
 * Electron already contains Chromium, so this needs no extra download and no
 * separate automation tool. It fills what it recognises, attaches the tailored
 * CV to the upload field, and then stops — she reads it and presses Submit.
 */
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, WebContentsView, session, shell, dialog } = require('electron');
const { buildScript, buildCollectQuestionsScript, buildApplyAnswersScript,
  buildFileInputMatchScript, HIGHLIGHT_CSS } = require('./autofill-script');

const TOOLBAR_H = 96;
let win = null;
let view = null;
let context = null;   // { applicationId, pdfPath, docxPath, profile, job }

const partition = () => session.fromPartition('persist:applyforms');

function layout() {
  if (!win || !view) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function open(ctx, parent) {
  context = ctx;

  if (win && !win.isDestroyed()) {
    win.focus();
  } else {
    win = new BrowserWindow({
      width: 1180,
      height: 900,
      parent,
      show: false,
      backgroundColor: '#fbfaf6',
      title: 'Apply',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'apply-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // apply-preload.js only uses contextBridge/ipcRenderer too — same
        // reasoning as the main window in main.js.
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'apply.html'));
    // The toolbar may not be listening yet when open() first sends the context,
    // so send it again once its window is actually ready.
    win.webContents.on('did-finish-load', () => {
      send('context', publicContext());
      if (view && !view.webContents.isDestroyed()) {
        const wc2 = view.webContents;
        send('nav', { loading: wc2.isLoading(), url: wc2.getURL(), title: wc2.getTitle(),
          canGoBack: wc2.navigationHistory.canGoBack() });
      }
    });
    win.on('resize', layout);
    win.on('closed', () => { win = null; view = null; context = null; });
    win.once('ready-to-show', () => win.show());
  }

  if (view) {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
    view.webContents.close();
  }

  view = new WebContentsView({
    webPreferences: {
      session: partition(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  layout();

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // Keep everything in this one view; only send genuinely external schemes out.
    if (/^https?:/i.test(url)) { wc.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-start-loading', () => send('nav', { loading: true }));
  wc.on('did-stop-loading', () => {
    wc.insertCSS(HIGHLIGHT_CSS).catch(() => {});
    send('nav', { loading: false, url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack() });
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) send('loadError', { code, desc, url });
  });

  wc.loadURL(ctx.job.apply_url);
  send('context', publicContext());
  return true;
}

function publicContext() {
  if (!context) return null;
  return {
    applicationId: context.applicationId,
    job: {
      title: context.job.title, company: context.job.company,
      location_raw: context.job.location_raw, apply_url: context.job.apply_url,
    },
    coverLetter: context.profile.coverLetter,
    hasPdf: !!(context.pdfPath && fs.existsSync(context.pdfPath)),
    matchScore: context.matchScore ?? null,
  };
}

/**
 * Two passes. The first is the fixed rule table — name, email, phone, the
 * fields every form has — which needs no key and is what runs when there is
 * none. The second only happens when a key exists: it hands the model the
 * questions the table could not answer (the dropdowns, the free-text
 * screening questions) along with the CV, and writes back what survives the
 * guards in ai.js#answerFormFields and buildApplyAnswersScript.
 *
 * The AI pass is strictly additive. If it throws — no key, rate limit, spend
 * cap reached, unparseable reply — the deterministic fill it ran on top of is
 * already done and still stands, which is why its failure is swallowed rather
 * than surfaced as a failed fill.
 */
async function fillForm() {
  if (!view || !context) throw new Error('No application form is open.');
  const result = await view.webContents.executeJavaScript(buildScript(context.profile), true);
  result.aiFilled = 0;
  result.aiTried = false;

  const ai = require('./ai');
  if (!ai.available()) return result;

  result.aiTried = true;
  try {
    const fields = await view.webContents.executeJavaScript(buildCollectQuestionsScript(), true);
    if (!fields?.length) return result;
    const answers = await ai.answerFormFields({
      fields,
      cv: context.cv || context.profile,
      job: context.job,
    });
    if (!answers.length) return result;
    const applied = await view.webContents.executeJavaScript(buildApplyAnswersScript(answers), true);
    result.aiFilled = applied?.filled || 0;
  } catch (err) {
    // The rule-based fill above already succeeded; this pass is a bonus.
    result.aiError = String(err.message || err).slice(0, 200);
  }
  return result;
}

/**
 * Puts the tailored CV into the page's file input. Chrome forbids scripts from
 * doing this, so it goes through the DevTools protocol, which the app is
 * allowed to drive against its own view.
 */
async function attachResume(which = 'pdf') {
  if (!view || !context) throw new Error('No application form is open.');
  const file = which === 'docx' ? context.docxPath : context.pdfPath;
  if (!file || !fs.existsSync(file)) throw new Error('The tailored CV file is missing. Regenerate it from the board.');

  // What each file input on the page looks like it is for — a cover letter or
  // portfolio field reads differently from a resume/CV one. A failure here
  // (page not ready, CSP oddity) is not fatal: pickResumeTargets() falls back
  // to the old attach-everywhere behaviour when it has nothing to go on.
  let matches = [];
  try { matches = await view.webContents.executeJavaScript(buildFileInputMatchScript(), true); }
  catch { /* fall through with an empty match list */ }

  const dbg = view.webContents.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: 'input[type=file]',
    });
    if (!nodeIds?.length) throw new Error('This page has no file upload field on it right now.');

    let count = 0;
    for (const nodeId of pickResumeTargets(nodeIds, matches)) {
      try {
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], nodeId });
        count++;
      } catch { /* hidden or detached input — skip it */ }
    }
    if (!count) throw new Error('Could not attach to the upload field. Use Reveal the CV and drag it in.');
    return { attached: count, file: path.basename(file) };
  } finally {
    if (attachedHere && dbg.isAttached()) { try { dbg.detach(); } catch { /* already gone */ } }
  }
}

/**
 * Chooses which of the page's file inputs the CV actually belongs in. This
 * used to attach to every `input[type=file]` on the page unconditionally —
 * harmless on the common one-upload form, wrong on any form with a separate
 * cover-letter or portfolio field, which received the CV file too.
 *
 * `matches[i]` describes the i-th `input[type=file]` in document order, read
 * moments earlier by `buildFileInputMatchScript()`; `nodeIds` is the same
 * selector's result from CDP, taken now. The two only line up if the DOM has
 * not changed in between, which `nodeIds.length === matches.length` is the
 * cheap way to notice. Whenever they disagree, or nothing was detected at
 * all, every input is targeted — never worse off than before this existed.
 */
function pickResumeTargets(nodeIds, matches) {
  if (matches.length !== nodeIds.length) return nodeIds;
  const resumeOnly = nodeIds.filter((_, i) => matches[i]?.resume);
  if (resumeOnly.length) return resumeOnly;
  const notExcluded = nodeIds.filter((_, i) => !matches[i]?.exclude);
  return notExcluded.length ? notExcluded : nodeIds;
}

function revealResume(which = 'pdf') {
  if (!context) throw new Error('No application form is open.');
  const file = which === 'docx' ? context.docxPath : context.pdfPath;
  if (!file || !fs.existsSync(file)) throw new Error('That file is no longer on disk.');
  shell.showItemInFolder(file);
  return true;
}

const nav = (action) => {
  if (!view) return false;
  const h = view.webContents.navigationHistory;
  if (action === 'back' && h.canGoBack()) h.goBack();
  else if (action === 'forward' && h.canGoForward()) h.goForward();
  else if (action === 'reload') view.webContents.reload();
  else if (action === 'home' && context) view.webContents.loadURL(context.job.apply_url);
  return true;
};

function close() {
  if (win && !win.isDestroyed()) win.close();
  return true;
}

async function confirmSubmitted(parent) {
  const { response } = await dialog.showMessageBox(parent || win, {
    type: 'question',
    buttons: ['Yes, it is submitted', 'Not yet'],
    defaultId: 0,
    cancelId: 1,
    message: 'Did the application go through?',
    detail: 'This logs it on the Applications page and schedules the follow-ups.',
  });
  return response === 0;
}

module.exports = { open, fillForm, attachResume, revealResume, nav, close, confirmSubmitted, publicContext,
  pickResumeTargets,
  get isOpen() { return !!(win && !win.isDestroyed()); } };
