#!/usr/bin/env python3
"""ChordMini (ChordNet 2E1D) のアプリ外推論ランナー（Phase 4 Stage 1 測定用）。

モデルの契約（tools/chordmini/README.md = HF モデルカード）どおりに実行する:

- デコードは ffmpeg でステレオ f32le（元のサンプルレート）。`-ac 1` は
  (L+R)/√2 のエネルギ保存リマトリクスになるため使わない。ダウンミックスは
  チャンネルごとのリサンプル後に算術平均 (L+R)/2 を取る（librosa.load の
  既定ダウンミックスと等価。モデルはこのゲイン条件で学習されている）。
- CQT は librosa 0.11.0 の librosa.cqt を cqt-plan の生成条件で実行する
  （sr=22050, hop=2048, fmin=C1, n_bins=144, bins_per_octave=24, hann,
  norm=1, sparsity=0.01, scale=True, pad_mode='constant'）。
  特徴量は log(|CQT| + 1e-6)。
- グラフは静的バッチ [16, 108, 144] 固定。108 フレーム窓（ストライド 108）を
  16 窓ずつ流し、最後のグループはゼロ窓で埋めて logits を切り戻す。

出力: <out>.logits.f32le（[T,170] float32 リトルエンディアン）と
<out>.meta.json（フレーム数・フレーム長・音声長・モデルのハッシュ等）。

使い方:
  python run_chordmini.py --audio <file> --out <prefix>
      [--model tools/chordmini/chordnet.onnx] [--config tools/chordmini/config.json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

SR = 22050
HOP = 2048
SEQ_LEN = 108
BATCH_WINDOWS = 16  # 静的グラフの契約（モデルカード参照）
FMIN = 32.70319566257483  # C1
N_BINS = 144
BPO = 24

FFMPEG = "/usr/bin/ffmpeg"


def decode_stereo(path: str) -> tuple[np.ndarray, int]:
    """ffmpeg でステレオ f32le にデコードする（チャンネルは触らない）。"""
    with tempfile.NamedTemporaryFile(suffix=".f32le") as tmp:
        subprocess.run(
            [FFMPEG, "-y", "-nostdin", "-v", "error", "-i", path, "-ac", "2", "-f", "f32le", tmp.name],
            check=True,
        )
        raw = Path(tmp.name).read_bytes()
    # サンプルレートは ffprobe で取る（デコードと分離しておく）
    sr = int(
        subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate",
                "-of", "csv=p=0", path,
            ],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    )
    data = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
    return data, sr


def to_mono_22050(stereo: np.ndarray, sr: int) -> np.ndarray:
    """チャンネルごとに 22050Hz 化してから算術平均 (L+R)/2 を取る。"""
    import librosa

    chans = []
    for ch in range(stereo.shape[1]):
        y = stereo[:, ch].astype(np.float32)
        if sr != SR:
            y = librosa.resample(y, orig_sr=sr, target_sr=SR)  # soxr_hq
        chans.append(y)
    n = min(len(c) for c in chans)
    return np.mean(np.stack([c[:n] for c in chans]), axis=0).astype(np.float32)


def log_cqt_features(y: np.ndarray) -> np.ndarray:
    import librosa

    cqt = librosa.cqt(
        y,
        sr=SR,
        hop_length=HOP,
        fmin=FMIN,
        n_bins=N_BINS,
        bins_per_octave=BPO,
        window="hann",
        norm=1,
        sparsity=0.01,
        scale=True,
        pad_mode="constant",
    )
    feats = np.log(np.abs(cqt) + 1e-6).T  # [T, 144]
    return np.ascontiguousarray(feats, dtype=np.float32)


def run_model(feats: np.ndarray, model_path: str) -> np.ndarray:
    import onnxruntime as ort

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    t = feats.shape[0]
    n_windows = int(np.ceil(t / SEQ_LEN))
    padded_frames = n_windows * SEQ_LEN
    padded = np.zeros((padded_frames, feats.shape[1]), dtype=np.float32)
    padded[:t] = feats
    windows = padded.reshape(n_windows, SEQ_LEN, feats.shape[1])
    n_groups = int(np.ceil(n_windows / BATCH_WINDOWS))
    logits = np.zeros((n_windows, SEQ_LEN, 170), dtype=np.float32)
    for g in range(n_groups):
        batch = np.zeros((BATCH_WINDOWS, SEQ_LEN, feats.shape[1]), dtype=np.float32)
        chunk = windows[g * BATCH_WINDOWS:(g + 1) * BATCH_WINDOWS]
        batch[: len(chunk)] = chunk
        out = sess.run(["logits"], {"features": batch})[0]
        logits[g * BATCH_WINDOWS:g * BATCH_WINDOWS + len(chunk)] = out[: len(chunk)]
    return logits.reshape(padded_frames, 170)[:t]


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    h.update(Path(path).read_bytes())
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True, help="出力プレフィックス")
    ap.add_argument("--model", default="tools/chordmini/chordnet.onnx")
    ap.add_argument("--config", default="tools/chordmini/config.json")
    args = ap.parse_args()

    import librosa
    import onnxruntime as ort

    config = json.loads(Path(args.config).read_text())
    stereo, sr = decode_stereo(args.audio)
    y = to_mono_22050(stereo, sr)
    feats = log_cqt_features(y)
    logits = run_model(feats, args.model)

    out_prefix = Path(args.out)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    logits.astype("<f4").tofile(str(out_prefix) + ".logits.f32le")
    meta = {
        "audio": args.audio,
        "sourceSampleRate": sr,
        "durationSec": float(len(y) / SR),
        "frames": int(logits.shape[0]),
        "frameDuration": HOP / SR,
        "numClasses": int(logits.shape[1]),
        "model": args.model,
        "modelSha256": sha256_of(args.model),
        "librosaVersion": librosa.__version__,
        "onnxruntimeVersion": ort.__version__,
        "vocab": config["chordVocab"],
        "smoothingKernel": config.get("smoothingKernel"),
    }
    Path(str(out_prefix) + ".meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"frames={logits.shape[0]} duration={meta['durationSec']:.2f}s -> {out_prefix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
