// Apply the mesh provenance audit (provenance-audit.md "## File Rows" table) to
// the catalog: source-of-record fill for `source_url` and `source_institution`.
//
// Fill-only: never overwrites a non-empty catalog value. When the audit's URL
// disagrees with an existing source_url the conflict is logged for human review.
// scan_source is intentionally NOT set here — the casts pass
// (enrich-from-sources.mjs --casts) derives it with the cast/original split.
//
// Rows used: Repo == "current" AND Confidence == "confirmed".
// Slug = the asset's directory (walking up past helper dirs like .../textures);
// sandbox/ and museum/ assets are ignored. Unmatched rows are reported.
//
// Usage: node scripts/apply-provenance-audit.mjs [--audit=/tmp/provenance-audit.md]
//        [--dry-run] [--report=/tmp/apply-audit-report.md]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(repoRoot, 'src/data/catalog.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const auditPath = (args.find((a) => a.startsWith('--audit=')) || '').slice(8) || '/tmp/provenance-audit.md';
const reportPath = (args.find((a) => a.startsWith('--report=')) || '').slice(9) || '/tmp/apply-audit-report.md';

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const bySlug = new Map(catalog.map((record) => [record.slug, record]));

function clean(value) {
  const text = String(value ?? '').trim();
  return text === '-' || text === '—' ? '' : text;
}
const isEmpty = (value) => clean(value) === '';

// Same recipe as enrich-from-sources.mjs — keep in sync.
function rebuildSearch(record) {
  return [
    record.title,
    record.artist,
    record.year,
    record.material,
    record.dimensions,
    record.museum,
    record.source_institution,
    record.collection,
    record.scan_source,
    record.note,
  ].map(clean).filter(Boolean).join(' ').toLowerCase();
}

// --- parse the audit table ----------------------------------------------------

const auditText = readFileSync(auditPath, 'utf8');
const tableStart = auditText.indexOf('## File Rows');
if (tableStart === -1) throw new Error('no "## File Rows" section in ' + auditPath);

const rows = [];
for (const line of auditText.slice(tableStart).split('\n')) {
  if (!line.startsWith('| ')) continue;
  const cells = line.split('|').map((cell) => cell.trim());
  // [ '', Repo, Asset, Original filename, Subject, Source URL, Scan author/source, License, Evidence, Confidence, '' ]
  if (cells.length < 10 || cells[1] === 'Repo' || /^-+$/.test(cells[1])) continue;
  rows.push({
    repo: cells[1],
    asset: cells[2],
    subject: cells[4],
    sourceCell: cells[5],
    scanAuthor: cells[6],
    license: cells[7],
    confidence: cells[9],
  });
}

// --- pick the primary record link out of the Source URL cell -------------------

function parseLinks(cell) {
  // URL may itself contain one level of parentheses (Wikimedia filenames).
  return [...cell.matchAll(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g)].map(([, label, url]) => ({ label, url }));
}

// Prefer the museum record / object page over direct file links.
function scoreLink({ label, url }) {
  let score = 0;
  if (/context|reference|wayback|readme/i.test(label)) return -5;
  if (/object page|record|file page|commons file|manifest source|source page|archive item|source object/i.test(label)) score += 3;
  if (/^(direct|full|optimized|original)\b|\b(stl|obj|glb|gltf|zip)\b|\bapi\b|download|media metadata|aton scene/i.test(label)) score -= 2;
  if (/open\.smk\.dk\/(\w{2}\/)?artwork\//i.test(url)) score += 2;
  if (/metmuseum\.org\/art\/collection\/search\/\d+/i.test(url)) score += 2;
  if (/commons\.wikimedia\.org\/wiki\/File:/i.test(url)) score += 2;
  if (/archcalc\.cnr\.it\/resources/i.test(url)) score += 2;
  if (/archive\.org\/details\//i.test(url)) score += 2;
  if (/3d\.si\.edu\/object/i.test(url)) score += 2;
  if (/myminifactory\.com\/object/i.test(url)) score += 2;
  if (/api\.|upload\.wikimedia|Special:Redirect|\/download\/|download-3d|web\.archive/i.test(url)) score -= 3;
  return score;
}

function primaryLink(cell) {
  const links = parseLinks(cell);
  if (!links.length) return null;
  let best = links[0];
  let bestScore = scoreLink(best);
  for (const link of links.slice(1)) {
    const score = scoreLink(link);
    if (score > bestScore) { best = link; bestScore = score; }
  }
  return best;
}

// --- normalize the Scan author / source column to a short institution ----------

const INSTITUTION_MAP = new Map([
  ['Musee Saint-Raymond / Wikimedia Commons STL', 'Musée Saint-Raymond / Wikimedia Commons'],
  ['Wikimedia Commons / MAHG scan', 'Wikimedia Commons / MAHG'],
  ['Scan the World / Wikimedia Commons STL', 'Scan the World / Wikimedia Commons'],
  ['Internet Archive / Thingiverse mirror', 'Internet Archive / Thingiverse'],
  ['Wikimedia Commons STL; SMK cast record for context', 'Wikimedia Commons'],
  ['Wikimedia Commons / Thingiverse-derived STL', 'Wikimedia Commons / Thingiverse'],
  ['Wikimedia Commons / Scan the World; bronze material pass', 'Wikimedia Commons / Scan the World'],
  ['Wikimedia Commons / Nationalmuseum STL', 'Wikimedia Commons / Nationalmuseum'],
  ['Wikimedia Commons / Cleveland Museum of Art STL', 'Wikimedia Commons / Cleveland Museum of Art'],
]);

function institutionFor(scanAuthor, url) {
  const text = clean(scanAuthor);
  if (INSTITUTION_MAP.has(text)) return INSTITUTION_MAP.get(text);
  if (/^SMK\b/i.test(text) || /open\.smk\.dk/i.test(url)) return 'SMK Open';
  if (/^The Met\b/i.test(text) || /metmuseum\.org/i.test(url)) return 'The Met';
  return text.split(';')[0].replace(/\s+STL$/i, '').trim();
}

// --- URL comparison (conflicts only when meaningfully different) ---------------

function urlKey(url) {
  return clean(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/open\.smk\.dk\/\w{2}\//, 'open.smk.dk/')
    .replace(/\/+$/, '');
}

// --- map rows to catalog slugs --------------------------------------------------

const report = {
  rowsTotal: rows.length,
  currentConfirmed: 0,
  ignored: [],          // sandbox/ + museum/ assets
  excluded: [],         // current rows that are not confirmed
  unmatched: [],        // no catalog slug found
  filledUrl: [],
  filledInstitution: [],
  alreadyHadBoth: [],
  conflicts: [],        // audit URL vs existing source_url
  institutionDiffers: [],// informational, value kept
  multiUrlSlugs: [],
};

const grouped = new Map(); // slug -> rows
for (const row of rows) {
  if (row.repo !== 'current') continue;
  if (row.confidence !== 'confirmed') {
    report.excluded.push(`${row.asset} (${row.confidence})`);
    continue;
  }
  report.currentConfirmed += 1;
  if (/^(sandbox|museum)\//.test(row.asset)) {
    report.ignored.push(row.asset);
    continue;
  }
  // Slug = asset directory; walk up past helper dirs (textures/) to a real slug.
  let dir = row.asset.split('/').slice(0, -1).join('/');
  while (dir && !bySlug.has(dir)) dir = dir.split('/').slice(0, -1).join('/');
  if (!dir) {
    report.unmatched.push(row.asset);
    continue;
  }
  if (!grouped.has(dir)) grouped.set(dir, []);
  grouped.get(dir).push(row);
}

// --- apply ----------------------------------------------------------------------

const changed = new Set();
for (const [slug, slugRows] of grouped) {
  const record = bySlug.get(slug);
  // Prefer the audit row for the exact file the site serves.
  const row = slugRows.find((r) => r.asset === record.model?.sourcePath) || slugRows[0];
  const link = primaryLink(row.sourceCell);
  if (!link) {
    report.unmatched.push(`${row.asset} (no parseable Source URL)`);
    continue;
  }
  const urls = new Set(slugRows.map((r) => primaryLink(r.sourceCell)?.url).filter(Boolean).map(urlKey));
  if (urls.size > 1) report.multiUrlSlugs.push({ slug, urls: [...urls] });

  const institution = institutionFor(row.scanAuthor, link.url);
  let touched = false;

  if (isEmpty(record.source_url)) {
    record.source_url = link.url;
    report.filledUrl.push({ slug, url: link.url, label: link.label });
    touched = true;
  } else if (urlKey(record.source_url) !== urlKey(link.url)) {
    report.conflicts.push({ slug, have: record.source_url, audit: link.url, label: link.label });
  }

  if (isEmpty(record.source_institution)) {
    record.source_institution = institution;
    report.filledInstitution.push({ slug, institution });
    touched = true;
  } else if (record.source_institution.toLowerCase() !== institution.toLowerCase()) {
    report.institutionDiffers.push({ slug, have: record.source_institution, audit: institution });
  }

  if (touched) changed.add(slug);
  else report.alreadyHadBoth.push(slug);
}

for (const slug of changed) {
  const record = bySlug.get(slug);
  record.search = rebuildSearch(record);
}

if (!dryRun) writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

// --- report ----------------------------------------------------------------------

const lines = [];
lines.push('# Provenance audit → catalog apply report');
lines.push('');
lines.push(`Run: ${new Date().toISOString()}${dryRun ? ' (dry run — catalog not written)' : ''}`);
lines.push(`Audit: ${auditPath}`);
lines.push('');
lines.push('## Counts');
lines.push('');
lines.push(`- File rows parsed: ${report.rowsTotal}`);
lines.push(`- current+confirmed rows: ${report.currentConfirmed}`);
lines.push(`- Ignored (sandbox/, museum/): ${report.ignored.length}`);
lines.push(`- current rows excluded by confidence: ${report.excluded.length}`);
lines.push(`- Catalog works matched: ${grouped.size}`);
lines.push(`- source_url filled: ${report.filledUrl.length}`);
lines.push(`- source_institution filled: ${report.filledInstitution.length}`);
lines.push(`- Works already complete (both fields): ${report.alreadyHadBoth.length}`);
lines.push(`- URL conflicts (existing kept): ${report.conflicts.length}`);
lines.push(`- Institution differs (existing kept, informational): ${report.institutionDiffers.length}`);
lines.push(`- Unmatched rows: ${report.unmatched.length}`);
lines.push('');
if (report.filledUrl.length) {
  lines.push('## source_url filled');
  lines.push('');
  lines.push('| Slug | Link label | URL |');
  lines.push('| --- | --- | --- |');
  for (const fill of report.filledUrl) lines.push(`| ${fill.slug} | ${fill.label} | ${fill.url} |`);
  lines.push('');
}
if (report.filledInstitution.length) {
  lines.push('## source_institution filled');
  lines.push('');
  lines.push('| Slug | Institution |');
  lines.push('| --- | --- |');
  for (const fill of report.filledInstitution) lines.push(`| ${fill.slug} | ${fill.institution} |`);
  lines.push('');
}
if (report.conflicts.length) {
  lines.push('## URL conflicts (catalog value kept — review by hand)');
  lines.push('');
  lines.push('| Slug | Catalog has | Audit says |');
  lines.push('| --- | --- | --- |');
  for (const conflict of report.conflicts) lines.push(`| ${conflict.slug} | ${conflict.have} | ${conflict.audit} |`);
  lines.push('');
}
if (report.institutionDiffers.length) {
  lines.push('## source_institution differs (catalog value kept)');
  lines.push('');
  for (const diff of report.institutionDiffers) lines.push(`- \`${diff.slug}\`: "${diff.have}" vs audit "${diff.audit}"`);
  lines.push('');
}
if (report.multiUrlSlugs.length) {
  lines.push('## Works whose audit rows point at different URLs (first/site-file row used)');
  lines.push('');
  for (const multi of report.multiUrlSlugs) lines.push(`- \`${multi.slug}\`: ${multi.urls.join(' vs ')}`);
  lines.push('');
}
if (report.unmatched.length) {
  lines.push('## Unmatched audit rows (no catalog slug)');
  lines.push('');
  for (const asset of report.unmatched) lines.push(`- ${asset}`);
  lines.push('');
}
if (report.ignored.length) {
  lines.push('## Ignored assets (sandbox/, museum/)');
  lines.push('');
  for (const asset of report.ignored) lines.push(`- ${asset}`);
  lines.push('');
}
if (report.excluded.length) {
  lines.push('## current rows excluded by confidence');
  lines.push('');
  for (const asset of report.excluded) lines.push(`- ${asset}`);
  lines.push('');
}

writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`current+confirmed rows: ${report.currentConfirmed}; works matched: ${grouped.size}`);
console.log(`source_url filled: ${report.filledUrl.length}; source_institution filled: ${report.filledInstitution.length}`);
console.log(`conflicts: ${report.conflicts.length}; unmatched: ${report.unmatched.length}; ignored: ${report.ignored.length}`);
console.log(`Report: ${reportPath}${dryRun ? ' (dry run)' : ''}`);
