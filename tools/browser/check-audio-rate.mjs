import { chromium } from "playwright";

const base = process.env.JUBEAT_PREVIEW_URL || "http://127.0.0.1:18767/";
const song = process.env.JUBEAT_AUDIO_SONG || (
  base.includes("thregren.world")
    ? "jubeat-festo/首次收录/arcade_90000093"
    : "v0/song000"
);
const edge = process.env.BROWSER_EXECUTABLE
  || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const rates = ["1.25", "0.5", "2", "0.75", "1", "0.25", "1.5", "1"];

const browser = await chromium.launch({
  headless: true,
  executablePath: edge,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") {
      const location = message.location().url || "";
      const optionalStoryCatalog = location.endsWith("/data/background-stories.json")
        && message.text().includes("404");
      if (!optionalStoryCatalog) errors.push(`${message.text()} @ ${location || "unknown"}`);
    }
  });

  await page.goto(`${base}?song=${encodeURIComponent(song)}&chart=EXT`, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  try {
    await page.waitForFunction(songId => {
      const player = window.__player;
      return player?.state?.song?.id === songId
        && player?.state?.chart
        && !document.querySelector("#btnPlay")?.disabled;
    }, song, { timeout: 30000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      player: !!window.__player,
      song: window.__player?.state?.song?.id,
      chart: !!window.__player?.state?.chart,
      playDisabled: document.querySelector("#btnPlay")?.disabled,
    }));
    throw new Error(`${error.message}\nplayer state: ${JSON.stringify(state)}`);
  }

  await page.evaluate(() => {
    const audio = document.querySelector("#audio");
    const samples = [];
    const events = [];
    const originalLoad = audio.load.bind(audio);
    let loads = 0;
    audio.load = () => {
      loads += 1;
      events.push({ type: "load", at: performance.now(), currentTime: audio.currentTime });
      return originalLoad();
    };
    for (const type of ["ratechange", "seeking", "seeked", "waiting", "playing", "pause", "ended"]) {
      audio.addEventListener(type, () => {
        events.push({
          type,
          at: performance.now(),
          currentTime: audio.currentTime,
          playbackRate: audio.playbackRate,
          readyState: audio.readyState,
        });
      });
    }
    const capture = () => {
      const player = window.__player;
      samples.push({
        at: performance.now(),
        currentTime: audio.currentTime,
        playbackRate: audio.playbackRate,
        paused: audio.paused,
        seeking: audio.seeking,
        readyState: audio.readyState,
        rawAudio: player.audioNow(),
        rawMedia: player.rawMediaTime(),
        currentMedia: player.currentMediaTime(),
        renderMedia: player.renderMediaTime(),
        playing: player.state.playing,
      });
    };
    window.__audioRateProbe = { samples, events, capture, loads: () => loads };
    const timer = setInterval(capture, 50);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  });

  await page.evaluate(() => window.__player.play());
  await page.waitForFunction(() => {
    const audio = document.querySelector("#audio");
    return window.__player.state.playing
      && window.__player.audioNow() > 0.2
      && (!audio.paused || window.__player.backend.mode === "webaudio");
  }, null, { timeout: 30000 });

  for (const rate of rates) {
    await page.selectOption("#rate", rate);
    await page.waitForTimeout(650);
    const current = await page.evaluate(() => {
      const audio = document.querySelector("#audio");
      return {
        rate: audio.playbackRate,
        time: audio.currentTime,
        playback: window.__player.state.playing,
      };
    });
    console.log(JSON.stringify({ switchedTo: rate, ...current }));
  }

  await page.waitForTimeout(700);
  const result = await page.evaluate(() => {
    window.__audioRateProbe.capture();
    return {
      samples: window.__audioRateProbe.samples,
      events: window.__audioRateProbe.events,
      loads: window.__audioRateProbe.loads(),
    };
  });
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  if (result.loads !== 1) throw new Error(`expected one media load, got ${result.loads}`);

  // The first WebAudio -> media-element handoff seeks to the current
  // position. All later rate changes must only update playbackRate.
  const seekEvents = result.events.filter(event => event.type === "seeking" || event.type === "seeked");
  const handoffAt = seekEvents.find(event => event.type === "seeking")?.at;
  const uncountedSeek = seekEvents.find(event => handoffAt == null || event.at > handoffAt + 1000);
  if (seekEvents.length > 2 || !seekEvents.some(event => event.type === "seeked") || uncountedSeek) {
    throw new Error(`rate changes unexpectedly sought: ${JSON.stringify(seekEvents)}`);
  }

  const samples = result.samples;
  const clockFailures = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!previous.playing || !current.playing) continue;
    const wall = (current.at - previous.at) / 1000;
    const expectedMax = wall * Math.max(previous.playbackRate, current.playbackRate) + 0.18;
    for (const [label, key] of [
      ["audio element", "currentTime"],
      ["raw media", "rawMedia"],
      ["chart media", "currentMedia"],
      ["render media", "renderMedia"],
    ]) {
      const delta = current[key] - previous[key];
      if (delta < -0.02) {
        clockFailures.push({ clock: label, kind: "backwards", delta, previous, current });
      } else if (delta > expectedMax) {
        clockFailures.push({ clock: label, kind: "jump", delta, expectedMax, previous, current });
      }
    }
  }
  if (clockFailures.length) {
    throw new Error(`media clocks lost continuity: ${JSON.stringify(clockFailures.slice(0, 4))}`);
  }

  const summary = result.events
    .filter(event => ["load", "ratechange", "waiting", "playing", "pause"].includes(event.type))
    .map(event => ({ type: event.type, currentTime: Number(event.currentTime.toFixed(3)), playbackRate: event.playbackRate }));
  console.log(JSON.stringify({ loads: result.loads, samples: samples.length, events: summary }, null, 2));
} finally {
  await browser.close();
}
