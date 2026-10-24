# AGENTS.md: Job Desk

Shared rules for every AI agent on this repo, in Claude Code (through CLAUDE.md) and Google Antigravity (which reads this file directly). Keep it under ~150 lines. It is read at the start of every run. Write `TBD` rather than guessing.

## Project
- What it is: A private, local-first job board and application desk built for one person: Srishti Sharma, a counselling psychologist. Electron on Windows, no server.
- Users: Single user (counselling psychologist)
- Related repos and contracts: None (standalone desktop application)

## Stack packs
<!-- One per line. Agents load {skills dir}/stack-<name>/SKILL.md for each. -->
- electron-desktop
- github-actions

## Commands
- Install: npm install
- Run locally: npm run dev  →  URL: native Electron window (no HTTP URL)
- Verify fast: bash scripts/verify.sh fast (Windows PowerShell: ./scripts/verify.ps1 fast)
- Verify full: bash scripts/verify.sh full
- Disposable database: Embedded node:sqlite in user data folder; in-memory / mocked during tests (node tests/smoke.js). No external database server.

## Git
- Base branch: master
- Branches: feat/<slug>, fix/<slug>, chore/<slug>
- PR: manual

## Conventions
- Process split: Main owns disk, network, database; renderer is plain HTML/CSS/JS without framework; communication only via src/preload/preload.js with typed channels.
- IPC: Every handler returns {ok, data} or {ok, error} — never a bare throw.
- Truth enforcement: Never let AI models invent CV content. enforceTruth and enforceResumeTruth strictly overwrite from master CV.
- No auto-submission: The app never submits job application forms; apply-browser.js fills fields and attaches CV, then stops for the human user.
- Sending rails: Daily cap, per-employer cooldown, valid recipient, already-sent, unfilled placeholder enforced in applier.js.
- Spending & AI chain: Free-first chain (Gemini 3.7 -> 3.6 -> 3.5 Flash -> openrouter/free -> Claude fallback). budget.checkBeforeCall runs before paid Claude calls. Prices in providers.js. Account for Gemini thinking tokens.
- Job sources: Metered queries via sources.js#budgetedQueries; quota/rate-limit errors must surface, never be swallowed.

## Design
- Design system / tokens: src/renderer/app.css (:root CSS custom properties)
- Direction: Clean editorial warm light theme, high readability, accessible contrast, typography-focused
- Brand: Archivo (sans-serif) and Newsreader (serif); icons and layout in src/renderer/

## Safety: agents never do these. They prepare the command and hand it over.
- Deploy, publish, release, upload, sign or notarize builds (npm run release, scripts/release.mjs)
- Modify code-signing keys/certs in scripts/signing/ or export PFX
- Change real secrets, .env values, baked keys (src/main/baked-keys.js), CI/CD or production configuration
- Any write to a database other than the disposable/in-memory test DB
- Push to the base branch, force-push, rewrite published history
- Change update channels or auto-update release endpoints

## Known baseline failures
<!-- Pre-existing failures moved out of `fast`, with a note on why. Remove as they get fixed. -->

## Lessons
<!-- One line each, added only with the user's approval after a review found a repeatable mistake.
     Format: - [area] Do X, not Y, because Z. -->
