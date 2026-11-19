import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stageFrontend } = require('../electron/frontend-staging.js');
const { serve } = require('../electron/site-server.js');

test('frontend snapshots preserve old content across updates and failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-frontend-'));
  const source = path.join(root, 'bundled'), cache = path.join(root, 'cache');
  fs.mkdirSync(path.join(source, 'static'), { recursive: true });
  const index = path.join(source, 'index.html');
  const asset = path.join(source, 'static', 'app.js');
  fs.writeFileSync(index, 'old index');
  fs.writeFileSync(asset, 'first');
  try {
    const first = stageFrontend(source, cache);
    assert.equal(stageFrontend(source, cache), first);
    const timestamp = fs.statSync(asset).mtime;
    fs.writeFileSync(asset, 'other');
    fs.utimesSync(asset, timestamp, timestamp);
    fs.writeFileSync(index, 'new index');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      if (String(file).endsWith(path.join('static', 'app.js'))) throw Error('injected failure');
      return originalWrite.call(this, file, ...args);
    };
    try { assert.throws(() => stageFrontend(source, cache), /injected failure/); }
    finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.readFileSync(path.join(first, 'index.html'), 'utf8'), 'old index');
    assert.equal(fs.readFileSync(path.join(first, 'static', 'app.js'), 'utf8'), 'first');
    const second = stageFrontend(source, cache);
    assert.notEqual(first, second);
    assert.equal(fs.readFileSync(path.join(second, 'static', 'app.js'), 'utf8'), 'other');
    fs.unlinkSync(path.join(second, '.complete'));
    assert.notEqual(stageFrontend(source, cache), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop server overlays frontend and preserves library resources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-overlay-'));
  const source = path.join(root, 'source'), site = path.join(root, 'site');
  fs.mkdirSync(path.join(source, 'static'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), 'frontend');
  fs.writeFileSync(path.join(source, 'static', 'app.js'), 'script');
  fs.writeFileSync(path.join(site, 'index.html'), 'old');
  fs.writeFileSync(path.join(site, 'data', 'library.json'), 'library');
  const frontend = stageFrontend(source, path.join(root, 'cache'));
  const server = await serve(site, { frontend });
  try {
    for (const [name, expected] of [['', 'frontend'], ['static/app.js', 'script'], ['data/library.json', 'library']]) {
      const response = await fetch(new URL(name, server.url));
      assert.equal(await response.text(), expected);
    }
    assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'old');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
