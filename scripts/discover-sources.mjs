#!/usr/bin/env node
import path from 'node:path';
import {
  asList,
  candidateIsKnown,
  catalogIndexes,
  clean,
  collectionFor,
  defaultStageDir,
  faceCountAllowed,
  hasSculptureSubject,
  isAllowedLicense,
  licenseLabel,
  licenseTier,
  loadCatalog,
  makeSlug,
  meshExtensionFromUrl,
  parseArgs,
  repoRoot,
  slugify,
  titleKey,
  writeJson,
  yearSortFromDisplay,
} from './ingest-utils.mjs';

const args = parseArgs();
const stageDir = path.resolve(repoRoot, args.stage || process.env.ATRIUM_INGEST_DIR || defaultStageDir);
const outPath = path.resolve(repoRoot, args.out || path.join(stageDir, 'candidates.json'));
const batchLimit = Number(args.limit || process.env.ATRIUM_INGEST_LIMIT || 10);
const sources = new Set(asList(args.sources || process.env.ATRIUM_INGEST_SOURCES || 'smk,smithsonian,sketchfab,threedscans'));
const perSourceLimit = Number(args['per-source-limit'] || process.env.ATRIUM_INGEST_PER_SOURCE_LIMIT || 50);

const sculptureQueries = asList(args.queries || process.env.ATRIUM_INGEST_QUERIES || 'statue,sculpture,bust,figure,relief');
const sketchfabMuseumUsers = new Set(asList(
  args['sketchfab-users']
  || process.env.SKETCHFAB_MUSEUM_USERS
  || 'Smithsonian,metmuseum,ClevelandArt,artsmia,MuseeSaintRaymond,WirtualneMuzeaMalopolski,VirtualMuseumsMalopolska,TheBritishMuseum'
).map((value) => value.toLowerCase()));

function firstTitle(titles) {
  if (!Array.isArray(titles)) return clean(titles);
  const english = titles.find((entry) => /en/i.test(clean(entry.language || entry.type)));
  return clean(english?.title || titles[0]?.title || '');
}

function smkArtist(item) {
  const creators = [
    ...(item.production || []).map((entry) => entry.creator),
    ...(item.artist || []),
  ].map(clean).filter(Boolean).filter((name) => !/^(ubekendt|unknown)$/i.test(name));
  return creators[0] || '';
}

function smkYear(item) {
  const notes = (item.original || []).flatMap((entry) => entry.production_date_notes || []).map(clean).filter(Boolean);
  return notes.find((value) => /\d/.test(value))
    ?.replace(/\bca\./i, 'c.')
    .replace(/\bf\.?\s*kr\.?\b/i, 'BCE') || '';
}

function smkMaterials(item) {
  const labels = new Map([['Gips', 'Plaster']]);
  return [...new Set((item.materials || []).map((value) => labels.get(value) || value).map(clean).filter(Boolean))].join(', ');
}

function smkDimensions(item) {
  const labels = new Map([['højde', 'H'], ['bredde', 'W'], ['dybde', 'D']]);
  return (item.dimensions || []).map((dimension) => {
    const label = labels.get(clean(dimension.type)) || clean(dimension.type);
    const value = clean(dimension.value);
    const unit = clean(dimension.unit).toLowerCase() === 'centimeter' ? 'cm' : clean(dimension.unit);
    return label && value ? `${label} ${value}${unit ? ` ${unit}` : ''}` : '';
  }).filter(Boolean).join(' x ');
}

function smkDisplayPlace(item) {
  const departments = new Map([
    ['Den Kongelige Afstøbningssamling', 'Royal Cast Collection'],
    ['Samling og Forskning (KAS)', 'Royal Cast Collection'],
  ]);
  const dept = departments.get(clean(item.responsible_department)) || clean(item.responsible_department);
  const room = clean(item.current_location_name).replace(/^Sal\b/i, 'Room');
  if (room && dept) return `${room}, ${dept}`;
  return dept;
}

function smkBestFiles(files) {
  return (files || [])
    .filter((file) => clean(file.url) && /model\/|\.stl|\.obj|\.ply|\.glb|\.zip/i.test(`${file.mime_type || ''} ${file.url}`))
    .sort((a, b) => {
      const as = Number(a.file_size || 0);
      const bs = Number(b.file_size || 0);
      const aSmall = /small/i.test(a.url) ? -1 : 0;
      const bSmall = /small/i.test(b.url) ? -1 : 0;
      return aSmall - bSmall || as - bs;
    });
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function discoverSmk(report) {
  const rows = Number(args['smk-rows'] || process.env.SMK_DISCOVERY_ROWS || 100);
  const maxPages = Number(args['smk-pages'] || process.env.SMK_DISCOVERY_PAGES || 8);
  const out = [];
  const seen = new Set();

  for (const query of asList(args['smk-queries'] || process.env.SMK_DISCOVERY_QUERIES || 'Statue,Buste,Relief,Skulptur,KAS,DEP')) {
    for (let page = 0; page < maxPages && out.length < perSourceLimit; page += 1) {
      const url = `https://api.smk.dk/api/v1/art/search/?keys=${encodeURIComponent(query)}&rows=${rows}&offset=${page * rows}`;
      let payload;
      try {
        payload = await fetchJson(url);
      } catch (error) {
        report.skipped.push({ source: 'smk', query, reason: error.message });
        break;
      }
      for (const item of payload.items || []) {
        if (!item.has_3d_file) continue;
        const accession = clean(item.object_number);
        if (!accession || seen.has(accession)) continue;
        seen.add(accession);

        const files = smkBestFiles(item.files_3D);
        const primary = files[0];
        const license = licenseLabel(item.rights);
        const title = firstTitle(item.titles) || accession;
        const subject = (item.object_names || []).map((entry) => entry.name).filter(Boolean).join(', ');
        const year = smkYear(item);
        const original = (item.original || [])[0] || {};
        const originalPlace = (original.current_owner || []).map(clean).filter(Boolean).join(', ');
        const history = (original.object_history_note || []).map(clean).filter(Boolean).join('; ');

        if (!primary) {
          report.skipped.push({ source: 'smk', accession, title, reason: 'no downloadable 3D file URL' });
          continue;
        }
        if (!isAllowedLicense(`${license} ${item.rights || ''}`)) {
          report.skipped.push({ source: 'smk', accession, title, reason: `license not allowed: ${item.rights || license}` });
          continue;
        }
        const candidate = {
          source: 'smk',
          title,
          subject,
          artist: smkArtist(item),
          year,
          year_sort: yearSortFromDisplay(year),
          material: smkMaterials(item),
          dimensions: smkDimensions(item),
          museum: originalPlace,
          displayed_at: smkDisplayPlace(item),
          source_institution: 'SMK - National Gallery of Denmark',
          source_url: `https://open.smk.dk/en/artwork/3d/${encodeURIComponent(accession)}`,
          source_record_url: clean(item.object_url),
          download_url: primary.url,
          download_format: meshExtensionFromUrl(primary.url, '.stl').replace('.', ''),
          download_size_bytes: Number(primary.file_size || 0),
          alternate_downloads: files.slice(1).map((file) => ({
            url: file.url,
            sizeBytes: Number(file.file_size || 0),
            format: meshExtensionFromUrl(file.url, '.stl').replace('.', ''),
          })),
          accession,
          license,
          license_url: clean(item.rights),
          license_tier: licenseTier(`${license} ${item.rights || ''}`),
          scan_author: 'SMK digitization',
          attribution: 'SMK - National Gallery of Denmark',
          scan_source: clean(item.responsible_department),
          note: history,
          source_payload: { object_number: accession, query },
        };
        if (hasSculptureSubject(candidate)) out.push(candidate);
      }
      if ((payload.offset || 0) + (payload.rows || rows) >= (payload.found || 0)) break;
    }
  }
  return out;
}

function smithsonianSourceUrl(row) {
  const modelUrl = clean(row.content?.model_url || row.url);
  const uuid = modelUrl.split(':').pop();
  return uuid ? `https://3d.si.edu/object/3d/${encodeURIComponent(`${slugify(row.title)}:${uuid}`)}` : clean(row.content?.uri);
}

function faceCountFromSmithsonian(row) {
  const uri = clean(row.content?.uri);
  const match = uri.match(/(?:^|[-_])(\d{2,4})k(?:[-_]|\.|$)/i);
  return match ? Number(match[1]) * 1000 : null;
}

async function discoverSmithsonian(report) {
  const rows = Number(args['smithsonian-rows'] || process.env.SMITHSONIAN_DISCOVERY_ROWS || 80);
  const out = [];
  const seen = new Set();
  for (const query of sculptureQueries) {
    const url = `https://3d-api.si.edu/api/v1.0/content/file/search?q=${encodeURIComponent(query)}&file_type=glb&file_quality=Medium&rows=${rows}`;
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      report.skipped.push({ source: 'smithsonian', query, reason: error.message });
      continue;
    }
    for (const row of payload.rows || []) {
      const modelUrl = clean(row.content?.model_url || row.url);
      const uri = clean(row.content?.uri);
      const title = clean(row.title);
      const faceCount = faceCountFromSmithsonian(row);
      if (!modelUrl || !uri || !title || seen.has(modelUrl)) continue;
      seen.add(modelUrl);
      if (!faceCountAllowed(faceCount)) {
        report.skipped.push({ source: 'smithsonian', title, reason: `face count outside range: ${faceCount}` });
        continue;
      }
      const candidate = {
        source: 'smithsonian',
        title,
        subject: query,
        year: '',
        year_sort: null,
        material: '',
        dimensions: '',
        museum: 'Smithsonian Institution',
        displayed_at: '',
        source_institution: 'Smithsonian 3D',
        source_url: smithsonianSourceUrl(row),
        source_record_url: modelUrl,
        download_url: uri,
        download_format: 'glb',
        download_size_bytes: 0,
        face_count: faceCount,
        accession: modelUrl,
        license: 'CC0 1.0',
        license_url: 'https://www.si.edu/openaccess',
        license_tier: 1,
        scan_author: 'Smithsonian 3D',
        attribution: 'Smithsonian Institution',
        scan_source: clean(row.content?.usage || 'Smithsonian Open Access'),
        gltf_orientation_compliant: row.content?.gltf_orientation_compliant === true || row.content?.gltf_orientation_compliant === 'true',
        compressed: row.content?.draco_compressed === true || row.content?.draco_compressed === 'true',
        source_payload: { model_url: modelUrl, query, quality: clean(row.content?.quality) },
      };
      if (hasSculptureSubject(candidate)) out.push(candidate);
      if (out.length >= perSourceLimit) return out;
    }
  }
  return out;
}

function sketchfabLicense(model) {
  const label = clean(model.license?.label);
  const uid = clean(model.license?.uid);
  if (/cc0|public domain/i.test(label)) return { license: 'CC0 1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  if (/attribution/i.test(label) || /\bby\b/i.test(label)) return { license: 'CC BY', license_url: 'https://creativecommons.org/licenses/by/4.0/' };
  return { license: label || uid, license_url: '' };
}

async function discoverSketchfab(report) {
  const count = Number(args['sketchfab-count'] || process.env.SKETCHFAB_DISCOVERY_COUNT || 24);
  const out = [];
  const seen = new Set();
  for (const license of ['cc0', 'by']) {
    for (const query of sculptureQueries) {
      const url = new URL('https://api.sketchfab.com/v3/search');
      url.searchParams.set('type', 'models');
      url.searchParams.set('downloadable', 'true');
      url.searchParams.set('license', license);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      let payload;
      try {
        const headers = { accept: 'application/json' };
        if (process.env.SKETCHFAB_TOKEN) headers.Authorization = `Token ${process.env.SKETCHFAB_TOKEN}`;
        payload = await fetchJson(url.toString(), headers);
      } catch (error) {
        report.skipped.push({ source: 'sketchfab', query, license, reason: error.message });
        continue;
      }
      for (const model of payload.results || []) {
        if (!model.uid || seen.has(model.uid)) continue;
        seen.add(model.uid);
        const username = clean(model.user?.username).toLowerCase();
        const displayName = clean(model.user?.displayName);
        if (sketchfabMuseumUsers.size && !sketchfabMuseumUsers.has(username) && !sketchfabMuseumUsers.has(displayName.toLowerCase())) {
          report.skipped.push({ source: 'sketchfab', title: model.name, reason: `publisher not in allowlist: ${displayName || username}` });
          continue;
        }
        const archives = model.archives || {};
        const archive = archives.glb || archives.gltf || archives.source;
        const faceCount = Number(archive?.faceCount || model.faceCount || 0) || null;
        const licenseInfo = sketchfabLicense(model);
        const candidate = {
          source: 'sketchfab',
          title: clean(model.name),
          subject: query,
          artist: displayName,
          year: '',
          year_sort: null,
          material: '',
          dimensions: '',
          museum: displayName,
          displayed_at: '',
          source_institution: `Sketchfab / ${displayName || username}`,
          source_url: clean(model.viewerUrl),
          source_record_url: clean(model.uri),
          download_url: '',
          download_api_url: `https://api.sketchfab.com/v3/models/${model.uid}/download`,
          download_format: archive?.type === 'gltf' ? 'gltf' : 'glb',
          download_size_bytes: Number(archive?.size || 0),
          face_count: faceCount,
          accession: model.uid,
          license: licenseInfo.license,
          license_url: licenseInfo.license_url,
          license_tier: licenseTier(licenseInfo.license),
          scan_author: displayName || username,
          attribution: `${displayName || username}, Sketchfab`,
          scan_source: 'Sketchfab downloadable model',
          description: clean(model.description),
          tags: (model.tags || []).map((tag) => tag.name || tag.slug).filter(Boolean),
          source_payload: { uid: model.uid, user: username, query, archiveType: archive?.type },
        };
        if (!isAllowedLicense(candidate.license)) {
          report.skipped.push({ source: 'sketchfab', title: candidate.title, reason: `license not allowed: ${candidate.license}` });
          continue;
        }
        if (!faceCountAllowed(faceCount)) {
          report.skipped.push({ source: 'sketchfab', title: candidate.title, reason: `face count outside range: ${faceCount}` });
          continue;
        }
        if (hasSculptureSubject(candidate)) out.push(candidate);
        if (out.length >= perSourceLimit) return out;
      }
    }
  }
  return out;
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return '';
  }
}

function tdsField(html, label) {
  const re = new RegExp(`<span[^>]*singleLabel[^>]*>${label}:<\\/span>\\s*([^<]+)`, 'i');
  return clean(html.match(re)?.[1]);
}

async function discoverThreeDScans(report) {
  const pages = Number(args['tds-pages'] || process.env.TDS_DISCOVERY_PAGES || 2);
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const indexUrl = page === 1 ? 'https://threedscans.com/' : `https://threedscans.com/page/${page}/`;
    let html;
    try {
      html = await fetchText(indexUrl);
    } catch (error) {
      report.skipped.push({ source: 'threedscans', url: indexUrl, reason: error.message });
      continue;
    }
    const postUrls = [...html.matchAll(/href=["'](https:\/\/threedscans\.com\/[^"']+\/)["']/g)]
      .map((match) => match[1])
      .filter((url) => !/\/(?:page|info|feed|comments|wp-json)\//i.test(url));
    for (const postUrl of postUrls) {
      if (seen.has(postUrl) || out.length >= perSourceLimit) continue;
      seen.add(postUrl);
      let post;
      try {
        post = await fetchText(postUrl);
      } catch (error) {
        report.skipped.push({ source: 'threedscans', url: postUrl, reason: error.message });
        continue;
      }
      const downloadUrl = [...post.matchAll(/href=["']([^"']+\.(?:stl|obj|ply|glb|gltf|zip)(?:\?[^"']*)?)["']/gi)]
        .map((match) => absoluteUrl(match[1], postUrl))
        .find((url) => /threedscans\.com/i.test(url));
      const title = clean(post.match(/<h2[^>]*entry-title[^>]*>\s*<a[^>]*>([^<]+)/i)?.[1])
        || clean(post.match(/<title>([^<]+)/i)?.[1]).replace(/\s*-\s*Three D Scans$/i, '');
      if (!downloadUrl || !title) {
        report.skipped.push({ source: 'threedscans', url: postUrl, title, reason: 'no direct model download link' });
        continue;
      }
      const period = tdsField(post, 'Period');
      const location = tdsField(post, 'Location');
      const scanned = tdsField(post, 'Scanned');
      const scanner = tdsField(post, 'Scanner');
      const candidate = {
        source: 'threedscans',
        title,
        subject: 'sculpture',
        artist: '',
        year: period,
        year_sort: yearSortFromDisplay(period),
        material: '',
        dimensions: '',
        museum: location,
        displayed_at: location,
        source_institution: 'Three D Scans',
        source_url: postUrl,
        source_record_url: postUrl,
        download_url: downloadUrl,
        download_format: meshExtensionFromUrl(downloadUrl, '.zip').replace('.', ''),
        download_size_bytes: 0,
        accession: slugify(postUrl.replace(/^https?:\/\/threedscans\.com\//i, '')),
        license: 'Public Domain / No restrictions',
        license_url: 'https://threedscans.com/info/',
        license_tier: 1,
        scan_author: 'Oliver Laric / Three D Scans',
        attribution: 'Three D Scans',
        scan_source: scanner || 'Photogrammetry scan',
        note: [scanned ? `Scanned ${scanned}` : '', location].filter(Boolean).join('; '),
        source_payload: { postUrl, indexUrl },
      };
      if (hasSculptureSubject(candidate)) out.push(candidate);
    }
  }
  return out;
}

function normalizeCandidate(candidate, usedSlugs) {
  const next = { ...candidate };
  next.collection = slugify(next.collection || collectionFor(next));
  next.slug = clean(next.slug) || makeSlug(next, usedSlugs);
  next.license = licenseLabel(next.license, next.license_url);
  next.license_tier = next.license_tier || licenseTier(`${next.license} ${next.license_url || ''}`);
  next.year_sort = next.year_sort ?? yearSortFromDisplay(next.year);
  next.period = next.period || '';
  next.subject = clean(next.subject);
  next.title_key = titleKey(next.title);
  next.discovered_at = new Date().toISOString();
  return next;
}

const catalog = await loadCatalog();
const indexes = catalogIndexes(catalog);
const usedSlugs = new Set(catalog.map((item) => item.slug));
const report = { generated_at: new Date().toISOString(), skipped: [], sources: {}, duplicateCandidates: [] };
let candidates = [];

const adapters = [
  ['smk', discoverSmk],
  ['smithsonian', discoverSmithsonian],
  ['sketchfab', discoverSketchfab],
  ['threedscans', discoverThreeDScans],
];

for (const [name, adapter] of adapters) {
  if (!sources.has(name)) continue;
  const before = candidates.length;
  try {
    candidates.push(...(await adapter(report)));
  } catch (error) {
    report.skipped.push({ source: name, reason: error.message });
  }
  report.sources[name] = { discovered: candidates.length - before };
}

const unique = [];
const seen = new Set();
for (const candidate of candidates) {
  if (!isAllowedLicense(`${candidate.license || ''} ${candidate.license_url || ''}`)) {
    report.skipped.push({ source: candidate.source, title: candidate.title, reason: `license not allowed: ${candidate.license}` });
    continue;
  }
  if (!hasSculptureSubject(candidate)) {
    report.skipped.push({ source: candidate.source, title: candidate.title, reason: 'subject does not read as sculpture/figure/bust/relief' });
    continue;
  }
  const knownBy = candidateIsKnown(candidate, indexes);
  if (knownBy) {
    report.duplicateCandidates.push({ title: candidate.title, source: candidate.source, knownBy });
    continue;
  }
  const key = `${candidate.source}:${candidate.accession || candidate.source_url || candidate.download_url}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(normalizeCandidate(candidate, usedSlugs));
}

unique.sort((a, b) => {
  const sourceRank = ['smk', 'smithsonian', 'sketchfab', 'threedscans'];
  return sourceRank.indexOf(a.source) - sourceRank.indexOf(b.source)
    || (Number(b.face_count || 0) - Number(a.face_count || 0))
    || a.title.localeCompare(b.title);
});

const selected = unique.slice(0, batchLimit);
await writeJson(outPath, {
  schema: 'atrium-auto-ingest-candidates/1',
  generated_at: report.generated_at,
  repo_catalog_count: catalog.length,
  batch_limit: batchLimit,
  candidates: selected,
  report: {
    ...report,
    candidates_after_dedupe: unique.length,
    selected: selected.length,
  },
});

console.log(`Discovered ${unique.length} new allowed candidates; selected ${selected.length}.`);
for (const candidate of selected) {
  console.log(`  + ${candidate.slug} (${candidate.source}, ${candidate.license})`);
}
console.log(`Wrote ${outPath}`);
