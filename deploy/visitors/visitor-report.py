#!/usr/bin/env python3
"""Build a privacy-minimal aggregate report from the private visitor SQLite."""
from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import sqlite3
import tempfile
import urllib.request

from ip2region import Reader

SIZE = 11_122_642
GIT_BLOB_SHA1 = "bda1438a83e9ab152f5451d93e2138e35a166a26"
COMMIT = "f8b0792b0cd729f5b2593f690aeed225e49c1967"
MIRRORS = (
    f"https://ghfast.top/https://raw.githubusercontent.com/lionsoul2014/ip2region/{COMMIT}/data/ip2region_v4.xdb",
    f"https://cdn.jsdelivr.net/gh/lionsoul2014/ip2region@{COMMIT}/data/ip2region_v4.xdb",
    f"https://raw.githubusercontent.com/lionsoul2014/ip2region/{COMMIT}/data/ip2region_v4.xdb",
)
BOT = re.compile(r"HeadlessChrome|bot\b|spider|crawler|Playwright|Puppeteer|JubeatDeploymentCheck|JubeatStatsQA|StatsQA|python-requests|Python-urllib|curl/", re.I)
TZ = datetime.timezone(datetime.timedelta(hours=8))


def digest(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def ensure_geo(path, allow_download):
    path = pathlib.Path(path)
    if path.is_file():
        data = path.read_bytes()
        if len(data) == SIZE and digest(data) == GIT_BLOB_SHA1:
            Reader(path)
            return path
        raise ValueError("cached IP2region database failed verification")
    if not allow_download:
        raise FileNotFoundError(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    for url in MIRRORS:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "JubeatVisitorReport/1.0"})
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(SIZE + 1)
            if len(data) != SIZE or digest(data) != GIT_BLOB_SHA1:
                continue
            fd, temporary = tempfile.mkstemp(prefix=".ip2region-", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                Reader(temporary)
                os.chmod(temporary, 0o600)
                os.replace(temporary, path)
            finally:
                pathlib.Path(temporary).unlink(missing_ok=True)
            return path
        except (OSError, ValueError):
            continue
    raise RuntimeError("no verified IP2region mirror was reachable; the previous cache was preserved")


def device(ua):
    if re.search(r"iPad|Tablet", ua, re.I) or ("Android" in ua and "Mobile" not in ua):
        return "平板"
    if re.search(r"iPhone|iPod|Android|Mobile", ua, re.I):
        return "手机"
    if re.search(r"Windows|Macintosh|X11|Linux", ua, re.I):
        return "电脑"
    return "未知"


def browser(ua):
    if "MicroMessenger" in ua:
        return "微信内置"
    if re.search(r"Edg/|EdgA/|EdgiOS/", ua):
        return "Edge"
    if re.search(r"Chrome/|CriOS/", ua):
        return "Chrome/Chromium"
    if re.search(r"Firefox/|FxiOS/", ua):
        return "Firefox"
    if "Safari/" in ua:
        return "Safari"
    return "其他/未知"


def load_events(db_path, cutoff):
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    connection.execute("PRAGMA query_only=ON")
    try:
        rows = connection.execute("SELECT payload FROM events WHERE at>=? ORDER BY at", (cutoff,))
        events = []
        seen = set()
        for (payload,) in rows:
            try:
                event = json.loads(payload)
                event_id = event.get("event_id")
                if not event_id or event_id in seen or BOT.search(str(event.get("ua") or "")):
                    continue
                if event.get("event") not in {
                    "page", "song", "app_ready", "library_ready", "library_error", "chart_ready", "chart_error",
                    "audio_ready", "audio_error", "play_start", "play_25", "play_75", "play_complete", "play_error",
                    "share_open", "share_complete",
                }:
                    continue
                at = int(datetime.datetime.fromisoformat(event["time"].replace("Z", "+00:00")).timestamp())
                if at < cutoff:
                    continue
                seen.add(event_id)
                event["_at"] = at
                events.append(event)
            except (KeyError, TypeError, ValueError):
                continue
        return events
    finally:
        connection.close()


def aggregate(events, now, geo_reader=None):
    visitors = collections.defaultdict(list)
    days = collections.defaultdict(lambda: {"page_views": 0, "song_selections": 0, "visitors": set()})
    funnel = collections.Counter()
    songs = {}
    devices = collections.Counter()
    browsers = collections.Counter()
    for event in events:
        identity = str(event.get("visitor") or "")
        if not identity:
            continue
        visitors[identity].append(event)
        event_type = event["event"]
        funnel[event_type] += 1
        local = datetime.datetime.fromtimestamp(event["_at"], TZ)
        day = days[local.strftime("%Y-%m-%d")]
        day["visitors"].add(identity)
        if event_type == "page":
            day["page_views"] += 1
        if event_type == "song":
            day["song_selections"] += 1
            song = str(event.get("song") or "")
            if song:
                row = songs.setdefault(song, {"song": song, "title": str(event.get("title") or song), "selections": 0, "visitors": set(), "last_at": 0})
                row["selections"] += 1
                row["visitors"].add(identity)
                row["last_at"] = max(row["last_at"], event["_at"])
    geography = collections.defaultdict(lambda: {"visitors": 0, "page_views": 0, "song_selections": 0})
    for identity, items in visitors.items():
        first = next(iter(items))
        ua = str(first.get("ua") or "")
        devices[device(ua)] += 1
        browsers[browser(ua)] += 1
        if geo_reader is not None:
            public = next((ipaddress.ip_address(item["ip"]) for item in items if item.get("ip") and ipaddress.ip_address(item["ip"]).is_global), None)
            if public and public.version == 4:
                fields = (geo_reader.search(str(public)).split("|") + [""] * 5)[:5]
                clean = lambda value: "" if value in ("", "0", "-") else value
                country, province, city = map(clean, fields[:3])
                key = (country or "未知", province, city or province or "城市未知")
                row = geography[key]
                row["visitors"] += 1
                row["page_views"] += sum(item["event"] == "page" for item in items)
                row["song_selections"] += sum(item["event"] == "song" for item in items)
    top = sorted(songs.values(), key=lambda row: (-row["selections"], -row["last_at"], row["song"]))[:10]
    for row in top:
        row["visitors"] = len(row["visitors"])
        row.pop("last_at", None)
    return {
        "generated_at": datetime.datetime.fromtimestamp(now, TZ).isoformat(),
        "window_days": 7,
        "timezone": "Asia/Shanghai",
        "totals": {
            "visitors": len(visitors),
            "page_views": funnel["page"],
            "song_selections": funnel["song"],
            "song_visitors": sum(any(item["event"] == "song" for item in items) for items in visitors.values()),
        },
        "daily": [{"date": day, "visitors": len(row["visitors"]), "page_views": row["page_views"], "song_selections": row["song_selections"]} for day, row in sorted(days.items())],
        "funnel": dict(sorted(funnel.items())),
        "devices": dict(sorted(devices.items())),
        "browsers": dict(sorted(browsers.items())),
        "geography": [
            {"country": key[0], "province": key[1], "city": key[2], **row}
            for key, row in sorted(geography.items(), key=lambda item: (-item[1]["visitors"], item[0]))
        ],
        "top_songs": top,
    }


def write_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".visitor-report-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--geo-db", type=pathlib.Path)
    parser.add_argument("--allow-download", action="store_true")
    parser.add_argument("--no-geo", action="store_true")
    args = parser.parse_args()
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    reader = None
    try:
        if not args.no_geo and args.geo_db:
            reader = Reader(ensure_geo(args.geo_db, args.allow_download))
        events = load_events(args.db, now - 7 * 86400)
        report = aggregate(events, now, reader)
        write_atomic(args.out / "latest.json", report)
        write_atomic(args.out / (datetime.datetime.fromtimestamp(now, TZ).strftime("%Y-%m-%d") + ".json"), report)
        print(json.dumps({"ok": True, "visitors": report["totals"]["visitors"], "top_songs": len(report["top_songs"])}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
