(() => {
  'use strict';

  const HEADER_BYTES = 24;
  const ROW_BYTES = 72;
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_COMPACT_BYTES = 2 * 1024 * 1024;
  const JBR1_MAGIC = 0x4a425231; // Followed by a newline and UTF-8 JSON.
  const JBR2_MAGIC = 0x4a425232;
  const MAX_NOTES = 16384;
  const GZIP_CHUNK_BYTES = 16 * 1024;
  const PERFECT_CLOCK_OFFSET = 254;
  const MAX_HIT_DELTA_MS = 1000;
  const GRADES = ['MISS', 'POOR', 'GOOD', 'GREAT', 'PERFECT'];

  function payloadSize(header) {
    const view = new DataView(header.buffer);
    if (view.getUint32(0) !== 0x4f465438 || view.getUint32(4, true) !== 8 ||
        view.getUint32(12, true) !== 0 || view.getUint32(16, true) !== 0 ||
        view.getUint32(20, true) !== ROW_BYTES) {
      throw new Error('不支持此回放格式，仅支持每条记录为 72 字节的 OFT8 v8。');
    }
    const size = view.getUint32(8, true) * ROW_BYTES;
    if (size > MAX_BYTES - HEADER_BYTES) {
      throw new Error('OFT8 回放声明的记录大小超过 32 MiB 上限。');
    }
    return size;
  }

  async function readReplay(file) {
    if (!file || typeof file.slice !== 'function' || typeof file.stream !== 'function') {
      throw new Error('无效的回放文件。');
    }
    if (file.size > MAX_BYTES) throw new Error('回放文件超过 32 MiB 上限。');

    let signature;
    try {
      signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    } catch {
      throw new Error('无法读取回放文件。');
    }
    const gzip = signature[0] === 0x1f && signature[1] === 0x8b;
    let stream;
    if (gzip) {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('当前浏览器不支持 gzip 回放解压。');
      }
      // Bound each write to the decoder as well as the total retained output.
      let offset = 0;
      stream = new ReadableStream({
        async pull(controller) {
          if (offset >= file.size) {
            controller.close();
            return;
          }
          const end = Math.min(offset + GZIP_CHUNK_BYTES, file.size);
          const chunk = await file.slice(offset, end).arrayBuffer();
          offset = end;
          controller.enqueue(new Uint8Array(chunk));
        },
      }).pipeThrough(new DecompressionStream('gzip'));
    } else {
      stream = file.stream();
    }

    const reader = stream.getReader();
    const header = new Uint8Array(HEADER_BYTES);
    let headerRead = 0;
    let payload;
    let payloadRead = 0;
    let compact = false;
    let done = false;
    try {
      while (!done) {
        let chunk;
        try {
          ({ done, value: chunk } = await reader.read());
        } catch {
          throw new Error(gzip ? 'gzip 回放已截断或压缩数据无效。' : '无法读取回放文件。');
        }
        if (done) break;
        if (!payload) {
          const count = Math.min(header.length - headerRead, chunk.length);
          header.set(chunk.subarray(0, count), headerRead);
          headerRead += count;
          if (headerRead < header.length) continue;
          chunk = chunk.subarray(count);
          const magic = new DataView(header.buffer).getUint32(0);
          compact = magic === JBR1_MAGIC || magic === JBR2_MAGIC;
          if (compact) {
            payload = new Uint8Array(MAX_COMPACT_BYTES);
            payload.set(header);
            payloadRead = HEADER_BYTES;
          } else {
            payload = new Uint8Array(payloadSize(header));
          }
        }
        if (chunk.length > payload.length - payloadRead) {
          throw new Error(compact ? '精简回放解压后超过 2 MiB 上限。' : 'OFT8 回放在声明的记录之后含有多余数据。');
        }
        payload.set(chunk, payloadRead);
        payloadRead += chunk.length;
      }
    } finally {
      if (!done) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!payload) throw new Error('回放文件头已截断。');
    if (compact) return parseCompact(payload.subarray(0, payloadRead));
    if (payloadRead !== payload.length) throw new Error('OFT8 回放记录已截断。');
    return parsePayload(payload);
  }

  function tickMs(tick) {
    return tick * 10 / 3;
  }

  function parsePayload(payload) {
    const view = new DataView(payload.buffer);
    const rowCount = payload.length / ROW_BYTES;
    const field = (row, index) => view.getInt32(row * ROW_BYTES + index * 4, true);
    const rawMs = row => view.getBigUint64(row * ROW_BYTES + 24, true);
    const chart = [];
    let resultCount = 0;
    let firstClock = rowCount;
    let previousChartTick = -1;

    for (let row = 0; row < rowCount; row++) {
      const type = field(row, 0);
      if (type === 11) {
        const subtype = field(row, 5);
        if (subtype < 0 || subtype > 4) throw new Error('不支持此 OFT8 谱面事件类型。');
        // The verified non-tap subtypes 1–4 are chart metadata.
        if (subtype !== 0) continue;
        const tick = field(row, 4);
        const panel = field(row, 6);
        if (tick < 0 || tick < previousChartTick || panel < 0 || panel >= 16) {
          throw new Error(`第 ${row + 1} 条 OFT8 记录的谱点无效或顺序错误。`);
        }
        if (field(row, 8) !== tick || field(row, 11) !== tick) {
          throw new Error('不支持带独立结束时刻的 OFT8 谱点（例如长按）。');
        }
        if (chart.length === MAX_NOTES) throw new Error('OFT8 谱点数量超过上限。');
        chart.push({
          tick,
          note: { timeMs: tickMs(tick), panel, hitMs: null, deltaMs: null, grade: null, judgmentMs: null },
        });
        previousChartTick = tick;
      } else if (type === 2) {
        const grade = field(row, 3);
        const baseScore = field(row, 8);
        const combo = field(row, 9);
        const maxCombo = field(row, 10);
        const bonus = field(row, 11);
        if (grade < 1 || grade > GRADES.length || baseScore < 0 || baseScore > 900000 ||
            bonus < 0 || bonus > 1024 || combo < 0 || combo > maxCombo || maxCombo > field(row, 12)) {
          throw new Error(`第 ${row + 1} 条 OFT8 记录的判定无效。`);
        }
        resultCount++;
        if (resultCount > MAX_NOTES) throw new Error('OFT8 判定数量超过上限。');
      } else if (type === 12 && firstClock === rowCount) {
        firstClock = row;
      }
    }

    if (!chart.length || !resultCount) throw new Error('OFT8 回放缺少谱点或判定。');
    if (firstClock === rowCount) throw new Error('OFT8 回放缺少帧时钟。');
    if (chart.length !== resultCount) {
      throw new Error('OFT8 谱点与判定数量不一致，回放可能不完整或包含不支持的长按。');
    }

    const progress = [];
    const pending = [];
    let nextNote = 0;
    let lastResult;
    let previousFrame;
    let previousTick;
    let previousRaw;

    for (let clock = firstClock, end; clock < rowCount; clock = end) {
      const frameTime = field(clock, 1);
      const frame = field(clock, 3);
      const tick = field(clock, 4);
      let snapshot = -1;
      let frameResults = 0;
      let inputPanels = 0;
      for (end = clock + 1; end < rowCount && field(end, 0) !== 12; end++) {
        const type = field(end, 0);
        if (type === 14) {
          if (snapshot !== -1) throw new Error(`OFT8 第 ${frame} 帧含有重复的输入快照。`);
          snapshot = end;
        } else if (type === 15) {
          const panel = field(end, 4);
          if (field(end, 3) !== frame || panel < 0 || panel >= 16 || (inputPanels & (1 << panel))) {
            throw new Error(`OFT8 第 ${frame} 帧含有无效或重复的按键记录。`);
          }
          inputPanels |= 1 << panel;
        } else if (type === 2) {
          frameResults++;
        }
      }
      if (tick - field(clock, 5) !== 540 || snapshot === -1 ||
          field(snapshot, 1) !== frameTime || field(snapshot, 2) !== field(clock, 2) ||
          field(snapshot, 3) !== frame) {
        throw new Error(`OFT8 第 ${frame} 帧缺少有效的时钟和输入快照配对。`);
      }
      const rawFrame = rawMs(snapshot);
      if (previousFrame !== undefined &&
          (frame <= previousFrame || tick < previousTick || rawFrame <= previousRaw)) {
        throw new Error(`OFT8 第 ${frame} 帧的时钟顺序无效。`);
      }
      previousFrame = frame;
      previousTick = tick;
      previousRaw = rawFrame;

      const current = field(snapshot, 9);
      const previous = field(snapshot, 10);
      if (current < 0 || current > 0xffff || previous < 0 || previous > 0xffff ||
          field(snapshot, 11) !== (current & ~previous) || field(snapshot, 12) !== (previous & ~current)) {
        throw new Error(`OFT8 第 ${frame} 帧的按键掩码无效。`);
      }

      // Each type3 visits the next pending chart note, including notes from earlier frames.
      while (nextNote < chart.length && chart[nextNote].tick < tick) {
        pending.push(chart[nextNote++]);
      }
      let visited = 0;
      let remaining = 0;
      let assigned = 0;
      const judgmentTick = tick - PERFECT_CLOCK_OFFSET;
      const judgmentMs = tickMs(judgmentTick);
      for (let visit = clock + 1; visit < end; visit++) {
        if (field(visit, 0) !== 3) continue;
        const entry = pending[visited++];
        const x = field(visit, 3);
        const y = field(visit, 4);
        if (!entry || field(visit, 1) !== frameTime || x < 0 || x >= 4 || y < 0 || y >= 4 ||
            x + 4 * y !== entry.note.panel) {
          throw new Error(`OFT8 第 ${frame} 帧的谱点访问顺序与判定队列不一致。`);
        }
        const result = visit + 3;
        if (result >= end || field(result, 0) !== 2) {
          pending[remaining++] = entry;
          continue;
        }
        const marker = visit + 1;
        const finish = visit + 2;
        if (field(marker, 0) !== 9 || field(finish, 0) !== 4 ||
            field(finish, 3) !== x || field(finish, 4) !== y ||
            field(marker, 1) !== frameTime || field(finish, 1) !== frameTime ||
            field(result, 1) !== frameTime || field(marker, 3) !== frame) {
          throw new Error(`OFT8 第 ${frame} 帧的判定记录组合无效。`);
        }

        const { note } = entry;
        note.grade = GRADES[field(result, 3) - 1];
        note.judgmentMs = judgmentMs;
        const pressed = rawMs(visit);
        if (field(visit, 5) && pressed > 0n && pressed <= rawFrame) {
          const offset = Number(pressed - rawFrame);
          const deltaMs = tickMs(judgmentTick - entry.tick) + offset;
          if (Math.abs(deltaMs) > MAX_HIT_DELTA_MS) {
            throw new Error(`OFT8 第 ${frame} 帧的按键偏差超出 ±${MAX_HIT_DELTA_MS} ms，时间戳无效。`);
          }
          note.hitMs = judgmentMs + offset;
          note.deltaMs = deltaMs;
        }
        const score = field(result, 8) + Math.floor(field(result, 11) * 100000 / 1024);
        progress.push([judgmentMs, score, field(result, 9)]);
        lastResult = result;
        assigned++;
      }
      if (visited !== pending.length || assigned !== frameResults) {
        throw new Error(`OFT8 第 ${frame} 帧的谱点或判定无法完整配对。`);
      }
      pending.length = remaining;
    }

    if (progress.length !== resultCount || nextNote !== chart.length || pending.length) {
      throw new Error('OFT8 回放的谱点或判定无法完整配对。');
    }
    return {
      notes: chart.map(entry => entry.note),
      summary: { score: progress[progress.length - 1][1], maxCombo: field(lastResult, 10) },
      progress,
    };
  }

  function chartHint(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [song, code] = value;
    if (typeof song !== 'string' || !song.length || song.length > 1024 ||
        typeof code !== 'string' || !code.length || code.length > 64) return null;
    return { song, code };
  }

  async function encodeCompact(data, selection) {
    // Preserve the OFT clock's 10/3 ms ticks and offsets in thirds of a millisecond.
    const tick = ms => Math.round(ms * 3 / 10);
    const notes = data.notes.map(note => [
      tick(note.timeMs), note.panel, GRADES.indexOf(note.grade),
      note.deltaMs == null ? null : Math.round(note.deltaMs * 3),
      tick(note.judgmentMs),
    ]);
    const progress = data.progress.map(([ms, score, combo]) => [tick(ms), score, combo]);
    const rows = [notes, progress, data.summary.maxCombo];
    const hint = [selection?.song, selection?.code];
    if (chartHint(hint)) rows.push(hint);
    const plain = new Blob([rows.length === 4 ? 'JBR2\n' : 'JBR1\n', JSON.stringify(rows)]);
    if (typeof CompressionStream !== 'function') return { blob: plain, suffix: '.jbr' };
    const blob = await new Response(plain.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return { blob, suffix: '.jbr.gz' };
  }

  function parseCompact(bytes) {
    const invalid = () => new Error('精简回放格式无效或数据不完整。');
    if (bytes[4] !== 10) throw invalid();
    let replay;
    try {
      replay = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(5)));
    } catch {
      throw invalid();
    }
    const version2 = bytes[3] === 0x32;
    if (!Array.isArray(replay) || replay.length < 3 || replay.length > (version2 ? 4 : 3)) throw invalid();
    const [noteRows, progressRows, maxCombo] = replay;
    const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    const validTick = value => inRange(value, -PERFECT_CLOCK_OFFSET, 0x7fffffff);
    if (!Array.isArray(noteRows) || !noteRows.length || noteRows.length > MAX_NOTES ||
        !Array.isArray(progressRows) || progressRows.length !== noteRows.length ||
        !inRange(maxCombo, 0, noteRows.length)) throw invalid();

    const judgments = new Map();
    let previousNote = 0;
    const notes = noteRows.map(row => {
      if (!Array.isArray(row) || row.length !== 5) throw invalid();
      const [tick, panel, grade, offset, judgment] = row;
      if (!validTick(tick) || tick < previousNote || !validTick(judgment) ||
          !inRange(panel, 0, 15) || !inRange(grade, 0, GRADES.length - 1) ||
          (offset !== null && !inRange(offset, -3 * MAX_HIT_DELTA_MS, 3 * MAX_HIT_DELTA_MS))) throw invalid();
      previousNote = tick;
      judgments.set(judgment, (judgments.get(judgment) ?? 0) + 1);
      const timeMs = tickMs(tick);
      const deltaMs = offset === null ? null : offset / 3;
      return {
        timeMs, panel, grade: GRADES[grade], deltaMs,
        hitMs: deltaMs === null ? null : timeMs + deltaMs,
        judgmentMs: tickMs(judgment),
      };
    });

    let previousJudgment = -PERFECT_CLOCK_OFFSET;
    const progress = progressRows.map(row => {
      if (!Array.isArray(row) || row.length !== 3) throw invalid();
      const [tick, score, combo] = row;
      const count = judgments.get(tick);
      if (!validTick(tick) || tick < previousJudgment || !count ||
          !inRange(score, 0, 1000000) || !inRange(combo, 0, maxCombo)) throw invalid();
      judgments.set(tick, count - 1);
      previousJudgment = tick;
      return [tickMs(tick), score, combo];
    });
    const data = { notes, progress, summary: { score: progress[progress.length - 1][1], maxCombo } };
    const hint = version2 && chartHint(replay[3]);
    if (hint) data.chartHint = hint;
    return data;
  }

  globalThis.parseOftReplay = readReplay;
  globalThis.encodeCompactReplay = encodeCompact;
})();
