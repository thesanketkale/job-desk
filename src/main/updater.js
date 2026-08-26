'use strict';
/**
 * Automatic updates, checked straight against this repository's own GitHub
 * releases — private or public, it makes no difference to the app.
 *
 * A private repository's releases are not readable by an unauthenticated
 * request; electron-updater's `PrivateGitHubProvider` reads them with a token
 * instead (confirmed in `electron-updater/out/providerFactory.js`: passing
 * `private: true` plus a `token` switches the provider, nothing else). The
 * token that requires is a GitHub Personal Access Token, pasted into Settings
 * once and stored the same way every other credential in this app is —
 * through `settings.setSecret`, so it goes through `safeStorage` like the
 * Gemini or SMTP key, not sat in a config file. It never leaves the machine
 * except in the `Authorization` header of the two GitHub API calls a check
 * makes; it is not bundled into the installer, so extracting the .exe gives
 * nobody the token.
 *
 * The PAT only needs read access to this one repository's contents — enough
 * to list and download release assets. A fine-grained token (not a classic
 * one) scoped to just this repository with "Contents: Read-only" is the
 * narrowest thing GitHub offers; SETUP.md has the exact steps to hand her.
 *
 * Without a token, this still works for a genuinely public repository (no
 * auth needed) or a `generic` static-host channel. `channel: 'off'` in
 * `package.json`'s `updates` block is the only way to switch it off outright.
 */
const { app, dialog, shell } = require('electron');
const settings = require('./settings');

let autoUpdater = null;
let notified = false;
let notifiedAvailable = false;
let lastCheck = null;   // { at, ok, message } — so a silent background failure is not invisible
// Whether the feed was actually built WITH a token, as opposed to a token row
// merely existing. Those two can disagree — a saved secret that no longer
// decrypts on this machine leaves hasSecret() true while applyFeed() sends
// nothing — and when they do, the unauthenticated feed 404s on a private
// repository and the old message blamed the repository's permissions for what
// was really a credential that never left the database.
let feedHasToken = false;

function config() {
  let pkg = {};
  try { pkg = require('../../package.json'); } catch { /* running from an odd place */ }
  return { channel: 'off', url: '', releasesPage: '', ...(pkg.updates || {}) };
}

/** owner/repo come from the same publish block electron-builder already uses. */
function githubTarget() {
  let pkg = {};
  try { pkg = require('../../package.json'); } catch { /* running from an odd place */ }
  const publish = [].concat(pkg.build?.publish || []).find((p) => (p.provider || p) === 'github');
  return { owner: publish?.owner || '', repo: publish?.repo || '' };
}

const enabled = () => ['github-public', 'generic'].includes(config().channel);

const hasToken = () => settings.hasSecret('github_pat');

/** Rebuilds the feed from whatever is configured right now — called at launch
 *  and again the moment a token is saved or removed in Settings, since that
 *  can happen long after `init()` already ran. */
function applyFeed() {
  if (!autoUpdater) return;
  const cfg = config();
  if (cfg.channel === 'generic') {
    if (cfg.url) autoUpdater.setFeedURL({ provider: 'generic', url: cfg.url });
    return;
  }
  const { owner, repo } = githubTarget();
  if (!owner || !repo) return;
  const token = settings.getSecret('github_pat', '');
  feedHasToken = !!token;
  autoUpdater.setFeedURL({ provider: 'github', owner, repo, private: !!token, token: token || undefined });
}

function init(getWindow) {
  const cfg = config();
  if (!enabled()) return { enabled: false, reason: cfg.channel === 'off'
    ? 'Updates are switched off for this build.' : 'Unknown update channel.' };

  try { ({ autoUpdater } = require('electron-updater')); }
  catch { return { enabled: false, reason: 'electron-updater is not installed.' }; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  applyFeed();

  // Fires the moment a check finds a newer version, well before it finishes
  // downloading — autoDownload is already true, so the download has already
  // started by the time this shows; this is the "yes, one exists" popup, not
  // the "yes/no, download it?" one. update-downloaded below is the separate,
  // later "it's ready, install now?" popup once the file is actually here.
  autoUpdater.on('update-available', async (info) => {
    if (notifiedAvailable) return;
    notifiedAvailable = true;
    const win = getWindow?.();
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      message: `Version ${info.version} is available`,
      detail: 'Downloading it now in the background. You will be asked to install it once it is ready.',
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (notified) return;
    notified = true;
    const win = getWindow?.();
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Version ${info.version} is ready`,
      detail: 'It installs in a few seconds. Nothing you have saved is affected.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    // Never interrupt her with a dialog over a failed background check — but
    // it used to stop at this log line, which nobody reads unprompted. Settings
    // now shows the same message, via app:updateStatus, so a private repo with
    // no token yet reads as "needs a token" instead of quietly never updating.
    const message = friendlyUpdateError(err);
    lastCheck = { at: new Date().toISOString(), ok: false, message };
    require('./db').logActivity('update_error', String(err?.message || err).slice(0, 200));
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  return { enabled: true, channel: cfg.channel };
}

/**
 * The GitHub API's own wording is technical; this is what to do about it.
 *
 * Auth is checked before "not found", not after. electron-updater's
 * getLatestVersionInfo() wraps ANY failure — a rejected token included — in
 * the same "Unable to find latest version on GitHub ... please ensure a
 * production release exists" framing before the real HttpError. Confirmed
 * live with a revoked token: the wrapped message contains both that generic
 * not-found phrasing AND the literal "401"/"Bad credentials" from the
 * underlying error, in the same string. Checking not-found first would have
 * told a person with a bad token to go check the repository, when the fix is
 * the token.
 */
function friendlyUpdateError(err) {
  const m = String(err?.message || err);
  if (/401|403|bad credentials|invalid.*token|expired.*token/i.test(m)) {
    return 'That GitHub token was rejected — it may be wrong, expired, or revoked. Check it in Settings.';
  }
  // A release whose latest.yml names a file that is not attached to it. The
  // installer is built with spaces in its name and GitHub rewrites spaces to
  // dots on upload, so the two disagree and the download dies after the check
  // has already said an update is on the way — see `nsis.artifactName`, which
  // is now space-free so both sides agree. Nothing the person can fix.
  if (err?.code === 'ERR_UPDATER_ASSET_NOT_FOUND' || /cannot find asset/i.test(m)) {
    return 'That release is missing the file this app needs to install it. '
      + 'Ask Sanket for a rebuilt release, or install the newest version by hand.';
  }
  if (/404|not.?found/i.test(m)) {
    // feedHasToken, not hasToken(): the question is whether the request that
    // just 404'd actually carried a token, not whether one is on file.
    if (!feedHasToken) {
      return hasToken()
        ? 'The saved GitHub token could not be read on this computer, so the check ran without it. Re-enter it in Settings.'
        : 'Could not read the releases — if this repository is private, add a GitHub token in Settings.';
    }
    return 'Could not find a release. Check the token in Settings has access to this repository.';
  }
  return `Could not check for updates: ${m}`;
}

/** The Settings button. Honest about what it can and cannot do. */
async function checkNow() {
  const cfg = config();
  if (!enabled()) {
    if (cfg.releasesPage) await shell.openExternal(cfg.releasesPage);
    return {
      checked: false,
      current: app.getVersion(),
      message: cfg.releasesPage
        ? 'Opened the releases page in the browser — new versions are downloaded from there.'
        : 'This copy is updated by hand. Ask Sanket for the newest version.',
    };
  }
  if (!autoUpdater) {
    try { ({ autoUpdater } = require('electron-updater')); }
    catch { return { checked: false, current: app.getVersion(), message: 'electron-updater is not installed.' }; }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  }
  applyFeed();   // picks up a token saved after launch, without needing a restart
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const message = latest && latest !== app.getVersion()
      ? `Version ${latest} is downloading. It will install when the app is next closed.`
      : 'This is the newest version.';
    lastCheck = { at: new Date().toISOString(), ok: true, message };
    return { checked: true, current: app.getVersion(), latest, message };
  } catch (err) {
    const message = friendlyUpdateError(err);
    lastCheck = { at: new Date().toISOString(), ok: false, message };
    return { checked: false, current: app.getVersion(), message };
  }
}

module.exports = { init, checkNow, enabled, config, hasToken, applyFeed, friendlyUpdateError,
  get lastCheck() { return lastCheck; } };
