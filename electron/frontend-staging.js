const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Each server keeps one immutable snapshot, including while another window starts.
function stageFrontend(source, cacheRoot) {
  const sourceStatic = fs.existsSync(path.join(source, 'static')) ? path.join(source, 'static') : source;
  const files = [['index.html', path.join(source, 'index.html')]];
  for (const name of fs.readdirSync(sourceStatic).sort()) {
    const file = path.join(sourceStatic, name);
    if (name !== 'index.html' && !name.startsWith('.') && fs.statSync(file).isFile()) {
      files.push([path.join('static', name), file]);
    }
  }
  const contents = files.map(([name, file]) => [name, fs.readFileSync(file)]);
  const hash = crypto.createHash('sha256');
  for (const [name, data] of contents) {
    hash.update(JSON.stringify([name, data.length]));
    hash.update(data);
  }
  const digest = hash.digest('hex');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const matches = dir => fs.existsSync(path.join(dir, '.complete')) && contents.every(([name, data]) => {
    try { return fs.readFileSync(path.join(dir, name)).equals(data); }
    catch { return false; }
  });
  const existing = fs.readdirSync(cacheRoot).filter(name => name.startsWith(digest + '-'));
  for (const name of existing) {
    const candidate = path.join(cacheRoot, name);
    if (matches(candidate)) return candidate;
  }
  const stage = fs.mkdtempSync(path.join(cacheRoot, digest + '-'));
  try {
    for (const [name, data] of contents) {
      const dest = path.join(stage, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stage, '.complete'), digest, { flag: 'wx' });
    return stage;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { stageFrontend };
