import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const defaultStageDir = path.join(repoRoot, '.atrium-ingest');
export const catalogPath = path.join(repoRoot, 'src/data/catalog.json');
export const orientationsPath = path.join(repoRoot, 'src/data/orientations.json');
export const previewsPath = path.join(repoRoot, 'src/data/previews.json');
export const rendersPath = path.join(repoRoot, 'src/data/renders.json');

export const allowedLicensePatterns = [
  /cc0/i,
  /public\s*domain/i,
  /publicdomain/i,
  /no\s+known\s+copyright/i,
  /no\s+restrictions/i,
  /creative\s+commons\s+zero/i,
  /cc\s*by(?:\s|$|-|_)/i,
  /creativecommons\.org\/licenses\/by\//i,
];

const licenseTierOnePatterns = [
  /cc0/i,
  /public\s*domain/i,
  /publicdomain/i,
  /no\s+known\s+copyright/i,
  /no\s+restrictions/i,
  /creative\s+commons\s+zero/i,
];

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const trimmed = arg.slice(2);
    const eq = trimmed.indexOf('=');
    if (eq >= 0) {
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[trimmed] = argv[i + 1];
      i += 1;
    } else {
      out[trimmed] = true;
    }
  }
  return out;
}

export function clean(value) {
  const text = String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text === '-' || text === '—' ? '' : text;
}

export function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export function slugify(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 82) || 'untitled';
}

export function looseKey(value) {
  return slugify(value).replace(/-/g, ' ');
}

export function titleKey(value) {
  return looseKey(value)
    .replace(/\b(?:the|a|an|of|from|with|and|or|after|model|cast|scan)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeFilename(value, fallback = 'source') {
  const parsed = path.parse(clean(value).split(/[?#]/)[0]);
  const ext = parsed.ext.toLowerCase();
  const stem = slugify(parsed.name || fallback);
  return `${stem}${ext || ''}`;
}

export function collectionFor(candidate) {
  const text = [
    candidate.collection,
    candidate.title,
    candidate.subject,
    candidate.period,
    candidate.culture,
    candidate.museum,
    candidate.source_institution,
    candidate.note,
  ].map(clean).join(' ').toLowerCase();

  if (/egypt|amarna|pharaoh|sphinx|sekhmet|horus|osiris|isis/.test(text)) return 'egyptian';
  if (/assyria|ashur|nimrud|nineveh|mesopotam|sumer|akkad|gudea/.test(text)) return 'assyrian';
  if (/greek|hellenic|archaic|attic|athena|apollo|aphrodite|zeus|dionys/.test(text)) return 'greek';
  if (/roman|etruscan|palmyra|caesar|augustus|emperor|bust/.test(text)) return 'roman';
  if (/moche|maya|aztec|nayarit|asmat|cohoba|native american|americas|oceania|polynesia/.test(text)) return 'americas';
  if (/buddha|china|japan|india|khmer|asia|islamic|iran|persia/.test(text)) return 'asia';
  if (/africa|yoruba|kongo|senufo|mali|niger|benin|asante/.test(text)) return 'sub-saharan-africa';
  if (/rodin/.test(text)) return 'rodin';
  if (/michelangelo|donatello|renaissance|bregno|verrocchio/.test(text)) return 'renaissance';
  if (/neoclassical|canova|thorvaldsen|powers/.test(text)) return 'neoclassical';
  return 'automated';
}

export function periodFor(yearSort) {
  const year = Number(yearSort);
  if (Number.isFinite(year) && year < 500) return 'Ancient';
  if (Number.isFinite(year) && year < 1700) return 'Renaissance';
  if (Number.isFinite(year) && year < 1900) return 'Early modern';
  return 'Modern';
}

export function yearSortFromDisplay(display) {
  const text = clean(display);
  if (!text) return null;
  const century = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+century\s*(BCE|BC)?/i);
  if (century) return century[2] ? -Number(century[1]) : Number(century[1]) * 100;
  const range = text.match(/(\d{1,4})\s*[-–]\s*(\d{1,4})\s*(BCE|BC)?/i);
  if (range) return range[3] ? -Number(range[1]) : Number(range[1]);
  const leading = text.match(/(\d{1,4})/);
  if (!leading) return null;
  return /BCE|BC/i.test(text) ? -Number(leading[1]) : Number(leading[1]);
}

export function isAllowedLicense(value) {
  const text = clean(value);
  if (!text) return false;
  if (/cc\s*by\s*-\s*nc|cc\s*by\s*nc|non[-\s]?commercial|nc-sa|by-nc/i.test(text)) return false;
  return allowedLicensePatterns.some((pattern) => pattern.test(text));
}

export function licenseTier(value) {
  const text = clean(value);
  if (licenseTierOnePatterns.some((pattern) => pattern.test(text))) return 1;
  return isAllowedLicense(text) ? 2 : 3;
}

export function licenseLabel(value, url = '') {
  const text = clean(value) || clean(url);
  if (/publicdomain\/zero|cc0|creative\s+commons\s+zero/i.test(text)) return 'CC0 1.0';
  if (/publicdomain\/mark|public\s*domain|no\s+restrictions/i.test(text)) return 'Public Domain Mark 1.0';
  const by = text.match(/by\/([0-9.]+)/i);
  if (by) return `CC BY ${by[1]}`;
  if (/cc\s*by/i.test(text)) return 'CC BY';
  return text;
}

export async function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadCatalog() {
  return readJson(catalogPath, []);
}

export function catalogIndexes(catalog) {
  const bySlug = new Set();
  const bySource = new Set();
  const byAccession = new Set();
  const byTitle = new Set();

  for (const item of catalog) {
    if (item.slug) bySlug.add(clean(item.slug));
    if (item.source_url) bySource.add(clean(item.source_url).toLowerCase());
    if (item.accession) byAccession.add(clean(item.accession).toLowerCase());
    if (item.title) byTitle.add(titleKey(item.title));
  }

  return { bySlug, bySource, byAccession, byTitle };
}

export function candidateIsKnown(candidate, indexes) {
  if (candidate.slug && indexes.bySlug.has(clean(candidate.slug))) return 'slug';
  if (candidate.source_url && indexes.bySource.has(clean(candidate.source_url).toLowerCase())) return 'source_url';
  if (candidate.accession && indexes.byAccession.has(clean(candidate.accession).toLowerCase())) return 'accession';
  const key = titleKey(candidate.title);
  if (key && key.length > 8 && indexes.byTitle.has(key)) return 'title';
  return '';
}

export function makeSlug(candidate, used = new Set()) {
  const collection = slugify(collectionFor(candidate));
  const suffix = candidate.accession ? slugify(candidate.accession) : '';
  const baseTitle = slugify(candidate.title);
  const base = `${collection}/${[baseTitle, suffix].filter(Boolean).join('-')}`.replace(/-+$/g, '');
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

export function searchText(record) {
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

export function hasSculptureSubject(candidate) {
  const text = [
    candidate.title,
    candidate.subject,
    candidate.object_type,
    candidate.description,
    candidate.tags,
    candidate.note,
  ].flat().map(clean).join(' ').toLowerCase();
  return /sculpture|statue|statuette|figure|figurine|bust|portrait|head|relief|frieze|stele|sarcophagus|mask|idol|herm|torso|animal|sphinx|lion|horse|pole|gong|vessel|bronze|marble|plaster|stone|terracotta|wood/.test(text);
}

export function faceCountAllowed(faceCount) {
  if (!Number.isFinite(Number(faceCount)) || Number(faceCount) <= 0) return true;
  return Number(faceCount) >= 100000 && Number(faceCount) <= 10000000;
}

export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export async function downloadFile(url, dest, options = {}) {
  const headers = options.headers || {};
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed ${response.status} ${response.statusText} for ${url}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmp);
    out.on('error', reject);
    out.on('finish', resolve);
    (async () => {
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          hash.update(buffer);
          if (!out.write(buffer)) await new Promise((drain) => out.once('drain', drain));
        }
        out.end();
      } catch (error) {
        out.destroy(error);
      }
    })();
  });
  await rename(tmp, dest);
  return { bytes, sha256: hash.digest('hex'), contentType: response.headers.get('content-type') || '' };
}

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

export async function removePath(target) {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export function relativeToRepo(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

export function meshExtensionFromUrl(url, fallback = '.glb') {
  const ext = path.extname(clean(url).split(/[?#]/)[0]).toLowerCase();
  if (['.stl', '.obj', '.ply', '.glb', '.gltf', '.fbx', '.usdz', '.zip'].includes(ext)) return ext;
  return fallback;
}
