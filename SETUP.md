# Getting this onto GitHub, with builds on every release

About twenty minutes, once. Replace `OWNER` with your GitHub username throughout.

---

## 1. Get the code onto your machine

Unzip the bundle somewhere sensible — `D:\projects\jobdesk` or similar — then:

```bash
cd jobdesk
npm install
npm test          # 190 checks, should all pass
npm start         # the app opens
```

If `npm test` passes, the code arrived intact. `npm test` needs Node 22.5 or
newer on your system PATH (that's when `node:sqlite` shipped) — if it fails
immediately with `ERR_UNKNOWN_BUILTIN_MODULE`, that's an old system Node, not a
broken checkout. `npm start` works on any recent Node regardless, since
Electron bundles its own.

## 2. Continue in Claude Code

```bash
cd jobdesk
claude
```

`CLAUDE.md` is already in the repo, so Claude Code picks up the architecture, the
rules that matter, and the conventions without you explaining anything. Start with
something like *"read CLAUDE.md, then add X"*.

## 3. One public repository

Create `jobdesk` on GitHub as a **public** repository.

Public is the right call here, and it is what makes everything else simple:

- The app can update itself with no token at all, because public releases are
  readable by anyone. On a private repo, `electron-updater` needs a GitHub token
  shipped inside the `.exe`, where anyone with the file could extract it.
- CI minutes are unlimited and free on public repositories.
- There is no fine-grained PAT to create, store, or replace when it expires.

This is only safe because **nothing personal is in the repository or the build**:

- `resources/master-resume.json` — the real CV — is in `.gitignore`.
- It is also excluded from `build.files`, so it never reaches an installer.
- `scripts/check-build-privacy.mjs` reads the real CV and greps the whole build
  for every value in it. CI runs it *before* publishing and fails the release if
  anything matches.

**Keep the real CV somewhere.** It is not in the repo any more. A private gist, a
password manager note, or just the copy already in `%APPDATA%\Job Desk\` on the
machine running it. Losing it means importing the resume again, nothing worse.

## 4. Push it

```bash
cd jobdesk
git init
git add .
git commit -m "Job Desk: a local-first job board and application desk"
git branch -M main
git remote add origin https://github.com/thesanketkale/job-desk.git
git push -u origin main
```

Before that first push, replace the `OWNER` placeholders in `package.json`
(`repository.url`, `build.publish[0].owner`, `updates.releasesPage`), in
`README.md`, and in `LICENSE`.

Then verify nothing personal went up:

```bash
git ls-files | grep master-resume
# should show only master-resume.example.json
```

## 5. No secrets to configure

Nothing. `GITHUB_TOKEN` is issued automatically for each workflow run and can
publish releases to its own repository. This is the main practical advantage of
going public.

## 6. Cut the first release

```bash
npm run release        # 1.0.0 -> 1.0.1, commits, tags, pushes
```

Pushing the tag is the only thing that triggers a build. Watch it at
`github.com/thesanketkale/job-desk/actions`. About five minutes later the installer
and the portable `.exe` appear at `github.com/thesanketkale/job-desk/releases`.

`npm run release minor` and `npm run release 2.0.0` also work.

## 7. Hand the app over

Download `Job Desk Setup x.y.z.exe` from Releases and hand it over.

Windows SmartScreen will say *"Windows protected your PC"* on first run because
the app is unsigned — **More info** → **Run anyway**, once. It never asks again.
(A code-signing certificate is about $200/year and removes that. For one person
on one machine it is not worth it.)

**The CV.** The installer deliberately ships without one, by design. Either:

- let the app read the resume on first launch, which is the normal path, **or**
- copy `resources/master-resume.json` from your repo into
  `%APPDATA%\Job Desk\master-resume.json` before it is first opened, **or**
- build a personal copy that has it baked in: `npm run build:win:personal`,
  which writes to `dist-personal\`. Never publish that file anywhere.

After the first release, updates take care of themselves: the app checks on
launch, downloads quietly, and installs when the app is next closed.

---

## What runs when

| | Trigger | Runner | Roughly |
|---|---|---|---|
| `test.yml` | every push and PR to `main` | Linux | 1–2 min |
| `release.yml` | pushing a `v*` tag | Windows | 5–8 min |

Both are free and unmetered on a public repository. The tests still run on the
cheap Linux runner, so a green tick on a pull request takes a minute rather than
eight.

## Day-to-day

```bash
git checkout -b some-change
# work, with Claude Code if you like
npm test
git commit -am "What changed"
git push -u origin some-change
# open a PR, tests run automatically, merge

git checkout main && git pull
npm run release
```

## If something goes wrong

**The release workflow fails at the publish step.** Check Settings → Actions →
General → Workflow permissions is set to **Read and write**. The build artifacts
are still attached to the Actions run, so nothing is lost — fix it and re-run the
job.

**The release is refused for containing personal details.** That is
`check-build-privacy.mjs` doing its job. It prints which value appeared in which
file. Usually it means a name or address was written into the source instead of
being read from the CV at runtime.

**The build fails on Windows but works locally.** Usually a filename case
mismatch; Windows does not care about case and Linux CI does. Check your imports.

**No updates are showing up.** Confirm `updates.channel` is `github-public` in
`package.json` and that `build.publish[0].owner` matches your username. The app
logs update failures silently on purpose — check `%APPDATA%\Job Desk\logs\`.

**You want updates turned off.** Set `updates.channel` to `off` in `package.json`
and release. The Settings button then just opens the releases page.
