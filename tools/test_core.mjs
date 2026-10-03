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

// ===================== 拖动进度条后的状态重建 =====================

test("firstAfter：第一颗 t 严格大于 sec 的下标（二分）", () => {
  const notes = [0, 1, 1, 2, 5].map((t) => ({ t }));
  assert.equal(Core.firstAfter(notes, -1), 0);
  assert.equal(Core.firstAfter(notes, 0), 1);
  assert.equal(Core.firstAfter(notes, 1), 3);   // 同刻的两颗都算「已经过去」
  assert.equal(Core.firstAfter(notes, 4.9), 4);
  assert.equal(Core.firstAfter(notes, 99), 5);
});

const FLASH = 0.14;

/** 旧版 rebuildVisualState 的「每帧扫完整谱面」实现，留着当参照物 */
function referenceStates(notes, chartT) {
  const out = [];
  let passed = 0;
  for (const n of notes) {
    if (n.t <= chartT) passed++;
    // 长押头尾各算一颗 note（实机口径）：尾判过了要再多算一颗连击
    if (n.kind === "hold" && n.endT != null && n.endT <= chartT) passed++;
    if (n.kind === "hold" && n.endT != null) {
      if (chartT >= n.t && chartT < n.endT) out.push("holding");
      else if (chartT >= n.endT) out.push("done");
      else out.push("pending");
    } else if (chartT >= n.t && chartT < n.t + FLASH) {
      out.push("flashing");
    } else if (chartT >= n.t + FLASH) {
      out.push("done");
    } else {
      out.push("pending");
    }
  }
  return { states: out, passed };
}

function applyRebuild(notes, prevCursor, prevActive, chartT, maxHold) {
  const r = Core.rebuildNoteStates(notes, prevCursor, prevActive, chartT, { flash: FLASH, maxHold });
  for (const u of r.updates) u.note.state = u.state;
  return r;
}

test("rebuildNoteStates：状态与旧的整谱面扫描完全一致（随机拖动）", () => {
  // 造一份「有 tap 有长押、有同刻音」的谱面
  const notes = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 0.05 + Math.random() * 0.4;
    if (Math.random() < 0.25) {
      notes.push({ t, endT: t + 0.3 + Math.random() * 3, kind: "hold", index: i % 16, state: "pending" });
    } else {
      notes.push({ t, endT: null, kind: "tap", index: i % 16, state: "pending" });
    }
  }
  notes.sort((a, b) => a.t - b.t);
  const maxHold = Math.max(...notes.filter((n) => n.kind === "hold")
    .map((n) => n.endT - n.t), 0);

  // 模拟连续拖动：每次只在上一次位置附近晃，也会偶尔来一次大跳。
  // 每次都比对「整谱面重扫」的参照结果，确保增量版和旧行为逐颗一致。
  let cursor = 0;
  let chartT = 0;
  let active = [];
  for (let step = 0; step < 300; step++) {
    const jump = Math.random() < 0.15;
    chartT = jump
      ? Math.random() * (t + 2)
      : Math.max(0, chartT + (Math.random() - 0.35) * 1.2);
    const r = applyRebuild(notes, cursor, active, chartT, maxHold);
    cursor = r.cursor;
    active = r.active;

    const ref = referenceStates(notes, chartT);
    assert.deepEqual(notes.map((n) => n.state), ref.states,
      `第 ${step} 步 chartT=${chartT.toFixed(3)}`);
    assert.equal(r.passed, ref.passed);
    // active 表就是「现在还亮着 / 还长押着」的那些
    assert.deepEqual(r.active, ref.states
      .map((s, i) => (s === "flashing" || s === "holding" ? i : -1))
      .filter((i) => i >= 0)
      .map((i) => notes[i]));

    // 面板上的灯：该亮的必须被重新点亮，不该亮的必须留在 -1
    // （clearPads() 已经全清，所以这里给的就是「重建后应该点亮的那些」）
    const wantHit = new Array(16).fill(-1);
    const wantHold = new Array(16).fill(-1);
    for (const n of notes) {
      const s = n.state;
      if (s === "holding") wantHold[n.index] = n.endT;
      else if (s === "flashing") wantHit[n.index] = n.t + FLASH;
    }
    const gotHit = new Array(16).fill(-1);
    const gotHold = new Array(16).fill(-1);
    for (const h of r.padHits) gotHit[h.pad] = h.until;
    for (const h of r.padHolds) gotHold[h.pad] = h.to;
    assert.deepEqual(gotHit, wantHit, `第 ${step} 步闪烁灯`);
    assert.deepEqual(gotHold, wantHold, `第 ${step} 步长押灯`);
  }
});

test("rebuildNoteStates：连续小幅拖动只改动手边那几颗音（不整谱重刷）", () => {
  const notes = [];
  for (let i = 0; i < 500; i++) {
    notes.push({ t: i * 0.1, endT: null, kind: "tap", index: i % 16, state: "pending" });
  }
  applyRebuild(notes, 0, [], 0, 0);                // 首次：把 [0, cursor) 全刷一遍（一次性）
  const r = applyRebuild(notes, Core.firstAfter(notes, 10), [], 10.05, 0);
  assert.ok(r.updates.length <= 2, `只该动 1~2 颗，实际 ${r.updates.length}`);
});

test("长押算两颗 note：尾判计入总 note 与连击（头判 / 尾判 / 全部）", () => {
  // 120BPM → 1 拍 = 0.5s。hold：0s 按下、1s 松开；再过 1s 一颗 tap。
  const parsed = Core.parseNotes(CHART([
    { beat: [0, 0, 1], index: 0, endbeat: [2, 0, 1] },
    { beat: [4, 0, 1], index: 5 },
  ]));
  assert.equal(parsed.nTap, 1);
  assert.equal(parsed.nHold, 1);
  assert.equal(parsed.nTotal, 3);              // tap 1 + hold(头+尾) 2
  assert.deepEqual(parsed.holdEnds, [1]);      // 尾判时刻表（给二分用）

  const notes = parsed.notes;
  assert.equal(notes[0].endT, 1);
  assert.equal(notes[1].t, 2);

  const at = (t, prev = { cursor: 0, active: [] }) =>
    Core.rebuildNoteStates(notes, prev.cursor, prev.active, t, {
      flash: FLASH, maxHold: parsed.maxHold, holdEnds: parsed.holdEnds,
    });
  const seq = [];
  let st = { cursor: 0, active: [] };
  for (const t of [0.1, 0.5, 1.0, 2.1, 99]) {
    const r = at(t, st);
    seq.push([t, r.passed]);
    st = { cursor: r.cursor, active: r.active };
  }
  // 0.1：头判过 → 1；0.5：还在长押里 → 1；1.0：尾判过 → 2；
  // 2.1：tap 过 → 3；99：全过 → 3 = nTotal（满连就是总 note 数）
  assert.deepEqual(seq, [[0.1, 1], [0.5, 1], [1.0, 2], [2.1, 3], [99, 3]]);

  // 直接跳转到长押尾巴之后（拖动进度条）也要算上那一条尾巴
  assert.equal(Core.countPassed(notes, 1.0, 1), 2);
  assert.equal(Core.countPassed(notes, 0.99, 1), 1);
  // 参数给错了（不是数组）也不能算崩，退回自己扫一遍
  assert.equal(Core.countPassed(notes, 1.0, 1, "坏参数"), 2);
});

// ===================== A–B 段落循环打点 =====================

test("abTap：A → B → 清除；B 打在 A 前面就两点对调", () => {
  let ab = { a: null, b: null };
  let r = Core.abTap(ab, 12.5);
  assert.deepEqual(r, { a: 12.5, b: null, phase: "A" });
  ab = { a: r.a, b: r.b };

  r = Core.abTap(ab, 30);
  assert.deepEqual(r, { a: 12.5, b: 30, phase: "B" });
  ab = { a: r.a, b: r.b };

  r = Core.abTap(ab, 40);
  assert.deepEqual(r, { a: null, b: null, phase: "clear" });

  // 第二点落在 A 前面（或同一刻）：对调，不产生空区间
  r = Core.abTap({ a: 20, b: null }, 5);
  assert.deepEqual(r, { a: 5, b: 20, phase: "B" });
  r = Core.abTap({ a: 20, b: null }, 20);
  assert.deepEqual(r, { a: 20, b: 20, phase: "B" });
});
