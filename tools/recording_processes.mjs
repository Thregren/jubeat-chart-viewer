/** Own only subprocesses created by this recording task. */
import {spawn} from 'node:child_process';
const owned = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let installed = false;

function signal(child, entry, name) {
  if (!child.pid) return;
  try {
    if (entry.group) process.kill(-child.pid, name);
    else if (child.exitCode === null && child.signalCode === null) child.kill(name);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export function stopManaged(child, {graceMs = 1500} = {}) {
  const entry = owned.get(child);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  entry.stopping = (async () => {
    clearTimeout(entry.timer);
    signal(child, entry, 'SIGTERM');
    // Wait even if the leader exits first: its descendants may ignore SIGTERM.
    await delay(graceMs);
    signal(child, entry, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      await Promise.race([entry.closed, delay(3000)]);
    }
    owned.delete(child);
  })();
  return entry.stopping;
}

export function spawnManaged(command, argv, options = {}) {
  const {timeoutMs = 1800000, processGroup = true, ...spawnOptions} = options;
  const group = process.platform !== 'win32' && processGroup && process.env.JUBEAT_RECORD_GROUP !== '1';
  const child = spawn(command, argv, {...spawnOptions, detached: group});
  let closed;
  const entry = {group, closed: new Promise(resolve => { closed = resolve; })};
  owned.set(child, entry);
  child.once('error', () => {
    if (!child.pid) { closed(); owned.delete(child); clearTimeout(entry.timer); }
  });
  child.once('exit', () => {
    clearTimeout(entry.timer);
    // Descendants can inherit the leader's stdout/stderr. Waiting for `close`
    // before terminating them deadlocks: those pipes stay open until they exit.
    if (group) void stopManaged(child, {graceMs: 50});
  });
  child.once('close', () => {
    closed(); clearTimeout(entry.timer);
    if (group) void stopManaged(child, {graceMs: 50});
    else owned.delete(child);
  });
  if (timeoutMs > 0) {
    entry.timer = setTimeout(() => { void stopManaged(child); }, timeoutMs);
    entry.timer.unref();
  }
  return child;
}

export async function cleanupProcesses() {
  await Promise.all([...owned.keys()].map(child => stopManaged(child)));
}

export function installProcessCleanup() {
  if (installed) return;
  installed = true;
  let stopping = false;
  for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(name, () => {
      if (stopping) return;
      stopping = true;
      void cleanupProcesses().finally(() => process.exit(code));
    });
  }
  process.on('exit', () => {
    for (const [child, entry] of owned) {
      try { signal(child, entry, 'SIGKILL'); } catch (_) { /* Process already gone. */ }
    }
  });
}
