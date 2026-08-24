'use strict';
/**
 * Automatic updates — wired, and off by default.
 *
 * WHY OFF: this repository is private. electron-updater can only read a private
 * repository's releases with a GitHub token, and that token would have to ship
 * inside the .exe, where anyone holding the file could extract it and read the
 * whole repository. That is a worse problem than updating by hand.
 *
 * TO TURN IT ON, pick one and set `updates.channel` in package.json:
 *
 *   "github-public" — publish releases to a PUBLIC repository. Source can stay
 *     private: point the release workflow at a separate public repo that holds
 *     nothing but builds. No token needed, because public releases are readable
 *     by anyone. Requires that the installer contain nothing personal — which
 *     it already does, because the CV lives in her data folder, not the bundle.
 *
 *   "generic" — publish `latest.yml` and the installer to any static host you
 *     control (any shared hosting will do). Set `updates.url`.
 *     Same requirement: nothing personal inside the installer.
 *
 * Either way the app then checks on launch, downloads in the background, and
 * installs when she next quits. Nothing else in the app changes.
 */
const { app, dialog, shell } = require('electron');

let autoUpdater = null;
let notified = false;

function config() {
  let pkg = {};
  try { pkg = require('../../package.json'); } catch { /* running from an odd place */ }
  return { channel: 'off', url: '', releasesPage: '', ...(pkg.updates || {}) };
}

const enabled = () => ['github-public', 'generic'].includes(config().channel);

function init(getWindow) {
  const cfg = config();
  if (!enabled()) return { enabled: false, reason: cfg.channel === 'off'
    ? 'Updates are handled by hand while the repository is private.' : 'Unknown update channel.' };

  try { ({ autoUpdater } = require('electron-updater')); }
  catch { return { enabled: false, reason: 'electron-updater is not installed.' }; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  if (cfg.channel === 'generic' && cfg.url) {
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.url });
  }

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
    // Never interrupt her over a failed update check.
    require('./db').logActivity('update_error', String(err?.message || err).slice(0, 200));
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  return { enabled: true, channel: cfg.channel };
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
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    return {
      checked: true,
      current: app.getVersion(),
      latest,
      message: latest && latest !== app.getVersion()
        ? `Version ${latest} is downloading. It will install when the app is next closed.`
        : 'This is the newest version.',
    };
  } catch (err) {
    return { checked: false, current: app.getVersion(), message: `Could not check: ${err.message}` };
  }
}

module.exports = { init, checkNow, enabled, config };
