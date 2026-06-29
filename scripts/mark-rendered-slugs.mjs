#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultStageDir, parseArgs, readJson, rendersPath, repoRoot, writeJson } from './ingest-utils.mjs';

const args = parseArgs();
const stageDir = path.resolve(repoRoot, args.stage || process.env.ATRIUM_INGEST_DIR || defaultStageDir);
const inputPath = path.resolve(repoRoot, args.input || path.join(stageDir, 'new-slugs.txt'));

async function readSlugs() {
  if (!existsSync(inputPath)) return [];
  const text = await readFile(inputPath, 'utf8');
  return text.split(/\r?\n/).map((slug) => slug.trim()).filter(Boolean);
}

const slugs = await readSlugs();
if (!slugs.length) {
  console.log('No rendered slugs to mark.');
  process.exit(0);
}

const missing = [];
for (const slug of slugs) {
  const thumb = path.join(repoRoot, 'public/previews/renders', slug, 'thumb.webp');
  if (!existsSync(thumb)) missing.push(slug);
}

if (missing.length) {
  console.error('Missing rendered thumbnails:');
  for (const slug of missing) console.error(`  - ${slug}`);
  process.exit(1);
}

const ordered = await readJson(rendersPath, []);
const existing = new Set(ordered);
for (const slug of slugs) {
  if (!existing.has(slug)) {
    ordered.push(slug);
    existing.add(slug);
  }
}

await writeJson(rendersPath, ordered);
console.log(`Marked ${slugs.length} rendered slug(s) in src/data/renders.json.`);
