"""Q2 Cm 検証: キーボードステムの E♭ は実演か、ボーカルの滲みか。

先行調査（Q2_CM_INVESTIGATION.md）は「キーボードが E♮ を E♭ に差し替えて
Cm を弾いている」と結論した。Suno のステムは後付け分離でありステム間の
滲みがありうるため、2仮説を判別する:
  A（実演）: キーボードが本当に E♭ を発音している
  B（滲み）: ボーカルの E♭ が分離の滲みとしてキーボードステムに現れている

判別手がかり:
  1. profiles.json から絶対パワーを復元し、E♮ 絶対量の推移を見る
     （滲みは加算のみ。キーボードが C のままなら E♮ 絶対量は残るはず）
  2. 包絡線とピッチ軌跡の指紋（ボーカル由来ならスクープ／揺らぎが写る）
  3. レベル比較（KB の E♭ 絶対量 vs 自ステムの通常発音・ボーカルの E♭）
  4. 対照ステムの E♭ 帯域エネルギー（滲みなら複数ステムに広がる）
  5. 倍音構造（KB の E♭ が KB 自身の音色か、声のフォルマントか）
  6. 128/141 秒の出現（ボーカルが E♭ を歌っていない回）との比較
  + 対照実験: ボーカルだけが装飾 E♭ を歌う 150.5/163.7 秒で
    キーボードステムに E♭ が現れるか（滲み量の実測）

使い方: python3 q2CmLeakCheck.py <profiles.json> <stem_dir> <out.json>
"""
import json
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

EB_MIDI = ["39", "51", "63", "75"]
EN_MIDI = ["40", "52", "64", "76"]
F_EB4 = 311.13
F_E4 = 329.63
F_EB3 = 155.56


# ---------- 段階1: profiles.json の絶対パワー ----------
def profile_abs(profiles, stem, keys):
    ts, ps = [], []
    for s in profiles[stem]:
        tot = 10 ** (s["powerDb"] / 10.0)
        ts.append(s["t"])
        ps.append(sum(s["detail"].get(k, 0.0) for k in keys) * tot)
    return np.array(ts), np.array(ps)


def win_mean(ts, ps, lo, hi):
    m = (ts >= lo) & (ts <= hi)
    return float(ps[m].mean()) if m.any() else float("nan")


def stage1(profiles):
    out = {}
    kb_t, kb_eb = profile_abs(profiles, "keyboard", EB_MIDI)
    _, kb_en = profile_abs(profiles, "keyboard", EN_MIDI)
    _, kb_e4 = profile_abs(profiles, "keyboard", ["64"])
    _, kb_eb4 = profile_abs(profiles, "keyboard", ["63"])
    wins = {
        "preN1": (149.5, 152.5), "N1": (152.9, 153.9),
        "preN2": (164.0, 165.6), "N2": (166.0, 167.3),
        "ev128": (128.2, 129.6), "ev141": (141.2, 142.1),
        "Am_ref": (157.5, 159.2), "midC": (159.8, 162.6),
    }
    out["keyboard"] = {
        name: {
            "Eb_abs": win_mean(kb_t, kb_eb, *w),
            "En_abs": win_mean(kb_t, kb_en, *w),
        }
        for name, w in wins.items()
    }
    # 対照: 装飾 E♭ の瞬間（ボーカルのみ）の KB E♭4 スライス値
    for name, (lo, hi) in {"approach1": (150.4, 150.6),
                           "approach2": (163.6, 163.8)}.items():
        out.setdefault("approach_kb_eb4_slice", {})[name] = win_mean(
            kb_t, kb_eb4, lo, hi)
    # 対照ステムの E♭ 絶対量（N1/N2 と直前）
    for stem in ("backing", "synth", "strings", "guitar", "fx", "vocals"):
        t, eb = profile_abs(profiles, stem, EB_MIDI)
        out[stem] = {
            "Eb_preN1": win_mean(t, eb, *wins["preN1"]),
            "Eb_N1": win_mean(t, eb, *wins["N1"]),
            "Eb_preN2": win_mean(t, eb, *wins["preN2"]),
            "Eb_N2": win_mean(t, eb, *wins["N2"]),
        }
    return out


# ---------- 段階2: 波形の細密解析 ----------
def load_mono(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64) / 32768.0
    if x.ndim == 2:
        return sr, x.mean(axis=1), x
    return sr, x, x[:, None]


def band_env(sr, x, f0, half_bw=9.0, nperseg=4096, hop=240):
    """f0 近傍帯域のパワー包絡（時刻配列つき）を返す。"""
    f, t, z = stft(x, fs=sr, nperseg=nperseg, noverlap=nperseg - hop,
                   window="hann")
    band = (np.abs(f - f0) <= half_bw)
    p = (np.abs(z[band]) ** 2).sum(axis=0)
    return t, p


def cents_track(sr, x, t0, t1, f0, win_s=0.12, hop_s=0.01):
    """窓ごとに f0 近傍のピーク周波数を補間しセント偏差を返す。"""
    n = int(win_s * sr)
    hop = int(hop_s * sr)
    nfft = 32768
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    sel = (freqs >= f0 - 14) & (freqs <= f0 + 14)
    idx = np.where(sel)[0]
    ts, cents = [], []
    start = int(t0 * sr)
    end = int(t1 * sr) - n
    pos = start
    while pos < end:
        seg = x[pos:pos + n] * np.hanning(n)
        mag = np.abs(np.fft.rfft(seg, nfft))[idx]
        k = int(np.argmax(mag))
        if 0 < k < len(mag) - 1:
            a, b, c = mag[k - 1], mag[k], mag[k + 1]
            delta = 0.5 * (a - c) / (a - 2 * b + c + 1e-30)
        else:
            delta = 0.0
        fpk = freqs[idx[k]] + delta * (freqs[1] - freqs[0])
        ts.append((pos + n / 2) / sr)
        cents.append(1200.0 * np.log2(fpk / f0))
        pos += hop
    return np.array(ts), np.array(cents)


def harmonic_profile(sr, x, t0, t1, f0, n_harm=8):
    """窓内の平均スペクトルから f0 の倍音列の相対振幅を返す。"""
    seg_all = x[int(t0 * sr):int(t1 * sr)]
    nfft = 16384
    hop = 4096
    if len(seg_all) < nfft:  # 短い窓はゼロ詰めして1回だけ測る
        seg = np.zeros(nfft)
        seg[:len(seg_all)] = seg_all * np.hanning(len(seg_all))
        acc = np.abs(np.fft.rfft(seg, nfft))
        cnt = 1
    else:
        acc = None
        cnt = 0
        for pos in range(0, len(seg_all) - nfft, hop):
            seg = seg_all[pos:pos + nfft] * np.hanning(nfft)
            mag = np.abs(np.fft.rfft(seg, nfft))
            acc = mag if acc is None else acc + mag
            cnt += 1
    acc /= max(cnt, 1)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    amps = []
    for k in range(1, n_harm + 1):
        m = (np.abs(freqs - k * f0) <= 3.5)
        amps.append(float(acc[m].max()) if m.any() else 0.0)
    amps = np.array(amps)
    return (amps / amps[0]).tolist()


def env_stats(t, p, t_lo, t_hi):
    m = (t >= t_lo) & (t <= t_hi)
    return t[m], p[m]


def db(x):
    return float(10 * np.log10(x + 1e-30))


def stage2(stem_dir):
    sr, kb, kb_st = load_mono(f"{stem_dir}/keyboard.wav")
    _, vo, vo_st = load_mono(f"{stem_dir}/vocals.wav")
    out = {}

    events = {
        # name: (span, kb_onset, vo_eb_span, kb_sustain_only, kb_e4_ref)
        "N1": dict(span=(151.8, 154.6), onset=152.73, vo=(152.74, 153.05),
                   sustain=(153.30, 154.00), e4ref=(151.15, 152.45)),
        "N2": dict(span=(165.0, 168.0), onset=165.85, vo=(165.85, 166.13),
                   sustain=(166.45, 167.30), e4ref=(164.60, 165.10)),
        "ev141": dict(span=(140.8, 143.4), onset=141.28, vo=None,
                      sustain=(141.6, 142.4), e4ref=None),
    }
    for name, ev in events.items():
        r = {}
        t_kb, p_kb = band_env(sr, kb, F_EB4)
        t_vo, p_vo = band_env(sr, vo, F_EB4)
        pk = float(p_kb[(t_kb >= ev["onset"]) &
                        (t_kb <= ev["onset"] + 1.4)].max())
        r["kb_eb4_peak_in_event"] = pk
        # ボーカル離脱後の KB E♭4 レベル（ピーク比 dB）
        if ev["vo"]:
            vend = ev["vo"][1]
            for dt, lab in ((0.25, "after_vo+0.25s"), (0.55, "after_vo+0.55s"),
                            (0.85, "after_vo+0.85s")):
                tt, pp = env_stats(t_kb, p_kb, vend + dt - 0.05,
                                   vend + dt + 0.05)
                r[lab] = db(pp.mean() / pk) if len(pp) else None
            # 重なり区間の包絡相関
            m1 = (t_kb >= ev["vo"][0] - 0.02) & (t_kb <= ev["vo"][1])
            m2 = (t_vo >= ev["vo"][0] - 0.02) & (t_vo <= ev["vo"][1])
            a, b = p_kb[m1], p_vo[m2]
            n = min(len(a), len(b))
            r["env_corr_overlap"] = float(np.corrcoef(a[:n], b[:n])[0, 1])
            r["vo_eb4_peak"] = float(p_vo[m2].max())
            r["kb_to_vo_peak_ratio"] = pk / float(p_vo[m2].max())
            # ピッチ軌跡
            tc_kb, c_kb = cents_track(sr, kb, ev["vo"][0] - 0.05,
                                      ev["vo"][1] + 0.05, F_EB4)
            tc_vo, c_vo = cents_track(sr, vo, ev["vo"][0] - 0.05,
                                      ev["vo"][1] + 0.05, F_EB4)
            r["kb_cents_mean"] = float(np.mean(c_kb))
            r["kb_cents_std"] = float(np.std(c_kb))
            r["vo_cents_mean"] = float(np.mean(c_vo))
            r["vo_cents_std"] = float(np.std(c_vo))
            r["kb_cents_first100ms"] = float(np.mean(c_kb[tc_kb <=
                                                  ev["vo"][0] + 0.10]))
            r["vo_cents_first100ms"] = float(np.mean(c_vo[tc_vo <=
                                                  ev["vo"][0] + 0.10]))
        # サステイン区間（ボーカル E♭ 不在）の KB E♭ レベル
        tt, pp = env_stats(t_kb, p_kb, *ev["sustain"])
        r["kb_sustain_mean_db_re_peak"] = db(pp.mean() / pk)
        # 倍音プロファイル
        r["harm_kb_eb4"] = harmonic_profile(sr, kb, *ev["sustain"], F_EB4)
        if ev["vo"]:
            r["harm_vo_eb4"] = harmonic_profile(sr, vo, ev["vo"][0] + 0.04,
                                                ev["vo"][1] - 0.02, F_EB4)
        if ev["e4ref"]:
            r["harm_kb_e4"] = harmonic_profile(sr, kb, *ev["e4ref"], F_E4)
        out[name] = r

    # 対照: 装飾 E♭（ボーカルのみ）の瞬間の KB ステム E♭4 帯域最大
    t_kb, p_kb = band_env(sr, kb, F_EB4)
    t_vo, p_vo = band_env(sr, vo, F_EB4)
    for name, (lo, hi) in {"approach1_150.5": (150.45, 150.75),
                           "approach2_163.7": (163.64, 163.92)}.items():
        mk = (t_kb >= lo) & (t_kb <= hi)
        mv = (t_vo >= lo) & (t_vo <= hi)
        out[name] = {
            "kb_eb4_band_max": float(p_kb[mk].max()),
            "vo_eb4_band_max": float(p_vo[mv].max()),
            "ratio": float(p_kb[mk].max() / p_vo[mv].max()),
        }
    # ev141: ボーカルに E♭ 音符は無い。帯域の最大同士を対照
    mk = (t_kb >= 141.3) & (t_kb <= 142.5)
    mv = (t_vo >= 141.3) & (t_vo <= 142.5)
    out["ev141_band"] = {
        "kb_eb4_band_max": float(p_kb[mk].max()),
        "vo_eb4_band_max": float(p_vo[mv].max()),
    }
    return out


def main():
    profiles = json.load(open(sys.argv[1]))
    result = {"stage1_profiles_abs": stage1(profiles),
              "stage2_waveform": stage2(sys.argv[2])}
    with open(sys.argv[3], "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(json.dumps(result, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
