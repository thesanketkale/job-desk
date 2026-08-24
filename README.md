# Job Desk

A job board and application desk that runs entirely on your own machine.

It pulls openings from published job APIs and company career pages, ranks each
one against a keyword vocabulary you control, generates your CV as PDF and Word,
drafts the covering email, sends it from your own mailbox, opens company
application forms inside itself and fills them in, and chases the ones that go
quiet.

No server. No account. No subscription. Your CV, your applications and every
document it has ever made for you stay in a folder on your computer.

Built originally for one counselling psychologist's job search, then generalised.
It works for any field — the vocabulary and the CV are both yours to define.

![Job Desk](https://img.shields.io/badge/platform-Windows-3f5d4b) ![License](https://img.shields.io/badge/license-MIT-3f5d4b)

## Install

Download the latest `Job Desk Setup x.y.z.exe` from
[Releases](https://github.com/thesanketkale/job-desk/releases) and run it. It installs
per-user, so it needs no administrator rights, and updates itself from then on.

Windows SmartScreen will warn on first run because the app is unsigned:
**More info** → **Run anyway**, once.

On first launch it asks for your CV. Everything the app produces is built from it.

## It works without an AI key

The whole app is usable, free, with no key at all: finding, ranking, filtering,
generating CV documents, sending applications, filling company forms, tracking,
follow-ups. In that mode it sends your full CV with a template letter that names
the role and describes your background, and leaves you one sentence to write.

An optional Claude API key adds three things: the CV is rewritten for each role,
the email is written from the job description, and you get an honest read on
whether you actually qualify — including blockers like a licence you do not hold.
About ₹5 (US$0.06) per application, prepaid, with a monthly cap the app enforces
itself before every request.

## Why it is built this way

**Electron, because Electron already contains Chromium.** The in-app browser
that fills company application forms needs a real browser engine. Bundling
Playwright or Puppeteer would add another 150 MB and a second browser to keep
updated. The app drives the one it already has.

**`node:sqlite`, not `better-sqlite3`.** Electron 43 ships Node 24, which has
SQLite built into the runtime. That removes the only native module the app would
otherwise need — so there is no `node-gyp`, no Visual Studio Build Tools, and no
rebuild step on any machine that touches this project.

**Hand-written PDF layout on top of `pdfkit`, standard fonts only.** Applicant
tracking systems parse Helvetica-family text reliably and choke on clever
layouts. The CV is one column, real text, no tables.

## Where things live

| | |
|---|---|
| `src/main/` | Everything with access to the disk, the network, and the database |
| `src/preload/` | The narrow bridge the interface is allowed to call |
| `src/renderer/` | The interface — plain HTML, CSS and JavaScript, no framework |
| `resources/` | The master CV and the app icon, shipped inside the build |
| `tests/` | `npm test` (no Electron needed) and a screenshot harness |

Her data is written to `%APPDATA%\Job Desk\` — or, in a portable build, to a
`JobDesk-Data` folder beside the `.exe`:

```
jobdesk.sqlite        every role, application, follow-up and log line
master-resume.json    the CV everything is tailored from
resumes/              every generated CV, kept for ever, named by employer and date
backups/              rolling copies of the database and the CV
logs/                 crash log, if there ever is one
```

## How it fits together

```
Find new jobs
  → sources.js    one adapter per source: Adzuna, Remotive, RemoteOK, Himalayas,
                  Arbeitnow, USAJOBS, Greenhouse/Lever/Ashby/Workable boards, and
                  any RSS or Atom feed
  → normalize.js  work mode, city/region/country, plain text, application address,
                  a stable fingerprint so the same role never lands twice
  → score.js      the keyword vocabulary, weighted, title matches worth 3x,
                  plus work-mode, country and recency adjustments
  → jobs table

Tailor & apply
  → claude.js     rewrites the CV against the description, drafts the email
  → enforceTruth  employers, dates, education and certifications are overwritten
                  from the master CV afterwards; any experience entry that cannot
                  be traced back to a real one is deleted
  → resume-pdf.js / resume-docx.js   the same layout in both formats
  → applier.js    rails: daily cap, per-employer cooldown, valid recipient,
                  already-sent check — all enforced in the main process
  → mailer.js     her own mailbox, BCC'd to herself
  → followups.js  the chase is scheduled the moment it sends

Fill in the company form
  → apply-browser.js   a WebContentsView with its own persistent session
  → autofill-script.js runs in the page, matches fields by their longest
                       matching label, marks what it touched
  → DevTools protocol  DOM.setFileInputFiles genuinely attaches the tailored CV
                       to the page's upload field
  → and then it stops. She reads it and presses Submit.
```

## The API key is optional

The app is fully functional with no key. `templates.js` is the no-key path: the
master CV goes out as-is with a locally generated letter that names the role and
the employer, built from the CV's own `pitch` field so editing the CV updates
every future letter. `applier.prepare()` branches on `claude.available()` and
both paths return the same shape, so nothing downstream knows the difference —
the application row records which was used in its `mode` column.

What a key actually buys, and the interface says exactly this rather than
overselling it:

| | Without a key | With a key |
|---|---|---|
| Finding, ranking, filtering | Full | Full |
| CV documents | Master CV, PDF + Word | Rewritten per role |
| Email | Template, one line for her to write | Written from the job description |
| Fit assessment | Keyword score only | Reads the description; flags licence, visa and time-zone blockers |
| Follow-up wording | Template | Written for the role |
| Sending, forms, tracking, follow-up scheduling | Full | Full |

The template letter deliberately leaves a bracketed placeholder for one sentence
she must write herself. `applier.send()` refuses while it is still present — the
one thing worse than a generic application is a generic application with the
instructions left in.

## The things that are deliberate

**It never presses Submit.** The form filler fills and highlights; a human
clicks. A mis-parsed field that has already been submitted cannot be recalled,
and in Indian counselling and EAP hiring the community is small enough that it
would be remembered.

**The tailoring cannot invent.** The prompt forbids it and `enforceTruth` then
overwrites every frozen fact from the master CV. A prompt is a request; a guard
is a guarantee.

**Nothing scrapes.** Every source is a published API or a company's own career
feed, so it will not break on a redesign and will not get her IP blocked.

**Spending cannot run away.** `budget.js` holds the price table and a per-month
ledger. `checkBeforeCall()` runs *before* every request and refuses it if the
worst-case cost would breach the month's cap — so the limit is enforced ahead of
the spend, not discovered after the bill. Model choice (Sonnet 5 / Haiku 4.5 /
Opus 5) is a setting, and the cost per application is shown in real terms. Note
that Console API billing is entirely separate from any Claude subscription; a
subscription cannot be drawn down by this app.

**Secrets go through `safeStorage`.** The Claude key and the mailbox password are
encrypted with a key held by Windows itself, so the database file alone does not
expose them. If Windows refuses the secure store, the app says so in Settings
rather than failing silently.

## Running it from source

```bash
npm install
npm start          # or: npm run dev   (opens developer tools)
npm test           # 88 checks, no Electron or network needed
```

`npm start` and `npm run dev` work on any recent Node, because Electron brings
its own (Node 24). `npm test` runs on your system's own `node`, though, and it
needs **Node 22.5 or newer** — that's when `node:sqlite` shipped. Check with
`node -v`; on an older Node, `npm test` fails immediately with
`ERR_UNKNOWN_BUILTIN_MODULE` rather than running the app.

## Building the Windows app

On a Windows machine with Node 22.5+ installed:

```bash
npm install
npm run build:win        # installer + portable, both x64, into dist\
```

That produces:

- `dist\Job Desk Setup 1.0.0.exe` — a normal installer with Start Menu and
  desktop shortcuts, installs per-user so it needs no administrator rights.
- `dist\JobDesk-portable-1.0.0.exe` — a single file that runs from anywhere and
  keeps its data beside itself. Good for a USB stick, or for trying it before
  installing.

`npm run build:portable` builds only the second one, which is faster.

**Code signing.** Unsigned, Windows SmartScreen shows "Windows protected your
PC" on first run: *More info* → *Run anyway*, once. It is worth signing before
handing this to anyone else; for one person on one machine it is not.

`npm run build:mac` and `npm run build:linux` are wired up too. macOS builds must
run on a Mac.

## Adding a company's career page

Most employers publish through Greenhouse, Lever, Ashby or Workable. The board
name is the last part of their careers URL — `boards.greenhouse.io/lyrahealth`
is `lyrahealth`. Sources → *Check it first* asks the real API before saving, so a
wrong name is caught immediately rather than silently returning nothing.

## Things worth knowing before it goes wrong

- **The board is empty.** She has not pressed *Find new jobs* yet, or the
  minimum score in Settings is too high.
- **Nothing from India.** The Adzuna keys are missing. They are free and they are
  where most Indian listings come from.
- **A source shows red.** Company boards change their name when a company
  switches systems. The Test button on Sources says so in one click.
- **Email fails.** Settings → *Check it works* prints the actual SMTP error in
  plain language rather than a code.
- **A form will not fill.** Some pages build their fields after load, or hide
  them behind a login. Reload, then fill. Failing that, *Show me the CV file* and
  drag it in.
