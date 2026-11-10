import { chromium } from "playwright";
import fs from "node:fs";

const base = process.env.JUBEAT_PREVIEW_URL || "http://127.0.0.1:18767/";
const song = process.env.JUBEAT_AUDIO_SONG || (
  base.includes("thregren.world")
    ? "jubeat-festo/首次收录/arcade_90000093"
    : "v0/song000"
);
const edgePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const edge = process.env.BROWSER_EXECUTABLE
  || (fs.existsSync(edgePath) ? edgePath : chromePath);
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
      ...(!previous.paused && !current.paused ? [["audio element", "currentTime"]] : []),
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

  // Verify density-bar scrubbing under variable-speed playback (including rapid
  // back-to-back scrubs while the previous media seek/resume is still settling).
  await page.selectOption("#rate", "0.75");
  const scrubCheck = await page.evaluate(async () => {
    const audio = document.querySelector("#audio");
    const canvas = document.querySelector("#densityCanvas");
    const player = window.__player;
    const rect = canvas.getBoundingClientRect();
    let playedDuringScrub = false;
    const onPlaying = () => {
      if (player.state.scrubbing) playedDuringScrub = true;
    };
    audio.addEventListener("playing", onPlaying);
    const dispatch = (type, ratio, pointerId = 1) => {
      const clientX = rect.left + Math.max(8, Math.min(rect.width - 8, rect.width * ratio));
      const clientY = rect.top + rect.height * 0.5;
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId,
        clientX,
        clientY,
      }));
    };
    try {
      dispatch("pointerdown", 0.25, 11);
      dispatch("pointermove", 0.35, 11);
      dispatch("pointerup", 0.35, 11);
      // Immediately start a second scrub before the first async seek/resume settles.
      dispatch("pointerdown", 0.40, 12);
      await new Promise(resolve => setTimeout(resolve, 60));
      const midScrubPaused = audio.paused && !player.state.playing && player.state.scrubbing;
      dispatch("pointermove", 0.55, 12);
      dispatch("pointerup", 0.55, 12);
      const targetMedia = player.currentMediaTime();
      const deadline = performance.now() + 8000;
      while (performance.now() < deadline) {
        if (player.state.playing && !audio.paused && !audio.seeking) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const resumedMedia = player.renderMediaTime();
      // v0.6.56: 真正要验的是「marker 用的画面时间」与「音乐播放头」是否同拍。
      // 旧断言只比较两个都来自 audioNow() 的内部时钟，画面整体漂移也照样通过。
      const off = (Number(window.JubeatApp.els.offset.value) || 0) / 1000;
      const base = window.JubeatApp.state.baseOffset || 0;
      const bias = () => player.renderMediaTime() - (audio.currentTime + off - base);
      const biases = [];
      for (let sample = 0; sample < 10; sample += 1) {
        biases.push(bias());
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const advancedMedia = player.renderMediaTime();
      return {
        playedDuringScrub,
        midScrubPaused,
        playing: player.state.playing,
        paused: audio.paused,
        rate: audio.playbackRate,
        targetMedia,
        resumedMedia,
        advancedMedia,
        biases,
        loads: window.__audioRateProbe.loads(),
      };
    } finally {
      audio.removeEventListener("playing", onPlaying);
    }
  });
  if (scrubCheck.playedDuringScrub || !scrubCheck.midScrubPaused) {
    throw new Error(`audio leaked during density scrub: ${JSON.stringify(scrubCheck)}`);
  }
  if (!scrubCheck.playing || scrubCheck.paused || scrubCheck.rate !== 0.75 || scrubCheck.loads !== 1) {
    throw new Error(`variable-speed scrub failed to resume cleanly: ${JSON.stringify(scrubCheck)}`);
  }
  if (Math.abs(scrubCheck.resumedMedia - scrubCheck.targetMedia) > 0.35
      || scrubCheck.advancedMedia <= scrubCheck.resumedMedia + 0.08) {
    throw new Error(`variable-speed scrub desynchronized chart clock: ${JSON.stringify(scrubCheck)}`);
  }
  // Marker 判定帧与音乐播放头的相位差：绝对值要小，更关键的是**不能随播放漂移**。
  // 官方 marker 一帧约 33.3ms 真实时间；旧版单调 floor 会在拖动后留下持续漂移。
  const biases = scrubCheck.biases;
  const maxAbsBias = Math.max(...biases.map(value => Math.abs(value)));
  const biasDrift = Math.max(...biases) - Math.min(...biases);
  if (maxAbsBias > 0.08 || biasDrift > 0.033) {
    throw new Error(`variable-speed scrub left markers out of sync with music: ${JSON.stringify({
      maxAbsBias, biasDrift, biases,
    })}`);
  }

  const summary = result.events
    .filter(event => ["load", "ratechange", "waiting", "playing", "pause"].includes(event.type))
    .map(event => ({ type: event.type, currentTime: Number(event.currentTime.toFixed(3)), playbackRate: event.playbackRate }));
  console.log(JSON.stringify({ loads: result.loads, samples: samples.length, events: summary }, null, 2));
} finally {
  await browser.close();
}
