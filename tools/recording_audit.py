"""Reusable chapter, frame timeline and active-play freeze verification."""
import json, re, shutil, subprocess, unicodedata, urllib.parse, urllib.request
from pathlib import Path
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
AUDIT_VERSION = 4
OVERLAP = 0.8
CHAPTER_RE = re.compile(r"(\d+):(\d+(?:\.\d+)?)\s+([A-Z]{3})\b")
def sanitize(name: str) -> str:
    """和 tools/rec/batch.mjs 的 sanitize() 保持一致（成片文件名就是它生成的）。"""
    out = str(name)
    for src, dst in (("/", "／"), ("\\", "／"), (":", "："), ("*", "＊"), ("?", "？"),
                     ('"', "＂"), ("<", "＜"), (">", "＞"), ("|", "｜")):
        out = out.replace(src, dst)
    out = "".join(ch for ch in out if ord(ch) >= 0x20)
    return out.rstrip(". ")[:120].strip() or "untitled"


def norm(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text)).casefold()


def parse_chapters(md_path: Path) -> list[tuple[str, float]]:
    """从 <曲名>.md 的「章节」段读出 [('EXT', 0.0), ('ADV', 112.0), ...]。"""
    try:
        text = md_path.read_text(encoding="utf-8")
    except OSError:
        return []
    found = CHAPTER_RE.findall(text)
    chapters = [(code, int(m) * 60 + float(s)) for m, s, code in found]
    chapters.sort(key=lambda item: item[1])
    return chapters


def fetch_json(url: str, timeout: float = 30.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def beat_to_float(beat) -> float:
    if isinstance(beat, (list, tuple)):
        a = float(beat[0] or 0)
        b = float(beat[1] or 0) if len(beat) > 1 else 0.0
        c = float(beat[2] or 1) if len(beat) > 2 else 1.0
        return a + (b / (c or 1.0))
    try:
        return float(beat)
    except (TypeError, ValueError):
        return 0.0


def build_bpm_map(events: list[dict]):
    """events: [{'beat':…, 'bpm':…}] → [(beat, bpm)]，首段从 0 拍算起。"""
    pts = []
    for event in events or []:
        pts.append((beat_to_float(event.get("beat")), float(event.get("bpm") or 120.0)))
    pts.sort(key=lambda item: item[0])
    if not pts:
        pts = [(0.0, 120.0)]
    if pts[0][0] > 0:
        pts.insert(0, (0.0, pts[0][1]))
    return pts


def seconds_at(pts: list[tuple[float, float]], beat: float) -> float:
    total = 0.0
    for i, (start_beat, bpm) in enumerate(pts):
        if beat <= start_beat:
            break
        end_beat = pts[i + 1][0] if i + 1 < len(pts) else beat
        span = min(beat, end_beat) - start_beat
        if span > 0:
            total += span * 60.0 / (bpm or 120.0)
        if beat <= end_beat:
            break
    return total


def chart_note_spans(chart: dict) -> list[tuple[float, float]]:
    """谱面音符的 (起, 止) 秒区间；长条按头尾展开。"""
    pts = build_bpm_map(chart.get("time") or [])
    spans = []
    for raw in chart.get("note") or []:
        if raw.get("index") is None:      # type=1 是音源事件，不是音符
            continue
        start = seconds_at(pts, beat_to_float(raw.get("beat")))
        end = start
        if raw.get("endbeat") is not None:
            end = seconds_at(pts, beat_to_float(raw.get("endbeat")))
        spans.append((start, max(start, end)))
    spans.sort()
    return spans


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def freeze_scan(path: Path, min_freeze: float) -> list[tuple[float, float]]:
    """跑一遍 freezedetect，返回 [(start, end)]。"""
    proc = subprocess.run(
        [FFMPEG, "-nostdin", "-v", "info", "-threads", "1", "-i", str(path),
         "-filter_threads", "1",
         "-vf", f"freezedetect=n=-60dB:d={min_freeze:g}", "-an", "-f", "null", "-"],
        capture_output=True, text=True, errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 定格扫描失败（退出码 {proc.returncode}）：{(proc.stderr or chr(32))[-500:]}")
    log = proc.stderr or ""
    starts = [float(x) for x in re.findall(r"freeze_start:\s*([0-9.]+)", log)]
    ends = [float(x) for x in re.findall(r"freeze_end:\s*([0-9.]+)", log)]
    spans = []
    for i, start in enumerate(starts):
        end = ends[i] if i < len(ends) else None
        if end is None:
            break
        spans.append((start, end))
    return spans


def audit_one(rel: str, out_dir: Path, library: dict, base_url: str,
              min_freeze: float, pad: float) -> dict:
    path = out_dir / rel
    md_path = path.with_suffix(".md")
    version = Path(rel).parent.name
    title = path.stem
    row = {"audit_version": AUDIT_VERSION, "file": rel, "verdict": "ok", "faults": [], "sheets": [], "freezes": []}
    try:
        stat = path.stat()
        row["size"] = stat.st_size
        row["mtime"] = int(stat.st_mtime)
    except OSError as exc:
        row["faults"].append(f"读不到成片：{exc}")
        row["verdict"] = "bad"
        return row

    song = library.get((version, norm(title))) or library.get((version, norm(sanitize(title))))
    if not song:
        row["faults"].append("曲库索引里找不到这首（无法用谱面判空档）")
    chapters = parse_chapters(md_path)
    if not chapters:
        row["faults"].append("成片 .md 里没有章节时间戳")

    duration = probe_duration(path)
    row["duration"] = round(duration, 3)

    # 分段区间：第 i 段的结尾 = 下一段起点 + 重叠量；最后一段到片尾。
    segments = {}
    for i, (code, start) in enumerate(chapters):
        end = (chapters[i + 1][1] + OVERLAP) if i + 1 < len(chapters) else duration
        segments[code] = (start, end)
        if end <= start + 0.1:
            row["faults"].append(f"{code} 分段区间异常（{start:.2f}s → {end:.2f}s，成片可能被裁短）")

    # 新录制附带精确分段时间；只接受与当前视频大小和修改时间匹配的元数据。
    # 旧片仍可用简介章节，但整秒章节无法用于判断紧贴边界的短空档。
    recorded_from = 0.0
    playback_starts = {}
    try:
        meta = json.loads(path.with_suffix(".rec.json").read_text(encoding="utf-8"))
        if (meta.get("schema") == 1 and meta.get("video_size") == stat.st_size
                and abs(float(meta["video_mtime_ms"]) - stat.st_mtime * 1000) < 2):
            exact = {str(x["code"]): (float(x["start"]), float(x["end"]))
                     for x in meta["segments"]}
            if set(exact) == set(segments) and all(duration + 0.1 >= e > s >= 0 for s, e in exact.values()):
                playback = {str(x["code"]): float(x.get("playback_start", x["start"]))
                            for x in meta["segments"]}
                if not all(exact[c][0] <= p < exact[c][1] for c, p in playback.items()):
                    raise ValueError("invalid playback_start")
                segments = exact
                recorded_from = float(meta.get("from") or 0)
                playback_starts = playback
                row["timeline"] = "exact"
    except (OSError, KeyError, ValueError, TypeError):
        pass

    # 拉每难度的谱面音符时间轴：既用来查截断，也用来判「定格是不是落在空档里」。
    spans_by_code: dict[str, list[tuple[float, float]]] = {}
    if song:
        raw_id = str(song["id"])
        stem = raw_id[:-4] if raw_id.lower().endswith(".mcz") else raw_id
        for code, (start, end) in segments.items():
            try:
                chart = fetch_json(f"{base_url}/data/charts/{urllib.parse.quote(stem)}/{code}.json")
                # 音符是谱面内部时间；合流章节与 freezedetect 是整片时间。
                # 和播放器一致：type=1 的 offset 是 beat 0 相对音频起点的毫秒偏移。
                type1 = next((n for n in chart.get("note") or [] if n.get("type") == 1), {})
                base_offset = float(type1.get("offset") or 0) / 1000
                playback_start = playback_starts.get(code, start)
                spans = [(playback_start + base_offset - recorded_from + a, playback_start + base_offset - recorded_from + b)
                         for a, b in chart_note_spans(chart)]
            except Exception as exc:
                row["sheets"].append({"code": code, "start": round(start, 3), "end": round(end, 3),
                                      "error": str(exc)[:120]})
                row["faults"].append(f"{code} 谱面时间轴读取失败，无法核验：{exc}")
                continue
            spans_by_code[code] = spans
            last = max((span[1] for span in spans), default=0.0)
            row["sheets"].append({"code": code, "start": round(start, 3), "end": round(end, 3),
                                  "notes": len(spans), "last_note": round(last, 3)})
            # 最后一个音符越过分段结尾 → 合流把尾巴裁掉了
            if end and last > end + 0.1:
                row["faults"].append(f"{code} 最后一个音符 {last:.2f}s 超出分段结尾 {end:.2f}s（疑似合流截断）")
            # 最后一个音符落在分段起点之前 → 这一段根本没进成片
            if spans and last < start - 0.1:
                row["faults"].append(f"{code} 最后一个音符 {last:.2f}s 早于分段起点 {start:.2f}s（这一段没录进去）")

    for start, end in freeze_scan(path, min_freeze):
        item = {"start": round(start, 3), "end": round(end, 3), "notes": None}
        # 有身份匹配的元数据才能认定准备画面；仍检查超出播放起点的任何静止。
        if any(segments[c][0] <= start and end <= p + 1e-6
               for c, p in playback_starts.items() if p > segments[c][0]):
            item["notes"] = 0
            item["reason"] = "intentional_preplay_hold"
            row["freezes"].append(item)
            continue
        lo, hi = start - pad, end + pad
        # 静止可能跨难度边界，旧的 0.8s 过渡也可能同时覆盖两段，必须检查全部相交段。
        codes = [c for c, (s, e) in segments.items() if s <= hi and e >= lo]
        item["sheet"] = "/".join(codes) or None
        if codes and all(c in spans_by_code for c in codes):
            hit = sum(1 for c in codes for s, e in spans_by_code[c]
                      if s <= min(hi, segments[c][1]) and e >= max(lo, segments[c][0]))
            item["notes"] = hit
            if hit:
                row["faults"].append(
                    f"{item['sheet']} 定格 {start:.2f}–{end:.2f}s（{end - start:.2f}s）窗口内有 {hit} 个音符")
        else:
            row["faults"].append(f"定格 {start:.2f}–{end:.2f}s（无法用谱面判空档，需人工看）")
        row["freezes"].append(item)

    if row["faults"]:
        row["verdict"] = "bad"
    return row


