'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** The only surface the interface can reach. No Node, no filesystem, no shell. */
const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('api', {
  network: { check: call('network:check') },
  jobs: {
    list: call('jobs:list'),
    get: call('jobs:get'),
    setStatus: call('jobs:setStatus'),
    facets: call('jobs:facets'),
  },
  refresh: {
    run: call('refresh:run'),
    status: call('refresh:status'),
    onStart: (fn) => on('refresh:start', fn),
    onProgress: (fn) => on('refresh:progress', fn),
    onDone: (fn) => on('refresh:done', fn),
    onError: (fn) => on('refresh:error', fn),
  },
  apply: {
    prepare: call('apply:prepare'),
    save: call('apply:save'),
    send: call('apply:send'),
    get: call('apply:get'),
    setStatus: call('apply:setStatus'),
    markSubmitted: call('apply:markSubmitted'),
    switchResume: call('apply:switchResume'),
    rails: call('apply:rails'),
    mode: call('apply:mode'),
  },
  applications: { list: call('applications:list') },
  followups: {
    list: call('followups:list'),
    draft: call('followups:draft'),
    send: call('followups:send'),
    skip: call('followups:skip'),
    snooze: call('followups:snooze'),
  },
  keywords: {
    list: call('keywords:list'),
    add: call('keywords:add'),
    toggle: call('keywords:toggle'),
    weight: call('keywords:weight'),
    remove: call('keywords:delete'),
    refreshFromResume: call('keywords:refreshFromResume'),
  },
  resume: {
    choose: call('resume:choose'),
    preview: call('resume:preview'),
    apply: call('resume:apply'),
    formats: call('resume:formats'),
  },
  profile: { get: call('profile:get') },
  ai: {
    providers: call('ai:providers'),
    setProvider: call('ai:setProvider'),
  },
  sources: {
    list: call('sources:list'),
    probe: call('sources:probe'),
    add: call('sources:add'),
    toggle: call('sources:toggle'),
    remove: call('sources:delete'),
  },
  settings: {
    get: call('settings:get'),
    set: call('settings:set'),
    setSecret: call('settings:setSecret'),
    testMail: call('settings:testMail'),
    testClaude: call('settings:testClaude'),
    validateClaudeKey: call('settings:validateClaudeKey'),
    sendTestEmail: call('settings:sendTestEmail'),
  },
  cv: { get: call('cv:get'), save: call('cv:save'), preview: call('cv:preview') },
  templates: { reset: call('templates:reset') },
  files: {
    open: call('file:open'),
    reveal: call('file:reveal'),
    saveAs: call('file:saveAs'),
  },
  browser: {
    open: call('browser:open'),
    submitted: call('browser:submitted'),
  },
  dashboard: { get: call('dashboard:get') },
  budget: { status: call('budget:status') },
  activity: { list: call('activity:list') },
  shell: { openExternal: call('shell:openExternal'), openDataFolder: call('shell:openDataFolder') },
  app: {
    backup: call('app:backup'),
    checkUpdates: call('app:checkUpdates'),
    updateStatus: call('app:updateStatus'),
    downloadUpdate: call('app:downloadUpdate'),
    installUpdate: call('app:installUpdate'),
    openCertificate: call('app:openCertificate'),
    onUpdateAvailable: (fn) => on('app:updateAvailable', fn),
    onUpdateProgress: (fn) => on('app:updateProgress', fn),
    onUpdateDownloaded: (fn) => on('app:updateDownloaded', fn),
    onUpdateError: (fn) => on('app:updateError', fn),
    onUpdateChecked: (fn) => on('app:updateChecked', fn),
  },
  onApplicationsChanged: (fn) => on('applications:changed', fn),
});
