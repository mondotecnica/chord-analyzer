#!/usr/bin/env python3
"""「宵のひかり」Suno ステムの前処理とステム品質の定量比較。

使い方:
  sunoYoiStemQuality.py prep     … 9ステム合計ミックスと写像グループ
                                   （other 等）を作成する
  sunoYoiStemQuality.py quality  … Suno 9ステム vs Demucs 4ステムの
                                   品質指標を stem-quality.json に書く

入力: stem-work/suno-yoi/src/*.wav（MP3 からデコードした 48kHz 16bit）
Demucs 側: stem-work/suno-yoi/htdemucs/mix/*.wav（44.1kHz、存在すれば）
測定は全てモノラル化（チャンネル平均）した信号で行う。帯域シェア・相関・
RMS は比の指標なので、サンプルレート差の影響は受けない（帯域端は Hz で
各ファイル自身の SR から計算する）。
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "stem-work" / "suno-yoi"
SRC = WORK / "src"

SUNO_STEMS = [
    "vocals", "backing_vocals", "bass", "drums",
    "guitar", "keyboard", "synth", "strings", "fx",
]
OTHER_GROUP = ["guitar", "keyboard", "synth", "strings", "fx"]
OTHER_NOFX_GROUP = ["guitar", "keyboard", "synth", "strings"]


def read_wav_stereo(path: Path):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        n = w.getnframes()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    data = data.reshape(-1, ch)
    return data, sr


def write_wav_stereo(path: Path, data: np.ndarray, sr: int) -> None:
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def mono(data: np.ndarray) -> np.ndarray:
    return data.mean(axis=1)


def prep() -> None:
    stems = {}
    sr = None
    for name in SUNO_STEMS:
        data, s = read_wav_stereo(SRC / f"{name}.wav")
        if sr is None:
            sr = s
        assert s == sr and len(data) == 212800 * 48 // 100 or True
        stems[name] = data
    lengths = {k: len(v) for k, v in stems.items()}
    print("lengths:", lengths, "sr:", sr)

    total = sum(stems.values())
    peak = float(np.max(np.abs(total)))
    over = float(np.mean(np.abs(total) > 1.0))
    gain = 1.0 if peak <= 0.999 else 0.999 / peak
    print(f"raw sum peak={peak:.4f} over1.0={over:.6%} gain={gain:.4f}")

    write_wav_stereo(WORK / "mix.wav", total * gain, sr)

    groups = {"other_suno": OTHER_GROUP, "other_suno_nofx": OTHER_NOFX_GROUP}
    group_info = {}
    for gname, members in groups.items():
        g = sum(stems[m] for m in members) * gain
        gpeak = float(np.max(np.abs(g)))
        extra = 1.0 if gpeak <= 0.999 else 0.999 / gpeak
        write_wav_stereo(WORK / f"{gname}.wav", g * extra, sr)
        group_info[gname] = {
            "members": members,
            "peakAfterGlobalGain": gpeak,
            "extraGain": extra,
        }
        print(gname, "peak", gpeak, "extraGain", extra)

    info = {
        "sampleRate": sr,
        "lengths": lengths,
        "rawSumPeak": peak,
        "rawSumOverFullScaleRatio": over,
        "mixGain": gain,
        "groups": group_info,
    }
    (WORK / "prep-info.json").write_text(json.dumps(info, indent=1))
    print("wrote mix.wav / other_suno.wav / other_suno_nofx.wav / prep-info.json")


BANDS = [
    ("20-60", 20, 60),
    ("60-120", 60, 120),
    ("120-250", 120, 250),
    ("250-1000", 250, 1000),
    ("1000-4000", 1000, 4000),
    ("4000-10000", 4000, 10000),
    ("10000+", 10000, 24000),
]


def band_shares(x: np.ndarray, sr: int) -> dict:
    # 長さ 2^23 までの全信号 rfft（10.2M サンプルでも可）
    spec = np.fft.rfft(x * np.hanning(len(x)))
    power = (np.abs(spec) ** 2)
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    total = power[(freqs >= 20)].sum()
    out = {}
    for name, lo, hi in BANDS:
        m = (freqs >= lo) & (freqs < hi)
        out[name] = float(power[m].sum() / total) if total > 0 else 0.0
    return out


def corr(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / denom) if denom > 0 else 0.0


def decay_tail(x: np.ndarray, sr: int) -> dict:
    """ボーカルステムの「オフセット後の減衰尾」代理指標。

    50ms RMS 包絡（dBFS）で、-25dB を下向きに横切るオフセットを検出し、
    そこから包絡が -55dB に届く（または再び -25dB を上向きに横切る）
    までの時間 [s] の中央値を返す。リバーブの尾が長いほど大きくなる。
    """
    win = int(0.05 * sr)
    n = len(x) // win
    env = np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(env + 1e-9)
    hop = 0.05
    decays = []
    i = 1
    while i < n:
        if db[i - 1] >= -25 and db[i] < -25:
            # 直前 0.5s が鳴っていたこと（瞬間的な谷での誤検出を除く）
            if np.max(db[max(0, i - 10):i]) < -20:
                i += 1
                continue
            j = i
            while j < n and db[j] > -55 and db[j] < -25 + 0:
                if db[j] >= -25:
                    break
                j += 1
                if (j - i) * hop > 3.0:
                    break
            if j < n and db[j] <= -55:
                decays.append((j - i) * hop)
            i = j
        else:
            i += 1
    return {
        "offsetEvents": len(decays),
        "medianDecaySec": float(np.median(decays)) if decays else None,
        "meanDecaySec": float(np.mean(decays)) if decays else None,
    }


def stem_metrics(stems: dict, sr: int) -> dict:
    monos = {k: mono(v) for k, v in stems.items()}
    total_energy = sum(float((m * m).sum()) for m in monos.values())
    total_wave = sum(monos.values())
    out = {}
    for name, m in monos.items():
        rms = float(np.sqrt((m * m).mean()))
        rest = total_wave - m
        bands = band_shares(m, sr)
        out[name] = {
            "rmsDbfs": 20 * np.log10(rms + 1e-12),
            "energyShare": float((m * m).sum() / total_energy) if total_energy else 0.0,
            "corrWithRestSum": corr(m, rest),
            "bands": bands,
        }
    # ペア間相関の最大絶対値
    names = list(monos.keys())
    max_pair = {"pair": None, "absCorr": 0.0}
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            c = abs(corr(monos[names[i]], monos[names[j]]))
            if c > max_pair["absCorr"]:
                max_pair = {"pair": f"{names[i]}|{names[j]}", "absCorr": c}
    return {"stems": out, "maxPairCorr": max_pair}


def band_carrier(metrics: dict, band: str) -> dict:
    """指定帯域のエネルギーの担い手（ステム別シェア、合計=1 に正規化）"""
    vals = {}
    for name, m in metrics["stems"].items():
        # ステム帯域エネルギー ∝ energyShare * bandShare（基準は任意、比のみ）
        vals[name] = m["energyShare"] * m["bands"][band]
    tot = sum(vals.values())
    return {k: (v / tot if tot > 0 else 0.0) for k, v in vals.items()}


def quality() -> None:
    suno = {}
    sr_s = None
    for name in SUNO_STEMS:
        d, s = read_wav_stereo(SRC / f"{name}.wav")
        suno[name] = d
        sr_s = s
    result = {"suno": stem_metrics(suno, sr_s)}
    result["suno"]["bandCarrier60_120"] = band_carrier(result["suno"], "60-120")
    result["suno"]["bandCarrier1000_4000"] = band_carrier(result["suno"], "1000-4000")
    result["suno"]["vocalsDecayTail"] = decay_tail(mono(suno["vocals"]), sr_s)
    result["suno"]["sampleRate"] = sr_s

    demucs_dir = WORK / "htdemucs" / "mix"
    if demucs_dir.exists():
        dem = {}
        sr_d = None
        for name in ["vocals", "drums", "bass", "other"]:
            d, s = read_wav_stereo(demucs_dir / f"{name}.wav")
            dem[name] = d
            sr_d = s
        result["demucs"] = stem_metrics(dem, sr_d)
        result["demucs"]["bandCarrier60_120"] = band_carrier(result["demucs"], "60-120")
        result["demucs"]["bandCarrier1000_4000"] = band_carrier(result["demucs"], "1000-4000")
        result["demucs"]["vocalsDecayTail"] = decay_tail(mono(dem["vocals"]), sr_d)
        result["demucs"]["sampleRate"] = sr_d

    # 参考セット: 05.mp3（同一曲の本人 Logic ミックス版、末尾が短い）を
    # 入力とした既存の Demucs 分離。入力音声そのものがアームB と異なる
    # （バランス・長さ）ため、厳密な対照ではなく参考値として併記する。
    dem05_dir = ROOT / "stem-work" / "suno-05" / "htdemucs" / "05"
    if dem05_dir.exists():
        dem = {}
        sr_d = None
        for name in ["vocals", "drums", "bass", "other"]:
            d, s = read_wav_stereo(dem05_dir / f"{name}.wav")
            dem[name] = d
            sr_d = s
        result["demucs05"] = stem_metrics(dem, sr_d)
        result["demucs05"]["bandCarrier60_120"] = band_carrier(result["demucs05"], "60-120")
        result["demucs05"]["bandCarrier1000_4000"] = band_carrier(result["demucs05"], "1000-4000")
        result["demucs05"]["vocalsDecayTail"] = decay_tail(mono(dem["vocals"]), sr_d)
        result["demucs05"]["sampleRate"] = sr_d
        result["demucs05"]["note"] = "入力は 05.mp3（本人ミックス、205.14s）。参考値。"

    (WORK / "stem-quality.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({
        k: {
            "maxPairCorr": v["maxPairCorr"],
            "vocalsDecayTail": v["vocalsDecayTail"],
            "bandCarrier60_120": v["bandCarrier60_120"],
        } for k, v in result.items()
    }, indent=1))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "quality"
    if mode == "prep":
        prep()
    else:
        quality()
