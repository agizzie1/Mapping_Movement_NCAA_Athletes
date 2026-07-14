# Mapping_Movement_NCAA_Athletes — website repo

This is the HAT Lab website repo, edited primarily in VS Code and pushed
manually via GitHub Desktop. The transfer-portal chord diagram is embedded
in the football page as a copy of the standalone artifact repo's files,
living at `artifact/football/`:
- `index.html`, `style.css`, `viz.js`, `chord_data.json`

The source of truth for those 4 files is the separate repo
`agizzie1/Mapping_Movement_ARTIFACT`, whose local working copy is at
`/Users/avagizzie/Desktop/HAT Lab/scraping 2026/github artifact uploads/`.

## Standing authorization (scoped)

The user has pre-authorized committing and pushing to `origin/main` in
*this* repo, but **only** for the four files under `artifact/football/`
listed above, and **only** when syncing them from the standalone artifact
repo after an edit made there in chat. No need to ask before each push —
just push and tell the user it's done.

This does **not** extend to any other file in this repo. The rest of the
site is the user's own VS Code + GitHub Desktop workflow:
- Never run `git add -A` or `git add .` in this repo — always add the
  specific artifact files by name, so in-progress unstaged edits to other
  website files are never swept into a commit.
- Always check `git status` before committing here, so uncommitted work
  the user hasn't pushed via GitHub Desktop yet is left alone.
- Never touch `css/`, `js/`, `assets/`, `*.html` at the repo root, or
  anything outside `artifact/football/`, without being explicitly asked.

Push auth: same SSH key/alias as the artifact repo
(`git@github.com-mapping-movement:...`) — this repo's `origin` remote was
switched from HTTPS to that alias on 2026-07-14 because HTTPS had no
cached credentials and failed non-interactively.
