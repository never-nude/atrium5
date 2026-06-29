#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  clean,
  defaultStageDir,
  downloadFile,
  fileSize,
  meshExtensionFromUrl,
  parseArgs,
  readJson,
  relativeToRepo,
  removePath,
  repoRoot,
  run,
  sanitizeFilename,
  slugify,
  writeJson,
} from './ingest-utils.mjs';

const args = parseArgs();
const stageDir = path.resolve(repoRoot, args.stage || process.env.ATRIUM_INGEST_DIR || defaultStageDir);
const inputPath = path.resolve(repoRoot, args.input || path.join(stageDir, 'candidates.json'));
const outPath = path.resolve(repoRoot, args.out || path.join(stageDir, 'fetched.json'));
const sourceRoot = path.join(stageDir, 'sources');
const limit = Number(args.limit || process.env.ATRIUM_INGEST_LIMIT || 0);

const meshExtensions = new Set(['.stl', '.obj', '.ply', '.glb', '.gltf', '.fbx', '.usdz']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function resolveSketchfabDownload(candidate) {
  if (candidate.download_url) return candidate.download_url;
  if (!candidate.download_api_url) return '';
  const token = process.env.SKETCHFAB_TOKEN || process.env.SKETCHFAB_API_TOKEN || '';
  if (!token) throw new Error('SKETCHFAB_TOKEN required for Sketchfab downloads');
  const response = await fetch(candidate.download_api_url, {
    headers: { Authorization: `Token ${token}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Sketchfab download API ${response.status} ${response.statusText}`);
  const payload = await response.json();
  return clean(payload.glb?.url || payload.gltf?.url || payload.source?.url);
}

async function extractZip(zipPath, destDir) {
  await removePath(destDir);
  await mkdir(destDir, { recursive: true });
  await run('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  const files = (await walk(destDir)).filter((file) => meshExtensions.has(path.extname(file).toLowerCase()));
  if (!files.length) throw new Error(`no mesh file found after extracting ${zipPath}`);
  let best = files[0];
  let bestSize = await fileSize(best);
  for (const file of files.slice(1)) {
    const size = await fileSize(file);
    if (size > bestSize) {
      best = file;
      bestSize = size;
    }
  }
  return best;
}

async function fileContains(file, needles) {
  const buffer = await readFile(file);
  const text = buffer.toString('latin1');
  return needles.some((needle) => text.includes(needle));
}

async function decodeGlbIfNeeded(file, candidate, report) {
  if (!['.glb', '.gltf'].includes(path.extname(file).toLowerCase())) return { file, decoded: false };
  const declaredCompressed = candidate.compressed || candidate.gltf_orientation_compliant === false;
  const embeddedCompressed = await fileContains(file, ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']);
  if (!declaredCompressed && !embeddedCompressed) return { file, decoded: false };

  const decoded = file.replace(/\.(glb|gltf)$/i, '_decoded.glb');
  const attempts = [
    ['npx', ['--yes', '@gltf-transform/cli', 'copy', file, decoded]],
    ['npx', ['--yes', '@gltf-transform/cli', 'cp', file, decoded]],
  ];
  for (const [cmd, cmdArgs] of attempts) {
    try {
      await run(cmd, cmdArgs);
      if (existsSync(decoded)) return { file: decoded, decoded: true };
    } catch (error) {
      report.warnings.push({ slug: candidate.slug, step: 'decode', command: `${cmd} ${cmdArgs.join(' ')}`, reason: error.message });
    }
  }
  report.warnings.push({ slug: candidate.slug, step: 'decode', reason: 'leaving compressed GLB in place after decode attempts failed' });
  return { file, decoded: false };
}

function sourceFilename(candidate, url) {
  const ext = meshExtensionFromUrl(url, candidate.download_format ? `.${candidate.download_format}` : '.glb');
  const fromUrl = sanitizeFilename(new URL(url).pathname.split('/').pop() || '');
  if (path.extname(fromUrl)) return fromUrl;
  return `${slugify(candidate.title || candidate.slug)}_source${ext}`;
}

async function fetchCandidate(candidate, report) {
  const slugDir = path.join(sourceRoot, candidate.slug);
  await mkdir(slugDir, { recursive: true });
  const url = clean(await resolveSketchfabDownload(candidate));
  if (!url) throw new Error('no download URL');
  const filename = sourceFilename(candidate, url);
  const downloadPath = path.join(slugDir, filename);
  const downloaded = await downloadFile(url, downloadPath);
  let sourcePath = downloadPath;
  let extractedFrom = '';

  if (path.extname(downloadPath).toLowerCase() === '.zip') {
    extractedFrom = downloadPath;
    sourcePath = await extractZip(downloadPath, path.join(slugDir, 'extracted'));
  }

  const decoded = await decodeGlbIfNeeded(sourcePath, candidate, report);
  sourcePath = decoded.file;

  const finalName = `${slugify(candidate.title || candidate.slug)}_source${path.extname(sourcePath).toLowerCase()}`;
  const finalPath = path.join(slugDir, finalName);
  if (sourcePath !== finalPath) {
    await copyFile(sourcePath, finalPath);
    sourcePath = finalPath;
  }

  return {
    ...candidate,
    fetched: {
      download_url: url,
      downloaded_path: relativeToRepo(downloadPath),
      local_source_path: relativeToRepo(sourcePath),
      filename: path.basename(sourcePath),
      format: path.extname(sourcePath).replace('.', '').toLowerCase(),
      bytes: await fileSize(sourcePath),
      original_download_bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      content_type: downloaded.contentType,
      decoded: decoded.decoded,
      extracted_from: extractedFrom ? relativeToRepo(extractedFrom) : '',
      fetched_at: new Date().toISOString(),
    },
  };
}

const input = await readJson(inputPath, { candidates: [] });
const candidates = (input.candidates || []).slice(0, limit || undefined);
const report = { generated_at: new Date().toISOString(), fetched: [], errors: [], warnings: [] };
const fetched = [];

if (!candidates.length) {
  await writeJson(outPath, {
    schema: 'atrium-auto-ingest-fetched/1',
    generated_at: report.generated_at,
    candidates: [],
    report,
  });
  console.log('No candidates to fetch.');
  process.exit(0);
}

for (const candidate of candidates) {
  try {
    const next = await fetchCandidate(candidate, report);
    fetched.push(next);
    report.fetched.push({ slug: candidate.slug, source: candidate.source, bytes: next.fetched.bytes });
    console.log(`Fetched ${candidate.slug}: ${next.fetched.local_source_path}`);
  } catch (error) {
    report.errors.push({ slug: candidate.slug, source: candidate.source, title: candidate.title, reason: error.message });
    console.warn(`Skipped ${candidate.slug}: ${error.message}`);
  }
}

await writeJson(outPath, {
  schema: 'atrium-auto-ingest-fetched/1',
  generated_at: report.generated_at,
  source_candidates: inputPath,
  candidates: fetched,
  report,
});
console.log(`Fetched ${fetched.length}/${candidates.length} candidates.`);
console.log(`Wrote ${outPath}`);
