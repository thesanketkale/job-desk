# Getting this onto GitHub, with builds on every release

About twenty minutes, once. Replace `OWNER` with your GitHub username throughout.

---

## 1. Get the code onto your machine

Unzip the bundle somewhere sensible — `D:\projects\jobdesk` or similar — then:

```bash
cd jobdesk
npm install
npm test          # 344 checks, should all pass
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

## 3. One repository — public, or private with a token

Create `jobdesk` on GitHub, public or private — both work for updates now.

**Public** is simpler:

- The app can update itself with no token at all, because public releases are
  readable by anyone.
- CI minutes are unlimited and free on public repositories.
- There is no fine-grained PAT to create, store, or replace when it expires.

**Private** needs one extra thing per person running the app: a GitHub Personal
Access Token, pasted into Settings → *Where everything is kept*. `updater.js`
uses it to call the GitHub API as `PrivateGitHubProvider` instead of the
unauthenticated one — the token stays on that machine (stored the same way the
Gemini or SMTP key is, through `settings.setSecret`, which is `safeStorage`
under the hood) and is never bundled into the installer, so extracting the
`.exe` gives nobody the token.

Give her a **fine-grained** token, not a classic one — narrower is safer for a
token that is handed over rather than kept:

1. github.com/settings/personal-access-tokens/new
2. Resource owner: your account. Repository access: **Only select repositories**
   → this one.
3. Repository permissions → **Contents: Read-only**. Nothing else.
4. Set an expiration (a year is reasonable) and generate it.
5. Hand her the token string once — GitHub will not show it again. It goes into
   Settings → *Where everything is kept* → *GitHub access token*.

Either way, this is only safe because **nothing personal is in the repository
or the build**:

- `resources/master-resume.json` — the real CV — is in `.gitignore`.
- It is also excluded from `build.files`, so it never reaches an installer.
- `scripts/check-build-privacy.mjs` reads the real CV (when present) and greps
  the whole build for every value in it, plus a small fixed denylist of values
  that have leaked once before (see the comment at the top of that file) so the
  same mistake catches itself even without the real CV on the machine doing the
  check. CI runs it *before* publishing and fails the release if anything
  matches.

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

Download `JobDesk-Setup-x.y.z.exe` from Releases and hand it over.

If the build is signed (see *Signing the build* below) and she has imported the
certificate once, it installs with no SmartScreen prompt at all. Unsigned, or on
a machine that has not imported the certificate yet, Windows SmartScreen says
*"Windows protected your PC"* on first run — **More info** → **Run anyway**,
once. It never asks again either way.

**The CV.** The installer deliberately ships without one, by design. Either:

- let the app read the resume on first launch, which is the normal path, **or**
- copy `resources/master-resume.json` from your repo into
  `%APPDATA%\Job Desk\master-resume.json` before it is first opened, **or**
- build a personal copy that has it baked in: `npm run build:win:personal`,
  which writes to `dist-personal\`. Never publish that file anywhere.

After the first release, updates take care of themselves: the app checks on
launch, downloads quietly, and installs when the app is next closed.

---

## Signing the build

Not a paid certificate — those run about $200/year and buy Windows-wide
reputation. This is a **self-signed** one instead: free, but trusted on
nowhere except the one machine that has been told to trust it. That is
exactly the scope needed here — one app, one person, one machine — and it is
what removes the SmartScreen prompt for her specifically, not for the world.

**Generate it once:**

```powershell
.\scripts\create-signing-cert.ps1
```

This writes four files to `scripts\signing\` (already gitignored — never commit
any of them):

| File | What it is |
|---|---|
| `jobdesk-signing.pfx` | The private key. electron-builder signs with this. Keep it. |
| `pfx-password.txt` | The password for the .pfx, generated randomly. Move it to a password manager, then delete this file. |
| `jobdesk-signing.pfx.base64.txt` | The .pfx re-encoded as a `data:` URL, for pasting into a GitHub Actions secret (a secret cannot point at a local file path). |
| `jobdesk-signing.cer` | The public certificate — no private key, safe to hand over. **This is the one Srishti needs**; GUIDE.md has her side of the steps. |

**Building locally, signed:**

```powershell
$env:CSC_LINK = (Resolve-Path ".\scripts\signing\jobdesk-signing.pfx").Path
$env:CSC_KEY_PASSWORD = Get-Content ".\scripts\signing\pfx-password.txt" -Raw
npm run build:win
```

electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD` automatically — nothing
in `package.json` needs to name the certificate. Leave the two variables unset
and the build comes out unsigned exactly as before, so signing is opt-in, not a
new requirement.

**Signing in CI:** add two repository secrets (Settings → Secrets and variables
→ Actions):

- `CSC_LINK` — the entire contents of `jobdesk-signing.pfx.base64.txt`
- `CSC_KEY_PASSWORD` — the contents of `pfx-password.txt`

`release.yml` already passes both through to the build step; the release
workflow signs automatically the moment those two secrets exist, and simply
builds unsigned if they do not.

**What this does and does not do:**

- It stops Windows from calling the publisher "Unknown" and lets the same
  certificate vouch for every future signed release — updates included — once
  it is trusted.
- It does **not** get the SmartScreen prompt to go away on a machine that has
  never seen this certificate. Reputation is not something a self-signed
  certificate can buy; only Srishti's own machine, after the one-time import
  in GUIDE.md, trusts it.
- Re-running the script makes a *different* certificate (a new thumbprint).
  Anything already trusted only trusts the old one — a new certificate means
  a new `.cer` to import, on every machine that trusted the previous one.

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
`package.json` and that `build.publish[0].owner`/`repo` match the real
repository. If it is private, check Settings shows a GitHub token saved — the
"Check for updates" button and the background check both now show the actual
reason in Settings (a rejected token, a repository the token cannot see, no
release found) instead of only writing it to `%APPDATA%\Job Desk\logs\`; the
log is still there too, for anything that happens before the window is open.

**You want updates turned off.** Set `updates.channel` to `off` in `package.json`
and release. The Settings button then just opens the releases page.
