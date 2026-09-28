这一版只调「marker 顺序数字」相关的两处：同押光晕的透明度可自定义，以及数字的出现时机。

## 一、同押光晕透明度可以自定义

以前「同押光晕」只有一个开关（开 / 关），中间没法调。现在选项区多了一根 **「光晕透明度」
滑杆（0–100%）**，只作用于**光晕那一层**：

- 数字背后的彩色大团光晕
- 两圈往外扩的波纹
- 数字本身的霓虹描边（外面那圈散光 + 里面那圈实色）

**白色数字本体不受它影响**——那条线跟着原来的 **「序号透明度」（10–100%）** 走。
所以把光晕拉到 0 就只剩一个干净的白数字（形状、半径、位置完全不变，只是把光晕整层淡掉），
想「只看按键顺序、不想被彩色晃眼」的时候用。

实现上给 `numCfg` 加了 `glowAlpha`（在 `app-base.js`），`app-marker.js` 的
`drawOrderNumber()` 里把 `ga = numCfg.glowAlpha` 乘进上面三处（halo 的两个
`addColorStop`、两圈波纹的 `globalAlpha`、霓虹描边的 `shadowColor`/`strokeStyle`
和第二层的 `globalAlpha`）。注意它的 clamp **允许 0**（`Number.isFinite` 判断，
不能用 `Number(v) || 1`，否则 0 会被吞成默认值）。

## 二、顺序数字改成「拍点前 0.10s」出现

以前是 **marker 一出现就画数字**——marker 动画默认 0.8× 速度、整段 ≈0.71s，
于是数字几乎从头挂到尾，看起来**提前一大截**，和实机不一样。

逐帧量 festo 实机录屏（640×480 / 30fps，谱面时间 = 视频时间 + 0.100s）：
**「数字第一次可见」到「爆花第一帧」恒定 3 帧 = 100ms**，7 条 note 一次不差。
分解一下：数字比拍点早 100ms；爆花比拍点晚约 33ms（玩家输入延迟，**官方本身如此，
我们不该跟**——本查看器把爆花钉在拍点上）。所以数字取 **「拍点前 0.10s」**。

改动：`app-marker.js` 新增 `const NUM_LEAD = 0.10;`，调用处从无条件
`drawOrderNumber(...)` 改成 `if (rel >= -NUM_LEAD) drawOrderNumber(...)`。

## 三、验证

| 检查 | 结果 |
|---|---|
| 逐帧量实机录屏（7 条 note 的数字「首次可见 → 爆花」帧数） | 恒定 3 帧 = 100ms，一次不差 |
| 本地定时抓帧（note 拍点 11.385s，采样 11.20 / 11.30 / 11.39） | 11.20 完全不画数字；≈11.29（拍点前 0.10s）首次出现；11.39 仍在闪 |
| 本地定时抓帧（同押组 t=5.538，滑杆 100 vs 0） | 100：青/彩色 halo + 波纹 + 霓虹描边；0：只剩白数字，形状 / 大小不变 |
| `node --check`（app-base / app-marker / app-wiring） | 通过 |
| `tools/set_version.py --check` | 版本号一致：0.6.5 |

## 四、部署 / 更新

曲库不用重传，只更新前端这几个文件（`?v=` 已提到 `0.6.5`）：

```
铺面查看器/player/static/index.html     →  <站点根>/index.html
铺面查看器/player/static/app-base.js    →  <站点根>/static/app-base.js
铺面查看器/player/static/app-marker.js  →  <站点根>/static/app-marker.js
铺面查看器/player/static/app-wiring.js  →  <站点根>/static/app-wiring.js
```
