# Job Desk

A job board and application desk that runs entirely on your own machine.

It pulls openings from published job APIs and company career pages, ranks each
one against a vocabulary built from your own CV, writes the application, sends it
from your own mailbox, fills in company forms, and chases the ones that go quiet.

No server. No account. No subscription. Your CV, your applications and every
document it has ever made for you stay in a folder on your computer.

![Job Desk](https://img.shields.io/badge/platform-Windows-3f5d4b) ![License](https://img.shields.io/badge/license-MIT-3f5d4b)

## Install

Download the latest `Job Desk Setup x.y.z.exe` from
[Releases](https://github.com/thesanketkale/job-desk/releases) and run it. It
installs per-user, so it needs no administrator rights, and updates itself from
then on. Windows SmartScreen warns once because the app is unsigned:
**More info** → **Run anyway**.

On first launch it reads your resume — PDF, Word, or text pasted in — and builds
everything from it: your name and contact details, and the words it searches the
job sites for.

**[How to use it →](GUIDE.md)**

## What it does

| | |
|---|---|
| **Finds** | Adzuna, Remotive, RemoteOK, Himalayas, Arbeitnow, Jooble, JSearch, Active Jobs DB, Y Combinator's board, any Greenhouse / Lever / Ashby / Workable board, any RSS or Atom feed |
| **Ranks** | Every role scored out of 100 against keywords taken from your own CV |
| **Writes** | Your CV as PDF and Word, a covering letter, and the email |
| **Sends** | From your own mailbox, copied to your inbox |
| **Fills** | Company application forms, inside the app — and never presses Submit |
| **Chases** | Follow-ups, scheduled the moment an application goes out |

All of that works with no AI key and no payment of any kind.

## The AI key is optional

Without one, each application sends your full CV with a template letter that
leaves you one sentence to write. With one, the CV is rewritten for each role,
the email is written from the job description, and you get an honest read on
whether you actually qualify.

Three services work: **Google Gemini** (the default — its free tier needs no
card), **Anthropic Claude**, and **OpenRouter**. Whichever you pick, the app
enforces its own monthly spending cap before every single request. Note that a
consumer chat subscription is not API access; the key comes from the provider's
developer console instead.

## Why it is built this way

**Electron, because it already contains Chromium.** The in-app browser that fills
company forms needs a real browser engine, and bundling a second one would add
another 150 MB.

**Four dependencies, and `node:sqlite` replaced a fifth.** Both `.docx` and
`.pdf` are read by hand rather than by a library: a `.docx` is a ZIP of XML, a
PDF's text sits in FlateDecode streams, and `node:zlib` already does the hard
part in both cases. A PDF that is a scan is refused with an explanation rather
than handed back as an empty CV.

**The tailoring cannot invent.** The prompt forbids it, and `enforceTruth()` then
overwrites every frozen fact from the master CV and deletes any experience entry
that cannot be traced back to a real one. A prompt is a request; a guard is a
guarantee — and it runs on the reply whichever service produced it.

**It never presses Submit.** The form filler fills and highlights; a human reads
it and clicks. A mis-parsed field that has already been submitted cannot be
recalled.

**Nothing scrapes.** Every source is a published API or a company's own career
feed, so it will not break on a redesign or get your IP blocked.

**Spending cannot run away.** The monthly cap is checked *before* each request,
rather than discovered afterwards on a bill.

## Where things live

| | |
|---|---|
| `src/main/` | Everything with access to the disk, the network and the database |
| `src/preload/` | The narrow bridge the interface is allowed to call |
| `src/renderer/` | The interface — plain HTML, CSS and JavaScript, no framework |
| `tests/` | `npm test`, which needs neither Electron nor the network |

Your data is written to `%APPDATA%\Job Desk\` — the database, the master CV,
every generated CV, and rolling backups. A portable build keeps the same folder
beside the `.exe` instead.

## From source

```bash
npm install
npm start          # npm run dev opens devtools
npm test           # 241 checks
```

`npm test` runs on your system's own Node and needs **22.5 or newer** — that is
when `node:sqlite` shipped. `npm start` does not care, because Electron brings
its own. Building needs Node 22.5+ as well:

```bash
npm run build:win  # installer + portable, both x64, into dist\
```

**[Publishing and CI →](SETUP.md)** · **[Architecture notes →](CLAUDE.md)**

## Licence

MIT. Built originally for one counselling psychologist's job search, then
generalised — it works for any field, since the CV and the vocabulary are both
yours.
