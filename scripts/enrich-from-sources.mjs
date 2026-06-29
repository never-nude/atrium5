// Enrich catalog records from their source institutions (SMK Open, The Met).
//
// Fill-only: a value coming back from an API lands in the catalog only when the
// catalog field is empty. Existing values are never overwritten — disagreements
// are logged as conflicts for human review instead.
//
// Usage: node scripts/enrich-from-sources.mjs [--dry-run] [--mine=/tmp/readme-mine.json] [--report=/tmp/enrich-report.md]
//        node scripts/enrich-from-sources.mjs --casts   (pass 2: cast scans re-pointed at original works; appends to the report)

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(repoRoot, 'src/data/catalog.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const castsMode = args.includes('--casts');
const minePath = (args.find((a) => a.startsWith('--mine=')) || '').slice(7) || '/tmp/readme-mine.json';
const reportPath = (args.find((a) => a.startsWith('--report=')) || '').slice(9) || '/tmp/enrich-report.md';

const API_DELAY_MS = 250;
const MET_SEARCH_CANDIDATES = 12;

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

// --slice=a:b limits the SMK/Met passes to catalog[a:b] so long runs can be
// split into sandbox-budget-sized chunks (fills are idempotent; catalog is
// rewritten whole each run).
const sliceArg = (args.find((a) => a.startsWith('--slice=')) || '').slice(8);
const [sliceStart, sliceEnd] = sliceArg ? sliceArg.split(':').map(Number) : [0, Infinity];
const sliceTargets = catalog.slice(sliceStart, sliceEnd === Infinity ? catalog.length : sliceEnd);
const mined = existsSync(minePath) ? JSON.parse(readFileSync(minePath, 'utf8')) : {};

const materialLabels = new Map([
  ['Gips', 'Plaster'],
]);

const dimensionLabels = new Map([
  ['højde', 'H'],
  ['bredde', 'W'],
  ['dybde', 'D'],
]);

const licenseLabels = [
  [/creativecommons\.org\/publicdomain\/mark/i, 'Public Domain Mark 1.0'],
  [/creativecommons\.org\/publicdomain\/zero/i, 'CC0 1.0'],
  [/creativecommons\.org\/licenses\/by\/4\.0/i, 'CC BY 4.0'],
];

function clean(value) {
  const text = String(value ?? '').trim();
  return text === '-' || text === '—' ? '' : text;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return !Number.isFinite(value);
  return clean(value) === '';
}

function looseKey(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameLoosely(a, b) {
  const ka = looseKey(a);
  const kb = looseKey(b);
  if (!ka || !kb) return ka === kb;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastFetch = 0;
async function fetchJson(url) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = lastFetch + API_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.status === 404) return null;
    // Rate limit / transient server error: back off and retry.
    if (response.status === 429 || response.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return response.json();
  }
  throw new Error(`still rate-limited after retries for ${url}`);
}

// --- report state -----------------------------------------------------------

const report = {
  smk: { resolved: [], skipped: [] },
  met: { resolved: [], skipped: [] },
  casts: { identified: [], fixed: [], skipped: [] },
  conflicts: [],
  filled: new Map(), // slug -> { source, fields: [] }
};

function recordFill(record, field, value, source) {
  record[field] = value;
  const entry = report.filled.get(record.slug) || { source, fields: [] };
  entry.fields.push(field);
  report.filled.set(record.slug, entry);
}

function fill(record, field, value, source) {
  if (isEmpty(value)) return false;
  if (isEmpty(record[field])) {
    recordFill(record, field, value, source);
    return true;
  }
  const agree = typeof value === 'number'
    ? Number(record[field]) === Number(value)
    : sameLoosely(record[field], value);
  if (!agree) {
    report.conflicts.push({ slug: record.slug, field, have: record[field], api: value, source });
  }
  return false;
}

function periodFor(yearSort) {
  const year = Number(yearSort);
  if (Number.isFinite(year) && year < 500) return 'Ancient';
  if (Number.isFinite(year) && year < 1700) return 'Renaissance';
  if (Number.isFinite(year) && year < 1900) return 'Early modern';
  return 'Modern';
}

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

// --- SMK pass ----------------------------------------------------------------

function smkObjectNumber(sourceUrl) {
  const match = clean(sourceUrl).match(/open\.smk\.dk\/(?:\w{2}\/)?artwork\/image\/([A-Z]+\d+)/i);
  return match?.[1] || '';
}

function smkArtist(item) {
  const creators = [
    ...(item.production || []).map((entry) => entry.creator),
    ...(item.artist || []),
  ]
    .map(clean)
    .filter(Boolean)
    .filter((name) => !/^(ubekendt|unknown)$/i.test(name))
    .filter((name) => !name.startsWith('...'));
  return creators[0] || '';
}

function ordinal(value) {
  const n = Number(value);
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function smkYear(item) {
  const notes = (item.original || []).flatMap((entry) => entry.production_date_notes || []).map(clean).filter(Boolean);
  const note = notes.find((value) => /\d/.test(value)) || '';
  if (!note) return '';

  const bceRange = note.match(/(\d{1,4})\s*[-–]\s*(\d{1,4})\s*f\.kr/i);
  if (bceRange) return `${bceRange[1]}–${bceRange[2]} BCE`;

  const bceApprox = note.match(/ca\.\s*(\d{1,4})\s*f\.kr/i);
  if (bceApprox) return `c. ${bceApprox[1]} BCE`;

  const bceCentury = note.match(/(\d{1,2})\.\s*århundrede\s*f\.kr/i);
  if (bceCentury) return `${ordinal(bceCentury[1])} century BCE`;

  const bceSingle = note.match(/(\d{1,4})\s*f\.kr/i);
  if (bceSingle) return `${bceSingle[1]} BCE`;

  return note.replace(/\s+/g, ' ');
}

function yearSortFromCentury(century, bce) {
  const midpoint = (100 * Number(century)) - 50;
  return bce ? -midpoint : midpoint;
}

// Sortable year from a display string, matching catalog conventions
// ("883–859 BCE" → -883, "c. 330 BCE" → -330, "2nd century BCE" → -150).
function yearSortFromDisplay(display) {
  const text = clean(display);
  if (!text) return null;
  const century = text.match(/(\d{1,2})(?:st|nd|rd|th)\s+century\s*(BCE|CE)?/i);
  if (century) return yearSortFromCentury(century[1], /^BCE$/i.test(century[2] || ''));
  const leading = text.match(/(\d{1,4})/);
  if (!leading) return null;
  return /BCE/i.test(text) ? -Number(leading[1]) : Number(leading[1]);
}

function smkMaterial(item) {
  return [...new Set((item.materials || []).map((value) => materialLabels.get(value) || value).map(clean).filter(Boolean))].join(', ');
}

function smkDimensions(item) {
  const dims = (item.dimensions || [])
    .map((dimension) => {
      const label = dimensionLabels.get(clean(dimension.type)) || clean(dimension.type);
      const value = clean(dimension.value);
      const unit = clean(dimension.unit).toLowerCase() === 'centimeter' ? 'cm' : clean(dimension.unit);
      return label && value ? `${label} ${value}${unit ? ` ${unit}` : ''}` : '';
    })
    .filter(Boolean);
  return dims.join(' × ');
}

function smkIsCastCollection(item) {
  return /afstøbningssamling|\(KAS\)/i.test(clean(item.responsible_department)) || /^KAS/i.test(clean(item.object_number));
}

function licenseLabelFor(rightsUrl) {
  const rights = clean(rightsUrl);
  for (const [pattern, label] of licenseLabels) {
    if (pattern.test(rights)) return label;
  }
  return rights;
}

async function smkPass() {
  for (const record of sliceTargets) {
    const mine = mined[record.slug] || {};
    const sourceUrl = clean(record.source_url) || clean(mine.source_url);
    const number = smkObjectNumber(sourceUrl);
    if (!number) continue;

    let item;
    try {
      const payload = await fetchJson(`https://api.smk.dk/api/v1/art?object_number=${encodeURIComponent(number)}`);
      item = payload?.items?.[0];
    } catch (error) {
      report.smk.skipped.push({ slug: record.slug, reason: `API error: ${error.message}` });
      continue;
    }
    if (!item) {
      report.smk.skipped.push({ slug: record.slug, reason: `no SMK record for ${number}` });
      continue;
    }

    fill(record, 'source_url', sourceUrl, 'SMK');
    fill(record, 'source_institution', clean(mine.source_institution) || 'SMK Open', 'SMK');
    // Once the casts pass has split cast from original (scan_source set), the SMK
    // record only describes the plaster cast: artist/year/material/museum on the
    // page belong to the ORIGINAL and must not be filled from here. Scan-side
    // fields (source, license, accession) and 1:1 cast dimensions still may.
    const castFixed = !isEmpty(record.scan_source);
    if (!castFixed) {
      fill(record, 'artist', smkArtist(item), 'SMK');
      const year = smkYear(item);
      fill(record, 'year', year, 'SMK');
      if (year && fill(record, 'year_sort', yearSortFromDisplay(year), 'SMK')) {
        record.period = periodFor(record.year_sort);
      }
      fill(record, 'material', smkMaterial(item), 'SMK');
    }
    fill(record, 'dimensions', smkDimensions(item), 'SMK');
    // "Room 120, Royal Cast Collection" and friends already say it — only fill/flag
    // when the catalog does not name the cast collection at all.
    if (!castFixed && smkIsCastCollection(item) && !looseKey(record.museum).includes('cast collection')) {
      fill(record, 'museum', 'SMK — Royal Cast Collection', 'SMK');
    }
    fill(record, 'license', licenseLabelFor(item.rights), 'SMK');
    fill(record, 'license_url', clean(item.rights), 'SMK');
    fill(record, 'accession', clean(item.object_number), 'SMK');
    report.smk.resolved.push({ slug: record.slug, id: number });
  }
}

// --- Met pass ----------------------------------------------------------------

const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';

// "lintel-470947" → { objectId: '470947' }
// "bisj-ancestor-pole-1978-412-1251" → { accession: '1978.412.1251' }
function metRef(slug) {
  const tail = slug.split('/').pop();
  const dotted = tail.match(/-(\d{1,4})-(\d{1,4})-(\d{1,4})$/);
  if (dotted) return { accession: `${dotted[1]}.${dotted[2]}.${dotted[3]}`, words: tail.slice(0, dotted.index) };
  const plain = tail.match(/-(\d{4,})$/);
  if (!plain) return null;
  if (plain[1].length >= 5 && plain[1].length <= 6) return { objectId: plain[1], words: tail.slice(0, plain.index) };
  return { ambiguous: plain[1], words: tail.slice(0, plain.index) };
}

function tokens(value) {
  return new Set(looseKey(value).split(' ').filter((word) => word.length >= 3));
}

function titleMatchesSlug(slugWords, title) {
  const slugTokens = tokens(slugWords.replace(/-/g, ' '));
  const titleTokens = tokens(title);
  if (!slugTokens.size || !titleTokens.size) return false;
  return [...slugTokens].some((word) => titleTokens.has(word));
}

async function metObjectByAccession(accession) {
  const search = await fetchJson(`${MET_API}/search?q=${encodeURIComponent(accession)}`);
  for (const id of (search?.objectIDs || []).slice(0, MET_SEARCH_CANDIDATES)) {
    const object = await fetchJson(`${MET_API}/objects/${id}`);
    if (object && clean(object.accessionNumber) === accession) return object;
  }
  return null;
}

// "Overall: 16 x 21 x 7 3/4 in. (40.6 x 53.3 x 19.7 cm)" → "40.6 × 53.3 × 19.7 cm"
function metDimensions(raw) {
  const text = clean(raw);
  const cm = text.match(/\(([^()]*\bcm)\)/);
  if (!cm) return text;
  return cm[1].replace(/\s*x\s*/gi, ' × ').replace(/\s+/g, ' ').trim();
}

// A source_url pointing at a Met object page identifies the object directly
// (audit-confirmed source of record) — no slug pattern needed.
function metUrlObjectId(record) {
  const match = clean(record.source_url).match(/metmuseum\.org\/art\/collection\/search\/(\d+)/i);
  return match?.[1] || '';
}

async function metPass() {
  for (const record of sliceTargets) {
    const urlId = metUrlObjectId(record);
    const ref = metRef(record.slug);
    if (!urlId && !ref) continue;
    if (!urlId && ref.ambiguous) {
      report.met.skipped.push({ slug: record.slug, reason: `trailing "${ref.ambiguous}" is 4 digits — could be a year, not an objectID` });
      continue;
    }

    let object;
    try {
      object = urlId
        ? await fetchJson(`${MET_API}/objects/${urlId}`)
        : ref.objectId
          ? await fetchJson(`${MET_API}/objects/${ref.objectId}`)
          : await metObjectByAccession(ref.accession);
    } catch (error) {
      report.met.skipped.push({ slug: record.slug, reason: `API error: ${error.message}` });
      continue;
    }
    if (!object) {
      report.met.skipped.push({ slug: record.slug, reason: `no Met object found for ${urlId || ref.objectId || ref.accession}` });
      continue;
    }
    // Slug-derived ids keep the title sanity-check as a blocker; for URL-derived
    // ids the URL itself is the evidence — title disagreement is only a warning,
    // logged below by the sameLoosely() conflict check.
    const slugWords = ref?.words || record.slug.split('/').pop();
    if (!urlId && !titleMatchesSlug(slugWords, object.title)) {
      report.met.skipped.push({ slug: record.slug, reason: `Met title "${object.title}" does not match slug words "${slugWords}"` });
      continue;
    }
    if (!sameLoosely(record.title, object.title)) {
      report.conflicts.push({ slug: record.slug, field: 'title', have: record.title, api: object.title, source: 'Met (kept catalog title)' });
    }

    fill(record, 'artist', clean(object.artistDisplayName), 'Met');
    fill(record, 'year', clean(object.objectDate), 'Met');
    if (fill(record, 'year_sort', Number(object.objectBeginDate), 'Met')) {
      record.period = periodFor(record.year_sort);
    }
    fill(record, 'material', clean(object.medium), 'Met');
    fill(record, 'dimensions', metDimensions(object.dimensions), 'Met');
    fill(record, 'museum', clean(object.repository), 'Met');
    fill(record, 'attribution', clean(object.creditLine), 'Met');
    if (object.isPublicDomain === true) {
      fill(record, 'license', 'CC0 1.0', 'Met');
      fill(record, 'license_url', 'https://creativecommons.org/publicdomain/zero/1.0/', 'Met');
    } else {
      report.conflicts.push({ slug: record.slug, field: 'license', have: clean(record.license) || '(empty)', api: 'isPublicDomain=false — rights review needed', source: 'Met' });
    }
    fill(record, 'source_url', clean(object.objectURL), 'Met');
    fill(record, 'source_institution', 'The Met', 'Met');
    fill(record, 'accession', clean(object.accessionNumber), 'Met');
    fill(record, 'wikidata', clean(object.objectWikidata_URL), 'Met');
    report.met.resolved.push({ slug: record.slug, id: String(object.objectID) });
  }
}

// --- Casts pass (--casts) ------------------------------------------------------
//
// Several catalog entries are scans of plaster casts (Royal Cast Collection, SMK
// Copenhagen) and conflated the scanned cast with the artwork itself: museum said
// "Royal Cast Collection", material said "Plaster". Owner ruling: the page
// describes the WORK; scan provenance gets its own field. This pass:
//   * writes `scan_source` from the old museum/material/source_institution values,
//   * re-points `museum`/`material` at the ORIGINAL via Wikidata — the only
//     allowed overwrites, and only when the old value is cast-side (mentions the
//     cast collection / is plaster); everything else stays fill-only + conflict log,
//   * fills artist / year (only when empty) / wikidata QID from the original,
//   * leaves license, license_url, source_url, attribution, accession untouched —
//     they describe the scan and render under the scan-source row in the template.
// Run separately from the SMK/Met passes: node scripts/enrich-from-sources.mjs --casts

const WD_API = 'https://www.wikidata.org/w/api.php';
const WD_CACHE_PATH = '/tmp/wd-cache.json';
const wdCache = existsSync(WD_CACHE_PATH) ? JSON.parse(readFileSync(WD_CACHE_PATH, 'utf8')) : {};
let lastWdFetch = 0;

async function wdJson(params) {
  const url = `${WD_API}?${new URLSearchParams({ format: 'json', ...params })}`;
  if (wdCache[url]) return wdCache[url];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const wait = lastWdFetch + 1200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastWdFetch = Date.now();
    let response;
    try {
      // Stalled connections (egress proxies black-holing reused sockets) hang fetch
      // forever without a timeout — abort and retry on a fresh attempt.
      response = await fetch(url, { headers: { 'User-Agent': 'atrium.earth catalog enrichment script' }, signal: AbortSignal.timeout(5000) });
    } catch {
      await sleep(300);
      continue;
    }
    if (response.status === 429 || response.status >= 500) { await sleep(2500 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    const data = await response.json();
    wdCache[url] = data;
    writeFileSync(WD_CACHE_PATH, JSON.stringify(wdCache));
    return data;
  }
  throw new Error(`Wikidata kept rate-limiting: ${url}`);
}

async function wdEntities(ids, props = 'claims|labels|descriptions') {
  const entities = {};
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 45) {
    const data = await wdJson({ action: 'wbgetentities', ids: unique.slice(i, i + 45).join('|'), props, languages: 'en' });
    Object.assign(entities, data.entities || {});
  }
  return entities;
}

const wdLabel = (entities, id) => entities?.[id]?.labels?.en?.value || '';

function wdClaims(entity, property) {
  return (entity?.claims?.[property] || [])
    .filter((claim) => claim.rank !== 'deprecated' && claim.mainsnak?.snaktype === 'value');
}

const claimItemId = (claim) => claim.mainsnak.datavalue?.value?.id;
const claimHasQualifier = (claim, qualifier) => Boolean(claim.qualifiers?.[qualifier]);

function preferRanked(claims) {
  const preferred = claims.filter((claim) => claim.rank === 'preferred');
  return preferred.length ? preferred : claims;
}

function isCastWork(record) {
  if (/cast collection/i.test(clean(record.museum))) return true;
  if (/plaster[- ]cast|cast scan|cast collection/i.test(clean(record.note))) return true;
  // SMK-sourced AND carrying a Royal Cast Collection (KAS) number. SMK also owns
  // ORIGINAL marbles (DEP/inv. accessions, e.g. the Bregno reliefs) — being SMK-
  // sourced alone is not a cast indicator.
  const smkSourced = /\bSMK\b/i.test(clean(record.source_institution)) || /smk\.dk/i.test(clean(record.source_url));
  const kasNumbered = /^KAS\d/i.test(clean(record.accession)) || /kas\d/i.test(clean(record.source_url));
  return smkSourced && kasNumbered;
}

// "Plaster cast, Room 120, Royal Cast Collection (SMK), Copenhagen" — built from the
// old museum value; works identified only by source_institution/note get the plain
// collection name (SMK's sculpture scans are its Royal Cast Collection digitisation).
function castScanSource(record) {
  // The SMK pass fills empty museums as "SMK — Royal Cast Collection"; drop that
  // prefix so scan_source reads "Plaster cast, Royal Cast Collection (SMK), Copenhagen".
  const oldMuseum = clean(record.museum).replace(/^SMK\s*[—–-]\s*/, '');
  const venue = /cast collection/i.test(oldMuseum) ? oldMuseum : 'Royal Cast Collection';
  return `Plaster cast, ${venue} (SMK), Copenhagen`;
}

// Alternate search phrasings for titles whose plain form finds nothing.
const CAST_QUERIES = {
  'apollo-lykeios': ['Apollo Lykeios', 'Apollo Lyceus'],
  'the-wrestlers': ['The Wrestlers sculpture', 'Pancrastinae'],
  'assyrian/ashurnasirpal-lion-hunt': ['Ashurnasirpal II lion hunt relief', 'lion hunt of Ashurnasirpal'],
  'assyrian/lion-released-from-cage': ['Lion released from cage relief Ashurbanipal', 'lion hunt of Ashurbanipal'],
};

// Phase-A curatorial picks. Famous works attract copies, prints, even Dali, so the
// search alone is ambiguous; these QIDs were verified by hand against the catalog
// entries. The script still enforces the sculpture-class check on every pin.
const CAST_PINS = {
  'discobolus': { qid: 'Q133732', why: 'the lost Myron original — search top hits are modern copies (Townley, Lancellotti, park bronzes)' },
  'athena-lemnia': { qid: 'Q950701', why: 'Phidias original; Bologna bust and Kassel copy also match the label' },
  'apollo-belvedere': { qid: 'Q619135', why: 'the Vatican marble; Dijon and Frankfurt copies also match' },
  'laocoon': { qid: 'Q465762', why: 'the Vatican group; NGA and Rijksmuseum bronzes also match' },
  'venus-de-milo': { qid: 'Q151952', why: 'the Louvre statue; Dali "Venus de Milo with Drawers" also matches' },
  'germanicus': { qid: 'Q115609581', why: 'the Louvre "Germanicus" (Galerie Daru) — an Amelia bronze shares the label' },
  'apollo-lykeios': { qid: 'Q3814239', why: 'Wikidata models this as the statue type ("Lyceus", artistic type) — the original is lost' },
  'the-wrestlers': { qid: 'Q3918710', why: 'the Uffizi group, labelled just "Wrestlers"' },
};

// Originals Wikidata cannot resolve to an item, or fields Wikidata leaves ambiguous.
// Values are curator-supplied (see `why`) and flagged MANUAL in the report.
const CAST_MANUAL = {
  'assyrian/ashurnasirpal-lion-hunt': {
    museum: 'British Museum, London',
    material: 'Gypsum alabaster',
    why: 'no Wikidata item for the Nimrud lion-hunt panel; museum from the catalog note ("the underlying original is in the British Museum"), material per the BM catalogue',
  },
  'assyrian/lion-released-from-cage': {
    museum: 'British Museum, London',
    material: 'Gypsum alabaster',
    why: 'nearest Wikidata item is the whole Lion Hunt of Ashurbanipal series (Q27920165, owned by the British Museum) — too coarse for a QID link; museum from the catalog note, material per the BM catalogue',
  },
  'discobolus': {
    material: 'Bronze (lost original)',
    why: 'Q133732 lists both bronze and marble (original vs. copies); Myron’s original was bronze',
  },
};

// P31 chain accepted as "this entity is the sculpture itself" (one P279 hop deep,
// so marble sculpture / colossal statue / lost sculpture / bust resolve too).
const SCULPTURE_ROOTS = new Set([
  'Q860861',   // sculpture
  'Q179700',   // statue
  'Q245117',   // relief
  'Q17489659', // group of works (relief cycles)
  'Q16767597', // artistic type (lost originals known only as a type, e.g. Apollo Lykeios)
]);

const ROOMLIKE = /^(room|hall|salle|sala|galerie|gallery)\b/i;
const NOT_A_CITY = /\b(arrondissement|borough|government region|county|province|district)\b/i;
const LOCATION_TWEAKS = new Map([
  ['Pio-Clementino museum', 'Vatican Museums'], // sub-museum; use the name visitors know
  ['Louvre Museum', 'Musée du Louvre'],
  ['Louvre', 'Musée du Louvre'],
]);

function titleLike(title, label) {
  const a = looseKey(title);
  const b = looseKey(label);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const tokensA = new Set(a.split(' ').filter((t) => t.length >= 3));
  const tokensB = new Set(b.split(' ').filter((t) => t.length >= 3));
  const shared = [...tokensA].filter((t) => tokensB.has(t));
  return shared.length >= Math.min(2, Math.min(tokensA.size, tokensB.size));
}

function formatInception(value) {
  const match = (value.time || '').match(/^([+-])(\d{4,})/);
  if (!match) return '';
  const year = Number(match[2]);
  const bce = match[1] === '-';
  if (value.precision >= 8) return bce ? `c. ${year} BCE` : `c. ${year}`;
  if (value.precision === 7) {
    const century = Math.max(1, Math.ceil(year / 100));
    return `${ordinal(century)} century${bce ? ' BCE' : ' CE'}`;
  }
  return '';
}

function entityIsLost(entity, classLabels) {
  if (/\blost\b/i.test(entity?.descriptions?.en?.value || '')) return true;
  return wdClaims(entity, 'P31').some((claim) => /\blost\b/i.test(wdLabel(classLabels, claimItemId(claim))));
}

async function castsPass() {
  // Works already carrying scan_source had the cast/original split done in an
  // earlier run (or at ingest) — leave them alone.
  const castRecords = catalog.filter((record) => isCastWork(record) && isEmpty(record.scan_source));
  report.casts.identified = castRecords.map((record) => record.slug);

  // Phase 1: search candidates for every cast work.
  const candidatesByWork = new Map();
  for (const record of castRecords) {
    const queries = CAST_QUERIES[record.slug] || [record.title];
    const seen = new Set();
    const candidates = [];
    for (const query of queries) {
      const data = await wdJson({ action: 'wbsearchentities', search: query, language: 'en', type: 'item', limit: '8' });
      for (const hit of data.search || []) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        candidates.push({ id: hit.id, label: hit.label || '' });
      }
    }
    candidatesByWork.set(record.slug, candidates);
  }

  // Phase 2: fetch candidate + pinned entities, then their P31 classes (+1 P279 hop).
  const candidateIds = [...candidatesByWork.values()].flat().map((c) => c.id);
  const pinnedIds = Object.values(CAST_PINS).map((pin) => pin.qid);
  const entities = await wdEntities([...candidateIds, ...pinnedIds]);
  const classIds = Object.values(entities).flatMap((entity) => wdClaims(entity, 'P31').map(claimItemId));
  const classEntities = await wdEntities(classIds, 'claims|labels');

  function sculptureClassOK(entity) {
    for (const claim of wdClaims(entity, 'P31')) {
      const id = claimItemId(claim);
      if (SCULPTURE_ROOTS.has(id)) return true;
      if (wdClaims(classEntities[id], 'P279').some((hop) => SCULPTURE_ROOTS.has(claimItemId(hop)))) return true;
    }
    return false;
  }

  // Phase 3: pick one entity per work — unambiguous search match, else Phase-A pin.
  const chosenByWork = new Map();
  for (const record of castRecords) {
    const accepted = (candidatesByWork.get(record.slug) || [])
      .filter((candidate) => titleLike(record.title, candidate.label) && sculptureClassOK(entities[candidate.id]));
    const pin = CAST_PINS[record.slug];
    if (pin && entities[pin.qid] && sculptureClassOK(entities[pin.qid])) {
      chosenByWork.set(record.slug, { qid: pin.qid, how: `pinned — ${pin.why}` });
    } else if (accepted.length === 1) {
      chosenByWork.set(record.slug, { qid: accepted[0].id, how: 'unambiguous search match' });
    } else if (CAST_MANUAL[record.slug]) {
      chosenByWork.set(record.slug, { qid: null, how: 'manual' });
    } else if (accepted.length > 1) {
      report.casts.skipped.push({ slug: record.slug, reason: `ambiguous — ${accepted.map((c) => c.id).join(', ')} all pass; pin one to proceed` });
    } else {
      report.casts.skipped.push({ slug: record.slug, reason: 'no Wikidata entity matched title + sculpture class' });
    }
  }

  // Phase 4: fetch referenced values (locations + admin chains + part-of, creators, materials).
  const valueIds = [];
  for (const { qid } of chosenByWork.values()) {
    if (!qid) continue;
    const entity = entities[qid];
    for (const property of ['P276', 'P195', 'P170', 'P186']) {
      for (const claim of wdClaims(entity, property)) valueIds.push(claimItemId(claim));
    }
  }
  const valueEntities = await wdEntities(valueIds, 'claims|labels');
  const hopIds = Object.values(valueEntities).flatMap((entity) => [
    ...wdClaims(entity, 'P131').map(claimItemId),
    ...wdClaims(entity, 'P361').map(claimItemId),
  ]);
  const hopEntities = await wdEntities(hopIds, 'claims|labels');
  const labelPool = { ...hopEntities, ...valueEntities };
  const hop2Ids = Object.values(hopEntities).flatMap((entity) => wdClaims(entity, 'P131').map(claimItemId)).filter((id) => !labelPool[id]);
  Object.assign(labelPool, await wdEntities(hop2Ids, 'labels'));

  function cityFor(locationId) {
    let current = locationId;
    for (let hop = 0; hop < 3; hop += 1) {
      const next = claimItemId(wdClaims(labelPool[current], 'P131')[0] || { mainsnak: {} });
      if (!next) return '';
      const text = wdLabel(labelPool, next);
      if (text && !NOT_A_CITY.test(text)) return text;
      current = next;
    }
    return '';
  }

  function museumDisplay(locationId, collectionId) {
    let name = LOCATION_TWEAKS.get(wdLabel(labelPool, locationId)) || wdLabel(labelPool, locationId);
    if (ROOMLIKE.test(name)) {
      const parent = claimItemId(wdClaims(labelPool[locationId], 'P361')[0] || { mainsnak: {} });
      const parentLabel = parent ? wdLabel(labelPool, parent) : '';
      const collectionLabel = collectionId ? wdLabel(labelPool, collectionId) : '';
      const department = collectionLabel.match(/department of .* of the (.+)$/i);
      if (parentLabel && !ROOMLIKE.test(parentLabel)) name = parentLabel;
      else if (department) name = department[1];
      else return '';
    }
    name = LOCATION_TWEAKS.get(name) || name; // normalise whichever path produced it
    const city = cityFor(locationId);
    return city && !looseKey(name).includes(looseKey(city)) ? `${name}, ${city}` : name;
  }

  // Phase 5: apply.
  for (const record of castRecords) {
    const choice = chosenByWork.get(record.slug);
    if (!choice) continue;
    const manual = CAST_MANUAL[record.slug];
    const entity = choice.qid ? entities[choice.qid] : null;
    const before = { museum: clean(record.museum), material: clean(record.material) };
    const entry = { slug: record.slug, qid: choice.qid, how: choice.how, before, notes: [] };
    if (manual) entry.notes.push(`MANUAL ${Object.keys(manual).filter((key) => key !== 'why').join('/')}: ${manual.why}`);

    record.scan_source = castScanSource(record);
    castChanged.add(record.slug);

    // Museum: the original's current location. Lost originals (or P276 carrying only
    // historical time qualifiers) have none — clearing beats keeping the cast's shelf.
    let museum = manual?.museum ?? null;
    let lost = false;
    if (!museum && entity) {
      lost = entityIsLost(entity, classEntities);
      const locations = preferRanked([...wdClaims(entity, 'P276'), ...wdClaims(entity, 'P195')])
        .filter((claim) => !claimHasQualifier(claim, 'P582'))
        .filter((claim) => !(lost && (claimHasQualifier(claim, 'P580') || claimHasQualifier(claim, 'P585'))));
      const locationId = locations.length ? claimItemId(locations[0]) : null;
      museum = locationId ? museumDisplay(locationId, claimItemId(wdClaims(entity, 'P195')[0] || { mainsnak: {} })) : null;
    }
    if (museum) {
      if (isEmpty(record.museum)) recordFill(record, 'museum', museum, 'Casts');
      else if (/cast collection/i.test(record.museum)) record.museum = museum; // allowed overwrite
      else if (!sameLoosely(record.museum, museum)) report.conflicts.push({ slug: record.slug, field: 'museum', have: record.museum, api: museum, source: 'Wikidata (casts)' });
    } else if (/cast collection/i.test(record.museum)) {
      record.museum = '';
      entry.notes.push(lost ? 'museum cleared — the original is lost (no current location)' : 'museum cleared — no location claim on Wikidata');
    }

    // Material: overwrite allowed only over cast material (plaster); a single
    // (or preferred-ranked) P186 value counts as resolved.
    let material = manual?.material ?? null;
    if (!material && entity) {
      const materials = preferRanked(wdClaims(entity, 'P186'));
      if (materials.length === 1) {
        const text = wdLabel(labelPool, claimItemId(materials[0]));
        material = text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
      } else if (materials.length > 1) {
        entry.notes.push(`material left as "${before.material}" — Wikidata lists ${materials.map((claim) => wdLabel(labelPool, claimItemId(claim))).join(' + ')}`);
      }
    }
    const plasterish = /^(plaster|gips)\b/i.test(before.material);
    if (material) {
      if (isEmpty(record.material)) recordFill(record, 'material', material, 'Casts');
      else if (plasterish) record.material = material; // allowed overwrite
      else if (!sameLoosely(record.material, material)) report.conflicts.push({ slug: record.slug, field: 'material', have: record.material, api: material, source: 'Wikidata (casts)' });
    } else if (plasterish) {
      entry.notes.push('material still says Plaster — needs a human (Wikidata unresolved)');
    }

    if (entity) {
      const creators = wdClaims(entity, 'P170').map((claim) => wdLabel(labelPool, claimItemId(claim))).filter(Boolean);
      if (creators.length) {
        const artist = creators.length > 1 ? `${creators.slice(0, -1).join(', ')} and ${creators[creators.length - 1]}` : creators[0];
        fill(record, 'artist', artist, 'Casts');
      }

      // Inception only as fallback into an empty year; prefer ranked, then precision.
      if (isEmpty(record.year)) {
        const inceptions = preferRanked(wdClaims(entity, 'P571'))
          .map((claim) => claim.mainsnak.datavalue?.value)
          .filter(Boolean)
          .sort((a, b) => b.precision - a.precision);
        const display = inceptions.length ? formatInception(inceptions[0]) : '';
        if (display) {
          const hadYearSort = !isEmpty(record.year_sort);
          fill(record, 'year', display, 'Casts');
          fill(record, 'year_sort', yearSortFromDisplay(display), 'Casts');
          if (!hadYearSort && !isEmpty(record.year_sort)) record.period = periodFor(record.year_sort);
        }
      }

      fill(record, 'wikidata', `https://www.wikidata.org/wiki/${choice.qid}`, 'Casts');
    }

    entry.after = { museum: clean(record.museum), material: clean(record.material) };
    entry.scan_source = record.scan_source;
    report.casts.fixed.push(entry);
  }
}

function pass2Markdown() {
  const lines = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('# Pass 2 — cast vs. original');
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}${dryRun ? ' (dry run — catalog not written)' : ''}`);
  lines.push('');
  lines.push(`Cast-derived works identified (${report.casts.identified.length}): ${report.casts.identified.map((slug) => `\`${slug}\``).join(', ')}`);
  lines.push('');
  lines.push(`- Fixed: ${report.casts.fixed.length}`);
  lines.push(`- Skipped: ${report.casts.skipped.length}`);
  lines.push(`- Conflicts logged (existing value kept): ${report.conflicts.length}`);
  lines.push('');
  lines.push('## Cast works fixed');
  lines.push('');
  lines.push('| Slug | Museum (before → after) | Material (before → after) | scan_source |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of report.casts.fixed) {
    const arrow = (from, to) => (from === to ? from || '(empty)' : `${from || '(empty)'} → ${to || '(empty)'}`);
    lines.push(`| ${entry.slug} | ${arrow(entry.before.museum, entry.after.museum)} | ${arrow(entry.before.material, entry.after.material)} | ${entry.scan_source} |`);
  }
  lines.push('');
  lines.push('## Resolution detail');
  lines.push('');
  for (const entry of report.casts.fixed) {
    lines.push(`- \`${entry.slug}\` → ${entry.qid || 'no QID'} (${entry.how})${entry.notes.length ? ` — ${entry.notes.join('; ')}` : ''}`);
  }
  lines.push('');
  if (report.casts.skipped.length) {
    lines.push('## Skipped');
    lines.push('');
    for (const skip of report.casts.skipped) lines.push(`- \`${skip.slug}\`: ${skip.reason}`);
    lines.push('');
  }
  if (report.conflicts.length) {
    lines.push('## Conflicts (kept catalog value, review by hand)');
    lines.push('');
    lines.push('| Slug | Field | Catalog has | API says | Source |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const conflict of report.conflicts) {
      lines.push(`| ${conflict.slug} | ${conflict.field} | ${conflict.have} | ${conflict.api} | ${conflict.source} |`);
    }
    lines.push('');
  }
  lines.push('## Fields filled this pass');
  lines.push('');
  if (report.filled.size) {
    lines.push('| Slug | Fields |');
    lines.push('| --- | --- |');
    for (const [slug, entry] of report.filled) lines.push(`| ${slug} | ${entry.fields.join(', ')} |`);
  } else {
    lines.push('Nothing beyond museum/material/scan_source.');
  }
  lines.push('');
  return lines.join('\n');
}

// --- run ----------------------------------------------------------------------

const castChanged = new Set();
if (castsMode) {
  await castsPass();
} else {
  await smkPass();
  await metPass();
}

for (const record of catalog) {
  if (report.filled.has(record.slug) || castChanged.has(record.slug)) record.search = rebuildSearch(record);
}

if (!dryRun) {
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

if (castsMode) {
  if (dryRun) console.log(pass2Markdown());
  else appendFileSync(reportPath, pass2Markdown());
  console.log(`Casts: ${report.casts.fixed.length} fixed / ${report.casts.skipped.length} skipped, ${report.conflicts.length} conflicts logged${dryRun ? ' (dry run)' : ''}`);
  console.log(`Report: ${reportPath}${dryRun ? ' (dry run — printed above, not appended)' : ''}`);
  process.exit(0);
}

// --- report -------------------------------------------------------------------

const missing = catalog
  .map((record) => {
    const gaps = ['artist', 'year', 'material', 'dimensions'].filter((field) => isEmpty(record[field]));
    return gaps.length ? `| ${record.slug} | ${gaps.join(', ')} |` : '';
  })
  .filter(Boolean);

const lines = [];
lines.push('# Catalog enrichment report');
lines.push('');
lines.push(`Run: ${new Date().toISOString()}${dryRun ? ' (dry run — catalog not written)' : ''}`);
lines.push('');
lines.push('## Counts');
lines.push('');
lines.push(`- SMK pass: ${report.smk.resolved.length} resolved, ${report.smk.skipped.length} skipped`);
lines.push(`- Met pass: ${report.met.resolved.length} resolved, ${report.met.skipped.length} skipped`);
lines.push(`- Works enriched (≥1 field filled): ${report.filled.size}`);
lines.push(`- Conflicts logged (existing value kept): ${report.conflicts.length}`);
lines.push('');

for (const [name, pass] of [['SMK', report.smk], ['Met', report.met]]) {
  if (pass.skipped.length) {
    lines.push(`## ${name} — skipped`);
    lines.push('');
    for (const skip of pass.skipped) lines.push(`- \`${skip.slug}\`: ${skip.reason}`);
    lines.push('');
  }
}

if (report.conflicts.length) {
  lines.push('## Conflicts (kept catalog value, review by hand)');
  lines.push('');
  lines.push('| Slug | Field | Catalog has | API says | Source |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const conflict of report.conflicts) {
    lines.push(`| ${conflict.slug} | ${conflict.field} | ${conflict.have} | ${conflict.api} | ${conflict.source} |`);
  }
  lines.push('');
}

lines.push('## Fields filled');
lines.push('');
if (report.filled.size) {
  lines.push('| Slug | Source | Fields |');
  lines.push('| --- | --- | --- |');
  for (const [slug, entry] of report.filled) {
    lines.push(`| ${slug} | ${entry.source} | ${entry.fields.join(', ')} |`);
  }
} else {
  lines.push('Nothing filled.');
}
lines.push('');

lines.push(`## Still missing artist/year/material/dimensions (${missing.length} works — research list)`);
lines.push('');
lines.push('| Slug | Missing |');
lines.push('| --- | --- |');
lines.push(...missing);
lines.push('');

writeFileSync(reportPath, `${lines.join('\n')}`);

console.log(`SMK: ${report.smk.resolved.length} resolved / ${report.smk.skipped.length} skipped`);
console.log(`Met: ${report.met.resolved.length} resolved / ${report.met.skipped.length} skipped`);
console.log(`Filled fields on ${report.filled.size} works, ${report.conflicts.length} conflicts logged`);
console.log(`Report: ${reportPath}${dryRun ? ' (dry run)' : ''}`);
