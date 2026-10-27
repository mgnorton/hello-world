#!/usr/bin/env node
// Build script (esbuild).
//   node tools/build.mjs            -> dist/ (bundled app + static files + data)
//   node tools/build.mjs --serve    -> build, then serve dist/ on http://localhost:8000 and rebuild on change
//   node tools/build.mjs --tests    -> bundle tests/*.test.ts into dist-tests/ for `node --test`
//   node tools/build.mjs --artifact -> artifact/ folder ready to publish as a claude.ai Artifact
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dist = join(root, 'dist');

const appOptions = {
  entryPoints: [join(root, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari16', 'firefox110'],
  outfile: join(dist, 'app.js'),
  minify: !args.has('--serve'),
  sourcemap: args.has('--serve') ? 'linked' : false,
  logLevel: 'info',
  legalComments: 'none',
};

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, 'public'), dist, { recursive: true });
}

async function buildApp() {
  copyStatic();
  await esbuild.build(appOptions);
}

async function buildTests() {
  const out = join(root, 'dist-tests');
  rmSync(out, { recursive: true, force: true });
  const entries = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => join(root, 'tests', f));
  await esbuild.build({
    entryPoints: entries, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'warning',
    define: { 'import.meta.dirname': JSON.stringify(join(root, 'tests')) },
  });
}

/** Turn dist/ into an Artifact-ready folder: index.html holds page content only (the host adds the skeleton). */
function buildArtifact() {
  const out = join(root, 'artifact');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const css = readFileSync(join(dist, 'css/style.css'), 'utf8');
  const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
  // Keep the Google Fonts links (the only external stylesheet host an Artifact allows).
  const fonts = (html.match(/<link [^>]*fonts\.(googleapis|gstatic)\.com[^>]*>/g) || []).join('\n');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script type="module" src="app.js"><\/script>/, '');
  const page = `${title}\n<meta name="skyline-data" content="base64">\n${fonts}\n<style>\n${css}\n</style>\n${body.trim()}\n<script type="module" src="app.js"></script>\n`;
  writeFileSync(join(out, 'index.html'), page);
  cpSync(join(dist, 'app.js'), join(out, 'app.js'));
  // Artifacts serve web media types only, so binary data ships as base64 text.
  mkdirSync(join(out, 'data'), { recursive: true });
  for (const f of readdirSync(join(dist, 'data'))) {
    const src = join(dist, 'data', f);
    if (f.endsWith('.json')) cpSync(src, join(out, 'data', f));
    else writeFileSync(join(out, 'data', `${f}.b64.txt`), readFileSync(src).toString('base64'));
  }
  const files = readdirSync(join(out, 'data')).map((f) => `data/${f}`);
  console.log('artifact files:', ['app.js', ...files].join(', '));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };

async function serve() {
  const ctx = await esbuild.context(appOptions);
  await ctx.watch();
  const port = Number(process.env.PORT || 8000);
  createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  }).listen(port, () => console.log(`Skyline 737 running at http://localhost:${port}`));
}

if (args.has('--tests')) {
  await buildTests();
} else {
  await buildApp();
  if (args.has('--artifact')) buildArtifact();
  if (args.has('--serve')) await serve();
}
