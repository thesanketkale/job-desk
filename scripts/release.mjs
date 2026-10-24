#!/usr/bin/env node
/**
 * Cuts a release: bumps the version, commits, tags, pushes.
 * The push of the tag is what triggers the build — nothing else does.
 *
 *   npm run release            # 1.0.0 -> 1.0.1
 *   npm run release minor      # 1.0.0 -> 1.1.0
 *   npm run release 2.3.0      # exactly that
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const git = (...args) => run('git', args);

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

try { git('rev-parse', '--is-inside-work-tree'); }
catch { die('This is not a git repository yet. Run the steps in SETUP.md first.'); }

if (git('status', '--porcelain')) {
  die('There are uncommitted changes. Commit or stash them, then release.');
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'master') {
  console.warn(`  Note: releasing from "${branch}", not master.`);
}

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const arg = process.argv[2] || 'patch';
const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg
  : arg === 'major' ? `${major + 1}.0.0`
    : arg === 'minor' ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const tag = `v${next}`;
const existing = git('tag', '--list', tag);
if (existing) die(`Tag ${tag} already exists.`);

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

git('add', 'package.json');
git('commit', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `Release ${tag}`);
git('push', 'origin', branch);
git('push', 'origin', tag);

console.log(`
  Released ${tag}.

  GitHub is building it now. Watch it at:
    ${(pkg.repository?.url || '').replace(/^git\+/, '').replace(/\.git$/, '')}/actions

  In about five minutes the installer appears under Releases.
`);
