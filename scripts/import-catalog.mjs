import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = process.env.SOURCE_ATRIUM_DIR || '/Users/michael/Projects/_active/atrium';
const sourceCatalog = path.join(sourceRoot, 'assets/catalog.json');
const dataDir = path.join(repoRoot, 'src/data');

function periodFor(entry) {
  const year = Number(entry.year_sort);
  if (Number.isFinite(year) && year < 500) return 'Ancient';
  if (Number.isFinite(year) && year < 1700) return 'Renaissance';
  if (Number.isFinite(year) && year < 1900) return 'Early modern';
  return 'Modern';
}

function searchText(entry) {
  return [
    entry.title,
    entry.artist,
    entry.year,
    entry.material,
    entry.museum,
    entry.source_institution,
    entry.collection,
    entry.note,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}


// RETIRED: the repo catalog is now master (see INGEST.md). This legacy import
// would clobber ingested works. It refuses to run once ingest entries exist.
{
  const { readFile: rf } = await import('node:fs/promises');
  try {
    const cur = JSON.parse(await rf(path.join(dataDir, 'catalog.json'), 'utf8'));
    if (cur.some((e) => e.license_tier)) {
      console.error('Refusing to run: catalog contains ingested entries. See INGEST.md.');
      process.exit(1);
    }
  } catch {}
}

const raw = JSON.parse(await readFile(sourceCatalog, 'utf8'));
const imported = raw.map((entry, index) => ({
  slug: entry.slug,
  collection: entry.collection || '',
  title: entry.title,
  artist: entry.artist || '',
  year: entry.year || '',
  year_sort: entry.year_sort,
  material: entry.material || '',
  museum: entry.museum || '',
  source_institution: entry.source_institution || '',
  source_url: entry.source_url || '',
  license: entry.license || '',
  note: entry.note || '',
  tier: entry.tier || 3,
  index: index + 1,
  total: raw.length,
  period: periodFor(entry),
  model: {
    sourcePath: entry.preview,
    format: entry.format,
    sizeBytes: entry.size || 0,
  },
  search: searchText(entry),
}));

await mkdir(dataDir, { recursive: true });
await writeFile(path.join(dataDir, 'catalog.json'), `${JSON.stringify(imported, null, 2)}\n`);
try {
  await readFile(path.join(dataDir, 'previews.json'), 'utf8');
} catch {
  await writeFile(path.join(dataDir, 'previews.json'), '{}\n');
}

console.log(`Imported ${imported.length} catalog records from ${sourceCatalog}`);
