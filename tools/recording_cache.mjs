import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export function fileDigest(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Cache bytes and identity must both match; a missing/partial sidecar is a miss. */
export async function cachedExtraction(source, dest, extract) {
  const sourceHash = fileDigest(source);
  const sidecar = dest + '.source.json';
  try {
    const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (meta.source === sourceHash && fs.statSync(dest).size >= 4096 && meta.output === fileDigest(dest)) return dest;
  } catch (_) { /* Legacy or interrupted cache is regenerated. */ }
  const data = await extract();
  if (data.length < 4096) throw new Error(`解出来的音源只有 ${data.length} 字节`);
  if (fileDigest(source) !== sourceHash) throw new Error('提取过程中源曲包已变化');
  const outputHash = createHash('sha256').update(data).digest('hex');
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const temp = dest + '.tmp-' + randomUUID();
  try {
    fs.writeFileSync(temp, data, {flag: 'wx'});
    fs.renameSync(temp, dest);
    // Bind metadata to this extraction's bytes, never a concurrently replaced
    // destination. An interrupted or racing publication then becomes a miss.
    fs.writeFileSync(temp, JSON.stringify({source: sourceHash, output: outputHash}), {flag: 'wx'});
    fs.renameSync(temp, sidecar);
  } finally { fs.rmSync(temp, {force: true}); }
  return dest;
}
