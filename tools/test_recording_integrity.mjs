import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {spawnManaged, stopManaged, cleanupProcesses} from './recording_processes.mjs';
import {cachedExtraction} from './recording_cache.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(20);
  }
  assert.fail('Fixture did not reach the expected state before its deadline');
}
function running(pid) {
  try { process.kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // An orphan may briefly be a zombie until the platform init process reaps it.
  if (process.platform !== 'win32') {
    try {
      return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding: 'utf8'}).trim().startsWith('Z');
    } catch (_) { return false; }
  }
  return true;
}
function treeScript(pidFile, {exitLeader = false} = {}) {
  const descendant = `process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000);`;
  return `const {spawn}=require('node:child_process'),fs=require('node:fs');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],
      {stdio:['ignore',process.stdout,process.stderr,'ipc']});
    child.once('message',pid=>{fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({leader:process.pid,child:pid}));
      ${exitLeader ? 'process.exit(0);' : ''}});
    setInterval(()=>{},1000);`;
}
async function treeCase(options, action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-process-test-'));
  const pidFile = path.join(root, 'pids.json');
  const child = spawnManaged(process.execPath, ['-e', treeScript(pidFile, options)], {
    timeoutMs: options.timeoutMs || 0, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  let pids;
  try {
    await until(() => fs.existsSync(pidFile));
    pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    await action(child, pids);
  } finally {
    await stopManaged(child, {graceMs: 20});
    // Only fixture PIDs are touched if a broken implementation leaves orphans.
    if (pids) for (const pid of Object.values(pids)) {
      if (running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test('explicit cancellation reaps the owned process tree and leaves unrelated processes alive', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  try {
    await treeCase({}, async (child, pids) => {
      await stopManaged(child, {graceMs: 40});
      await until(() => !running(pids.leader) && !running(pids.child));
      assert(running(other.pid), 'unrelated child must not be signalled');
    });
  } finally { other.kill('SIGKILL'); }
});

test('a managed deadline terminates descendants that ignore SIGTERM', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  await treeCase({timeoutMs: 600}, async (child, pids) => {
    await until(() => !running(pids.leader) && !running(pids.child));
    await stopManaged(child);
  });
});

test('normal leader exit reclaims descendants holding inherited stdout open', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  await treeCase({exitLeader: true}, async (child, pids) => {
    await until(() => !running(pids.child));
    await stopManaged(child);
    assert.equal(child.exitCode, 0);
  });
});

test('a recording worker handles SIGTERM and cleans its non-detached owned subprocesses', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-cancel-test-'));
  const pidFile = path.join(root, 'child.pid');
  const manager = new URL('./recording_processes.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs';import {spawnManaged,installProcessCleanup} from ${JSON.stringify(manager)};
    installProcessCleanup();
    const child=spawnManaged(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:0,stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const worker = spawnManaged(process.execPath, ['--input-type=module', '-e', script], {
    timeoutMs: 0, env: {...process.env, JUBEAT_RECORD_GROUP: '1'}, stdio: 'ignore',
  });
  let descendant;
  try {
    await until(() => fs.existsSync(pidFile));
    descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    worker.kill('SIGTERM');
    await until(() => worker.exitCode !== null && !running(descendant));
    assert.equal(worker.exitCode, 143);
  } finally {
    await stopManaged(worker, {graceMs: 20});
    if (descendant && running(descendant)) { try { process.kill(descendant, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('managed spawn failure and normal completion leave cleanup safe', async () => {
  const missing = spawnManaged('/nonexistent-jubeat-test-executable', [], {timeoutMs: 50, stdio: 'ignore'});
  const error = await new Promise(resolve => missing.once('error', resolve));
  assert.equal(error.code, 'ENOENT');
  await stopManaged(missing);
  await cleanupProcesses();
});

test('audio extraction refreshes for source changes despite preserved timestamps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-cache-test-'));
  const source = path.join(root, 'song.mcz'), dest = path.join(root, 'bgm.ogg');
  try {
    fs.writeFileSync(source, Buffer.alloc(6000, 'a'));
    fs.writeFileSync(dest, Buffer.alloc(5000, 'x')); // Legacy cache has no identity.
    const stamp = fs.statSync(source).mtime;
    let calls = 0;
    const extract = async () => { calls++; return fs.readFileSync(source); };
    await cachedExtraction(source, dest, extract);
    assert.equal(calls, 1);
    await cachedExtraction(source, dest, extract);
    assert.equal(calls, 1);
    fs.writeFileSync(source, Buffer.alloc(6000, 'b'));
    fs.utimesSync(source, stamp, stamp);
    await cachedExtraction(source, dest, extract);
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(dest)[0], 'b'.charCodeAt(0));
    fs.writeFileSync(dest, Buffer.alloc(6000, 'x'));
    await cachedExtraction(source, dest, extract);
    assert.equal(calls, 3, 'corrupted output is not accepted by a valid source sidecar');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('failed or changing-source extraction preserves the previous complete audio', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-cache-fail-'));
  const source = path.join(root, 'song.mcz'), dest = path.join(root, 'bgm.ogg');
  try {
    fs.writeFileSync(source, Buffer.alloc(6000, 'a'));
    fs.writeFileSync(dest, Buffer.alloc(5000, 'x'));
    await assert.rejects(cachedExtraction(source, dest, async () => { throw Error('decode failed'); }));
    await assert.rejects(cachedExtraction(source, dest, async () => {
      fs.writeFileSync(source, Buffer.alloc(6000, 'b'));
      return Buffer.alloc(6000, 'a');
    }), /源曲包已变化/);
    assert.equal(fs.readFileSync(dest)[0], 'x'.charCodeAt(0));
    assert.equal(fs.readdirSync(root).filter(name => name.includes('.tmp-')).length, 0);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('cache metadata cannot certify bytes replaced by another writer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-cache-race-'));
  const source = path.join(root, 'song.mcz'), dest = path.join(root, 'bgm.ogg');
  const rename = fs.renameSync;
  try {
    fs.writeFileSync(source, Buffer.alloc(6000, 'a'));
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === dest) fs.writeFileSync(dest, Buffer.alloc(6000, 'b'));
    };
    await cachedExtraction(source, dest, async () => Buffer.alloc(6000, 'a'));
    fs.renameSync = rename;
    let calls = 0;
    await cachedExtraction(source, dest, async () => { calls++; return Buffer.alloc(6000, 'a'); });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(dest)[0], 'a'.charCodeAt(0));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
