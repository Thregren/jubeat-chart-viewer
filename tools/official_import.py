#!/usr/bin/env python3
"""官方游戏解包（IFS）→ 本站曲库 .mcz 导入工具。

为什么要这个工具
----------------
曲库（`music/*.mcz`）来自第三方整理，缺了一批官方已经在配信的曲子。
与其找别人要，不如直接从街机解包里那把谱面、音源、封面原样提出来——
这三样本来就是官方素材，转出来的 .mcz 和曲库里其他曲子同构。

数据来源（`--extract` 指向解包根目录）
-------------------------------------
    data/ifs_pack/d{mid 前 7 位}/{mid}_msc.ifs

IFS 是"分块包"，共 5 块，固定顺序：

    blk0 = BGM（Konami BMP / OKI4S ADPCM）
    blk1 = 10 秒试听（同样是有损压缩，本项目用不到）
    blk2 = EXT 谱面    blk3 = ADV 谱面    blk4 = BSC 谱面

区块表在文件 0x10 处的 BE32 偏移减 60 处，每条 12 字节（BE32 偏移 + BE32 长度）。

谱面算法
--------
与 `jubeatools` 完全等价，实现细节见 `_ChartConverter` 的注释；
本地已对 3130 个难度 / 158.9 万音符做过逐音符比对，与曲库既有转法一致。

音源算法
--------
Konami BMP 不是 PCM，是 OKI4S ADPCM（等价于 vgmstream 的 `coding_OKI4S`）：
每半字节一个采样，step 表 48 项，指数回退表 16 项；双声道时一字节高 4 位是
左声道、低 4 位是右声道。解出来按曲库统一电平（RMS -14.61 dB）编码成 Vorbis。

用法
----
    python3 tools/official_import.py --songs tools/official_songs.json \
        --extract "/path/to/unpacked/contents" --covers /path/to/covers \
        [--out music] [--dry-run] [--only MID[,MID...]]
"""
from __future__ import annotations

import argparse
import array
import bisect
import io
import json
import math
import re
import struct
import subprocess
import sys
import time
import wave
import zipfile
from fractions import Fraction
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent

# ---------------------------------------------------------------- 谱面转换

# IFS 里难度块的固定下标（见模块开头）
_BLOCK = {"EXT": 2, "ADV": 3, "BSC": 4}
# jubeat 内部 tick 频率：300 Hz
_TICK_HZ = 300
# 拍值取整粒度：1/48 拍（与曲库既有谱面一致）
_BEAT_SNAP = 48
# 长押方向：0=下 1=上 2=右 3=左；index = x + 4*y
_DIR_VEC = {0: (0, -1), 1: (0, 1), 2: (-1, 0), 3: (1, 0)}


class ChartError(ValueError):
    """谱面无法解析（多半是官方没配信的占位块）。"""


def load_ifs(path: Path) -> tuple[bytes, list[tuple[int, int]]]:
    """读 IFS 分块表：返回 (整包字节, [(块偏移, 块长度) × 5])。"""
    data = path.read_bytes()
    if len(data) < 0x14:
        raise ChartError(f"IFS 太小：{path}")
    table_off = struct.unpack_from(">I", data, 0x10)[0]
    start = table_off - 60
    if start < 0 or start + 12 * 5 > len(data):
        raise ChartError(f"IFS 分块表越界：{path}")
    entries = []
    for i in range(5):
        off, size = struct.unpack_from(">II", data, start + 12 * i)
        entries.append((table_off + off, size))
    return data, entries


def read_block(ifs: Path, index: int) -> bytes:
    data, entries = load_ifs(ifs)
    off, size = entries[index]
    if off + size > len(data):
        raise ChartError(f"IFS 块 {index} 越界：{ifs}")
    return data[off:off + size]


def _parse_events(text: bytes) -> list[tuple[int, str, int]]:
    """谱面明文（cp932）→ [(tick, 指令, 值)]。"""
    out: list[tuple[int, str, int]] = []
    for line in text.decode("cp932", "replace").split("\r\n"):
        if not line.strip():
            continue
        parts = [x.strip() for x in line.split(",")]
        if len(parts) < 2 or not parts[1]:
            continue
        try:
            pos = int(parts[0])
        except ValueError:
            continue
        if parts[1] in ("MEASURE", "END", "HAKU"):
            out.append((pos, parts[1], 0))
            continue
        try:
            value = int(parts[2])
        except (ValueError, IndexError):
            continue
        out.append((pos, parts[1], value))
    return out


def _truncate(value: Fraction, places: int) -> Fraction:
    scale = Fraction(10) ** places
    return Fraction(math.floor(value * scale), scale)


def _value_to_bpm(value: int) -> Fraction:
    """BPM 值 → 真实 BPM（Konami 存的是 60000000/BPM 的截断整数）。"""
    exact = Fraction(6 * 10 ** 7, value)
    places = 0
    while True:
        candidate = _truncate(exact, places)
        if 6 * 10 ** 7 / candidate < value + 1:
            return candidate
        places += 1


def _round_beats(beats: Fraction, denom: int = _BEAT_SNAP) -> Fraction:
    return Fraction(round(beats * denom), denom)


class _TimeMap:
    """BPM 变化点（按秒）→ 拍轴。谱面里的 note 位置只有 tick，拍值要靠它积分。"""

    def __init__(self, points: list[tuple[Fraction, Fraction]]):
        self.changes: list[tuple[Fraction, Fraction, Fraction]] = []
        beat = Fraction(0)
        prev: tuple[Fraction, Fraction] | None = None
        for sec, bpm in points:
            if prev is not None:
                beat += prev[1] * (sec - prev[0]) / 60
            self.changes.append((sec, beat, bpm))
            prev = (sec, bpm)
        self._secs = [c[0] for c in self.changes]

    def beats_at(self, seconds: Fraction) -> Fraction:
        i = max(0, bisect.bisect_right(self._secs, seconds) - 1)
        sec, beat, bpm = self.changes[i]
        return beat + bpm * (seconds - sec) / 60

    def seconds_at(self, beat: Fraction) -> Fraction:
        sec, base, bpm = self.changes[0]
        return sec + (beat - base) * 60 / bpm


def parse_chart(ifs: Path, code: str) -> tuple[list, list, Fraction]:
    """解一个难度。

    返回 (notes, timing, offset)：
        notes  = [(beat, index, endbeat|None, endindex|None)]
        timing = [(beat, bpm)]，即 Malody `time` 数组
        offset = 第 0 拍的秒数（本项目的谱面不带偏移，恒为 0）
    """
    block = _BLOCK[code]
    try:
        raw = read_block(ifs, block)
    except ChartError:
        raise
    if len(raw) < 32:
        raise ChartError(f"{ifs.name} 的 {code} 块是占位（官方未配信）")

    events = _parse_events(raw)
    tempos = sorted((t, v) for t, cmd, v in events if cmd == "TEMPO")
    if not tempos:
        raise ChartError(f"{ifs.name} 的 {code} 块里没有 TEMPO")
    if tempos[0][0] != 0:
        raise ChartError(f"{ifs.name} 的 {code} 块 TEMPO 不从 tick 0 开始")

    tm = _TimeMap([(Fraction(t, _TICK_HZ), _value_to_bpm(v)) for t, v in tempos])

    notes = []
    for tick, cmd, value in events:
        if cmd == "PLAY":
            notes.append((_round_beats(tm.beats_at(Fraction(tick, _TICK_HZ))),
                          value, None, None))
        elif cmd == "LONG":
            index = value & 15
            direction = (value >> 4) & 3
            length = (value >> 6) & 3
            duration = value >> 8
            raw_beat = tm.beats_at(Fraction(tick, _TICK_HZ))
            beat = _round_beats(raw_beat)
            endbeat = _round_beats(
                tm.beats_at(Fraction(tick + duration, _TICK_HZ)) - raw_beat)
            dx, dy = _DIR_VEC[direction]
            x, y = index % 4, index // 4
            endx, endy = x + dx * length, y + dy * length
            notes.append((beat, index, beat + endbeat, endx + 4 * endy))

    # 这里**不**把「终点不晚于起点」的长押降级成单点。
    # 实机的物量口径是「单点 ×1 + 长押 ×2」，退化的长押照样算头、尾两颗：
    # 灼熱 Beach Side Bunny EXT 有 655 条 1 tick（≈3ms）的长押，官方物量
    # 1606 = 272 单点 + 667 长押 ×2；降级成单点的话本地只有 951，整整少 655 颗。
    # 前端对 endbeat == beat 的长押有兜底（不画箭头，其余同普通 note）。
    notes.sort(key=lambda n: (n[0], n[1]))
    timing = [(_round_beats(beat), bpm) for _, beat, bpm in tm.changes]
    return notes, timing, tm.seconds_at(Fraction(0))


def beat_tuple(beat: Fraction) -> list[int]:
    """Fraction → Malody 的 [整数拍, 分子, 分母]。"""
    whole = int(beat)
    frac = beat - whole
    if frac == 0:
        return [whole, 0, 1]
    return [whole, frac.numerator, frac.denominator]


# ---------------------------------------------------------------- 音源解码

# OKI4S 的步长表（48 项）与指数回退表
_STEP_SIZES = (
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253,
    279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876,
    963, 1060, 1166, 1282, 1411, 1552,
)
_STEP_DELTA = (-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8)


class AudioError(ValueError):
    """音源不是可解的 Konami BMP。"""


def parse_bmp_header(data: bytes) -> dict:
    if len(data) < 0x20 or data[:4] != b"BMP\x00":
        raise AudioError("不是 Konami BMP（缺少 BMP\\0 魔数）")
    num_samples, loop_start, loop_end = struct.unpack_from(">III", data, 4)
    channels = data[0x10] or struct.unpack_from("<H", data, 16)[0]
    sample_rate = struct.unpack_from(">I", data, 0x14)[0]
    if channels not in (1, 2):
        raise AudioError(f"声道数不支持：{channels}")
    if not sample_rate:
        raise AudioError("采样率为 0")
    adpcm = data[0x20:]
    limit = len(adpcm) * (2 if channels == 1 else 1)
    if num_samples == 0 or num_samples > limit:
        num_samples = limit
    return {
        "num_samples": num_samples, "channels": channels,
        "sample_rate": sample_rate, "loop_start": loop_start,
        "loop_end": loop_end, "adpcm": adpcm,
    }


def decode_bmp_to_pcm(data: bytes) -> tuple[bytes, int, int]:
    """Konami BMP → (16-bit LE 立体声 PCM, 采样率, 声道数)。"""
    head = parse_bmp_header(data)
    adpcm = head["adpcm"]
    channels = head["channels"]
    count = head["num_samples"]
    out = bytearray(count * channels * 2)
    hist = [0, 0]
    step = [0, 0]

    for i in range(count):
        if channels == 2:
            byte = adpcm[i] if i < len(adpcm) else 0
            nibbles = ((byte >> 4) & 0xF, byte & 0xF)
        else:
            byte = adpcm[i // 2] if (i // 2) < len(adpcm) else 0
            nibbles = ((byte >> 4) & 0xF,) if (i & 1) == 0 else (byte & 0xF,)
        for ch, code in enumerate(nibbles):
            delta = _STEP_SIZES[step[ch]] << 4
            acc = delta >> 3
            if code & 1:
                acc += delta >> 2
            if code & 2:
                acc += delta >> 1
            if code & 4:
                acc += delta
            if code & 8:
                acc = -acc
            hist[ch] = max(-32768, min(32767, hist[ch] + acc))
            step[ch] = max(0, min(48, step[ch] + _STEP_DELTA[code]))
            struct.pack_into("<h", out, (i * channels + ch) * 2, hist[ch])

    return bytes(out), head["sample_rate"], channels


# ---------------------------------------------------------------- 响度归一

# 曲库统一电平（实测各版本 .mcz 里 bgm.ogg 的中位数）
TARGET_RMS_DB = -14.61
# Vorbis 编解码会掉一点电平，编码时先补回来
_VORBIS_OFFSET_DB = 0.45
# 曲库里的 bgm.ogg 是 128 kbps Vorbis（libvorbis -q 4）。这里留一点余量：
# 这些音源上线前还要再转一次 Opus，中间环节质量高一点，叠两次有损也听不出来。
VORBIS_QUALITY = 5


def _pcm_rms_db(pcm: bytes) -> float:
    if not pcm:
        return float("-inf")
    total = 0
    count = len(pcm) // 2
    for i in range(count):
        sample = int.from_bytes(pcm[i * 2:i * 2 + 2], "little", signed=True)
        total += sample * sample
    if total <= 0:
        return float("-inf")
    return 20.0 * math.log10(math.sqrt(total / count) / 32768.0)


def _amplify_pcm(pcm: bytes, gain: float) -> bytes:
    """按倍率放大并限幅（16-bit PCM）。"""
    if not pcm or abs(gain - 1.0) < 1e-9:
        return pcm
    samples = array.array("h")
    samples.frombytes(pcm)
    for i, value in enumerate(samples):
        scaled = int(value * gain)
        samples[i] = -32768 if scaled < -32768 else 32767 if scaled > 32767 else scaled
    return samples.tobytes()


def _pcm_to_wav(pcm: bytes, rate: int, channels: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return buf.getvalue()


def _oggenc() -> str | None:
    """本机有没有 libvorbis 编码器（oggenc 优先，其次 ffmpeg 自带 libvorbis）。"""
    from shutil import which
    return which("oggenc")


def _ffmpeg(*args: str, data: bytes | None = None) -> bytes:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                           "-nostdin", *args],
                          input=data, capture_output=True, timeout=900)
    if proc.returncode != 0:
        raise AudioError(proc.stderr.decode("utf-8", "replace").strip()[:400])
    return proc.stdout


def encode_vorbis(wav: bytes) -> bytes:
    """WAV → Ogg Vorbis（libvorbis）。

    优先用 oggenc（vorbis-tools），因为新版 ffmpeg 已经不再带 libvorbis 编码器；
    两个都没有就退回 ffmpeg 自带的 vorbis（音质差一些，但保证能出片）。
    """
    exe = _oggenc()
    if exe:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "in.wav"
            dst = Path(tmp) / "out.ogg"
            src.write_bytes(wav)
            proc = subprocess.run([exe, "-Q", "-q", str(VORBIS_QUALITY),
                                   "-o", str(dst), str(src)],
                                  capture_output=True, timeout=900)
            if proc.returncode == 0 and dst.is_file():
                return dst.read_bytes()
            raise AudioError(proc.stderr.decode("utf-8", "replace").strip()[:200]
                             or "oggenc 编码失败")
    return _ffmpeg("-i", "pipe:0", "-c:a", "vorbis", "-strict", "-2",
                   "-q:a", str(VORBIS_QUALITY), "-f", "ogg", "pipe:1", data=wav)


def bmp_to_ogg(data: bytes) -> bytes:
    """Konami BMP → 与曲库同电平的 Ogg Vorbis。"""
    pcm, rate, channels = decode_bmp_to_pcm(data)
    rms = _pcm_rms_db(pcm)
    if math.isfinite(rms):
        gain_db = (TARGET_RMS_DB + _VORBIS_OFFSET_DB) - rms
    else:
        gain_db = 0.0
    ogg = encode_vorbis(_pcm_to_wav(_amplify_pcm(pcm, 10 ** (gain_db / 20)),
                                    rate, channels))

    # 编出来再量一次，偏得多就补一次（有损编码后电平总归会飘一点）
    decoded = _ffmpeg("-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le",
                      "pipe:1", data=ogg)
    after = _pcm_rms_db(decoded)
    if math.isfinite(after):
        correction = TARGET_RMS_DB - after
        if abs(correction) > 0.15:
            ogg = encode_vorbis(_pcm_to_wav(
                _amplify_pcm(pcm, 10 ** ((gain_db + correction) / 20)),
                rate, channels))
    return ogg


# ---------------------------------------------------------------- 打包 .mcz

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_name(text: str) -> str:
    """曲名 → 文件名（去掉文件系统不友好的字符）。"""
    cleaned = _ILLEGAL.sub("_", text).strip().rstrip(".")
    return cleaned or "untitled"


def build_mcz(
    *,
    ifs: Path,
    cover: bytes,
    mid: str,
    title: str,
    artist: str,
    levels: dict[str, str],
    out_path: Path,
) -> dict:
    """按曲库既有格式写一个 .mcz，返回统计信息。"""
    audio = bmp_to_ogg(read_block(ifs, 0))
    cover_name = f"jkt_{mid}.png"
    stamp = int(time.time())
    stats = {}

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for code in ("BSC", "ADV", "EXT"):
            notes, timing, _ = parse_chart(ifs, code)
            level = str(levels[code])
            version = f"{code} Lv{level}"
            chart = {
                "meta": {
                    "background": cover_name, "version": version, "id": 0,
                    "mode": 4, "time": stamp,
                    "song": {"title": title, "artist": artist, "id": 0},
                    "mode_ext": {}, "cover": cover_name,
                    "level": level, "creator": "jubeat",
                },
                "time": [{"beat": beat_tuple(beat), "bpm": float(bpm)}
                         for beat, bpm in timing],
                "note": [{"beat": [0, 0, 1], "sound": "bgm.ogg",
                          "type": 1, "offset": 0, "vol": 100}],
                "extra": {version: {"divide": 4, "speed": 100, "save": 0,
                                    "lock": 0, "edit_mode": 0}},
            }
            for beat, index, endbeat, endindex in notes:
                note = {"beat": beat_tuple(beat), "index": index}
                if endbeat is not None:
                    note["endbeat"] = beat_tuple(endbeat)
                    note["endindex"] = endindex
                chart["note"].append(note)

            stats[code] = {
                "notes": len(notes),
                "holds": sum(1 for n in notes if n[2] is not None),
                "bpm": round(float(timing[0][1]), 4),
            }
            z.writestr(f"0/{safe_name(title)}_{version}.mc",
                       json.dumps(chart, ensure_ascii=False, separators=(",", ":")))
        z.writestr("0/bgm.ogg", audio)
        z.writestr(f"0/{cover_name}", cover)

    stats["audio_bytes"] = len(audio)
    stats["mcz_bytes"] = out_path.stat().st_size
    return stats


# ---------------------------------------------------------------- 命令行

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="官方 IFS 解包 → .mcz")
    ap.add_argument("--songs", required=True, help="曲目清单 JSON")
    ap.add_argument("--extract", required=True, help="解包根目录（含 data/ifs_pack）")
    ap.add_argument("--covers", help="封面目录（{mid}.png）")
    ap.add_argument("--out", default=str(REPO / "music"), help="曲库根目录")
    ap.add_argument("--only", help="只处理这些 mid（逗号分隔）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = ap.parse_args(argv)

    songs = json.loads(Path(args.songs).read_text(encoding="utf-8"))
    only = set(args.only.split(",")) if args.only else None
    pack_dir = Path(args.extract) / "data" / "ifs_pack"
    cover_dir = Path(args.covers) if args.covers else None
    out_root = Path(args.out)

    done = failed = 0
    for song in songs:
        mid = str(song["mid"])
        if only and mid not in only:
            continue
        ifs = pack_dir / f"d{mid[:7]}" / f"{mid}_msc.ifs"
        if not ifs.is_file():
            print(f"[skip] {mid} 找不到 {ifs}", file=sys.stderr)
            failed += 1
            continue
        cover_path = cover_dir / f"{mid}.png" if cover_dir else None
        if cover_path and not cover_path.is_file():
            print(f"[skip] {mid} 缺封面 {cover_path}", file=sys.stderr)
            failed += 1
            continue

        out_path = out_root / song["version"] / f"{safe_name(song['title'])}.mcz"
        if out_path.exists() and not song.get("overwrite"):
            print(f"[skip] {mid} 目标已存在：{out_path}")
            continue
        if args.dry_run:
            print(f"[dry ] {mid} → {out_path}")
            continue

        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            stats = build_mcz(
                ifs=ifs, cover=cover_path.read_bytes() if cover_path else b"",
                mid=mid, title=song["title"], artist=song["artist"],
                levels=song["levels"], out_path=out_path,
            )
        except (ChartError, AudioError, OSError) as exc:
            print(f"[fail] {mid} {song['title']}: {exc}", file=sys.stderr)
            failed += 1
            continue

        done += 1
        print(f"[ ok ] {mid} {song['title']}  "
              + "  ".join(f"{c}:{stats[c]['notes']}n/{stats[c]['holds']}h"
                          for c in ("BSC", "ADV", "EXT"))
              + f"  bpm={stats['EXT']['bpm']}  音源 {stats['audio_bytes']//1024} KiB"
              + f"  → {out_path.relative_to(out_root)}")

    print(f"\n完成 {done} 首，失败/跳过 {failed} 首")
    return 1 if failed and not done else 0


if __name__ == "__main__":
    raise SystemExit(main())
