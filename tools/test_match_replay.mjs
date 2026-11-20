import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import '../jubeat_viewer/player/static/parse-oft.js';

const { parseOftReplay, encodeCompactReplay } = globalThis;

function makeOft() {
  const rows = [
    [11, 0, 0, 0, 300, 0, 1, 0, 300, 0, 0, 300],
    [11, 0, 0, 0, 300, 0, 3, 0, 300, 0, 0, 300],
    [12, 17, 0, 1, 554, 14],
    [14, 17, 0, 1, 0, 0, 5000],
    [3, 17, 0, 1, 0, 1, 4995],
    [9, 17, 0, 1],
    [4, 17, 0, 1, 0],
    [2, 17, 0, 5, 0, 0, 0, 0, 450000, 1, 1, 0, 2],
    [3, 17, 0, 3],
    [9, 17, 0, 1],
    [4, 17, 0, 3, 0],
    [2, 17, 0, 1, 0, 0, 0, 0, 450000, 0, 1, 0, 2],
  ];
  const bytes = Buffer.alloc(24 + 72 * rows.length);
  bytes.write('OFT8');
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt32LE(rows.length, 8);
  bytes.writeUInt32LE(72, 20);
  rows.forEach((row, index) => {
    row.forEach((field, column) => bytes.writeInt32LE(field, 24 + index * 72 + column * 4));
  });
  return bytes;
}

test('OFT8 and compact replay preserve timing, an untimed miss and simultaneous score updates', async () => {
  const oft = makeOft();
  const original = await parseOftReplay(new Blob([oft]));
  assert.deepEqual(await parseOftReplay(new Blob([gzipSync(oft)])), original);
  assert.deepEqual(original.notes.map(({ grade, deltaMs }) => [grade, deltaMs]),
    [['PERFECT', -5], ['MISS', null]]);
  assert.deepEqual(original.progress, [[1000, 450000, 1], [1000, 450000, 0]]);
  assert.deepEqual(original.summary, { score: 450000, maxCombo: 1 });
  const file = await encodeCompactReplay(original);
  assert.equal(file.suffix, '.jbr.gz');
  assert.deepEqual(await parseOftReplay(file.blob), original);
});

test('compact replay rejects missing score snapshots or oversized data', async () => {
  const unmatched = 'JBR1\n[[[300,1,4,0,300]],[[301,450000,1]],1]';
  await assert.rejects(parseOftReplay(new Blob([unmatched])), /精简回放格式无效/);
  const oversized = gzipSync('JBR1\n' + ' '.repeat(2 * 1024 * 1024));
  await assert.rejects(parseOftReplay(new Blob([oversized])), /超过 2 MiB/);
});
