"""Q2 Cm 調査: ステム別ピッチクラス・プロファイル。

プロジェクトのクロマ（FFT4096・最近傍ビン割当て）の量子化誤差を避けるため、
長い FFT（32768 点）+ セント空間での三角重み付けで、量子化の滑らかな
ピッチクラス／MIDI 別パワープロファイルを出す。44.1kHz に統一して解析する。

使い方: python3 q2CmProfile.py <out.json> <name=path> [<name=path> ...]
窓は 80–200 秒固定（Q3 の Am 参照区間 85–95 秒を含むため）。
"""
import json
import subprocess
import sys

import numpy as np

SR = 44100
T0, DUR = 80.0, 120.0
FFT = 32768
HOP = 0.25
FMIN, FMAX = 50.0, 6000.0


def load(path: str) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-ss", str(T0), "-t", str(DUR),
           "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def profiles(x: np.ndarray):
    win = np.hanning(FFT)
    freqs = np.fft.rfftfreq(FFT, 1.0 / SR)
    band = (freqs >= FMIN) & (freqs <= FMAX)
    fb = freqs[band]
    midi_f = 69.0 + 12.0 * np.log2(fb / 440.0)
    m0 = np.floor(midi_f).astype(int)
    frac = midi_f - m0
    nframes = int(DUR / HOP)
    half = FFT // 2
    out = []
    for i in range(nframes):
        c = int(i * HOP * SR)
        lo = max(0, c - half)
        hi = min(len(x), lo + FFT)
        seg = np.zeros(FFT)
        seg[: hi - lo] = x[lo:hi]
        spec = np.fft.rfft(seg * win)
        power = (spec.real ** 2 + spec.imag ** 2)[band]
        midi_pow = np.zeros(128)
        np.add.at(midi_pow, m0, power * (1.0 - frac))
        np.add.at(midi_pow, m0 + 1, power * frac)
        total = midi_pow.sum()
        if total <= 0:
            continue
        pc = np.zeros(12)
        for m in range(24, 121):
            pc[m % 12] += midi_pow[m]
        pc_share = pc / total
        detail = {}
        for m in (39, 51, 63, 75, 40, 52, 64, 76, 36, 48, 60, 43, 55, 67):
            detail[str(m)] = float(midi_pow[m] / total)
        # ベース帯域（MIDI 24–50）の最強音
        low = midi_pow[24:51]
        bass_midi = int(np.argmax(low)) + 24
        out.append({
            "t": round(T0 + i * HOP, 2),
            "pc": [round(float(v), 4) for v in pc_share],
            "detail": detail,
            "bassMidi": bass_midi,
            "bassShareLow": float(low.max() / (low.sum() + 1e-30)),
            "powerDb": round(float(10 * np.log10(total + 1e-30)), 1),
        })
    return out


def main() -> int:
    out_path = sys.argv[1]
    result = {}
    for spec in sys.argv[2:]:
        name, path = spec.split("=", 1)
        x = load(path)
        result[name] = profiles(x)
        print(f"{name}: {len(result[name])} frames", flush=True)
    with open(out_path, "w") as f:
        json.dump(result, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
