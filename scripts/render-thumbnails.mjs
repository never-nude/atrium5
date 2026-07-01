import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import orientations from '../src/data/orientations.json' with { type: 'json' };
import catalog from '../src/data/catalog.json' with { type: 'json' };
import materialAppearances from '../src/data/material-appearances.json' with { type: 'json' };
import appearanceOverrides from '../src/data/appearance-overrides.json' with { type: 'json' };

const root = resolve('.');
const modelRoot = join(root, 'public/models/previews');
const outRoot = join(root, 'public/previews/renders');
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const serverPort = 8099;
const width = 1000;
const height = 1250;
const recordsBySlug = new Map(catalog.map((record) => [record.slug, record]));
const internalNotePatterns = [
  'mesh',
  'source stl',
  'source mesh',
  'viewer uses',
  'viewer basis',
  'museum-style lighting',
  'mobile-friendly controls',
  'post-load rotation',
  'camera unchanged',
  'upright in this viewer',
];

if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}`);

const mime = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.glb', 'model/gltf-binary'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

function walk(dir, prefix = '') {
  const slugs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) slugs.push(...walk(full, rel));
    else if (entry.name === 'preview.glb') slugs.push(prefix);
  }
  return slugs;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text === '-' || text === '—' ? '' : text;
}

function valueKey(value) {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function publicNote(record) {
  const note = clean(record.note);
  if (!note) return '';
  const lower = note.toLowerCase();
  if (internalNotePatterns.some((pattern) => lower.includes(pattern))) return '';
  return note;
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    // Some sandboxed/bridged filesystems disallow unlink/rmdir on mounted dirs.
    // Non-fatal: this only cleans up a scratch Chrome profile dir.
  }
}

function materialsFor(record) {
  const values = new Set();
  const override = clean(materialAppearances.slugOverrides[record.slug]);
  if (override) values.add(override);

  const explicit = clean(record.material);
  if (explicit) {
    for (const item of explicit.split(/[,;/]+/g)) {
      const label = clean(item);
      if (label) values.add(label);
    }
  }

  const text = `${record.title ?? ''} ${record.year ?? ''} ${publicNote(record)}`.toLowerCase();
  const inferred = [
    [/bronze/, 'Bronze'],
    [/marble/, 'Marble'],
    [/limestone/, 'Limestone'],
    [/silver/, 'Silver'],
    [/wood|post|mask|pole|box|drum|gong/, 'Wood'],
    [/terracotta|ceramic|clay/, 'Ceramic'],
    [/stone|stele|relief|sarcophagus|capital|corbel|lintel|voussoir|sphinx/, 'Stone'],
  ];

  for (const [pattern, label] of inferred) {
    if (pattern.test(text)) values.add(label);
  }

  if (!values.size) {
    const fallback = clean(materialAppearances.collectionDefaults[clean(record.collection)]);
    if (fallback) values.add(fallback);
  }

  return [...values];
}

function materialProfileFor(slug, materials) {
  const overrideProfile = clean(appearanceOverrides[slug]?.profile);
  if (overrideProfile && materialAppearances.profiles[overrideProfile]) return overrideProfile;
  for (const material of materials) {
    const key = profileForMaterial(material);
    if (key && materialAppearances.profiles[key]) return key;
  }
  return 'neutral';
}

function profileForMaterial(material) {
  const exact = materialAppearances.materialToProfile[valueKey(material)];
  if (exact) return exact;

  const text = material.toLowerCase();
  if (/black marble/.test(text)) return 'stone';
  if (/marble|ivory/.test(text)) return 'marble';
  if (/plaster|cast/.test(text)) return 'plaster';
  if (/limestone|dolomite/.test(text)) return 'limestone';
  if (/quartzite|metagraywacke|chlorite|diorite|andesite|basalt|sandstone|alabaster|stone/.test(text)) return 'stone';
  if (/silver/.test(text)) return 'silver';
  if (/bronze|brass|copper|gilded|metal/.test(text)) return 'bronze-patina';
  if (/terracotta|ceramic|earthenware|clay/.test(text)) return 'ceramic';
  if (/wood|oak|mahogany|basswood|cottonwood|iroko|guaiacum|barkcloth|bamboo|fiber|fibre|rattan|plant|leaf|leaves|sago|shell|cloth|resin|organic/.test(text)) return 'wood';
  return '';
}

function effectiveAppearanceFor(slug, profileKey) {
  const base = materialAppearances.profiles[profileKey] || materialAppearances.profiles.neutral;
  const { profile: _profile, ...override } = appearanceOverrides[slug] || {};
  return { ...base, ...override };
}

function appearanceForSlug(slug) {
  const record = recordsBySlug.get(slug);
  if (!record) return materialAppearances.profiles.neutral;
  const profileKey = materialProfileFor(slug, materialsFor(record));
  return effectiveAppearanceFor(slug, profileKey);
}

function staticServer() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);
    const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'public/__render.html';
    const file = resolve(root, rawPath);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime.get(extname(file)) || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(serverPort, '127.0.0.1', resolveListen));
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function startChrome() {
  const profile = process.env.CHROME_PROFILE_DIR || join(root, '.tmp/chrome-render-profile');
  removeDir(profile);
  mkdirSync(profile, { recursive: true });

  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-background-networking',
    '--run-all-compositor-stages-before-draw',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--window-size=${width},${height}`,
    ...(process.env.CHROME_EXTRA_ARGS ? process.env.CHROME_EXTRA_ARGS.split(' ') : []),
    'about:blank',
  ];

  const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      return { proc, profile, port, stderr: () => stderr };
    }
    if (proc.exitCode !== null) break;
    await delay(100);
  }

  proc.kill('SIGKILL');
  throw new Error(`Chrome did not expose DevTools. ${stderr}`);
}

async function newPage(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) throw new Error(`Chrome target create failed: ${response.status} ${await response.text()}`);
  const target = await response.json();
  return createCdpClient(target.webSocketDebuggerUrl);
}

async function createCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
    else resolve(message.result || {});
  });

  function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
  }

  return {
    send,
    close() {
      socket.close();
    },
  };
}

async function waitForRender(page, slug) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { result } = await page.send('Runtime.evaluate', {
      expression: "document.body?.dataset.renderReady === 'true' ? 'ready' : (document.body?.dataset.renderError || '')",
      returnByValue: true,
    });
    if (result.value === 'ready') return;
    if (result.value) throw new Error(`${slug} render failed: ${result.value}`);
    await delay(100);
  }
  throw new Error(`${slug} render timed out`);
}

async function render(page, slug, index, total) {
  const transform = orientations[slug] || 'auto';
  const legacyUp = typeof transform === 'string' ? transform : transform.upAxis || transform.axis || 'auto';
  const transformParam = typeof transform === 'string' ? transform : JSON.stringify(transform);
  const appearance = JSON.stringify(appearanceForSlug(slug));
  const outDir = join(outRoot, slug);
  const png = join(outDir, 'thumb.png');
  const webp = join(outDir, 'thumb.webp');
  mkdirSync(outDir, { recursive: true });
  try { rmSync(png, { force: true }); } catch { /* see removeDir() note above */ }

  const model = `/public/models/previews/${slug}/preview.glb`;
  const url = `http://127.0.0.1:${serverPort}/public/__render.html?model=${encodeURIComponent(model)}&up=${encodeURIComponent(legacyUp)}&transform=${encodeURIComponent(transformParam)}&appearance=${encodeURIComponent(appearance)}`;
  await page.send('Page.navigate', { url });
  await waitForRender(page, slug);
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(png, Buffer.from(data, 'base64'));

  await sharp(png).webp({ quality: 90 }).toFile(webp);
  try { rmSync(png, { force: true }); } catch { /* see removeDir() note above */ }
  console.log(`[${index + 1}/${total}] ${slug}`);
}

let slugs = walk(modelRoot).sort();
if (process.env.ONLY) {
  const only = new Set(process.env.ONLY.split(',').map((slug) => slug.trim()).filter(Boolean));
  slugs = slugs.filter((slug) => only.has(slug));
}
if (process.env.LIMIT) slugs = slugs.slice(0, Number(process.env.LIMIT));
if (!slugs.length) throw new Error('No models matched the render request');

const server = staticServer();
let browser;
let page;
await listen(server);
try {
  browser = await startChrome();
  page = await newPage(browser.port, 'about:blank');
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  for (let i = 0; i < slugs.length; i += 1) await render(page, slugs[i], i, slugs.length);
} finally {
  if (page) page.close();
  if (browser) {
    browser.proc.kill('SIGTERM');
    await delay(250);
    if (browser.proc.exitCode === null) browser.proc.kill('SIGKILL');
    await delay(250);
    removeDir(browser.profile);
  }
  await closeServer(server);
}
