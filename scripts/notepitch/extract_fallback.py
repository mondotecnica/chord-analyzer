"""フォールバック音高抽出（numpy/scipy のみ、Basic Pitch が使えない場合）。

2つのモードを持つ。「音符そのもの」ではなく「音符相当の証拠」を作る。

- mono: 単音系ステム（bass / vocals）向け。正規化自己相関の F0 追跡
  （プロジェクトの Phase 3.0 実験と同方式: 窓 2048 / ホップ 512、
  放物線補間、信頼度 = 正規化自己相関ピーク）。安定した音高の連続を
  音符として切り出す。
- multi: 多音系（other ステム / 合成曲の混合音）向け。フレーム単位の
  スペクトルピーク抽出＋倍音説明による抑制で、実在音の候補集合を作り、
  連続フレームを音符相当イベントにまとめる。

使い方:
  python extract_fallback.py <in.wav> <out.json> <mono|multi>
"""

import json
import sys

import numpy as np
from scipy.io import wavfile


def load_mono(path: str) -> tuple[np.ndarray, int]:
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        x = data.astype(np.float64) / 32768.0
    elif data.dtype == np.int32:
        x = data.astype(np.float64) / 2147483648.0
    else:
        x = data.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x, sr


# ---------------------------------------------------------------------------
# mono: 自己相関 F0 追跡
# ---------------------------------------------------------------------------

def track_f0(x: np.ndarray, sr: int, fmin: float, fmax: float,
             win: int = 2048, hop: int = 512, conf_th: float = 0.6):
    """フレームごとの (時刻, MIDI音高, 信頼度, RMS) を返す。"""
    frames = []
    n = len(x)
    min_lag = int(sr / fmax)
    max_lag = int(sr / fmin)
    for start in range(0, max(1, n - win), hop):
        frame = x[start:start + win]
        if len(frame) < win:
            frame = np.pad(frame, (0, win - len(frame)))
        rms = float(np.sqrt(np.mean(frame ** 2)))
        t = (start + win / 2) / sr
        if rms < 1e-4:
            frames.append((t, None, 0.0, rms))
            continue
        f = frame - frame.mean()
        ac = np.correlate(f, f, mode="full")[win - 1:]
        if ac[0] <= 0:
            frames.append((t, None, 0.0, rms))
            continue
        acn = ac / ac[0]
        seg = acn[min_lag:max_lag + 1]
        if len(seg) == 0:
            frames.append((t, None, 0.0, rms))
            continue
        peak = float(seg.max())
        # オクターブ下誤りを避けるため、最大ピークの 0.9 倍以上を持つ
        # 最も小さいラグを優先する
        cand = np.where(seg >= 0.9 * peak)[0]
        lag = int(cand[0]) + min_lag if len(cand) else int(seg.argmax()) + min_lag
        conf = float(acn[lag])
        if conf < conf_th:
            frames.append((t, None, conf, rms))
            continue
        # 放物線補間
        if 0 < lag < len(acn) - 1:
            a, b, c = acn[lag - 1], acn[lag], acn[lag + 1]
            denom = a - 2 * b + c
            shift = 0.5 * (a - c) / denom if denom != 0 else 0.0
        else:
            shift = 0.0
        freq = sr / (lag + shift)
        midi = 69 + 12 * np.log2(freq / 440.0)
        frames.append((t, float(midi), conf, rms))
    return frames


def frames_to_notes(frames, hop_sec: float, min_frames: int = 3):
    """安定音高の連続フレームを音符にまとめる（中央値で代表音高）。"""
    notes = []
    run: list = []

    def flush(run):
        if len(run) >= min_frames:
            pitches = [r[1] for r in run]
            med = float(np.median(pitches))
            p = int(round(med))
            # 中央値から ±0.6 半音以内のフレームが 70% 未満なら不安定として捨てる
            stable = np.mean([abs(v - med) <= 0.6 for v in pitches])
            if stable >= 0.7:
                amp = float(np.median([r[3] for r in run]))
                notes.append({"s": round(run[0][0] - hop_sec / 2, 3),
                              "e": round(run[-1][0] + hop_sec / 2, 3),
                              "p": p, "a": round(amp, 4)})

    for fr in frames:
        t, midi, _conf, _rms = fr
        if midi is None:
            flush(run)
            run = []
            continue
        if run and abs(midi - float(np.median([r[1] for r in run]))) > 0.6:
            flush(run)
            run = []
        run.append(fr)
    flush(run)
    return notes


# ---------------------------------------------------------------------------
# multi: スペクトルピークによる実在音候補
# ---------------------------------------------------------------------------

def extract_multi(x: np.ndarray, sr: int, n_fft: int = 4096, hop: int = 512,
                  midi_lo: int = 24, midi_hi: int = 96):
    from scipy.signal import get_window

    win = get_window("hann", n_fft)
    hop_sec = hop / sr
    n_frames = max(1, (len(x) - n_fft) // hop + 1)
    # pitch -> フレーム列 (amp)
    active: dict[int, dict[int, float]] = {}
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    for fi in range(n_frames):
        start = fi * hop
        frame = x[start:start + n_fft]
        if len(frame) < n_fft:
            frame = np.pad(frame, (0, n_fft - len(frame)))
        mag = np.abs(np.fft.rfft(frame * win))
        fmax = float(mag.max()) if len(mag) else 0.0
        if fmax < 1e-6:
            continue
        # ローカルピーク
        peaks = []
        for i in range(2, len(mag) - 2):
            if (mag[i] > mag[i - 1] and mag[i] >= mag[i + 1]
                    and mag[i] > mag[i - 2] and mag[i] >= mag[i + 2]
                    and mag[i] >= 0.08 * fmax):
                peaks.append((freqs[i], float(mag[i])))
        if not peaks:
            continue
        peaks.sort(key=lambda p: -p[1])
        accepted: list[tuple[float, float, int]] = []  # (freq, mag, midi)
        for freq, m in peaks:
            if freq < 27.5:
                continue
            midi_f = 69 + 12 * np.log2(freq / 440.0)
            midi = int(round(midi_f))
            if midi < midi_lo or midi > midi_hi or abs(midi_f - midi) > 0.45:
                continue
            # 倍音として説明できるピークは抑制する:
            # 強い低音 f0 の k 倍音 (k=2,3,4) に一致し、振幅が
            # その低音の 0.7/k 未満なら、その低音の倍音とみなす
            explained = False
            for (f0, m0, _pm) in accepted:
                for k in (2, 3, 4):
                    if abs(freq - k * f0) <= 0.03 * k * f0 and m < 0.7 * m0 / k:
                        explained = True
                        break
                if explained:
                    break
            if explained:
                continue
            if any(pm == midi for (_f, _m, pm) in accepted):
                continue
            accepted.append((freq, m, midi))
        for (_f, m, midi) in accepted:
            active.setdefault(midi, {})[fi] = m / fmax
    # フレーム列 → イベント（1フレームの隙間を許容、最小2フレーム）
    notes = []
    for midi, fmap in active.items():
        idx = sorted(fmap)
        run = [idx[0]]
        runs = []
        for v in idx[1:]:
            if v - run[-1] <= 2:
                run.append(v)
            else:
                runs.append(run)
                run = [v]
        runs.append(run)
        for run in runs:
            if len(run) < 2:
                continue
            amp = float(np.median([fmap[i] for i in run]))
            notes.append({"s": round(run[0] * hop_sec, 3),
                          "e": round((run[-1] + 1) * hop_sec, 3),
                          "p": midi, "a": round(amp, 4)})
    notes.sort(key=lambda n: (n["s"], n["p"]))
    return notes


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: extract_fallback.py <in.wav> <out.json> <mono|multi>",
              file=sys.stderr)
        return 2
    src, dst, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    x, sr = load_mono(src)
    if mode == "mono":
        # 低音域（ベース想定）と通常域の2帯域を試し、音符数が多い方を採る
        hop_sec = 512 / sr
        notes_lo = frames_to_notes(track_f0(x, sr, 35, 400), hop_sec)
        notes_hi = frames_to_notes(track_f0(x, sr, 55, 1200), hop_sec)
        notes = notes_lo if len(notes_lo) >= len(notes_hi) else notes_hi
        engine = "fallback-mono-yin"
    else:
        notes = extract_multi(x, sr)
        engine = "fallback-multi-peak"
    with open(dst, "w") as f:
        json.dump({"source": src, "engine": engine, "notes": notes}, f)
    print(f"{src}: {len(notes)} notes ({engine}) -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
