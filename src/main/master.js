'use strict';
/**
 * The master CV.
 *
 * It lives in her data folder, not inside the app bundle, so that:
 *   - an app update never overwrites her edits,
 *   - the build itself contains no personal details, which is what makes it
 *     safe to publish installers or open the repository later.
 *
 * On first run the bundled seed is copied across. The seed may be the real CV
 * (private repo) or the blank example (public repo) — the app does not care.
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const BUNDLED = () => path.join(__dirname, '..', '..', 'resources', 'master-resume.json');
const EXAMPLE = () => path.join(__dirname, '..', '..', 'resources', 'master-resume.example.json');
const LOCAL = () => path.join(db.paths.root, 'master-resume.json');

function seedPath() {
  if (fs.existsSync(BUNDLED())) return BUNDLED();
  if (fs.existsSync(EXAMPLE())) return EXAMPLE();
  return null;
}

function master() {
  if (!fs.existsSync(LOCAL())) {
    const seed = seedPath();
    if (!seed) throw new Error('No CV found. Open Settings and paste one in.');
    fs.copyFileSync(seed, LOCAL());
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LOCAL(), 'utf8'));
  } catch (err) {
    throw new Error('The CV file could not be read — it may have been edited into invalid JSON. '
      + `Open Settings to fix it, or restore a copy from the backups folder. (${err.message})`);
  }
  if (!data || !data.name) throw new Error('The CV has no name in it. Add one in Settings.');
  return data;
}

/** True while the CV is still the untouched example — the app prompts for hers. */
function isPlaceholder() {
  try {
    return master().placeholder === true;
  } catch { return true; }
}

function saveMaster(data) {
  if (!data || typeof data !== 'object' || !data.name) throw new Error('That is not a valid CV.');
  if (fs.existsSync(LOCAL())) {
    fs.copyFileSync(LOCAL(), path.join(db.paths.backups, `master-resume-${Date.now()}.json`));
  }
  delete data.placeholder;
  fs.writeFileSync(LOCAL(), JSON.stringify(data, null, 2));
  return data;
}

module.exports = { master, saveMaster, isPlaceholder, localPath: LOCAL };
