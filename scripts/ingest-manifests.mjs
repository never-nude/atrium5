#!/usr/bin/env node
// Ingest atrium-vault manifests into the Atrium catalog.
//
// Reads manifest JSONs from the vault repo checkout, validates them against
// the atrium-ingest/1 schema, downloads release assets into the local source
// archive, verifies checksums, and appends entries to src/data/catalog.json.
//
// The repo catalog is the master record. The legacy import:catalog flow
// (regenerate-from-old-checkout) is retired; see INGEST.md.
//
// Env:
//   ATRIUM_VAULT_DIR   checkout of never-nude/atrium-vault   (default: ../atrium-vault)
//   SOURCE_ATRIUM_DIR  local raw-source archive              (default: ../atrium)
//   ATRIUM_VAULT_REPO  owner/name for release downloads      (default: never-nude/atrium-vault)
//   GITHUB_TOKEN       token with repo read on the vault     (required unless --no-download)
//
// Flags:
//   --dry-run          validate + report, change nothing
//   --no-download      append catalog entries, skip asset downloads (files already local)
//   --only=<prefix>    restrict to manifests whose slug starts with prefix

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const vaultDir = process.env.ATRIUM_VAULT_DIR || path.resolve(repoRoot, '../atrium-vault');
const sourcesDir = process.env.SOURCE_ATRIUM_DIR || path.resolve(repoRoot, '../atrium');
const vaultRepo = process.env.ATRIUM_VAULT_REPO || 'never-nude/atrium-vault';
const token = process.env.GITHUB_TOKEN || '';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noDownload = args.includes('--no-download');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7) || null;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const TIER1_LICENSES = ['cc0', 'public domain', 'pdm', 'no restrictions', 'no known copyright'];
const TIER2_LICENSES = ['cc by'];

const catalogPath = path.join(repoRoot, 'src/data/catalog.json');

function periodFor(yearSort) {
  const year = Number(yearSort);
  if (Number.isFinite(year) && year < 500) return 'Ancient';
  if (Number.isFinite(year) && year < 1700) return 'Renaissance';
  if (Number.isFinite(year) && year < 1900) return 'Early modern';
  return 'Modern';
}

function searchText(m) {
  return [
    m.title,
    m.artist,
    sourceField(m, 'year'),
    sourceField(m, 'material'),
    sourceField(m, 'dimensions'),
    sourceField(m, 'museum'),
    m.source_institution,
    m.scan_source,
    m.slug.split('/')[0],
    m.note,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const SOURCE_FIELD_ALIASES = {
  year: ['date', 'objectDate', 'production_date', 'productionDate', 'production_date_notes', 'dated'],
  material: ['medium', 'materials', 'technique'],
  dimensions: ['dimension', 'measurements', 'measurement'],
  museum: ['held', 'repository', 'current_owner', 'currentOwner', 'current_location', 'currentLocation', 'original_location', 'originalLocation', 'holding_institution', 'holdingInstitution'],
};

const SOURCE_RECORD_KEYS = ['source_record', 'sourceRecord', 'source', 'metadata', 'object', 'original'];

function textValue(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return textValue(value.label || value.name || value.title || value.value || value.text || value.display);
  }
  return '';
}

function sourceField(m, field) {
  const aliases = SOURCE_FIELD_ALIASES[field] || [];
  const records = [m, ...SOURCE_RECORD_KEYS.map((key) => m[key]).filter((record) => record && typeof record === 'object')];

  for (const record of records) {
    for (const key of [field, ...aliases]) {
      const value = textValue(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function sourceYearSort(m) {
  for (const record of [m, ...SOURCE_RECORD_KEYS.map((key) => m[key]).filter((r) => r && typeof r === 'object')]) {
    for (const key of ['year_sort', 'yearSort']) {
      if (record[key] === null || record[key] === undefined || record[key] === '') continue;
      const value = Number(record[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return yearSortFromDisplay(sourceField(m, 'year'));
}

function yearSortFromCentury(century, bce) {
  const midpoint = (100 * Number(century)) - 50;
  return bce ? -midpoint : midpoint;
}

function yearSortFromDisplay(display) {
  const text = textValue(display);
  if (!text) return null;
  const century = text.match(/(\d{1,2})(?:st|nd|rd|th)\s+century\s*(BCE|CE)?/i);
  if (century) return yearSortFromCentury(century[1], /^BCE$/i.test(century[2] || ''));
  const leading = text.match(/(\d{1,4})/);
  if (!leading) return null;
  return /BCE/i.test(text) ? -Number(leading[1]) : Number(leading[1]);
}

function licenseLooksLike(license, needles) {
  const l = (license || '').toLowerCase();
  return needles.some((n) => l.includes(n));
}

function validate(m, file) {
  const errs = [];
  if (m.schema !== 'atrium-ingest/1') errs.push('schema must be atrium-ingest/1');
  if (!SLUG_RE.test(m.slug || '')) errs.push(`bad slug: ${m.slug}`);
  if (!m.title) errs.push('missing title');
  if (!m.source_url) errs.push('missing source_url');
  if (![1, 2, 3].includes(m.tier)) errs.push(`tier must be 1|2|3, got ${m.tier}`);
  if (m.tier === 1 && !licenseLooksLike(m.license, TIER1_LICENSES)) errs.push(`tier 1 but license "${m.license}" doesn't read as CC0/PD`);
  if (m.tier === 2 && !licenseLooksLike(m.license, TIER2_LICENSES)) errs.push(`tier 2 but license "${m.license}" doesn't read as CC BY`);
  if (m.tier === 2 && !m.attribution) errs.push('tier 2 requires attribution');
  if (m.tier !== 3) {
    if (!Array.isArray(m.files) || m.files.length === 0) errs.push('files[] required for tier 1/2');
    for (const f of m.files || []) {
      if (!f.name || !f.format || !f.release_tag) errs.push(`file entry incomplete: ${JSON.stringify(f)}`);
      if (!f.sha256 || !/^[0-9a-f]{64}$/.test(f.sha256)) errs.push(`file ${f.name}: missing/bad sha256`);
    }
  }
  if (m.year_sort !== null && m.year_sort !== undefined && !Number.isFinite(Number(m.year_sort))) {
    errs.push(`year_sort must be integer or null, got ${m.year_sort}`);
  }
  return errs.map((e) => `${file}: ${e}`);
}

async function listManifests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listManifests(p)));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const releaseCache = new Map();
async function releaseAssets(tag) {
  if (releaseCache.has(tag)) return releaseCache.get(tag);
  const res = await fetch(`https://api.github.com/repos/${vaultRepo}/releases/tags/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`release ${tag}: HTTP ${res.status}`);
  const json = await res.json();
  const map = new Map(json.assets.map((a) => [a.name, a]));
  releaseCache.set(tag, map);
  return map;
}

async function downloadAsset(fileSpec, destPath) {
  const assets = await releaseAssets(fileSpec.release_tag);
  const asset = assets.get(fileSpec.name);
  if (!asset) throw new Error(`asset ${fileSpec.name} not found in release ${fileSpec.release_tag}`);
  const res = await fetch(asset.url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`download ${fileSpec.name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== fileSpec.sha256) throw new Error(`sha256 mismatch for ${fileSpec.name}: got ${digest}`);
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  return buf.length;
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const known = new Set(catalog.map((e) => e.slug));

const manifestsRoot = path.join(vaultDir, 'manifests');
if (!existsSync(manifestsRoot)) {
  console.error(`No manifests dir at ${manifestsRoot} — set ATRIUM_VAULT_DIR or clone the vault next to this repo.`);
  process.exit(1);
}

let files = await listManifests(manifestsRoot);
files.sort();

const report = { added: [], duplicates: [], quarantined: [], errors: [] };
const additions = [];

for (const file of files) {
  let m;
  try {
    m = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    report.errors.push(`${file}: unparseable JSON (${e.message})`);
    continue;
  }
  if (only && !(m.slug || '').startsWith(only)) continue;
  const errs = validate(m, path.relative(vaultDir, file));
  if (errs.length) {
    report.errors.push(...errs);
    continue;
  }
  if (known.has(m.slug)) {
    report.duplicates.push(m.slug);
    continue;
  }
  if (m.tier === 3) {
    report.quarantined.push(m.slug);
    continue;
  }
  additions.push(m);
}

console.log(`Manifests scanned: ${files.length}`);
console.log(`Ready to ingest: ${additions.length} | duplicates: ${report.duplicates.length} | tier-3 quarantined: ${report.quarantined.length} | errors: ${report.errors.length}`);
if (report.errors.length) {
  console.error('\nValidation errors:');
  for (const e of report.errors) console.error(`  - ${e}`);
}
if (dryRun) {
  for (const m of additions) console.log(`  + ${m.slug} (${m.license}) [${(m.files || []).map((f) => f.name).join(', ')}]`);
  process.exit(report.errors.length ? 2 : 0);
}
if (!additions.length) {
  console.log('Nothing to ingest.');
  process.exit(report.errors.length ? 2 : 0);
}
if (!noDownload && !token) {
  console.error('GITHUB_TOKEN required to download vault release assets (or pass --no-download).');
  process.exit(1);
}

for (const m of additions) {
  const primary = m.files.find((f) => f.role === 'source') || m.files[0];
  const destRel = path.join(m.slug, primary.name);
  const destAbs = path.join(sourcesDir, destRel);
  const year = sourceField(m, 'year');
  const yearSort = sourceYearSort(m);
  const material = sourceField(m, 'material');
  const museum = sourceField(m, 'museum');
  const dimensions = sourceField(m, 'dimensions');
  let sizeBytes = primary.sizeBytes || 0;
  if (!noDownload) {
    process.stdout.write(`  ↓ ${m.slug} ← ${primary.name} ... `);
    sizeBytes = await downloadAsset(primary, destAbs);
    console.log(`${(sizeBytes / 1e6).toFixed(1)} MB ok`);
    for (const extra of m.files.slice(1)) {
      await downloadAsset(extra, path.join(sourcesDir, m.slug, extra.name));
    }
  } else if (!existsSync(destAbs)) {
    console.warn(`  ! ${destAbs} missing (running --no-download)`);
  }

  catalog.push({
    slug: m.slug,
    collection: m.slug.split('/')[0],
    title: m.title,
    artist: m.artist || '',
    year,
    year_sort: yearSort ?? null,
    material,
    museum,
    source_institution: m.source_institution || '',
    scan_source: m.scan_source || '',
    source_url: m.source_url,
    license: m.license || '',
    license_url: m.license_url || '',
    attribution: m.attribution || '',
    accession: m.accession || '',
    wikidata: m.wikidata || '',
    note: m.note || '',
    tier: 3,
    license_tier: m.tier,
    ingested: new Date().toISOString().slice(0, 10),
    index: 0,
    total: 0,
    period: periodFor(yearSort),
    model: { sourcePath: destRel, format: primary.format, sizeBytes },
    search: searchText(m),
    ...(dimensions ? { dimensions } : {}),
  });
  report.added.push(m.slug);
  known.add(m.slug);
}

catalog.forEach((e, i) => {
  e.index = i + 1;
  e.total = catalog.length;
});

await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`\nCatalog now ${catalog.length} works (+${report.added.length}).`);
console.log('Next: npm run models:preview, npm run images:posters, npm run images:renders, npm run verify:assets.');
process.exit(report.errors.length ? 2 : 0);
