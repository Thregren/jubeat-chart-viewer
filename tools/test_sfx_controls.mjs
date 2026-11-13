import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const wiring = fs.readFileSync(new URL('../jubeat_viewer/player/static/app-wiring.js', import.meta.url), 'utf8');
const base = fs.readFileSync(new URL('../jubeat_viewer/player/static/app-base.js', import.meta.url), 'utf8');

/**
 * 分享页是构建时生成的静态快照，后加的控件（同押开关）不会出现在里面。
 * 这里用一份「万能元素」把 bindEvents 完整跑一遍，模拟两种页面：
 *   full  —— 入口页，控件齐全
 *   share —— 分享页，chordSound 不存在（querySelector 返回 null）
 *
 * 「试听三档」按钮已删除：页面里根本没有 #sfxAudition，
 * 所以 els.sfxAudition 恒为 undefined，bindEvents 也不得再去绑定它。
 *
 * opts.saved 用来喂给 store() 的读取结果，便于验证「旧设置迁移」这类恢复逻辑。
 */
function boot(missing, opts = {}) {
  const any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'options') return [];
      if (prop === 'matches') return false;
      if (prop === 'length') return 0;
      if (['value', 'checked', 'textContent', 'disabled', 'hidden'].includes(prop)) return '';
      return any;
    },
    apply() { return any; },
    set() { return true; },
    has() { return true; },
    deleteProperty() { return true; },
  });

  const listeners = {};
  const controls = {
    // v5：只有 关 / 点击 / 太鼓 三项，「拍手」组已删除。
    // 下拉框初始值取「点击」——和 index.html 的默认一致。
    metroSound: {
      value: 'click',
      options: [{value: ''}, {value: 'click'}, {value: 'taiko'}],
      addEventListener() {},
    },
  };
  if (!missing.includes('chordSound')) {
    controls.chordSound = {checked: false, addEventListener(type, fn) {listeners['chord:' + type] = fn;}};
  }
  const els = new Proxy({}, {
    get(_target, prop) {
      if (prop in controls) return controls[prop];
      if (missing.includes(prop)) return null;
      // 已删除的控件：元素不存在，属性读取必须是 undefined（当作金丝雀）。
      if (prop === 'sfxAudition') return undefined;
      return any;
    },
  });

  const calls = {prepareSfx: 0, previewSfx: []};
  const writes = [];
  const saved = opts.saved || {};
  // 单参 = 读，双参 = 写；把键名做成有意义的字符串，而不是全 '' 的 Proxy
  function store(key, value) {
    if (value === undefined) return Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : null;
    writes.push({key, value});
    return undefined;
  }
  const STORAGE = new Proxy({}, {get: (_t, prop) => typeof prop === 'string' ? prop : undefined});

  const A = {
    els, state: {}, markerCfg: {}, numCfg: {},
    services: {register() {}, renderer: {mode: 'auto'}},
    STORAGE,
    GLOW_PAIRS: [],
    store,
    el: () => any, frontVersion: () => '0.7.0', toast() {}, renumberCurrent() {},
    fmtTime: () => '', playMetro() {}, sfxReset() {}, setPlaying() {}, selectMarker() {},
    layoutCanvas() {}, refreshCanvas() {}, glowPair: () => ({main: '', alt: ''}),
    density: {placeholder: false}, layoutDensity() {}, drawDensity() {}, densitySeekFromEvent: () => 0,
    bucketInfo: () => '', tapAB() {}, clearAB() {}, updateABButton() {}, setCollapsed() {},
    setSidebarOpen() {}, loadLibrary() {}, renderList() {}, loadChart() {}, backend: {},
    bindLoadEvents() {}, startBufferAt() {}, sidebarJustOpened: () => false,
    keepAudioAlive() {}, audioNow: () => 0, currentMediaTime: () => 0, seekTo() {},
    play() {}, pause() {}, togglePlay() {}, restart() {}, resumeAfterSeek() {},
    settleAfterSeek() {}, stop() {}, requestPaint() {}, resourcePath: s => s,
    normalizeHexColor: v => v || '#ffffff', normalizeChordStyle: v => v || 'glow',
    clampNumScale: v => v, clampNumAlpha: v => v, clampNumGlowAlpha: v => v,
    prepareSfx() {calls.prepareSfx++;}, previewSfx(v) {calls.previewSfx.push(v);},
  };

  const document = {
    hidden: false, fonts: null,
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => any, createElement: () => any,
    addEventListener() {}, body: {appendChild() {}, classList: {contains: () => false}},
    documentElement: {dataset: {}},
  };
  const window = {
    JubeatApp: A,
    JubeatRuntime: {
      RequestScope: class {
        start() {return {signal: null};}
        current() {return false;}
        cancel() {}
        finish() {}
      },
    },
    JubeatSongLinks: {install() {}},
    JubeatCore: {soundEffectVolume: v => v || 60},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    addEventListener() {},
  };
  class ResizeObserver {observe() {}}
  const removeItems = [];
  const localStorage = {length: 0, key: () => null,
    removeItem(key) {removeItems.push(key);}, getItem: () => null, setItem() {}};
  vm.runInNewContext(wiring, {
    window, document, console, URLSearchParams, Date, Promise, ResizeObserver,
    location: {search: '', pathname: '/'}, performance: {now: () => 0},
    localStorage, sessionStorage: {getItem: () => null, setItem() {}},
    setTimeout: () => 0, clearTimeout() {}, Option: function () {}, Event: function () {},
  });
  return {A, listeners, controls, calls, writes, removeItems};
}

test('分享页缺少同押开关时，交互绑定不会中途抛错，也不会去找已删除的试听按钮', () => {
  const h = boot(['chordSound']);
  assert.doesNotThrow(() => h.A.bindEvents());
  assert.equal(h.listeners['chord:change'], undefined);
  assert.equal(h.listeners['audition:click'], undefined, '不得再绑定 sfxAudition');
  assert.equal(h.A.els.sfxAudition, undefined, '页面里不存在 #sfxAudition');
});

test('入口页绑定同押开关，且没有任何试听按钮回调', () => {
  const h = boot([]);
  assert.doesNotThrow(() => h.A.bindEvents());
  assert.equal(typeof h.listeners['chord:change'], 'function');
  assert.equal(h.listeners['audition:click'], undefined, '试听按钮已删除，不应有 audition:click');
  assert.equal(h.controls.sfxAudition, undefined);
});

test('旧 clap / billy / nyan 等非法 metroSound 设置恢复时迁移为 click 并写回', () => {
  for (const legacy of ['clap', 'billy', 'nyan', 'clap-normal', 'nyan-v2-accent', 'unknown-kind', 'CLICK']) {
    const h = boot([], {saved: {metroSound: legacy}});
    assert.doesNotThrow(() => h.A.bindEvents(), `${legacy}: 恢复设置不得抛错`);
    assert.ok(h.writes.some(w => w.key === 'metroSound' && w.value === 'click'),
      `${legacy}: 必须 store(STORAGE.metroSound, "click") 写回`);
    assert.equal(h.controls.metroSound.value, 'click',
      `${legacy}: restoreSelectValue 必须把下拉框落到 click，而不是「关」`);
  }
});

test('合法的 metroSound 值（含「关」）不需要迁移、不被改写', () => {
  for (const good of ['', 'click', 'taiko']) {
    const h = boot([], {saved: {metroSound: good}});
    assert.doesNotThrow(() => h.A.bindEvents(), `${good}: 恢复设置不得抛错`);
    assert.ok(!h.writes.some(w => w.key === 'metroSound'),
      `${good}: 合法值不应被迁移写回`);
    assert.equal(h.controls.metroSound.value, good, `${good}: 下拉框应保持原值`);
  }
  // 'clap' 已不是合法值：必须迁移（单独列出，避免以后又被加回白名单）。
  const h = boot([], {saved: {metroSound: 'clap'}});
  h.A.bindEvents();
  assert.ok(h.writes.some(w => w.key === 'metroSound' && w.value === 'click'),
    "clap: 已删除的分组必须迁移为 click");
  assert.equal(h.controls.metroSound.value, 'click', 'clap: 下拉框必须落到 click');
  assert.ok(!h.controls.metroSound.options.some(o => o.value === 'clap'),
    '下拉框不应再有 clap 选项');
});

test('「同押独立音效」默认打开：新用户 / 老版本旧默认值都落成勾选', () => {
  // 全新用户：完全没有记录 → 默认开
  const fresh = boot([]);
  fresh.A.bindEvents();
  assert.equal(fresh.controls.chordSound.checked, true,
    '全新用户必须默认开启同押独立音效');

  // 老版本（settingsVersion < 9）存过 "0"：那是旧默认值，必须被忽略一次
  for (const version of ['0', '1', '8']) {
    const h = boot([], {saved: {settingsVersion: version, chordSound: '0'}});
    h.A.bindEvents();
    assert.equal(h.controls.chordSound.checked, true,
      `设置版本 ${version}: 旧默认「关」必须被清掉，改为默认开启`);
    assert.ok(h.removeItems.includes('chordSound'),
      `设置版本 ${version}: 必须清掉旧的 chordSound 记录`);
  }

  // 已经是新版本：尊重用户显式关掉的选择
  const off = boot([], {saved: {settingsVersion: '9', chordSound: '0'}});
  off.A.bindEvents();
  assert.equal(off.controls.chordSound.checked, false,
    '设置版本 9 之后用户显式关闭必须被保留');
  assert.ok(!off.removeItems.includes('chordSound'), '新版本不得再清用户的选择');

  const on = boot([], {saved: {settingsVersion: '9', chordSound: '1'}});
  on.A.bindEvents();
  assert.equal(on.controls.chordSound.checked, true, '新版本显式开启自然是勾选');
});

test('同押开关的默认状态与 index.html 的 checked 属性一致', () => {
  const html = fs.readFileSync(
    new URL('../jubeat_viewer/player/static/index.html', import.meta.url), 'utf8');
  const input = html.match(/<input[^>]*id=["']chordSound["'][^>]*>/);
  assert.ok(input, 'index.html 必须有 #chordSound');
  assert.match(input[0], /\bchecked\b/, '默认打开就必须在 HTML 上写 checked，避免首帧闪一下未勾选');
  assert.match(html, /title="默认开启。开启后，一批同押只发一次/,
    '同押开关的 title 必须说明默认开启');
});

/** app-base.js 启动自检：模拟分享页缺 #chordSound 的情形。 */
function baseBoot(absent) {
  const A = {};
  const element = {};
  const document = {
    baseURI: 'https://ub.thregren.world/',
    querySelector: sel => absent.some(id => sel === '#' + id) ? null : element,
    createElement: () => ({}),
  };
  class Services {register(_name, value) {return value;} dispose() {}}
  class SettingsStore {access() {return null;}}
  class CanvasRenderer {mode = 'auto'; ratio() {return 1;}}
  const window = {
    JubeatApp: A, JubeatCore: {}, JubeatVersions: {order: [], labels: {}},
    JubeatServices: {Services, SettingsStore, CanvasRenderer},
    addEventListener() {}, devicePixelRatio: 1,
  };
  vm.runInNewContext(base, {
    window, document, console, URL, Promise, Date, TextEncoder, Intl,
    localStorage: {getItem: () => null, setItem() {}},
    location: {href: 'https://ub.thregren.world/', origin: 'https://ub.thregren.world'},
    navigator: {userAgent: ''},
  });
  return A;
}

test('分享页缺同押开关时启动自检不会白屏，els 里也不再关联试听按钮', () => {
  const A = baseBoot(['chordSound']);
  assert.doesNotThrow(() => A.assertEls());
  assert.equal(A.els.chordSound, null);
  assert.ok(!('sfxAudition' in A.els), 'els 里不应再有 sfxAudition 这个键');
  // OPTIONAL_ELS 不能靠「把已删除的控件加进白名单」来兜底。
  const optional = base.match(/OPTIONAL_ELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(optional, 'app-base.js 必须还定义 OPTIONAL_ELS');
  assert.doesNotMatch(optional[1], /sfxAudition/, 'OPTIONAL_ELS 不应包含 sfxAudition');
  assert.match(optional[1], /chordSound/, 'chordSound 仍是分享页可缺省的控件');
});

test('其它必需控件缺失时启动自检仍然会报错', () => {
  const A = baseBoot(['songList']);
  assert.throws(() => A.assertEls(), /songList/);
});
