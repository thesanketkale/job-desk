# Job Desk — notes for Claude Code

A private, local-first job board and application desk built for one person:
Srishti Sharma, a counselling psychologist. Electron on Windows, no server.

## Run it

```bash
npm install
npm start            # npm run dev opens devtools
npm test             # 241 checks, no Electron and no network needed
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
stale — same as the prices. Confirmed live: `gemini-2.5-flash`, listed in
Google's own model catalogue as though it worked, 404s with "no longer
available to new users" — the catalogue is not proof a model actually answers.

**Gemini's 3.x models spend hidden "thinking" tokens before they answer, and
those tokens bill at the output rate.** Confirmed live: a trivial prompt used
`total_tokens: 99` against `completion_tokens: 1` — thinking can be 70-85% of
the real bill on a complex one. `providers.js#parseResponse` prices on
`total_tokens - prompt_tokens`, not `completion_tokens` alone, or Gemini spend
would be silently undercounted. `ping()` passes `reasoning_effort: "minimal"`
(the `cheapReasoningField`) so a tiny key-check call does not spend its entire
token budget on invisible reasoning and return nothing.

**`http.js#request()` reads the response body on a failing status too.** It
used to discard it, so every non-2xx reply reached `postJson`'s caller as a
bare `"HTTP 429"` — losing the provider's actual reason and bypassing
`friendlyError()` entirely. A provider's own error can also arrive wrapped in a
one-element array rather than a bare object; `parseResponse` unwraps both.

**Metered job-source adapters go through `sources.js#budgetedQueries`, and a
quota error must surface, never be swallowed.** `ingest.runAll()` used to pass
every active keyword to every adapter — Adzuna alone multiplied 16 keywords by
6 countries by 2 pages into ~192 calls a refresh, blowing a monthly free-tier
quota in hours — and every adapter's `catch` on a failed page swallowed the
error and returned whatever partial rows it already had, so a rate-limited
source still wrote `ok: 1` to `fetch_log` and showed a green pill on the
Sources page. `budgetedQueries()` takes a bounded slice of the keyword list
that rotates with `settings`'s `fetch_rotation` counter each refresh, so every
keyword is still used over a day, just not all at once. `isQuotaError()`
distinguishes a 429/403/rate-limit from a genuine end of results; the former is
re-thrown as an explicit, friendly error (e.g. "Adzuna refused further
requests (rate limit)."), the latter still just breaks the pagination loop.
Any new metered adapter needs both.

**A job-source API's documentation is a starting point, not the contract —
probe it live before trusting a field name or an endpoint path.** Careerjet
was dropped entirely: its dashboard requires whitelisting the server's IP,
which no ordinary install of a distributed desktop app can satisfy. Jooble's
`jobs[].id` is a bare JSON number outside `Number.MAX_SAFE_INTEGER` —
`JSON.parse` rounds it (a real id observed as `...378831` came back
`...379000`) — and `fingerprint()` keys dedup on `external_id` before it ever
looks at the URL, so `mapJoobleJob` pulls the id from the `/jdp/<id>` path in
`link` instead, which never goes through numeric parsing; a naive
trailing-digits regex on `link` is not enough on its own, because real list
responses append a tracking query string after the id (`?ckey=...&bscr=32.…`)
that a clean single-job fixture will not have, so the id must come from
inside the `/jdp/` path specifically. JSearch's plan-documented `GET /search`
returning `{data: [...]}` is stale: the currently-subscribed endpoint is
`/search-v2`, nested one level deeper as `{data: {jobs: [...]}}` — and
RapidAPI's 404 for a genuinely wrong path (`"Endpoint '/search' does not
exist"`) looks nothing like its 403 for an unsubscribed key (`"You are not
subscribed to this API"`), which is how to tell the two apart without
guessing. Both were caught by running the adapter through `fetchSource` end
to end against a live key, not by unit-testing the mapper against an
isolated fixture alone — do both before trusting a new adapter.

**RapidAPI job listings that resell LinkedIn, Naukri, Indeed or Glassdoor data
are scrapers with a paid middleman, not a licensed feed — do not add them.**
Evaluated and rejected: "LinkedIn Job Search API", "Indeed", "Glassdoor
Real-Time", a "Jobs API" with Bing/Indeed/LinkedIn sub-endpoints, and a
"JOBS SEARCH API" whose own params list `site_name:
[indeed, linkedin, zip_recruiter, glassdoor, naukri, bayt]`. A RapidAPI
reseller doing the scraping instead of this app doesn't change that the
underlying site's terms get violated, and it adds a second account (this
app's RapidAPI account) that can be banned for it. JSearch is the one
exception already in this codebase, and the distinction is real, not just
convenient: it resells Google for Jobs' own structured job data (confirmed
live — `job_publisher: "LinkedIn"` reached via a `google.com/search` link in
the response, not a direct crawl of linkedin.com), which is why it survived
this same review and the others didn't.

**A RapidAPI listing's name and description are marketing, not proof — check
what a live call actually returns before judging it on ToS grounds or
usefulness.** "Google Jobs API" sounds like a JSearch-style Google for Jobs
reseller; a real call returns generic web search results (Reddit threads,
relocation-advice blog posts) with `"company": "Reddit"` on a "job" —
rejected for not being job data at all, nothing to do with terms of service.
"faang.watch API"'s documented endpoints return its own marketing website's
HTML on every path tried, not JSON — rejected as broken, regardless of what
it claims to do. Conversely, "Active Jobs DB" shares a provider
("Fantastic.jobs") with the already-rejected "LinkedIn Job Search API", which
is a reason to check it carefully, not to reject it by association: a live
call shows every sampled job carrying `source_type: "ats"` (Workday,
SuccessFactors, Zoho Recruit, Eightfold observed) with the apply URL pointing
straight at the employer's own careers portal — the same category as the
`greenhouse`/`lever`/`ashby`/`workable` adapters above, just aggregated
across many boards at once. Added alongside "Free Y Combinator Jobs API"
(YC's own Work at a Startup board, `source_type: "jobboard"`, `source:
"ycombinator"`) — which carries no free-text description field in any
observed response, so `mapYcJob` leaves `description_html` empty rather than
substituting company-level metadata that describes the employer, not the role.

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

**A PDF is refused rather than half-read.** `pdf-text.js` returns
`{text, quality}` — `good`, `poor` or `none` — and `resume-read.js` throws on
anything but `good`. A scan has no text in it, only a picture of text; showing
somebody an empty or garbled CV and calling it theirs is worse than telling them
to paste it. Two things in there are load-bearing and non-obvious: array
brackets in a content stream must not clear the operand stack (they are
punctuation, not operators, and clearing on them discards every string before
its `TJ`), and bytes 0x80–0x9F must go through the WinAnsi table, or an en dash
becomes a control code and every "Dec 2019 – Mar 2023" stops parsing as a date
range, which loses every job on the CV.

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
| `src/main/resume-read.js` | Resume file → plain text. Picks the reader by extension. |
| `src/main/pdf-text.js` | PDF → plain text. Hand-rolled; no dependency. Reports its own confidence. |
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
