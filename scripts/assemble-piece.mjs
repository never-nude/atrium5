#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  catalogIndexes,
  candidateIsKnown,
  catalogPath,
  clean,
  defaultStageDir,
  downloadFile,
  fileSize,
  licenseTier,
  loadCatalog,
  orientationsPath,
  parseArgs,
  periodFor,
  previewsPath,
  readJson,
  relativeToRepo,
  repoRoot,
  run,
  searchText,
  slugify,
  writeJson,
} from './ingest-utils.mjs';

const args = parseArgs();
const stageDir = path.resolve(repoRoot, args.stage || process.env.ATRIUM_INGEST_DIR || defaultStageDir);
const inputPath = path.resolve(repoRoot, args.input || path.join(stageDir, 'fetched.json'));
const reportPath = path.resolve(repoRoot, args.report || path.join(stageDir, 'last-report.md'));
const reportJsonPath = path.resolve(repoRoot, args['report-json'] || path.join(stageDir, 'last-report.json'));
const newSlugsPath = path.resolve(repoRoot, args['new-slugs'] || path.join(stageDir, 'new-slugs.txt'));
const sourceArchive = path.resolve(repoRoot, args['source-archive'] || process.env.SOURCE_ATRIUM_DIR || path.join(stageDir, 'source-archive'));
const targetFaces = Number(args['target-faces'] || process.env.ATRIUM_PREVIEW_TARGET_FACES || 400000);
const skipAssets = Boolean(args['skip-assets']);
const dryRun = Boolean(args['dry-run']);
const maxAlternateBytes = Number(args['max-alternate-bytes'] || process.env.ATRIUM_MAX_ALTERNATE_BYTES || 700_000_000);

function pythonCommand() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = path.join(repoRoot, '.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

function posixJoin(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function formatIntegrity(integrity) {
  if (!integrity) return 'unknown';
  return `faces=${integrity.faces ?? '?'} ncomp=${integrity.ncomp ?? '?'} bratio=${integrity.bratio ?? '?'}`;
}

function badIntegrity(integrity) {
  if (!integrity) return true;
  if (!Number.isFinite(Number(integrity.faces)) || Number(integrity.faces) <= 0) return true;
  if (Number(integrity.ncomp) > 50) return true;
  if (Number(integrity.bratio) > 0.3) return true;
  if (Number(integrity.largest_frac) && Number(integrity.largest_frac) < 0.5) return true;
  return false;
}

async function proposeOrientation(sourcePath, slug) {
  const result = await run(pythonCommand(), ['scripts/auto_orient.py', sourcePath, '--slug', slug], { capture: true });
  return JSON.parse(result.stdout);
}

async function maybeRetryAlternate(candidate, firstProposal, report) {
  if (!badIntegrity(firstProposal.integrity)) return { candidate, proposal: firstProposal };
  const alternates = candidate.alternate_downloads || [];
  if (!alternates.length) return { candidate, proposal: firstProposal };

  for (const alternate of alternates) {
    const size = Number(alternate.sizeBytes || alternate.file_size || 0);
    if (size && size > maxAlternateBytes) {
      report.warnings.push({ slug: candidate.slug, reason: `alternate too large to retry automatically: ${size} bytes` });
      continue;
    }
    const ext = path.extname(new URL(alternate.url).pathname).toLowerCase() || `.${alternate.format || 'stl'}`;
    const dest = path.join(stageDir, 'sources', candidate.slug, `${slugify(candidate.title)}_alternate${ext}`);
    try {
      const downloaded = await downloadFile(alternate.url, dest);
      const proposal = await proposeOrientation(dest, candidate.slug);
      if (!badIntegrity(proposal.integrity)) {
        const next = {
          ...candidate,
          fetched: {
            ...candidate.fetched,
            local_source_path: relativeToRepo(dest),
            filename: path.basename(dest),
            format: ext.replace('.', ''),
            bytes: await fileSize(dest),
            sha256: downloaded.sha256,
            retried_from_alternate: true,
          },
        };
        report.warnings.push({ slug: candidate.slug, reason: 'small/source candidate failed integrity; accepted alternate download' });
        return { candidate: next, proposal };
      }
      report.warnings.push({ slug: candidate.slug, reason: `alternate also failed integrity: ${formatIntegrity(proposal.integrity)}` });
    } catch (error) {
      report.warnings.push({ slug: candidate.slug, reason: `alternate retry failed: ${error.message}` });
    }
  }
  return { candidate, proposal: firstProposal };
}

function catalogEntry(candidate, archiveRel, sizeBytes) {
  const yearSort = candidate.year_sort ?? null;
  const entry = {
    slug: candidate.slug,
    collection: candidate.collection || candidate.slug.split('/')[0],
    title: candidate.title,
    artist: candidate.artist || '',
    year: candidate.year || '',
    year_sort: yearSort,
    material: candidate.material || '',
    museum: candidate.museum || '',
    displayed_at: candidate.displayed_at || '',
    source_institution: candidate.source_institution || '',
    source_url: candidate.source_url || '',
    source_record_url: candidate.source_record_url || '',
    license: candidate.license || '',
    license_url: candidate.license_url || '',
    attribution: candidate.attribution || candidate.scan_author || '',
    accession: candidate.accession || '',
    scan_author: candidate.scan_author || '',
    scan_source: candidate.scan_source || '',
    note: candidate.note || '',
    dimensions: candidate.dimensions || '',
    tier: 3,
    license_tier: candidate.license_tier || licenseTier(`${candidate.license || ''} ${candidate.license_url || ''}`),
    ingested: new Date().toISOString().slice(0, 10),
    index: 0,
    total: 0,
    period: candidate.period || periodFor(yearSort),
    model: {
      sourcePath: archiveRel,
      format: candidate.fetched?.format || candidate.download_format || path.extname(archiveRel).replace('.', ''),
      sizeBytes,
    },
  };
  entry.search = searchText(entry);
  return entry;
}

async function generateAssets(slugs) {
  if (skipAssets || !slugs.length) return;
  const env = { SOURCE_ATRIUM_DIR: sourceArchive };
  await run(pythonCommand(), [
    'scripts/generate-previews.py',
    '--source',
    sourceArchive,
    '--target-faces',
    String(targetFaces),
    '--limit',
    String(slugs.length),
    ...slugs.flatMap((slug) => ['--slug', slug]),
  ], { env });
  await run('node', ['scripts/generate-posters.mjs']);
}

function orientationForJson(proposal) {
  return {
    upAxis: proposal.upAxis || 'auto',
    modelRotation: proposal.modelRotation || [0, 0, 0],
    yaw: proposal.yaw || 0,
    status: 'auto',
    confidence: proposal.confidence ?? 0,
    note: proposal.reason || 'Automated orientation proposal.',
  };
}

function markdownReport(report) {
  const lines = [
    '# Atrium Auto Ingest Report',
    '',
    `Generated: ${report.generated_at}`,
    `Accepted: ${report.accepted.length}`,
    `Rejected: ${report.rejected.length}`,
    `Needs orientation: ${report.needs_orientation.length}`,
    '',
  ];

  if (report.accepted.length) {
    lines.push('## Accepted Pieces', '');
    lines.push('| Piece | Source | License | Tri-count | Integrity | Orientation |');
    lines.push('| --- | --- | --- | ---: | --- | --- |');
    for (const item of report.accepted) {
      lines.push(`| ${item.title} (\`${item.slug}\`) | [source](${item.source_url}) | ${item.license} | ${item.tri_count || 'unknown'} | ${item.integrity} | ${item.orientation} |`);
    }
    lines.push('');
  }

  if (report.needs_orientation.length) {
    lines.push('## Needs Orientation Review', '');
    lines.push('| Piece | Proposed value | Confidence | Reason |');
    lines.push('| --- | --- | ---: | --- |');
    for (const item of report.needs_orientation) {
      lines.push(`| ${item.title} (\`${item.slug}\`) | \`${item.proposed}\` | ${item.confidence} | ${item.reason} |`);
    }
    lines.push('');
  }

  if (report.rejected.length) {
    lines.push('## Rejected', '');
    lines.push('| Piece | Source | Reason | Integrity |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of report.rejected) {
      lines.push(`| ${item.title || item.slug} | ${item.source || ''} | ${item.reason} | ${item.integrity || ''} |`);
    }
    lines.push('');
  }

  if (report.warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${warning.slug || 'batch'}: ${warning.reason}`);
    lines.push('');
  }

  lines.push('## Per-piece Provenance', '');
  for (const item of report.accepted) {
    lines.push(`- \`${item.slug}\`: subject=${item.subject || 'unknown'}; author=${item.scan_author || item.attribution || 'unknown'}; accession=${item.accession || 'unknown'}; displayed_at=${item.displayed_at || 'unknown'}; dimensions=${item.dimensions || 'unknown'}.`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const input = await readJson(inputPath, { candidates: [] });
let candidates = input.candidates || [];
if (args.slugs) {
  const wanted = new Set(String(args.slugs).split(',').map((slug) => slug.trim()).filter(Boolean));
  candidates = candidates.filter((candidate) => wanted.has(candidate.slug));
}

const catalog = await loadCatalog();
const orientations = await readJson(orientationsPath, {});
const indexes = catalogIndexes(catalog);
const report = {
  schema: 'atrium-auto-ingest-report/1',
  generated_at: new Date().toISOString(),
  accepted: [],
  rejected: [],
  needs_orientation: [],
  warnings: [],
};
const additions = [];
const acceptedSlugs = [];

if (!candidates.length) {
  await writeJson(reportJsonPath, report);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(path.dirname(newSlugsPath), { recursive: true });
  await writeFile(newSlugsPath, '');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(reportPath, markdownReport(report)));
  console.log('No fetched candidates to assemble.');
  process.exit(0);
}

for (const originalCandidate of candidates) {
  let candidate = originalCandidate;
  const knownBy = candidateIsKnown(candidate, indexes);
  if (knownBy) {
    report.rejected.push({ slug: candidate.slug, title: candidate.title, source: candidate.source, reason: `already in catalog by ${knownBy}` });
    continue;
  }
  const sourcePath = path.resolve(repoRoot, candidate.fetched?.local_source_path || '');
  if (!candidate.fetched?.local_source_path || !existsSync(sourcePath)) {
    report.rejected.push({ slug: candidate.slug, title: candidate.title, source: candidate.source, reason: 'fetched source file missing' });
    continue;
  }

  let proposal;
  try {
    proposal = await proposeOrientation(sourcePath, candidate.slug);
    const retry = await maybeRetryAlternate(candidate, proposal, report);
    candidate = retry.candidate;
    proposal = retry.proposal;
  } catch (error) {
    report.rejected.push({ slug: candidate.slug, title: candidate.title, source: candidate.source, reason: `orientation/integrity failed: ${error.message}` });
    continue;
  }

  if (badIntegrity(proposal.integrity)) {
    report.rejected.push({
      slug: candidate.slug,
      title: candidate.title,
      source: candidate.source,
      reason: 'geometry failed integrity gate',
      integrity: formatIntegrity(proposal.integrity),
    });
    continue;
  }

  const currentSourcePath = path.resolve(repoRoot, candidate.fetched.local_source_path);
  const archiveRel = posixJoin(candidate.slug, candidate.fetched.filename || path.basename(currentSourcePath));
  const archiveAbs = path.join(sourceArchive, archiveRel);
  if (!dryRun) {
    await mkdir(path.dirname(archiveAbs), { recursive: true });
    await copyFile(currentSourcePath, archiveAbs);
  }
  const sizeBytes = await fileSize(currentSourcePath);
  const entry = catalogEntry(candidate, archiveRel, sizeBytes);
  additions.push(entry);
  acceptedSlugs.push(candidate.slug);
  indexes.bySlug.add(candidate.slug);
  indexes.bySource.add(clean(candidate.source_url).toLowerCase());
  indexes.byAccession.add(clean(candidate.accession).toLowerCase());

  const orientationValue = JSON.stringify({
    upAxis: proposal.upAxis,
    modelRotation: proposal.modelRotation,
    yaw: proposal.yaw || 0,
  });
  const acceptedReport = {
    slug: candidate.slug,
    title: candidate.title,
    source: candidate.source,
    source_url: candidate.source_url,
    subject: candidate.subject,
    scan_author: candidate.scan_author,
    attribution: candidate.attribution,
    accession: candidate.accession,
    displayed_at: candidate.displayed_at,
    dimensions: candidate.dimensions,
    license: candidate.license,
    tri_count: proposal.integrity?.faces || candidate.face_count || '',
    integrity: formatIntegrity(proposal.integrity),
    orientation: proposal.flag === 'auto' ? `auto ${orientationValue} confidence=${proposal.confidence}` : 'NEEDS ORIENTATION',
  };
  report.accepted.push(acceptedReport);

  if (proposal.flag === 'auto') {
    orientations[candidate.slug] = orientationForJson(proposal);
  } else {
    report.needs_orientation.push({
      slug: candidate.slug,
      title: candidate.title,
      proposed: orientationValue,
      confidence: proposal.confidence ?? 0,
      reason: proposal.reason || 'Auto orientation marked this as review.',
    });
  }
}

if (!dryRun && additions.length) {
  catalog.push(...additions);
  catalog.forEach((entry, index) => {
    entry.index = index + 1;
    entry.total = catalog.length;
  });
  await writeJson(catalogPath, catalog);
  await writeJson(orientationsPath, orientations);
  await generateAssets(acceptedSlugs);
  const previews = await readJson(previewsPath, {});
  for (const slug of acceptedSlugs) {
    const previewPath = path.join(repoRoot, 'public/models/previews', slug, 'preview.glb');
    if (existsSync(previewPath) && !previews[slug]) {
      previews[slug] = {
        url: `/models/previews/${slug}/preview.glb`,
        bytes: await fileSize(previewPath),
        sourceBytes: additions.find((item) => item.slug === slug)?.model?.sizeBytes || 0,
        sourceFormat: additions.find((item) => item.slug === slug)?.model?.format || '',
        faces: null,
        sourceFaces: null,
      };
    }
  }
  await writeJson(previewsPath, previews);
}

await writeJson(reportJsonPath, report);
await mkdir(path.dirname(reportPath), { recursive: true });
await mkdir(path.dirname(newSlugsPath), { recursive: true });
await writeFile(newSlugsPath, acceptedSlugs.length ? `${acceptedSlugs.join('\n')}\n` : '');
await import('node:fs/promises').then(({ writeFile }) => writeFile(reportPath, markdownReport(report)));

console.log(`Accepted ${report.accepted.length}; rejected ${report.rejected.length}; needs orientation ${report.needs_orientation.length}.`);
console.log(`Wrote ${newSlugsPath}`);
console.log(`Wrote ${reportPath}`);
