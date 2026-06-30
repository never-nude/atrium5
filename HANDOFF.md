# Atrium.earth — Working Handoff (resume on any machine)

Single doc to pick up atrium.earth work. Read top to bottom once. Last updated 2026-06-30.

## 0. What it is
Digital sculpture museum. **Live: https://atrium.earth** (GitHub Pages). Astro single-build
site, MapLibre-free — Three.js viewer per piece. **231 works** as of this handoff.
- Repo: **`github.com/never-nude/atrium.earth`** (RENAMED from `atrium5` on 2026-06-30; the
  old URL still redirects). branch `main` → serves the live site. `public/CNAME` = atrium.earth.
- Older repos `atrium`, `atrium4` are stale — do not touch.

## 1. Machines, repo, accounts
- Desktop clone: `~/Documents/Claude/Projects/Atrium.earth` (Cowork-connected folder).
- Laptop clone: `~/Projects/_active/atrium-earth`.
- **Pull before work, push after.** Both machines on `main`.
- Fix the remote on each machine after the rename:
  `git remote set-url origin https://github.com/never-nude/atrium.earth.git`
- **Push gotcha:** GitHub has two accounts — `wp-cna` (default active) and `never-nude` (owns
  the repo). Plain `git push` 403s as wp-cna. Before pushing:
  `gh auth switch --user never-nude && gh auth setup-git && git push`

## 2. The workflow (set 2026-06-30)
**Claude + Mike own the whole pipeline end-to-end.** Codex is scoped to **harvesting only**:
it finds/fetches meshes, converts them to clean STL, and pushes raw files + manifests to the
**vault** (`never-nude/atrium-vault`). **Codex never commits/pushes to the site repo** — its
pushes there silently 403 (wp-cna) and stall as "committed but not pushed."

Flow per batch: Codex harvests → vault → Mike runs ingest + asset build on the Mac → Claude
QAs orientation/framing/metadata → Mike pushes.

## 3. Deploy / ingest commands (Mac only)
Renders need local Chrome + native `sharp`; previews need the trimesh venv — **these run on the
Mac, not in Claude's sandbox.**

Ingest a new vault batch (vault cloned as sibling `../atrium-vault`):
```
git -C ../atrium-vault pull
npm run ingest -- --dry-run                 # validate
GITHUB_TOKEN=$(gh auth token) npm run ingest # downloads sources, appends catalog
SOURCE_ATRIUM_DIR=../atrium npm run models:preview   # STL/OBJ/PLY/GLB -> preview.glb
npm run images:posters
npm run images:renders                       # WebP thumbnails (Chrome)
npm run verify:assets                        # flags any piece missing preview/thumb
```
Single-piece re-render: `ONLY=<slug> npm run images:renders`.
Renders are mandatory before push (no poster-only ships, owner's rule).

## 4. Orientation / framing overrides — `src/data/orientations.json`
Per-piece object: `{ upAxis, modelRotation:[x,y,z]deg, yaw, fit, viewDirection:[x,y,z], status, note }`.
Both the thumbnail renderer (`public/__render.html`) and the live viewer (`Viewer.astro`) read it
via `frameCameraToBox(direction: viewDirection || [0.55,0.34,0.9], padding: fit || …)`. Larger
`fit` = camera further out / smaller subject.

**Claude can't rasterize in its sandbox** (no GL/sharp/X libs). Claude solves orientation/framing
**by geometry** instead: a three.js vertex-projection sim that reproduces `frameCameraToBox`
exactly and measures projected coverage — relief = direction that MAXIMIZES coverage (face-on);
reclining figure = max coverage at LOW elevation (broadside); base-down = densest/widest bottom
band. Then Mike renders and Claude verifies the thumbnail (identical math to the viewer). Don't
hand-guess camera angles — compute them.

## 5. OPEN ITEMS (start here)
1. **5 poster-only pieces — no 3D (highest priority).** Ingested but their FBX/ZIP sources don't
   convert (trimesh has no FBX support; ZIP not handled), so no `preview.glb`. They're live as
   poster-only. Fix: Codex re-stages each as a clean ~20 MB STL in the vault (new release tag) and
   updates the manifest `model{sourcePath,format:"stl",sizeBytes}`. Then re-ingest — **but they're
   already in the catalog, so a plain re-ingest skips them as duplicates**: first remove the 5 stub
   entries from `catalog.json` (and `previews.json`/`renders.json` if present), then
   `npm run ingest` → `models:preview` → `images:renders`, then QA + push. The 5:
   - americas/stirrup-spout-bottle-feline-snake-met
   - asia/kneeling-winged-monster-smithsonian (722 MB ZIP — decimate hard)
   - egyptian/sarcophagus-of-harkhebit-met
   - near-east-mesopotamia/tombstone-architectural-niche-met
   - sub-saharan-africa/zoomorphic-headrest-unobadula-met
2. **michelangelo/dawn** — mesh bundles an oversized plain base block bigger than the figure; no
   camera/orientation fixes it. Needs a mesh trim or cleaner re-fetch (Codex). Currently reverted
   to prior view, status `needs-refetch`.
3. **asia/brazier-of-rasulid-sultan-met** — USDZ→GLB conversion baked in an arbitrary tumble. Needs
   a clean re-fetch (Met glTF/GLB directly, or re-convert preserving up-axis).
4. **diana-of-villa-bartholoni** — only catalog entry still missing `dimensions` (Codex couldn't
   source them without inventing; acceptable gap). Backfill if a holding-museum record turns up.

## 6. FORMAT RULE (hard lesson)
`models:preview` (trimesh) only converts **STL / OBJ / PLY / GLB**. **FBX, ZIP, USDZ do NOT
produce a preview.glb** — pieces land catalogued but 3D-less. Codex must deliver clean STL
(~20 MB sweet spot; decimate larger; preserve up-axis; no oversized base block) in the vault.

## 7. Codex prompts (paste-ready)
**Harvest batch of 5 (diversity + STL):** 5 pieces, ≥4 regions, ≥3 eras, ≤2 per region/era; read
catalog.json read-only, tally per region+era, fill THIN buckets (Baroque=0, Asia, Sub-Saharan
Africa, Americas, Neoclassical). Bars: real material + dimensions + housing institution/gallery,
maker, period+date, accession, source_url (object page), wikidata if any; CC0/PD/CC BY only
(no NC, no Italian-state/closed-door); deduped. Format: clean STL/OBJ/PLY/GLB; convert FBX/USDZ/
ZIP to ~20–40 MB STL preserving scale + up-axis; sanity-check upright, no oversized base block.
Deliver: manifests/<region>/<slug>.json + STL as vault Release asset; present a one-message digest
(diversity/tally line, per-piece blocks, vault tag/asset/manifest, "all cleared / dropped X
because Y"). Never touch the site repo.

**Re-stage relay (for items 5.1–5.3):** convert the named sources to clean STL, update manifests,
new release tag, same slugs/metadata.

## 8. Recently completed (don't redo)
Danaïd reframe (fit 2.5→1.1); Aphaia fixes — Lying Wounded Warrior + Kneeling Archer XII upright;
Greek Slave (Smithsonian) + Saint-Raymond/MIA/Met batches (catalog 203→231); dimensions backfill
(8 of 9, Diana excepted); Sapi hunting horn reframe (diagonal); **Dying Gaul (profile) + Madonna
of the Stairs (face-on) — fixed, verified, live** (their orientations.json `status:"review"` label
is stale; they're done).

## 9. Reply convention
End every atrium reply with two terminal commands:
```
open "https://atrium.earth/?v=$(date +%s)"
open "https://atrium.earth/"
```
(Pages can lag ~60s after a push; the cache-buster avoids the stale build.) Mike prefers cut-and-
paste terminal over GUI; lead with the deliverable.
