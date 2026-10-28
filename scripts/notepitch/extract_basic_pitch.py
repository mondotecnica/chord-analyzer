"""Basic Pitch で WAV から音符列を抽出し JSON に保存する。

この環境（Python 3.12）では basic-pitch 0.4.0 が要求する
tensorflow<2.15.1 が解決できないため、パッケージ同梱の ONNX モデル
(nmp.onnx) を onnxruntime で直接使う（--no-deps で導入し、
推論系の依存だけを個別に入れた venv で実行する）。

使い方:
  python extract_basic_pitch.py <in.wav> <out.json>
出力: {"source": ..., "engine": "basic-pitch-onnx", "notes": [{"s","e","p","a"}]}
"""

import json
import pathlib
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_basic_pitch.py <in.wav> <out.json>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    import basic_pitch
    from basic_pitch.inference import Model, predict

    onnx_path = (pathlib.Path(basic_pitch.__file__).parent
                 / "saved_models" / "icassp_2022" / "nmp.onnx")
    if not onnx_path.exists():
        print(f"ONNX model not found: {onnx_path}", file=sys.stderr)
        return 1
    model = Model(str(onnx_path))
    _model_output, _midi, note_events = predict(src, model)
    notes = [
        {"s": round(float(s), 3), "e": round(float(e), 3),
         "p": int(p), "a": round(float(a), 4)}
        for (s, e, p, a, _bends) in note_events
    ]
    notes.sort(key=lambda n: (n["s"], n["p"]))
    with open(dst, "w") as f:
        json.dump({"source": src, "engine": "basic-pitch-onnx", "notes": notes}, f)
    print(f"{src}: {len(notes)} notes -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
