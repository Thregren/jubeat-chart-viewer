#!/usr/bin/env python3
"""生成节拍音「咚」（se/don.wav）。

背景：原来那份 don 是纯低频闷鼓（频谱重心 ~250Hz），笔记本 / 手机小喇叭上基本
听不见，只有音量拉大才勉强能分辨。这里重新合成一版「又能听出是鼓、又听得清」的
咚：低频鼓皮保持在，但补上击打瞬态（啪）、中频穿透层和一点点软削波谐波，
让它在小喇叭上也有存在感。

用法：

    python3 tools/make_don.py            # 覆盖写 se/don.wav
    python3 tools/make_don.py --out a.wav

产物不入库（se/ 被 .gitignore 排除），构建时会复制到 site/media/se/。
"""

from __future__ import annotations

import argparse
import struct
import wave
from pathlib import Path

import numpy as np

SR = 44100
DUR = 0.24


def _t() -> np.ndarray:
    return np.arange(int(SR * DUR)) / SR


def _exp_env(t: np.ndarray, tau: float, attack: float = 0.0015) -> np.ndarray:
    """极快起音 + 指数衰减的包络，避免 0 处爆点（pop）。"""
    env = np.exp(-t / tau)
    a = max(int(attack * SR), 1)
    env[:a] *= np.linspace(0.0, 1.0, a) ** 2
    return env


def _sweep(t: np.ndarray, f0: float, f1: float, tau: float) -> np.ndarray:
    """指数下滑音（鼓皮的音高下坠），相位用积分保证连续。"""
    k = tau / (1.0 - np.exp(-t[-1] / tau))
    freq = f1 + (f0 - f1) * np.exp(-t / tau)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return np.sin(phase)


def _bandpass_noise(t: np.ndarray, center: float, q: float, tau: float) -> np.ndarray:
    """带通白噪声：鼓皮 / 鼓边的噪声成分。"""
    rng = np.random.default_rng(20261004)
    noise = rng.standard_normal(len(t))
    # 用简单的双极点谐振器近似带通，免去 scipy 依赖
    w0 = 2 * np.pi * center / SR
    r = np.exp(-w0 / (2 * q))
    b0 = (1 - r) * np.sqrt(1 - 2 * r * np.cos(w0) + r * r)
    out = np.zeros(len(t))
    x1 = x2 = y1 = y2 = 0.0
    for i, x in enumerate(noise):
        y = b0 * x - b0 * x2 + 2 * r * np.cos(w0) * y1 - r * r * y2
        x2, x1 = x1, x
        y2, y1 = y1, y
        out[i] = y
    return out * _exp_env(t, tau, attack=0.0008)


def _soft_clip(x: np.ndarray, drive: float = 1.5) -> np.ndarray:
    """轻度软削波：给低频鼓皮补上谐波，小喇叭上更容易听出来。"""
    return np.tanh(x * drive) / np.tanh(drive)


def _highpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    """一阶高通串联 order 次，去掉 60Hz 以下的浑浊和直流。"""
    rc = 1.0 / (2 * np.pi * cutoff)
    alpha = rc / (rc + 1.0 / SR)
    y = x
    for _ in range(order):
        out = np.empty_like(y)
        prev_x = 0.0
        prev_y = 0.0
        for i, v in enumerate(y):
            prev_y = alpha * (prev_y + v - prev_x)
            prev_x = v
            out[i] = prev_y
        y = out
    return y


def render() -> np.ndarray:
    t = _t()

    # 1) 击打瞬态「啪」：高频噪声短促爆点，负责在小喇叭上"被听见"
    click = _bandpass_noise(t, center=2800.0, q=0.8, tau=0.009) * 0.5
    # 2) 鼓边高频实音：给一点金属感的"咚"
    rim = (
        np.sin(2 * np.pi * 2400.0 * t) * _exp_env(t, 0.010) * 0.2
        + np.sin(2 * np.pi * 1500.0 * t) * _exp_env(t, 0.020) * 0.18
    )
    # 3) 鼓皮主体：低频下滑音（比老版本高八度一点、尾巴更短，少一点糊）
    body = _sweep(t, 205.0, 86.0, 0.030) * _exp_env(t, 0.088) * 0.85
    # 4) 二次谐波：中频主力，笔记本 / 手机小喇叭主要靠这一层听出来
    h2 = _sweep(t, 420.0, 196.0, 0.028) * _exp_env(t, 0.074) * 0.52
    # 5) 三次谐波：中频穿透层，和「咔」区分开
    h3 = _sweep(t, 720.0, 344.0, 0.022) * _exp_env(t, 0.054) * 0.36
    # 6) 四次谐波：清脆的一下，给"咚"定位置感
    h4 = _sweep(t, 1180.0, 560.0, 0.018) * _exp_env(t, 0.026) * 0.2
    # 7) 鼓皮噪声：包住整个起击，让鼓"实"
    skin = _bandpass_noise(t, center=1700.0, q=1.0, tau=0.018) * 0.3
    # 8) 中频"鼓身"层：跟鼓皮一起衰减的 500Hz 附近实音，小喇叭上决定音量感
    thigh = _sweep(t, 560.0, 268.0, 0.026) * _exp_env(t, 0.085) * 0.3

    x = np.tanh((click + rim + body + h2 + h3 + h4 + skin + thigh) * 0.9)
    x = _soft_clip(x, 1.35)
    x = _highpass(x, 55.0, order=2)

    # 归一化到 -1.5dBFS 左右，留点余量给多个音同时响
    peak = float(np.max(np.abs(x))) or 1.0
    return x / peak * 0.84


def write_wav(path: Path, x: np.ndarray) -> None:
    data = np.clip(x, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> int:
    ap = argparse.ArgumentParser(description="生成节拍音「咚」")
    ap.add_argument("--out", default="se/don.wav", help="输出路径（默认 se/don.wav）")
    args = ap.parse_args()
    root = Path(__file__).resolve().parent.parent
    out = Path(args.out)
    if not out.is_absolute():
        out = root / out
    write_wav(out, render())
    print(f"已生成 {out}（{out.stat().st_size} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
