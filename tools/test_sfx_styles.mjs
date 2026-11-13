/**
 * v5 静态契约检查：只读源码，断言「已删除的代码分支」不再存在。
 *
 * 这里刻意宽容注释 —— 注释里出现「旧版存过 clap / billy / nyan」等已删除分组
 * 这类说明是合理的，不该报错。所以先用一个小词法器把行注释 / 块注释去掉，
 * 只在剩下的「代码」里匹配禁用标识。也不假设 A/B/C/D 的具体实现细节，
 * 只检查契约里明确要求删掉的分支标识。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const STATIC_DIR = new URL('../jubeat_viewer/player/static/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, STATIC_DIR), 'utf8');

/** 去掉 JS 的行注释与块注释，但保留字符串 / 模板字面量里的 // 等字样。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';   // code | line | block | squote | dquote | template
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '*') {state = 'block'; i += 2; continue;}
      if (c === '/' && n === '/') {state = 'line'; i += 2; continue;}
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'squote' : c === '"' ? 'dquote' : 'template';
        out += c; i++; continue;
      }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') {state = 'code'; out += c;}
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {state = 'code'; i += 2; continue;}
      if (c === '\n') out += c;
      i++; continue;
    }
    // 字符串内部：遇到匹配引号（考虑转义）才退出
    const quote = state === 'squote' ? "'" : state === 'dquote' ? '"' : '`';
    if (c === '\\') {out += c + (n == null ? '' : n); i += 2; continue;}
    if (c === quote) {state = 'code'; out += c; i++; continue;}
    out += c; i++; continue;
  }
  return out;
}

const code = Object.fromEntries(
  ['sfx.js', 'app-audio.js', 'core.js', 'app-wiring.js', 'app-base.js']
    .map(name => [name, stripComments(read(name))]),
);
const html = read('index.html');   // HTML 不走 JS 词法器，只做属性级精确匹配

/** 合法音色组（v5：「拍手」组已删除）。 */
const LEGAL_KINDS = ['click', 'taiko'];

/** 只匹配「代码分支」：字符串字面量、函数定义 / 调用、档位比较，不做整词通杀。 */
const RULES = [
  {
    file: 'sfx.js',
    forbidden: [
      [/\bsoundSixteenthMark\b/, '跨组 16 分签名函数已删除'],
      [/\bsoundChord\b/, '跨组三音和弦签名已删除'],
      [/\bsoundNyan\b/, 'nyan 合成音已删除'],
      [/\bbilly\b/i, 'billy 分组已删除'],
      [/\bnyan\b/i, 'nyan 分组已删除'],
      [/["']accent["']/, 'accent 档已删除'],
      [/chord\.ogg/i, '自定义 chord.ogg 已删除'],
      [/\bsoundClap16\b/, '拍手组 16 分档 voice 已删除'],
      [/\bsoundClapChord\b/, '拍手组和弦档 voice 已删除'],
      [/\bsoundClap\b/, '拍手组 normal 档 voice 已删除'],
      [/\bclapBurst\b/, 'clapBurst 发声核已删除'],
      [/\bSFX_VOICES\s*\.\s*clap\b/, 'SFX_VOICES 不再有拍手组'],
      [/\bSFX_LEVELS\s*\.\s*clap\b/, 'SFX_LEVELS 不再有拍手组'],
    ],
  },
  {
    file: 'app-audio.js',
    forbidden: [
      [/["']billy/i, 'billy 素材名 / 分组字符串已删除'],
      [/["']nyan/i, 'nyan 素材名 / 分组字符串已删除'],
      [/["']accent["']/, 'accent 档字符串已删除'],
      [/variant\s*===\s*["']accent/, '不再按 accent 档位分支'],
      [/\bsoundSixteenthMark\b/, '不再调用跨组 16 分签名'],
      [/\bsoundChord\b/, '不再调用跨组三音和弦签名'],
      [/\bsoundNyan\b/, '不再调用 nyan 合成音'],
      [/chord\.ogg/i, '自定义 chord.ogg 支持已删除'],
      [/["']clap["']/, 'metroSound 取值不再有 clap（旧值迁移到 click）'],
      [/\bsoundClap16\b/, '不再调用拍手组 16 分档'],
      [/\bsoundClapChord\b/, '不再调用拍手组和弦档'],
      [/\bsoundClap\b/, '不再调用拍手组 normal 档'],
      [/\bclapBurst\b/, '不再调用 clapBurst'],
      [/\bSFX_VOICES\s*\.\s*clap\b/, 'SFX_VOICES 不再有拍手组'],
      [/\bSFX_LEVELS\s*\.\s*clap\b/, 'SFX_LEVELS 不再有拍手组'],
      [/\bpreviewSfxSequence\b/, '整段试听排程 previewSfxSequence 已彻底删除'],
    ],
  },
  {
    file: 'core.js',
    forbidden: [
      [/["']accent["']/, 'hitSoundKind 不再返回 accent'],
      [/return\s+["']accent["']/, 'hitSoundKind 不再有 accent 分支'],
      [/%\s*4/, '删除取模 4 的重音判定'],
    ],
  },
  {
    file: 'app-wiring.js',
    forbidden: [
      [/["']billy/i, '恢复设置里不再有 billy 硬编码'],
      [/["']nyan/i, '恢复设置里不再有 nyan 硬编码'],
    ],
  },
];

for (const {file, forbidden} of RULES) {
  test(`静态契约：${file} 代码里不存在已删除的分支（注释里的合理提及除外）`, () => {
    const src = code[file];
    assert.ok(src.length > 0, `${file} 源码可读`);
    for (const [pattern, why] of forbidden) {
      assert.doesNotMatch(src, pattern, `${file}: ${why}`);
    }
  });
}

test('合法音色组只有 click / taiko：#metroSound 的 option 集合恰为 关 / click / taiko', () => {
  const select = html.match(/<select[^>]*id=["']metroSound["'][\s\S]*?<\/select>/);
  assert.ok(select, 'index.html 必须有 #metroSound');
  const values = [...select[0].matchAll(/<option[^>]*value=["']([^"']*)["']/g)].map(m => m[1]);
  assert.deepEqual(values.sort(), ['', ...LEGAL_KINDS].sort(), '#metroSound 只允许关 / click / taiko');
});

test('normalizedKind 只认 click / taiko（clap 已被静音兜底）', () => {
  const src = code['app-audio.js'];
  const fn = src.match(/function\s+normalizedKind\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(fn, 'app-audio.js 必须定义 normalizedKind');
  for (const kind of LEGAL_KINDS) {
    assert.match(fn[1], new RegExp(`["']${kind}["']`), `normalizedKind 必须接受 ${kind}`);
  }
  assert.doesNotMatch(fn[1], /["']clap["']/, 'normalizedKind 不得再把 clap 当合法分组');
});

test('#sfxAudition 试听按钮与 els.sfxAudition 已删除', () => {
  assert.doesNotMatch(html, /\bid=["']sfxAudition["']/, 'index.html 不得再有 #sfxAudition');
  assert.doesNotMatch(html, /<option[^>]*value=["']clap["']/,
    'index.html 不得再有 value="clap" 的音色选项');
  const base = code['app-base.js'];
  assert.doesNotMatch(base, /\bsfxAudition\b/, 'app-base.js 的 els / OPTIONAL_ELS 不得再有 sfxAudition');
  const optional = base.match(/OPTIONAL_ELS\s*=\s*new\s+Set\s*\(([\s\S]*?)\)\s*;/);
  assert.ok(optional, 'app-base.js 必须定义 OPTIONAL_ELS');
  assert.doesNotMatch(optional[1], /\bsfxAudition\b/, 'OPTIONAL_ELS 不得含已删除的元素');
});

test('音效总线：SFX_BUS / limiterCurve / preGain + 软限幅，且 oversample 必须 none', () => {
  const src = code['app-audio.js'];
  const bus = src.match(/const\s+SFX_BUS\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(bus, 'app-audio.js 必须定义 SFX_BUS');
  for (const key of ['preGain', 'limiterDrive', 'limiterCeiling']) {
    assert.match(bus[1], new RegExp(`\\b${key}\\s*:`), `SFX_BUS.${key} 必须存在`);
  }
  assert.match(src, /function\s+limiterCurve\s*\(/, '必须定义 limiterCurve');

  const fn = src.match(/function\s+sfxBus\s*\(\s*\)\s*\{[\s\S]*?\n\s{2}\}\s*\n/);
  assert.ok(fn, 'app-audio.js 必须定义 sfxBus');
  assert.match(fn[0], /createWaveShaper/, 'sfxBus 必须插入 WaveShaper 软限幅');
  assert.doesNotMatch(fn[0], /createDynamicsCompressor/,
    '不得依赖 DynamicsCompressor 的自动 makeup（跨引擎不一致）');
  assert.match(fn[0], /limiterCurve\s*\(/, 'sfxBus 必须用 limiterCurve 作为削波曲线');
  assert.match(fn[0], /oversample\s*=\s*["']none["']/,
    'oversample 必须是 none（2x/4x 的插值过冲会让峰值反超天花板）');
  assert.doesNotMatch(fn[0], /oversample\s*=\s*["'](?:2x|4x)["']/,
    'sfxBus 的限幅器不得改回 2x / 4x 过采样');
});

test('去注释器本身有效：注释里的禁用词不会误报，代码里的会保留', () => {
  const sample = [
    '// 旧版存过 billy / nyan / accent，现已删除',
    '/* soundSixteenthMark 与 soundChord 已废弃 */',
    'const kind = "click"; // 合法',
    'const bad = "billy";',
  ].join('\n');
  const stripped = stripComments(sample);
  assert.doesNotMatch(stripped, /旧版存过|已废弃|现已删除/, '注释正文应被去掉');
  assert.match(stripped, /"billy"/, '代码里的字符串必须保留下来供检查');
  assert.match(stripped, /"click"/);
});
