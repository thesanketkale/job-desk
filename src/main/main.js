'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, shell, dialog, Menu, nativeTheme } = require('electron');

// One instance only — two copies writing to the same database would corrupt it.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const db = require('./db');
const settings = require('./settings');
const seed = require('./seed');
const ingest = require('./ingest');
const applyBrowser = require('./apply-browser');
const updater = require('./updater');

let mainWindow = null;
let refreshTimer = null;
let refreshing = false;

const isDev = process.argv.includes('--dev');

function dataDir() {
  // Portable builds keep everything next to the .exe so the whole thing can
  // live on a USB stick or be copied to a new machine in one drag.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'JobDesk-Data');
  }
  return app.getPath('userData');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#fbfaf6',
    title: 'Job Desk',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Any link to the outside world opens in her real browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Refresh job sources', accelerator: 'CmdOrCtrl+R', click: () => runRefresh('menu') },
        { type: 'separator' },
        {
          label: 'Open the data folder',
          click: () => shell.openPath(db.paths.root),
        },
        {
          label: 'Check for updates',
          click: async () => {
            const r = await updater.checkNow();
            if (r.message) {
              dialog.showMessageBox(mainWindow, { type: 'info', message: r.message,
                detail: `Installed version: ${app.getVersion()}`, buttons: ['OK'] });
            }
          },
        },
        {
          label: 'Back up everything now',
          click: async () => {
            try {
              const file = db.backup();
              await dialog.showMessageBox(mainWindow, {
                type: 'info', message: 'Backup saved', detail: file, buttons: ['OK'],
              });
            } catch (err) {
              dialog.showErrorBox('Backup failed', String(err.message));
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
      ...(isDev ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { label: 'Help', submenu: [
      { label: 'Version ' + app.getVersion(), enabled: false },
      { label: 'Where is my data?', click: () => shell.openPath(db.paths.root) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Shared by the button, the menu item, the launch check, and the timer. */
async function runRefresh(reason = 'manual') {
  if (refreshing) return { skipped: true, reason: 'already running' };
  refreshing = true;
  const notify = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  notify('refresh:start', { reason });
  try {
    const summary = await ingest.runAll({
      onProgress: (p) => notify('refresh:progress', p),
    });
    notify('refresh:done', summary);
    return summary;
  } catch (err) {
    notify('refresh:error', { message: String(err.message) });
    throw err;
  } finally {
    refreshing = false;
  }
}

function scheduleAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const hours = Number(settings.get('refresh_every_hours', 6));
  if (!hours) return;
  refreshTimer = setInterval(() => { runRefresh('timer').catch(() => {}); }, hours * 3600 * 1000);
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';   // the app has one deliberate visual world
  try {
    db.init(dataDir());
    seed.seedIfEmpty();
  } catch (err) {
    dialog.showErrorBox('Job Desk could not start',
      `The database could not be opened.\n\n${err.message}\n\nFolder: ${dataDir()}`);
    app.quit();
    return;
  }

  require('./ipc').register({ getMainWindow: () => mainWindow, runRefresh, isRefreshing: () => refreshing,
    scheduleAutoRefresh, applyBrowser });

  buildMenu();
  createWindow();
  scheduleAutoRefresh();
  updater.init(() => mainWindow);

  // A quiet catch-up on launch, once the window is up and interactive.
  if (settings.get('refresh_on_launch', true) && settings.get('onboarded', false)) {
    setTimeout(() => { runRefresh('launch').catch(() => {}); }, 2500);
  }

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  try { db.handle().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* nothing open */ }
});

function logCrash(kind, err) {
  try {
    fs.appendFileSync(path.join(db.paths.logs, 'crash.log'),
      `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`);
  } catch { /* logging must never itself crash the app */ }
}

process.on('unhandledRejection', (reason) => {
  // Background work failing is not worth a dialog; losing it silently is worse.
  logCrash('unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  if (app.isReady()) {
    dialog.showErrorBox('Something went wrong',
      `${err.message || err}\n\nThe details were written to the logs folder, which you can open `
      + 'from the File menu. Nothing she has saved is affected.');
  }
});
