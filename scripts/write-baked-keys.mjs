#!/usr/bin/env node
/**
 * Writes src/main/baked-keys.js from GitHub Actions secrets, right before
 * electron-builder packages the app. This is what lets a from-scratch install
 * work with nothing but a resume and an email — every service key in here is
 * ours, not something a non-technical user is expected to go and get.
 *
 * The file this writes is gitignored: real values exist only on the CI
 * runner, for the duration of one build, inside the artifact — never in the
 * repository. Every secret is optional; an env var that is not set is simply
 * left out, and settings.js#getSecret falls back to nothing for it, same as
 * an install with no baked keys at all — see SETUP.md for which repo secrets
 * to add and where each one comes from.
 *
 * A key she pastes into Settings herself always wins over the baked one
 * (settings.js#getSecret checks the saved row first) — this is a floor to
 * build on, not a lock on the door.
 */
import { writeFileSync } from 'node:fs';

const env = (name) => (process.env[name] || '').trim();

const keys = {
  gemini_api_key: env('BAKED_GEMINI_API_KEY') || undefined,
  anthropic_api_key: env('BAKED_ANTHROPIC_API_KEY') || undefined,
  openrouter_api_key: env('BAKED_OPENROUTER_API_KEY') || undefined,
  github_pat: env('BAKED_GITHUB_PAT') || undefined,
  adzuna: (env('BAKED_ADZUNA_APP_ID') || env('BAKED_ADZUNA_APP_KEY'))
    ? { app_id: env('BAKED_ADZUNA_APP_ID'), app_key: env('BAKED_ADZUNA_APP_KEY') } : undefined,
  jooble: env('BAKED_JOOBLE_API_KEY') ? { api_key: env('BAKED_JOOBLE_API_KEY') } : undefined,
  jsearch: env('BAKED_JSEARCH_API_KEY') ? { api_key: env('BAKED_JSEARCH_API_KEY') } : undefined,
  activejobsdb: env('BAKED_ACTIVEJOBSDB_API_KEY') ? { api_key: env('BAKED_ACTIVEJOBSDB_API_KEY') } : undefined,
  ycjobs: env('BAKED_YCJOBS_API_KEY') ? { api_key: env('BAKED_YCJOBS_API_KEY') } : undefined,
};
for (const k of Object.keys(keys)) if (keys[k] === undefined) delete keys[k];

const out = new URL('../src/main/baked-keys.js', import.meta.url);
writeFileSync(out,
  `'use strict';\n// Generated at build time from GitHub Actions secrets. Gitignored — never committed.\n`
  + `module.exports = ${JSON.stringify(keys, null, 2)};\n`);

const count = Object.keys(keys).length;
console.log(count
  ? `Baked ${count} key(s) into this build: ${Object.keys(keys).join(', ')}.`
  : 'No BAKED_* secrets set — building with no keys baked in, same as before this existed.');
