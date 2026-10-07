#!/usr/bin/env python3
"""Read-only site availability, cache, TLS and latency checks with local history."""
from __future__ import annotations
import argparse, datetime, gzip, io, json, socket, ssl, statistics, time, urllib.request
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://ub.thregren.world")
    parser.add_argument("--state", type=Path, default=Path(__file__).resolve().parent.parent / "cache/site-monitor.json")
    args = parser.parse_args(); base = args.url.rstrip("/")
    try:
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError: context = ssl.create_default_context()
    problems = []; timings = {}; info = {}
    def fetch(path, expected=200, headers=None):
        start = time.monotonic()
        req = urllib.request.Request(base + path, headers={"Accept-Encoding":"gzip", "User-Agent":"Jubeat-site-monitor/1.0", **(headers or {})})
        with urllib.request.urlopen(req, timeout=20, context=context) as response:
            if response.status != expected: raise ValueError(f"{path}: status {response.status}")
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024: raise ValueError("resource too large")
            if response.headers.get("Content-Encoding") == "gzip":
                body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024: raise ValueError("decoded resource too large")
            timings[path] = round(time.monotonic()-start, 3)
            return body, response.headers
    try:
        _, headers = fetch("/")
        for key in ("Content-Security-Policy", "Strict-Transport-Security", "X-Content-Type-Options"):
            if not headers.get(key): problems.append("missing header: " + key)
        catalog, _ = fetch("/data/library.json"); catalog = json.loads(catalog)
        report, _ = fetch("/data/build.json"); report = json.loads(report)
        songs = catalog.get("songs", [])
        if not songs or report.get("songs") != len(songs) or report.get("failed_count"):
            problems.append("catalog/build report mismatch")
        info.update(version=report.get("version"), songs=len(songs), charts=sum(len(s.get("charts", [])) for s in songs))
        audio = next((s["assets"]["audio"] for s in songs if s.get("assets", {}).get("audio")), "media/audio/jubeat-saucer/Windy%20Fairy.ogg")
        data, audio_headers = fetch("/" + audio, 206, {"Range":"bytes=0-1023"})
        if len(data) != 1024 or data[:4] != b"OggS" or not audio_headers.get("Content-Range"): problems.append("audio range check failed")
        hostname = urllib.parse.urlsplit(base).hostname
        with socket.create_connection((hostname,443), timeout=15) as connection:
            with context.wrap_socket(connection, server_hostname=hostname) as tls:
                expires = datetime.datetime.strptime(tls.getpeercert()["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
                days = (expires-datetime.datetime.now(datetime.timezone.utc)).total_seconds()/86400
                info["tls_days_left"] = round(days, 1)
                if days < 21: problems.append("TLS certificate expires in less than 21 days")
    except Exception as error:
        problems.append(type(error).__name__ + ": " + str(error)[:200])
    try: history = json.loads(args.state.read_text())
    except FileNotFoundError: history = []
    except (ValueError, OSError): history = []; problems.append("monitor history could not be read")
    samples = [x["timings"]["/"] for x in history[-24:] if "/" in x.get("timings", {}) and not x.get("problems")]
    if timings.get("/", 0) > max(2.0, statistics.median(samples)*4 if samples else 2.0): problems.append("homepage latency exceeds baseline")
    result = {"checked_at":datetime.datetime.now(datetime.timezone.utc).isoformat(), "info":info, "timings":timings, "problems":problems}
    args.state.parent.mkdir(parents=True, exist_ok=True)
    temp = args.state.with_suffix(".tmp"); temp.write_text(json.dumps((history+[result])[-168:],ensure_ascii=False,indent=2)); temp.replace(args.state)
    print(json.dumps(result,ensure_ascii=False)); return 1 if problems else 0

if __name__ == "__main__": raise SystemExit(main())
