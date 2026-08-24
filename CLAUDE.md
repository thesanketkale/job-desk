# Job Desk — notes for Claude Code

A private, local-first job board and application desk built for one person:
Srishti Sharma, a counselling psychologist. Electron on Windows, no server.

## Run it

```bash
npm install
npm start            # npm run dev opens devtools
npm test             # 88 checks, no Electron and no network needed
```

`npm test` needs Node 22.5+ on the system PATH (`node:sqlite` isn't available
before that) — `npm start`/`npm run dev` don't care, since Electron brings its
own Node 24. `npm test` is fast and covers the logic that matters. Run it
before and after any change to `src/main/`.

## Architecture in one paragraph

The main process owns everything with access to the disk, the network and the
database; the renderer is plain HTML/CSS/JS with no framework and reaches the
main process only through `src/preload/preload.js`, which exposes a fixed list of
channels. Every IPC handler returns `{ok, data}` or `{ok, error}` — never a bare
throw — so the interface never has to guess. Data lives in one SQLite file in the
user's data folder.

## Rules that are load-bearing, not stylistic

**Never let the model invent CV content.** `claude.js` asks for a rewrite, and
`enforceTruth()` then overwrites employers, dates, education and certifications
from the master CV and deletes any experience entry that cannot be traced back to
a real one. If you touch the tailoring path, that function must still run last.
There are tests for it; they are not decorative.

**The app never submits an application form.** `apply-browser.js` fills fields
and attaches the CV, then stops. Adding a click-submit would be a product
regression, not a feature.

**Sending rails live in `applier.js`, not the interface.** Daily cap, per-employer
cooldown, valid recipient, already-sent, unfilled placeholder. Anything that can
send must go through `applier.send()`.

**Spending is checked before the request, not after.** `budget.checkBeforeCall()`
runs first in `claude.js#call`. Prices are in `budget.js` and go stale — verify
against claude.com/pricing before trusting them.

**The app works with no API key.** `templates.js` is the free path; `applier.prepare()`
branches on `claude.available()` and both branches return the same shape. Any new
feature that only works with a key needs a template fallback or a clear reason.

**The installer must never contain personal data.** `resources/master-resume.json`
is excluded from `build.files`; the CV is copied into the user's data folder on
first run. This is what makes the public releases repo safe. There is a test and
a CI step guarding it.

## Where things are

| Path | What |
|---|---|
| `src/main/db.js` | Schema and query helpers. Migrations are additive-only, in `migrate()`. |
| `src/main/sources.js` | One adapter per job source. All published APIs; nothing scrapes. |
| `src/main/normalize.js` | Feed data → one comparable shape. Work mode, place, entities, fingerprints. |
| `src/main/score.js` | Keyword ranking. Title matches count triple. |
| `src/main/claude.js` | Tailoring and follow-up drafting, plus the truth guard. |
| `src/main/templates.js` | The no-key path. |
| `src/main/applier.js` | Prepare, send, rails, status. |
| `src/main/apply-browser.js` | The in-app browser. Uses CDP `DOM.setFileInputFiles` to attach the CV. |
| `src/main/budget.js` | Prices, monthly ledger, the hard cap. |
| `src/renderer/app.js` | Every view. One function per route in `VIEWS`. |
| `src/renderer/app.css` | Design tokens at the top. Nothing below them uses a raw pixel value. |

## Conventions

- British/Indian English in all user-facing text, including error messages.
- Errors tell the person what to do next, not what the exception was.
- Two fonts, one sage accent (`--accent: #3f5d4b`), warm neutrals. Tokens only.
- No dependency gets added without a reason that survives a sentence of scrutiny.
  There are currently four, and `node:sqlite` deliberately replaced a fifth.

## Releasing

```bash
npm run release          # patch: 1.0.0 -> 1.0.1
npm run release minor
```

That bumps, commits, tags and pushes. The tag triggers `.github/workflows/release.yml`,
which builds on Windows and publishes to the public releases repo. See SETUP.md.
