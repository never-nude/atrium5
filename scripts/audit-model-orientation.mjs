import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import catalog from '../src/data/catalog.json' with { type: 'json' };
import orientations from '../src/data/orientations.json' with { type: 'json' };
import { applyModelTransform, normalizeModel, parseModelTransform } from '../public/model-render-utils.js';

globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class ProgressEvent extends Event {};
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => {
  if (String(args[0] || '').includes("Couldn't load texture")) return;
  originalWarn(...args);
};
console.error = (...args) => {
  if (String(args[0] || '').includes("Couldn't load texture")) return;
  originalError(...args);
};

const root = resolve('.');
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

const RECUMBENT = /\b(lying|reclining|recumbent|sleeping|fallen|wounded|dead|danaid|barberini faun)\b/i;
const PEDIMENT_LOW = /\b(pediment|kneeling|crouching|seated|sitting|squatting)\b/i;
const EXCLUDED = /\b(relief|frieze|stele|sarcophagus|capital|corbel|lintel|voussoir|block|panel|plaque|tondo|medallion|bust|head|portrait|torso|fragment|mask|helmet|bowl|ewer|box|vessel|shield|obelisk|post|pole|gong|horse head)\b/i;
const STANDING = /\b(standing|standing buddha|statue|figure|kore|kouros|athena|apollo|aphrodite|venus|david|madonna|saint|warrior|priest|pharaoh|kaaper|nefertiti|doryphoros|diadoumenos|herakles|hercules|hermes|diana|hebe|vulcan|ganymede|germanicus|augustus|perseus|john the baptist)\b/i;

function loadGlb(file) {
  const buffer = readFileSync(file);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolveLoad, rejectLoad) => {
    loader.parse(arrayBuffer, '', resolveLoad, rejectLoad);
  });
}

function removeScanHelpers(model) {
  const helpers = [];
  model.traverse((obj) => {
    if (/^(?:cubo|disco)(?:_|\.|$)/i.test(obj.name || '') || /^(?:cubo|disco)(?:_|\.|$)/i.test(obj.material?.name || '')) helpers.push(obj);
  });
  for (const helper of helpers) helper.parent?.remove(helper);
}

function sizeFor(box) {
  return box.getSize(new THREE.Vector3());
}

function axisFor(size) {
  const values = [
    ['X', size.x],
    ['Y', size.y],
    ['Z', size.z],
  ].sort((a, b) => b[1] - a[1]);
  return values[0][0];
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '';
}

function dims(size) {
  return `${fmt(size.x)} x ${fmt(size.y)} x ${fmt(size.z)}`;
}

function textFor(record) {
  return [
    record.title,
    record.slug,
    record.artist,
    record.material,
    record.note,
    record.search,
  ].filter(Boolean).join(' ');
}

function subjectType(record) {
  const text = textFor(record);
  if (RECUMBENT.test(text)) return 'recumbent';
  if (PEDIMENT_LOW.test(text)) return 'low/pediment';
  if (EXCLUDED.test(text)) return 'excluded-fragment';
  if (STANDING.test(text)) return 'standing-figure';
  return 'general';
}

function statusFor(record, rawSize, viewSize, transform) {
  const subject = subjectType(record);
  const horizontal = Math.max(viewSize.x, viewSize.z);
  const verticalRatio = horizontal ? viewSize.y / horizontal : 1;
  const flatAfterTransform = verticalRatio < 0.68;
  const hasExplicitRotation = transform.modelRotation.some((value) => value !== 0) || transform.upAxis === 'x';

  if (subject === 'recumbent' || subject === 'low/pediment') {
    return {
      subject,
      status: 'left-as-is',
      reason: subject === 'recumbent' ? 'title/metadata implies recumbency' : 'kneeling/crouching/pediment figure',
    };
  }

  if (subject === 'excluded-fragment') {
    return { subject, status: 'left-as-is', reason: 'excluded object type' };
  }

  if (subject === 'standing-figure' && flatAfterTransform) {
    return {
      subject,
      status: hasExplicitRotation ? 'rotated' : 'candidate',
      reason: `standing subject but transformed Y/horizontal ratio is ${verticalRatio.toFixed(2)}`,
    };
  }

  if (flatAfterTransform && subject === 'general') {
    return {
      subject,
      status: 'ambiguous',
      reason: `flat geometry but title is not a confident standing figure; raw up ${axisFor(rawSize)}`,
    };
  }

  if (hasExplicitRotation) {
    return { subject, status: 'rotated', reason: 'explicit model transform applied' };
  }

  return { subject, status: 'upright/ok', reason: 'bounds fit current orientation' };
}

function transformLabel(transform) {
  const rotation = transform.modelRotation.some((value) => value !== 0)
    ? ` rot=[${transform.modelRotation.join(',')}]`
    : '';
  const fit = transform.fit ? ` fit=${transform.fit}` : '';
  const yaw = transform.yaw ? ` yaw=${transform.yaw}` : '';
  return `${transform.upAxis}${fit}${yaw}${rotation}`;
}

const rows = [];
for (const record of catalog) {
  const file = join(root, 'public/models/previews', record.slug, 'preview.glb');
  if (!existsSync(file)) continue;

  const gltf = await loadGlb(file);
  const model = gltf.scene;
  removeScanHelpers(model);

  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = sizeFor(rawBox);
  const transform = parseModelTransform(orientations[record.slug] || 'auto');
  applyModelTransform(THREE, model, transform);
  const normalized = normalizeModel(THREE, model);
  const viewBox = normalized.box;
  const viewSize = normalized.size;
  const audit = statusFor(record, rawSize, viewSize, transform);
  const restsOnGround = Math.abs(viewBox.min.y + viewSize.y / 2) < 0.005 ? 'yes' : 'check';

  rows.push({
    slug: record.slug,
    title: record.title,
    subject: audit.subject,
    rawDims: dims(rawSize),
    rawUp: axisFor(rawSize),
    transform: transformLabel(transform),
    viewDims: dims(viewSize),
    restsOnGround,
    status: audit.status,
    reason: audit.reason,
  });
}

const wanted = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
const filtered = wanted.size ? rows.filter((row) => wanted.has(row.slug)) : rows;
const showAll = process.argv.includes('--all') || !wanted.size;
const outputRows = showAll ? filtered : filtered.filter((row) => row.status !== 'upright/ok');

console.log('| slug | subject | raw XYZ | raw up | transform | viewer XYZ | ground | status | reason |');
console.log('| --- | --- | ---: | --- | --- | ---: | --- | --- | --- |');
for (const row of outputRows) {
  console.log(`| ${row.slug} | ${row.subject} | ${row.rawDims} | ${row.rawUp} | ${row.transform} | ${row.viewDims} | ${row.restsOnGround} | ${row.status} | ${row.reason} |`);
}

const counts = rows.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] || 0) + 1;
  return acc;
}, {});
console.log('');
console.log(`Total audited: ${rows.length}`);
console.log(`Rotated: ${counts.rotated || 0}`);
console.log(`Left as-is: ${counts['left-as-is'] || 0}`);
console.log(`Flagged candidates: ${counts.candidate || 0}`);
console.log(`Flagged ambiguous: ${counts.ambiguous || 0}`);
