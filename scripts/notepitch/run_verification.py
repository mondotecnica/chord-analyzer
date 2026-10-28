"""音符レベル解析の検証オーケストレータ。

手順:
1. 対象音声ごとに音符列 JSON を用意する（キャッシュ済みなら再利用）。
   エンジンは --engine bp（Basic Pitch / ONNX）または fallback。
2. 既存測定 JSON の検出セグメンテーションをグリッドに、音符→コード
   推論（chordinfer、ルール固定）で各区間をラベル付けする。
3. extensionScoring / measureSynthetic / measureReal の移植で採点し、
   measurements/notepitch/notepitch-results.json に書き出す。

使い方:
  python3 run_verification.py --engine bp [--force-extract] [--only synthetic,suno,real]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from chordinfer import (  # noqa: E402
    Note, bass_pc, bass_pc_v2, infer_chord, pc_shares, sample_score,
    sample_score_real, truth_label_from_full_name, truth_label_from_synthetic,
)

BASS_RULE = "v1"

PROJECT = Path(__file__).resolve().parents[2]
NOTES_DIR = PROJECT / "measurements" / "notepitch" / "notes"
VENV_PY = str(Path.home() / ".venvs" / "notepitch" / "bin" / "python")
BASS_POOL_MAX = 50  # 合成曲: ベース音符プールの上限 MIDI（ベース 36–47 / 和音 60+）
REAL_BASS_POOL_MAX = 60  # 実曲/Suno の bass ステム:  bleed の高音を除く上限


def load_notes(path: Path) -> list[Note]:
    d = json.loads(path.read_text())
    return [Note(n["s"], n["e"], n["p"], n["a"]) for n in d["notes"]]


def ensure_notes(engine: str, wav: Path, tag: str, fb_mode: str,
                 force: bool) -> Path:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    out = NOTES_DIR / f"{tag}.{engine}.json"
    if out.exists() and not force:
        return out
    if engine == "bp":
        cmd = [VENV_PY, str(PROJECT / "scripts/notepitch/extract_basic_pitch.py"),
               str(wav), str(out)]
    else:
        cmd = [sys.executable, str(PROJECT / "scripts/notepitch/extract_fallback.py"),
               str(wav), str(out), fb_mode]
    print("extract:", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr)
        raise SystemExit(f"extraction failed for {wav}")
    return out


def guesses_on_grid(grid, harmony: list[Note], bass: list[Note] | None):
    out = []
    for seg in grid:
        t0, t1 = seg["startSec"], seg["endSec"]
        g = infer_chord(harmony, bass, t0, t1, bass_rule=BASS_RULE)
        out.append({"start": t0, "end": t1, "guess": g})
    return out


def bass_accuracy(truth_segs, harmony: list[Note], bass: list[Note] | None):
    """正解セグメントごとに推定ベース音と正解 bassPc の一致（時間加重）。"""
    fn = bass_pc_v2 if BASS_RULE == "v2" else bass_pc
    tot = ok = 0.0
    for s in truth_segs:
        bpc = fn(bass if bass is not None else harmony, s["startSec"], s["endSec"])
        dur = s["endSec"] - s["startSec"]
        tot += dur
        if bpc == s["bassPc"]:
            ok += dur
    return ok / tot if tot else None


def detection_quality(truth, harmony: list[Note]):
    """合成曲のみ: 正解の構成音ピッチクラスが検出音符にどれだけ含まれ、
    逆に証拠のどれだけが非構成音か（検出器自体のエラー内訳）。
    正解の構成音は synth.ts の設計（root/3rd/5th/octave/+7th/add9）から作る。
    """
    tot_w = 0.0
    recall_w = 0.0
    false_share = 0.0
    ev_tot = 0.0
    for s in truth["segments"]:
        root = None
        # chord フィールドから root/mode を引く
        name = s["chord"]
        from chordinfer import parse_synthetic_chord
        parsed = parse_synthetic_chord(name)
        if parsed is None:
            continue
        root, mode = parsed
        tones = {root, (root + (4 if mode == "major" else 3)) % 12, (root + 7) % 12}
        full = s.get("fullChord") or ""
        if "maj7" in full or "M7" in full:
            tones.add((root + 11) % 12)
        elif full.endswith("7") or "m7" in full:
            tones.add((root + 10) % 12)
        if "add9" in full:
            tones.add((root + 2) % 12)
        dur = s["endSec"] - s["startSec"]
        share = pc_shares(harmony, s["startSec"], s["endSec"])
        if share is None:
            continue
        tot_w += dur
        recall_w += dur * (1.0 if all(share[pc] >= 0.03 for pc in tones) else 0.0)
        ev_tot += dur
        false_share += dur * sum(share[pc] for pc in range(12) if pc not in tones)
    return {
        "chordTonePcRecall": recall_w / tot_w if tot_w else None,
        "nonChordEvidenceShare": false_share / ev_tot if ev_tot else None,
    }


def run_synthetic(engine: str, force: bool, results: dict):
    p31 = json.loads((PROJECT / "measurements/phase3/phase3-1-synthetic.json").read_text())
    genre = json.loads((PROJECT / "measurements/phase3/phase3-genre-synthetic.json").read_text())
    grids = {}
    current = {}
    for item in p31:
        grids[item["songId"]] = item["on"]["detectedSegments"]
        current[item["songId"]] = {
            "root": item["on"]["rootAccuracy"], "triad": item["on"]["triadAccuracy"],
            "fullLabelOff": item["extOff"]["fullLabelAccuracy"],
            "fullLabelOn": item["extOn"]["fullLabelAccuracy"],
            "givenCoreOn": item["extOn"]["seventhGivenCore"],
            "falseFireOn": item["extOn"]["falseFireRate"],
        }
    for item in genre:
        sid = item["songId"]
        if sid not in grids:
            grids[sid] = item["arms"]["off"]["detectedSegments"]
            current[sid] = {"note": "genre JSON の off 測定（参考）",
                            "root": item["arms"]["off"]["rootAccuracy"],
                            "triad": item["arms"]["off"]["triadAccuracy"]}
    out = {}
    for sid in ["song-a", "song-b", "song-c", "song-d", "song-e",
                "song-f", "song-g", "song-h", "song-i"]:
        truth = json.loads((PROJECT / f"test-audio/{sid}.groundtruth.json").read_text())
        notes_path = ensure_notes(engine, PROJECT / f"test-audio/{sid}.wav",
                                  sid, "multi", force)
        harmony = load_notes(notes_path)
        bass_pool = [n for n in harmony if n.pitch <= BASS_POOL_MAX]
        guesses = guesses_on_grid(grids[sid], harmony, bass_pool)
        truth_segs = []
        for s in truth["segments"]:
            lab = truth_label_from_synthetic(s)
            if lab is None:
                continue
            truth_segs.append({"startSec": s["startSec"], "endSec": s["endSec"],
                               "label": s.get("fullChord") or s["chord"], "truth": lab})
        score = sample_score(truth_segs, guesses, truth["durationSec"])
        # 参考（診断用）: 正解グリッドで集計した場合の推論層のみの成績。
        # 事前登録の主判定は検出グリッド側で行い、こちらは境界汚染と
        # 推論誤りの切り分けにのみ使う。
        truth_grid = [{"startSec": s["startSec"], "endSec": s["endSec"]}
                      for s in truth["segments"]]
        tg = sample_score(truth_segs, guesses_on_grid(truth_grid, harmony, bass_pool),
                          truth["durationSec"])
        score["truthGrid"] = {
            "fullLabelAccuracy": tg["fullLabelAccuracy"],
            "rootAccuracy": tg["rootAccuracy"],
            "triadAccuracy": tg["triadAccuracy"],
            "seventhGivenCore": tg["seventhGivenCore"],
            "falseFireRate": tg["falseFireRate"],
        }
        score["bassAccuracy"] = bass_accuracy(truth["segments"], harmony, bass_pool)
        score["detection"] = detection_quality(truth, harmony)
        score["noteCount"] = len(harmony)
        score["segmentLabels"] = [
            {"start": g["start"], "end": g["end"],
             "label": g["guess"].label if g["guess"] else "N.C."}
            for g in guesses
        ]
        out[sid] = {"score": score, "current": current.get(sid)}
        print(f"{sid}: fullLabel={score['fullLabelAccuracy']} root={score['rootAccuracy']} "
              f"triad={score['triadAccuracy']} (current fullOn={current.get(sid, {}).get('fullLabelOn')})",
              flush=True)
    results["synthetic"] = out


def find_stem_dir(base: Path) -> Path:
    subs = [p for p in base.rglob("*") if p.is_dir() and (p / "other.wav").exists()]
    if not subs:
        raise SystemExit(f"stems not found under {base}")
    return subs[0]


def run_suno(engine: str, force: bool, results: dict):
    sdir = find_stem_dir(PROJECT / "stem-work/suno-05")
    fb_h = "multi" if engine == "fallback" else "multi"
    fb_b = "mono" if engine == "fallback" else "multi"
    other = load_notes(ensure_notes(engine, sdir / "other.wav", "suno05-other", fb_h, force))
    bass_all = load_notes(ensure_notes(engine, sdir / "bass.wav", "suno05-bass", fb_b, force))
    bass = [n for n in bass_all if n.pitch <= REAL_BASS_POOL_MAX]

    def window(t0, t1):
        g = infer_chord(other, bass, t0, t1, bass_rule=BASS_RULE)
        share = pc_shares(other, t0, t1)
        return {
            "window": [t0, t1],
            "label": g.label if g else None,
            "root": g.root if g else None,
            "mode": g.mode if g else None,
            "ext": g.ext if g else None,
            "bassPc": g.bass_pc if g else None,
            "share": {str(i): round(v, 3) for i, v in enumerate(share)} if share else None,
        }

    q1 = [window(51, 56), window(93, 98)]
    q3 = [window(85, 87), window(87, 89), window(89, 91), window(91, 93)]
    q4 = window(62, 65)
    q4_notes_pc = sorted({n.pitch % 12 for n in other if n.start < 65 and n.end > 62})
    q4["notePcsPresent"] = q4_notes_pc
    q4["hasB"] = 11 in q4_notes_pc
    q4["hasG"] = 7 in q4_notes_pc

    def is_am7(w):
        return w["root"] == 9 and w["mode"] == "minor" and w["ext"] == "m7"
    q1_pass = all(w["bassPc"] == 2 and is_am7(w) for w in q1)
    expect = [
        lambda w: w["root"] == 0 and w["mode"] == "major",                    # C / CM7
        lambda w: w["root"] == 11 and w["ext"] == "7",                        # B7
        lambda w: w["root"] == 4 and w["ext"] == "7",                         # E7
        lambda w: w["root"] == 9 and w["mode"] == "minor",                    # Am / Am7
    ]
    q3_hits = [bool(f(w)) for f, w in zip(expect, q3)]
    q3_pass = sum(q3_hits) >= 3 and q3_hits[1]
    q4_pass = (q4["bassPc"] == 1 and q4["root"] == 9 and q4["mode"] == "minor"
               and q4["hasB"] and q4["hasG"])
    results["suno"] = {
        "q1": q1, "q3": q3, "q3Hits": q3_hits, "q4": q4,
        "q1Pass": q1_pass, "q3Pass": q3_pass, "q4Pass": q4_pass,
        "fixturesPassed": int(q1_pass) + int(q3_pass) + int(q4_pass),
    }
    print(f"suno: Q1={'PASS' if q1_pass else 'FAIL'} Q3={'PASS' if q3_pass else 'FAIL'} "
          f"({q3_hits}) Q4={'PASS' if q4_pass else 'FAIL'}", flush=True)


def run_real(engine: str, force: bool, results: dict):
    p31 = json.loads((PROJECT / "measurements/phase3/phase3-1-real-stems.json").read_text())
    items = {x["slug"]: x for x in p31}
    out = {}
    for slug in ["put-your-records-on", "everything"]:
        sdir = find_stem_dir(PROJECT / f"stem-work/{slug}")
        other = load_notes(ensure_notes(engine, sdir / "other.wav", f"{slug}-other",
                                        "multi", force))
        bass_all = load_notes(ensure_notes(engine, sdir / "bass.wav", f"{slug}-bass",
                                           "mono" if engine == "fallback" else "multi",
                                           force))
        bass = [n for n in bass_all if n.pitch <= REAL_BASS_POOL_MAX]
        grid = items[slug]["stemsOn"]["detectedSegments"]
        grid = [{"startSec": s["startSec"], "endSec": s["endSec"]} for s in grid]
        guesses = guesses_on_grid(grid, other, bass)
        truth = json.loads((PROJECT / f"measurements/real/{slug}/truth.json").read_text())
        truth_segs = []
        for s in truth["segments"]:
            lab = truth_label_from_full_name(s["chord"])
            if lab is None:
                continue
            truth_segs.append({"startSec": s["startSec"], "endSec": s["endSec"],
                               "label": s["chord"], "truth": lab})
        score = sample_score_real(truth_segs, guesses, truth["durationSec"])
        cur = items[slug]
        score["noteCountOther"] = len(other)
        score["noteCountBass"] = len(bass)
        out[slug] = {
            "score": score,
            "currentStemsOff": {
                "root": cur["stemsOff"]["rootAccuracy"],
                "triad": cur["stemsOff"]["triadAccuracy"],
                "core": cur["stemsOff"]["coreAccuracy"],
            },
            "currentStemsExtOn": {
                "fullLabel": cur["stemsExtOn"]["fullLabelAccuracy"],
                "givenCore": cur["stemsExtOn"]["seventhGivenCore"],
            },
            "segmentLabels": [
                {"start": g["start"], "end": g["end"],
                 "label": g["guess"].label if g["guess"] else "N.C."}
                for g in guesses
            ],
        }
        print(f"{slug}: root={score['rootAccuracy']} triad={score['triadAccuracy']} "
              f"core={score['coreAccuracy']} fullLabel={score['fullLabelAccuracy']} "
              f"(current stemsOff root={cur['stemsOff']['rootAccuracy']} "
              f"triad={cur['stemsOff']['triadAccuracy']})", flush=True)
    results["real"] = out


def main() -> int:
    global BASS_RULE
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["bp", "fallback"], required=True)
    ap.add_argument("--force-extract", action="store_true")
    ap.add_argument("--only", default="synthetic,suno,real")
    ap.add_argument("--bass-rule", choices=["v1", "v2"], default="v1")
    ap.add_argument("--out", default="notepitch-results.json")
    args = ap.parse_args()
    BASS_RULE = args.bass_rule

    results: dict = {"engine": args.engine, "bassRule": args.bass_rule}
    only = set(args.only.split(","))
    if "synthetic" in only:
        run_synthetic(args.engine, args.force_extract, results)
    if "suno" in only:
        run_suno(args.engine, args.force_extract, results)
    if "real" in only:
        run_real(args.engine, args.force_extract, results)

    out_path = PROJECT / "measurements/notepitch" / args.out
    # 既存結果とマージ（--only で部分実行しても他セクションを消さない）
    if out_path.exists():
        prev = json.loads(out_path.read_text())
        if prev.get("engine") == args.engine and prev.get("bassRule", "v1") == args.bass_rule:
            prev.update(results)
            results = prev
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
