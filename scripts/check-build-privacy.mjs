#!/usr/bin/env node
/**
 * Fails if anything personal ended up inside a build.
 *
 * This is the check that makes publishing installers to a public repository
 * safe. It reads the real CV out of the private repo, then greps the packaged
 * output for every value in it. If any of them appear, the build is refused.
 *
 *   node scripts/check-build-privacy.mjs [distDir]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const distDir = process.argv[2] || 'dist';
const cvPath = 'resources/master-resume.json';

if (!existsSync(distDir)) {
  console.error(`  Nothing to check: ${distDir} does not exist.`);
  process.exit(0);
}

if (!existsSync(cvPath)) {
  console.log('  No private CV in the repo, so there is nothing that could leak.');
  process.exit(0);
}

const cv = JSON.parse(readFileSync(cvPath, 'utf8'));

/** Every string worth protecting: the name, and every contact detail. */
const needles = new Set();
if (cv.name) needles.add(cv.name);
for (const v of Object.values(cv.contact || {})) {
  if (typeof v === 'string' && v.trim().length > 5) needles.add(v.trim());
}
// The email's local part and domain, in case only half of it ends up embedded.
const email = cv.contact?.email || '';
if (email.includes('@')) email.split('@').forEach((part) => part.length > 4 && needles.add(part));

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const files = walk(distDir);
const hits = [];

for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  const text = buf.toString('latin1');          // catches UTF-8 and UTF-16 fragments
  for (const needle of needles) {
    if (text.includes(needle)) hits.push({ file: path.relative(process.cwd(), file), needle });
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
