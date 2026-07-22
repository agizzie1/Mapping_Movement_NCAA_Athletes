# Mapping_Movement_NCAA_Athletes — website repo

This is the HAT Lab website repo, edited primarily in VS Code and pushed
manually via GitHub Desktop. The transfer-portal chord diagrams are embedded
as copies of the two standalone artifact repos' files:
- `artifact/football/` — `index.html`, `style.css`, `player-search.js`,
  `viz.js`, `chord_data.json`, plus a `fonts/` subfolder
  (`Sailec-Light.otf`, `Supria Sans Black.otf`) that `style.css`'s
  `@font-face` rules load
- `artifact/basketball/` — same 5 files, no `fonts/` subfolder (basketball's
  `style.css` has no `@font-face` rules of its own)

(Football grew from 4 files to 5 on 2026-07-20 when the player-search
feature was split out of `viz.js` into its own `player-search.js`.
Basketball's embed was added 2026-07-22, mirroring football's structure —
`basketball.html`'s `<section class="artifact-section">` now iframes
`artifact/basketball/index.html`, replacing the old `.coming-soon`
placeholder div.)

The source of truth for the football files is the separate repo
`agizzie1/Mapping_Movement_ARTIFACT`, local working copy at
`/Users/avagizzie/Desktop/HAT Lab/scraping 2026/github artifact uploads/`.
The source of truth for the basketball files is
`agizzie1/Mapping_Movement_ARTIFACT_BBALL`, local working copy at
`/Users/avagizzie/Desktop/HAT Lab/scraping 2026 - basketball/github artifact uploads/`.

## Standing authorization (scoped)

The user has pre-authorized committing and pushing to `origin/main` in
*this* repo, but **only** for the files under `artifact/football/` and
`artifact/basketball/` listed above, and **only** when syncing them from
the corresponding standalone artifact repo after an edit made there in
chat. No need to ask before each push — just push and tell the user it's
done.

This does **not** extend to any other file in this repo. The rest of the
site is the user's own VS Code + GitHub Desktop workflow:
- Never run `git add -A` or `git add .` in this repo — always add the
  specific artifact files by name (under `artifact/football/` or
  `artifact/basketball/`), so in-progress unstaged edits to other website
  files are never swept into a commit.
- Always check `git status` before committing here, so uncommitted work
  the user hasn't pushed via GitHub Desktop yet is left alone.
- Never touch `css/`, `js/`, `assets/`, `*.html` at the repo root, or
  anything outside `artifact/football/` and `artifact/basketball/`,
  without being explicitly asked.

Push auth: same SSH key/alias as the artifact repo
(`git@github.com-mapping-movement:...`) — this repo's `origin` remote was
switched from HTTPS to that alias on 2026-07-14 because HTTPS had no
cached credentials and failed non-interactively.
