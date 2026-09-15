'use strict';
const nodemailer = require('nodemailer');
const settings = require('./settings');
const network = require('./network');

/** @param draft An unsaved mailbox config to validate instead of the stored one — lets a Save button check before it commits. */
function config(draft) {
  const s = draft || settings.secrets().smtp;
  if (!s.host) throw new Error('No outgoing mail server set up yet. Open Settings and add the mailbox.');
  if (!s.user || !s.pass) throw new Error('The mailbox password is missing. Add it in Settings.');
  return s;
}

function transport(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465 ? true : !!s.secure && s.port !== 587,
    requireTLS: s.port === 587,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
  });
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (/EAUTH|535|authentication/i.test(m)) {
    return 'The mail server rejected that username and password. Check them in Settings — for Gmail it has to be an App Password, not the normal one.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Could not find that mail server. Check the server address in Settings.';
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET/i.test(m)) {
    return 'Could not reach the mail server. Check the internet connection, and that the port is right (465 for SSL, 587 for TLS).';
  }
  if (/self.signed|certificate/i.test(m)) return 'The mail server presented a certificate the app does not trust.';
  return m;
}

/** @param draft Passed straight to config() — validate a Save button's unsaved fields instead of what's on disk. */
async function verify(draft) {
  let s;
  try { s = config(draft); }
  catch (err) { return { ok: false, message: err.message }; }
  try {
    network.requireInternet();
    await transport(s).verify();
    return { ok: true, message: `Signed in to ${s.host} as ${s.user}.` };
  } catch (err) {
    const normalised = network.normaliseInternetError(err);
    // A definite "you're offline" is a connectivity failure, not an SMTP one —
    // it must stay a thrown, coded error so runWithInternet's own retry/popup
    // handles it, the same as any other {internet:true} channel. Only an
    // ordinary SMTP failure (wrong password, unknown host) becomes the
    // friendly ok:false a "check it works" button shows inline.
    if (normalised.code === network.INTERNET_ERROR_CODE) throw normalised;
    return { ok: false, message: friendlyError(err) };
  }
}

/** @param {{path:string,filename:string}[]} attachments */
async function send({ to, toName, subject, text, attachments = [], bcc = null }) {
  const s = config();
  try {
    network.requireInternet();
    const info = await transport(s).sendMail({
      from: s.from_name
        ? { name: s.from_name, address: s.from_email || s.user }
        : (s.from_email || s.user),
      to: toName ? { name: toName, address: to } : to,
      replyTo: s.from_email || s.user,
      bcc: bcc || undefined,
      subject,
      text,
      html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#1c1c18">${
        String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>')
      }</div>`,
      attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const normalised = network.normaliseInternetError(err);
    // Same distinction as verify(): a real "no internet right now" must reach
    // the caller as the coded connectivity error so the app's Retry/Cancel
    // popup and auto-retry kick in — wrapping it in a plain Error here (as a
    // send() failure did previously) silently dropped both, on an application
    // send this is the one place that matters most.
    if (normalised.code === network.INTERNET_ERROR_CODE) throw normalised;
    throw new Error(friendlyError(err));
  }
}

module.exports = { send, verify, friendlyError };
