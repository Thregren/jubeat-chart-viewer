#!/usr/bin/env node
/**
 * core.js（纯逻辑）单元测试：node --test tools/test_core.mjs
 *
 * 这些用例大多来自真实踩过的坑：
 *   - 长押的 endindex 是「尾巴方向」，不是第二个键（以前会凭空多出一个亮着的键）
 *   - 顺序数字要按「换气」分句，而且不能数到两位数
 *   - ?chart= 深链接要按难度代号匹配（以前按完整文件名匹配，BAS 会静默回落到 EXT）
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const Core = require("../铺面查看器/player/static/core.js");

const CHART = (notes, time = [{ beat: [0, 0, 1], bpm: 120 }]) => ({ time, note: notes });

test("beatToFloat / buildTimeMap：拍号与 BPM 变化", () => {
  assert.equal(Core.beatToFloat([3, 1, 2]), 3.5);
  assert.equal(Core.beatToFloat(2), 2);
  const map = Core.buildTimeMap([
    { beat: [0, 0, 1], bpm: 60 },      // 1 拍 = 1s
    { beat: [4, 0, 1], bpm: 120 },     // 1 拍 = 0.5s
  ]);
  assert.equal(map.beatToSec(4), 4);
  assert.equal(map.beatToSec(6), 5);   // 4→6 拍走的是 120BPM
  assert.equal(map.bpmAt(4.5), 120);
});

test("长押：endindex 是尾巴方向，不是第二条 note（phantom 回归）", () => {
  const parsed = Core.parseNotes(CHART([
    { beat: [0, 0, 1], index: 12, endbeat: [1, 0, 1], endindex: 14 },
    { beat: [1, 0, 1], index: 3 },
  ]));
  assert.equal(parsed.notes.length, 2);          // 不是 3 条
  const hold = parsed.notes[0];
  assert.equal(hold.kind, "hold");
  assert.equal(hold.index, 12);                  // 只占起点那一格
  assert.equal(hold.tailTip, 14);                // 尾巴方向保留下来
  assert.equal(hold.endIndex, undefined);        // 不再有「第二个键」这个字段
  assert.equal(parsed.nHold, 1);
  assert.equal(parsed.nTap, 1);
});

test("键位越界只夹到 0–15，不丢 note", () => {
  const parsed = Core.parseNotes(CHART([
    { beat: [0, 0, 1], index: 99 },
    { beat: [1, 0, 1], index: -3 },
  ]));
  assert.equal(parsed.notes.length, 2);          // note 数和曲库索引一致
  assert.equal(parsed.notes[0].index, 15);       // 99 → 15
  assert.equal(parsed.notes[1].index, 0);        // -3 → 0
});

test("顺序数字：同一时刻的音共用一个号（和弦）", () => {
  const parsed = Core.parseNotes(CHART([
    { beat: [0, 0, 1], index: 0 },
    { beat: [0, 0, 1], index: 5 },
    { beat: [1, 0, 1], index: 9 },
  ]));
  assert.equal(parsed.notes[0].seq, parsed.notes[1].seq);
  assert.equal(parsed.notes[0].group, parsed.notes[1].group);
  assert.equal(parsed.notes[0].groupSize, 2);
  assert.equal(parsed.notes[2].seq, parsed.notes[0].seq + 1);
});

test("顺序数字：换气（明显变稀疏）才从 1 重数", () => {
  // 6 个 0.5 拍的连续音 + 一个 3 拍的空档 + 2 个音
  const notes = [];
  for (let i = 0; i < 6; i++) notes.push({ beat: [i, 0, 2], index: i % 16 });
  notes.push({ beat: [10, 0, 1], index: 2 });
  notes.push({ beat: [11, 0, 1], index: 3 });
  const parsed = Core.parseNotes(CHART(notes));
  const seqs = parsed.notes.map((n) => n.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 1, 2]);
});

test("顺序数字：上限 9 封顶，不会出现两位数", () => {
  const notes = [];
  for (let i = 0; i < 25; i++) notes.push({ beat: [i, 0, 1], index: i % 16 });  // 每拍一个，没空档
  const parsed = Core.parseNotes(CHART(notes));
  const max = Math.max(...parsed.notes.map((n) => n.seq));
  assert.equal(max, Core.PHRASE_MAX);
  assert.ok(parsed.notes.every((n) => n.seq >= 1 && n.seq <= 9));
});

test("同押光晕：密处相邻两批双色交替，稀疏处用主色", () => {
  const notes = [];
  // 4 批同押，间隔 0.5 拍（密：120 BPM 下 0.25 s ≤ GLOW_DENSE_GAP）
  for (let i = 1; i <= 7; i += 2) {
    notes.push({ beat: [0, i, 4], index: 0 });
    notes.push({ beat: [0, i, 4], index: 5 });
  }
  // 一批孤立的同押（前后各空 4 拍）
  notes.push({ beat: [20, 0, 1], index: 1 });
  notes.push({ beat: [20, 0, 1], index: 6 });
  const parsed = Core.parseNotes(CHART(notes));
  const slots = parsed.notes.filter((n) => n.groupSize > 1).map((n) => n.glowSlot);
  // 5 批同押 × 2 个音 = 10 个 note：前 4 批（密）交替上色，最后一批（孤立）用主色
  assert.deepEqual(slots, [0, 0, 1, 1, 0, 0, 1, 1, 0, 0]);
});

test("pickChart：按难度代号找，兼容旧的 file 写法", () => {
  const charts = [
    { code: "BSC", level: "3", file: "0/a_BSC Lv3.mc" },
    { code: "EXT", level: "8", file: "0/a_EXT Lv8.mc" },
  ];
  assert.equal(Core.pickChart(charts, "ext").code, "EXT");
  assert.equal(Core.pickChart(charts, "EXT"), charts[1]);
  assert.equal(Core.pickChart(charts, "0/a_BSC Lv3.mc"), charts[0]);   // 旧深链接
  assert.equal(Core.pickChart(charts, "BAS"), null);                   // 没有就返回 null，不静默回落
});
