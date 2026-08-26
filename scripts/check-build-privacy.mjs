#!/usr/bin/env node
/**
 * Fails if anything personal ended up inside a build.
 *
 * This is the check that makes publishing installers to a public repository
 * safe. It reads the real CV out of the private repo, then greps the packaged
 * output for every value in it. If any of them appear, the build is refused.
 *
 *   node scripts/check-build-privacy.mjs [distDir]
 *
 * That CV check only runs when resources/master-resume.json happens to be on
 * the machine doing the build — which, by design, is never true in CI, since
 * the real CV is gitignored specifically so a checkout never has it. On its
 * own that made this step a guaranteed, silent pass in the one place it
 * actually runs: it printed "Clean" every single time without inspecting
 * anything, because there was nothing to check for. That is not the same bug
 * as a leak — the CV genuinely cannot reach a CI build this way — but it is
 * why a *different* leak got through this exact gate for months: someone
 * else's real city, state, notice period and years of experience were typed
 * directly into `ipc.js` as fallback form-fill values, which is regular
 * tracked source, not a gitignored data file, so it shipped in every public
 * build regardless of what CI could see. KNOWN_SENSITIVE below is a small,
 * hand-maintained list of exactly that class of value — checked unconditionally,
 * with no dependency on a local CV file — so a value like it slipping back into
 * source fails the build even when nobody's real CV is anywhere on the runner.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const distDir = process.argv[2] || 'dist';
const cvPath = 'resources/master-resume.json';

if (!existsSync(distDir)) {
  console.error(`  Nothing to check: ${distDir} does not exist.`);
  process.exit(0);
}

/**
 * Real personal values that have previously shipped hard-coded in source (see
 * the fix for ipc.js's browser:open handler). Extend this the same way if
 * another one is ever found: the point is not to enumerate every possible
 * secret, it is to make sure the exact mistake that happened once cannot
 * happen again unnoticed.
 */
const KNOWN_SENSITIVE = ['Vadodara', 'Gujarat'];

const needles = new Set(KNOWN_SENSITIVE);

if (existsSync(cvPath)) {
  const cv = JSON.parse(readFileSync(cvPath, 'utf8'));
  // Every string worth protecting: the name, and every contact detail.
  if (cv.name) needles.add(cv.name);
  for (const v of Object.values(cv.contact || {})) {
    if (typeof v === 'string' && v.trim().length > 5) needles.add(v.trim());
  }
  // The email's local part and domain, in case only half of it ends up embedded.
  const email = cv.contact?.email || '';
  if (email.includes('@')) email.split('@').forEach((part) => part.length > 4 && needles.add(part));
} else {
  console.log('  No private CV on this machine — checking only the fixed denylist below.');
}

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

/**
 * A single alphabetic word gets a word-boundary match instead of plain
 * substring search. "Gujarat" as a bare substring also matches "Gujarati" —
 * the language name, which is genuinely present in Electron's own bundled
 * Unicode script-shaping tables and lit this check up on a perfectly clean
 * build. A name or email with spaces or punctuation in it is specific enough
 * that this does not matter, so only single words are treated this way.
 */
const isPlainWord = (s) => /^[A-Za-z]+$/.test(s);
const wordRe = new Map();
function occursIn(text, needle) {
  if (!isPlainWord(needle)) return text.includes(needle);
  if (!wordRe.has(needle)) wordRe.set(needle, new RegExp(`\\b${needle}\\b`));
  return wordRe.get(needle).test(text);
}

const files = walk(distDir);
const hits = [];

for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  const text = buf.toString('latin1');          // catches UTF-8 and UTF-16 fragments
  for (const needle of needles) {
    if (occursIn(text, needle)) hits.push({ file: path.relative(process.cwd(), file), needle });
  }
}

if (hits.length) {
  console.error(`\n  Refusing this build: personal details are inside it.\n`);
  for (const h of hits.slice(0, 25)) console.error(`    ${h.needle}  ->  ${h.file}`);
  if (hits.length > 25) console.error(`    ...and ${hits.length - 25} more`);
  console.error(`
  The installer is published to a public repository, so it must contain nothing
  personal. Check "files" in package.json, and make sure the value is read from
  the CV at runtime rather than written into the source.
`);
  process.exit(1);
}

console.log(`  Clean: checked ${files.length} files for ${needles.size} personal values, found none.`);
