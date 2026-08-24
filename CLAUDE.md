# Job Desk — notes for Claude Code

A private, local-first job board and application desk built for one person:
Srishti Sharma, a counselling psychologist. Electron on Windows, no server.

## Run it

```bash
npm install
npm start            # npm run dev opens devtools
npm test             # 228 checks, no Electron and no network needed
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

**Never let the model invent CV content.** `ai.js` asks for a rewrite, and
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
runs first in `ai.js#call`. Prices live per provider in `providers.js` and go
stale — verify against that provider's own pricing page before trusting them.

**One shape above `providers.js`.** Anthropic has its own wire format; Google,
OpenRouter and OpenAI all speak OpenAI-compatible `/chat/completions`, so there
are exactly two adapters and adding a provider is a table entry. Everything above
sees `{text, usage}` with Anthropic's token names. `enforceTruth` and
`enforceResumeTruth` run on the reply whatever produced it — a cheaper provider is
never a weaker guarantee.

**Gemini is the default because its free tier is real.** `budget.providerId()`
falls back to `anthropic` when an install already has a Claude key, so nobody's
provider changes underneath them. Model ids are scoped to the provider and the
live list is fetched on key validation, because the table in `providers.js` goes
stale — same as the prices.

**The app works with no API key.** `templates.js` is the free path; `applier.prepare()`
branches on `ai.available()` and both branches return the same shape. Any new
feature that only works with a key needs a template fallback or a clear reason.
Onboarding asks for a key *after* setup is complete and Skip is a first-class
button, because the app is genuinely finished at that point.

**A key is checked before it is stored.** `ai.validateKey()` tests the shape
against that provider's format locally, then spends a fraction of a paisa proving
it against the real API;
`settings:validateClaudeKey` saves only on success. A key that is saved but wrong
looks like it is working until the first application fails.

**The vocabulary belongs to the resume, not to the source.** There is no starter
keyword list in `seed.js` any more, deliberately: one typed by somebody else
describes somebody else's career. `profile.rebuild()` builds it from the CV.
When it runs again it deletes only rows with `source = 'resume'` — anything the
person added, re-weighted or toggled is marked `source = 'user'` and survives.
If you add a path that writes keywords, set `source` or it will be treated as
theirs and never refresh.

**A parse is shown before it is saved.** `profile.preview()` reads and returns;
`profile.apply()` is what writes. Nothing derived from a resume — the CV, the
contact details, the keywords — is committed without the person seeing it in the
review step first. Heuristics get things wrong, and a wrong parse that is visible
costs a correction while a silent one costs a wrong application.

**The installer must never contain personal data.** `resources/master-resume.json`
is excluded from `build.files`; the CV is copied into the user's data folder on
first run. This is what makes the public releases repo safe. There is a test and
a CI step guarding it.

## Where things are

| Path | What |
|---|---|
| `src/main/db.js` | Schema and query helpers. Migrations are additive-only, in `migrate()`. |
| `src/main/resume-read.js` | Resume file → plain text. `.docx` via a hand-rolled ZIP read; no dependency. |
| `src/main/resume-parse.js` | Plain text → the CV shape, plus the flat profile facts. |
| `src/main/resume-keywords.js` | CV → the query/boost vocabulary. |
| `src/main/profile.js` | Owns the whole consequence of an import: CV, facts, mailbox, keywords. |
| `src/main/sources.js` | One adapter per job source. All published APIs; nothing scrapes. |
| `src/main/normalize.js` | Feed data → one comparable shape. Work mode, place, entities, fingerprints. |
| `src/main/score.js` | Keyword ranking. Title matches count triple. |
| `src/main/ai.js` | Tailoring and follow-up drafting, plus the truth guards. Provider-agnostic. |
| `src/main/providers.js` | Which service, and the two wire formats. A new provider is a table entry. |
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
