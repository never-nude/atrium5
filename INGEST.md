# Ingest: how new works enter Atrium

The repo's `src/data/catalog.json` is the **master catalog**. Do not run the legacy
import (`import:catalog:legacy`) — it regenerates the catalog from the retired
`assets/catalog.json` flow and will clobber everything ingested since. It now
refuses to run if it detects ingested entries.

## The flow

1. **Codex harvests** per `CODEX-BRIEF.md` in `never-nude/atrium-vault`:
   raw files → vault GitHub Releases, one manifest per piece → `manifests/<collection>/<slug>.json`.
2. **Ingest** (this repo, with the vault cloned as a sibling):

   ```bash
   npm run ingest -- --dry-run          # validate + preview what would land
   GITHUB_TOKEN=$(gh auth token) npm run ingest
   ```

   This appends catalog entries, downloads release assets into the local source
   archive (`SOURCE_ATRIUM_DIR`, default `../atrium`), verifies sha256, recomputes
   index/total. Tier-3 (NC) manifests are reported and skipped. Duplicates are skipped.

3. **Generate assets** for the new pieces:

   ```bash
   SOURCE_ATRIUM_DIR=../atrium npm run models:preview   # GLB previews (trimesh venv)
   npm run images:posters                                # SVG posters
   npm run images:renders                                # WebP thumbs (Chrome; CHROME_BIN to override)
   npm run verify:assets                                 # catches anything missing
   ```

4. **Renders are mandatory before push** — new works must ship with real thumbnails, never poster fallbacks (owner's rule, 2026-06-10). In the Claude sandbox: install Playwright's ARM64 chromium (npx playwright install chromium), then run with CHROME_BIN=<headless_shell path> CHROME_EXTRA_ARGS="--no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader" ONLY=<slugs>. Then append the new slugs to src/data/renders.json (nothing writes it automatically).

5. **Build, eyeball, push.** `npm run build`, check a few new work pages, push to main —
   the Pages workflow deploys.

## Automated open-scan pipeline

The scheduled path in `.github/workflows/ingest.yml` discovers CC0/Public Domain/CC BY
sculpture scans from whitelisted sources, stages downloads under `.atrium-ingest/`,
generates Atrium previews, and opens a draft PR. It never merges or publishes by
itself.

Local dry run:

```bash
npm run ingest:discover -- --limit=3
npm run ingest:fetch -- --limit=3
SOURCE_ATRIUM_DIR=.atrium-ingest/source-archive npm run ingest:assemble
npm run verify:assets
```

Sketchfab downloads require `SKETCHFAB_TOKEN`; without it, Sketchfab candidates are
reported but skipped at fetch time. The generated PR body lives at
`.atrium-ingest/last-report.md` and lists provenance, license, integrity, and
orientation decisions for every accepted or rejected candidate.

## Field semantics

- `tier` = curatorial prominence (1 featured … 3 default). Ingest always sets 3; promote by hand.
- `license_tier` = licensing class from the manifest (1 CC0/PD, 2 BY/BY-SA). NC never enters the public catalog.
- `model.sourcePath` is relative to `SOURCE_ATRIUM_DIR`. Raw sources never ship in this repo.

## Env

| Var | Default | Use |
|---|---|---|
| `ATRIUM_VAULT_DIR` | `../atrium-vault` | manifest source |
| `SOURCE_ATRIUM_DIR` | `../atrium` | raw model archive (also read by models:preview) |
| `ATRIUM_VAULT_REPO` | `never-nude/atrium-vault` | release asset downloads |
| `GITHUB_TOKEN` | — | required for private vault downloads |
| `CHROME_BIN` | macOS Chrome path | renderer for images:renders |
