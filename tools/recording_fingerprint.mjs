/** Recording identity binds the output to local source bytes and renderer code.
 * Missing inputs throw: legacy outputs cannot prove freshness automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const fileCache = new Map();
function digestFile(file) {
  const st = fs.statSync(file);
  const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const previous = fileCache.get(file);
  if (previous?.stamp === stamp) return previous.digest;
  const digest = createHash("sha256").update(fs.readFileSync(file)).digest();
  fileCache.set(file, {stamp, digest});
  return digest;
}
export function recordingFingerprint(repo, song, args = {}) {
  const hash = createHash('sha256');
  hash.update('jubeat-recording-inputs-v1\0');
  const library = process.env.JUBEAT_LIBRARY || path.join(repo, 'music');
  const root = fs.realpathSync(library);
  const source = fs.realpathSync(path.join(root, song));
  if (!source.startsWith(root + path.sep)) throw new Error('Song outside library');
  const add = (label, file) => {
    hash.update(label + '\0');
    hash.update(digestFile(file));
  };
  add('song', source);
  const staticDir = path.join(repo, '铺面查看器/player/static');
  for (const name of fs.readdirSync(staticDir).sort()) {
    if (/\.(?:js|css|html)$/.test(name)) add(name, path.join(staticDir, name));
  }
  for (const name of ['record.mjs', 'audio.mjs', 'cdp.mjs', 'cover.mjs', 'resources.mjs']) {
    add('rec/' + name, path.join(repo, 'tools/rec', name));
  }
  const performanceFile = path.join(repo, 'tools/rec/performance.json');
  if (fs.existsSync(performanceFile)) add('performance', performanceFile);
  const number = (key, fallback) => Number(args[key] ?? fallback);
  const parameters = {
    fps: number('fps', 60), width: number('card-w', 1440), height: number('card-h', 1080),
    fade: number('intro-fade', 1), hold: number('intro-hold', 1),
    sfx: number('sfx-volume', 120), quality: number('quality', 95),
    first: args['first-marker'] === true || args['first-marker'] === '1',
    charts: String(args.charts || 'EXT,ADV,BSC'),
    from: number('from', 0), limit: number('limit', 0), transition: number('transition', 0),
    transitionStyle: String(args['transition-style'] || 'fadeblack'), marker: String(args.marker || 'default'),
  };
  hash.update(JSON.stringify(parameters));
  // Marker and sound effect bytes also affect the output.
  for (const [label, dir] of [['marker', process.env.JUBEAT_MARKERS || path.join(repo, 'marker/jubeat_official')], ['se', path.join(repo, 'se')]]) {
    const visit = (base, relative = '') => {
      for (const entry of fs.readdirSync(base, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const rel = path.join(relative, entry.name), file = path.join(base, entry.name);
        if (entry.isDirectory()) visit(file, rel);
        else if (entry.isFile()) add(label + '/' + rel, file);
      }
    };
    if (fs.existsSync(dir)) visit(dir);
  }
  return hash.digest('hex');
}
