"""音符レベル解析の検証用ライブラリ（検証専用・src/ には非搭載）。

内容:
- 音符列 → 区間ごとのコード推論（ルールは 2026-10-28 の検証開始前に固定）
- 正解ラベルのパースと採点（scripts/extensionScoring.ts /
  measureSynthetic.ts / measureReal.ts の定義を Python に移植）

推論ルール（固定）:
- 区間の証拠 = 区間と重なる音符を (重なり秒数 × 振幅) で重み付けし、
  ピッチクラス別に集計して正規化した share[12]。
- 候補 = 12ルート × {長三和音, 短三和音, maj7, m7, dom7}。
  score = explained − 0.10 × missing − 0.02 × (構成音数 − 3)
    explained = 候補の構成音に乗っている share の合計
    missing   = share < 0.03 の構成音の個数（実在しない音への減点）
  同点時は構成音数が少ない候補 → ベース音とルートが一致する候補を優先。
- ベース音 = ベース音符群（ステム or 低音域）について音高ごとに重みを
  集計し、「最大重みの 0.3 倍以上の重みを持つ最も低い音高」のピッチ
  クラス。ベースがルートと異なれば分数コードとして併記する。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
BASE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# ---------------------------------------------------------------------------
# 音符→コード推論
# ---------------------------------------------------------------------------

# (mode, ext, 構成音インターバル)
QUALITIES = [
    ("major", None, (0, 4, 7)),
    ("minor", None, (0, 3, 7)),
    ("major", "maj7", (0, 4, 7, 11)),
    ("minor", "m7", (0, 3, 7, 10)),
    ("major", "7", (0, 4, 7, 10)),
]

MISSING_THRESHOLD = 0.03
MISSING_PENALTY = 0.10
COMPLEXITY_PENALTY = 0.02


@dataclass
class Note:
    start: float
    end: float
    pitch: int  # MIDI
    amp: float = 1.0


@dataclass
class ChordGuess:
    root: int
    mode: str  # "major" | "minor"
    ext: str | None  # "maj7" | "m7" | "7" | None
    bass_pc: int | None
    share: list[float] = field(default_factory=list)
    score: float = 0.0

    @property
    def label(self) -> str:
        name = NOTE_NAMES[self.root] + ("m" if self.mode == "minor" else "")
        if self.ext == "maj7":
            name = NOTE_NAMES[self.root] + "maj7"
        elif self.ext == "m7":
            name = NOTE_NAMES[self.root] + "m7"
        elif self.ext == "7":
            name = NOTE_NAMES[self.root] + "7"
        if self.bass_pc is not None and self.bass_pc != self.root:
            name += "/" + NOTE_NAMES[self.bass_pc]
        return name


def pc_shares(notes: list[Note], t0: float, t1: float) -> list[float] | None:
    """区間 [t0, t1) と重なる音符からピッチクラス share を作る。"""
    acc = [0.0] * 12
    total = 0.0
    for n in notes:
        ov = min(n.end, t1) - max(n.start, t0)
        if ov <= 0:
            continue
        w = ov * max(n.amp, 1e-6)
        acc[n.pitch % 12] += w
        total += w
    if total <= 0:
        return None
    return [a / total for a in acc]


def _pitch_weights(notes: list[Note], t0: float, t1: float) -> dict[int, float]:
    by_pitch: dict[int, float] = {}
    for n in notes:
        ov = min(n.end, t1) - max(n.start, t0)
        if ov <= 0:
            continue
        by_pitch[n.pitch] = by_pitch.get(n.pitch, 0.0) + ov * max(n.amp, 1e-6)
    return by_pitch


def bass_pc(notes: list[Note], t0: float, t1: float) -> int | None:
    """v1 ルール: 「最大重みの 0.3 倍以上を持つ最も低い音高」のピッチクラス。
    初回測定で使用。実測の結果、より重みの小さい低音ゴースト／経過音に
    引きずられる欠陥が判明した（結果文書参照）。再現用に残す。"""
    by_pitch = _pitch_weights(notes, t0, t1)
    if not by_pitch:
        return None
    wmax = max(by_pitch.values())
    for p in sorted(by_pitch):
        if by_pitch[p] >= 0.3 * wmax:
            return p % 12
    return None


def bass_pc_v2(notes: list[Note], t0: float, t1: float) -> int | None:
    """v2 ルール（検証中に v1 の欠陥を受けて修正）: ベース音符群の重みを
    ピッチクラスに合算し、最大のピッチクラスをベースとする。
    プロジェクト既存の aggregateBassDistribution（低域クロマ集計）と
    同じ統計であり、オクターブゴーストに強い。"""
    by_pitch = _pitch_weights(notes, t0, t1)
    if not by_pitch:
        return None
    by_pc: dict[int, float] = {}
    for p, w in by_pitch.items():
        by_pc[p % 12] = by_pc.get(p % 12, 0.0) + w
    return max(by_pc.items(), key=lambda kv: kv[1])[0]


def infer_chord(
    harmony_notes: list[Note],
    bass_notes: list[Note] | None,
    t0: float,
    t1: float,
    bass_rule: str = "v1",
) -> ChordGuess | None:
    share = pc_shares(harmony_notes, t0, t1)
    if share is None:
        return None
    if bass_notes:
        bpc = bass_pc_v2(bass_notes, t0, t1) if bass_rule == "v2" else bass_pc(bass_notes, t0, t1)
    else:
        bpc = None

    best: ChordGuess | None = None
    best_key: tuple | None = None
    for root in range(12):
        for mode, ext, intervals in QUALITIES:
            tones = [(root + i) % 12 for i in intervals]
            explained = sum(share[pc] for pc in tones)
            missing = sum(1 for pc in tones if share[pc] < MISSING_THRESHOLD)
            score = explained - MISSING_PENALTY * missing - COMPLEXITY_PENALTY * (len(tones) - 3)
            # 同点タイブレーク: 構成音数少 → ベース一致
            key = (score, -len(tones), 1 if bpc == root else 0)
            if best_key is None or key > best_key:
                best_key = key
                best = ChordGuess(root=root, mode=mode, ext=ext, bass_pc=bpc,
                                   share=share, score=score)
    return best


# ---------------------------------------------------------------------------
# 正解ラベルのパース（TS 実装の移植）
# ---------------------------------------------------------------------------

def extension_class(quality: str) -> str | None:
    """extensionScoring.ts extensionClassOf の移植。"""
    q = quality
    if q in ("", "m", "min"):
        return None
    if re.search(r"sus|add|\(|♭|b5|dim|aug|6|9|11|13", q):
        return "other"
    if re.search(r"maj7|M7|Δ", q):
        return "maj7"
    if re.match(r"m", q) and "7" in q:
        return "m7"
    if "7" in q:
        return "7"
    return "other"


def parse_truth_chord(chord: str):
    """measureReal.ts parseTruthChord の移植。(root, coreMode, inVocabulary)。"""
    if chord == "N.C.":
        return None
    main = chord.split("/")[0].replace("♭", "b").replace("♯", "#")
    m = re.match(r"^([A-G])(#|b)?(.*)$", main)
    if not m:
        return None
    root = BASE_PC[m.group(1)]
    if m.group(2) == "#":
        root += 1
    if m.group(2) == "b":
        root -= 1
    root %= 12
    q = m.group(3) or ""
    if q in ("", "m", "min"):
        return root, ("major" if q == "" else "minor"), True
    if re.match(r"sus", q):
        return root, None, False
    if re.match(r"(dim|°)", q):
        return root, "minor", False
    if re.match(r"(aug|\+)", q):
        return root, "major", False
    if re.match(r"m", q) and not re.match(r"maj", q):
        return root, "minor", False
    return root, "major", False


def truth_label_from_full_name(chord: str):
    """実曲の完全名 → (root, coreMode, ext)。"""
    core = parse_truth_chord(chord)
    if core is None:
        return None
    main = chord.split("/")[0].replace("♭", "b").replace("♯", "#")
    m = re.match(r"^([A-G])(#|b)?(.*)$", main)
    quality = (m.group(3) if m else "") or ""
    return core[0], core[1], extension_class(quality)


def parse_synthetic_chord(chord: str):
    """measureSynthetic.ts parseChord の移植。(root, mode) を返す。"""
    if chord == "N.C.":
        return None
    if chord.endswith("m"):
        r = NOTE_NAMES.index(chord[:-1]) if chord[:-1] in NOTE_NAMES else -1
        return (r, "minor") if r >= 0 else None
    r = NOTE_NAMES.index(chord) if chord in NOTE_NAMES else -1
    return (r, "major") if r >= 0 else None


def truth_label_from_synthetic(seg: dict):
    """合成曲の正解セグメント → (root, coreMode, ext)。"""
    core = parse_synthetic_chord(seg["chord"])
    if core is None:
        return None
    full = seg.get("fullChord")
    if not full:
        return core[0], core[1], None
    q = re.sub(r"^[A-G]#?", "", full)
    return core[0], core[1], extension_class(q)


# ---------------------------------------------------------------------------
# 採点（extensionScoring.ts の 10ms サンプリングを再現）
# ---------------------------------------------------------------------------

STEP = 0.01
IN_VOCAB = {"maj7", "7", "m7"}


def _ratio(a, b):
    return (a / b) if b > 0 else None


def _iter_samples(truth_segments, guesses, duration_sec):
    """10ms サンプリングで (gt_seg, det_guess|None) を列挙する共通ループ。
    TS ハーネスと同様、真値セグメントが無い時刻はスキップする。"""
    gi = 0
    t = 0.0
    while t < duration_sec - 1e-9:
        mid = t + STEP / 2
        gt = None
        for s in truth_segments:
            if s["startSec"] <= mid < s["endSec"]:
                gt = s
                break
        if gt is not None:
            while gi < len(guesses) - 1 and mid >= guesses[gi]["end"]:
                gi += 1
            det = None
            if guesses and guesses[gi]["start"] <= mid < guesses[gi]["end"]:
                det = guesses[gi]["guess"]
            yield gt, det
        t += STEP


def _extension_metrics(truth_segments, guesses, duration_sec):
    """extensionScoring.measureExtensions の移植（完全ラベル系の指標）。"""
    full_counted = full_ok = 0.0
    given_counted = given_ok = 0.0
    seventh_counted = seventh_ok = 0.0
    triad_counted = false_fire = 0.0
    nc_time = 0.0
    confusion: dict[str, float] = {}
    for gt, det in _iter_samples(truth_segments, guesses, duration_sec):
        if det is None:
            nc_time += STEP
            continue
        groot, gmode, gext = gt["truth"]
        if gmode is None:
            continue
        core_ok_flag = det.root == groot and det.mode == gmode
        exact = core_ok_flag and det.ext == gext
        if gext is None or gext in IN_VOCAB:
            full_counted += STEP
            if exact:
                full_ok += STEP
            else:
                key = f"{gt['label']} → {det.label}"
                confusion[key] = confusion.get(key, 0.0) + STEP
        if gext is not None and gext in IN_VOCAB:
            seventh_counted += STEP
            if exact:
                seventh_ok += STEP
            if core_ok_flag:
                given_counted += STEP
                if det.ext == gext:
                    given_ok += STEP
        if gext is None:
            triad_counted += STEP
            if det.ext is not None:
                false_fire += STEP
    conf = sorted(
        ({"gt_det": k, "sec": round(v, 2)} for k, v in confusion.items()),
        key=lambda x: -x["sec"],
    )[:8]
    return {
        "fullLabelAccuracy": _ratio(full_ok, full_counted),
        "fullLabelCountedSec": round(full_counted, 2),
        "seventhGivenCore": _ratio(given_ok, given_counted),
        "seventhGivenCoreSec": round(given_counted, 2),
        "seventhExactAccuracy": _ratio(seventh_ok, seventh_counted),
        "falseFireRate": _ratio(false_fire, triad_counted),
        "falseFireSec": round(triad_counted, 2),
        "extNcShare": nc_time / duration_sec if duration_sec > 0 else 0.0,
        "confusions": conf,
    }


def sample_score(truth_segments, guesses, duration_sec):
    """合成曲用: measureSynthetic の root/triad + extensionScoring の移植。
    truth_segments の truth は truth_label_from_synthetic の (root, mode, ext)。
    """
    counted = root_ok = triad_ok = 0.0
    nc_time = 0.0
    for gt, det in _iter_samples(truth_segments, guesses, duration_sec):
        if det is None:
            nc_time += STEP
            continue
        counted += STEP
        groot, gmode, _ = gt["truth"]
        if det.root == groot:
            root_ok += STEP
            if det.mode == gmode:
                triad_ok += STEP
    out = _extension_metrics(truth_segments, guesses, duration_sec)
    out.update({
        "rootAccuracy": _ratio(root_ok, counted),
        "triadAccuracy": _ratio(triad_ok, counted),
        "countedSec": round(counted, 2),
        "ncShare": nc_time / duration_sec if duration_sec > 0 else 0.0,
    })
    return out


def sample_score_real(truth_segments, guesses, duration_sec):
    """実曲用: measureReal.measureRealSong の移植 + extensionScoring。
    truth_segments の truth は (root, coreMode, ext)、追加で truthFull に
    完全名を持ち、語彙内外は parse_truth_chord で判定する。
    - root: 全 counted 時間（N.C. 除外）で root 一致
    - triad: 正解が語彙内（三和音）の時間のみを分母に root+mode 一致
    - core: 正解が語彙外の時間のみを分母に root+mode 一致
      （coreMode が null の正解では mode は不問）
    """
    counted = root_ok = 0.0
    triad_counted = triad_ok = 0.0
    core_counted = core_ok = 0.0
    nc_time = 0.0
    confusion: dict[str, float] = {}
    for gt, det in _iter_samples(truth_segments, guesses, duration_sec):
        if det is None:
            nc_time += STEP
            continue
        parsed = parse_truth_chord(gt["label"])
        if parsed is None:
            continue
        groot, gmode, in_vocab = parsed
        counted += STEP
        root_match = det.root == groot
        mode_match = gmode is None or det.mode == gmode
        if root_match:
            root_ok += STEP
        correct = root_match and mode_match
        if in_vocab:
            triad_counted += STEP
            if correct:
                triad_ok += STEP
        else:
            core_counted += STEP
            if correct:
                core_ok += STEP
        if not correct:
            key = f"{gt['label']} → {det.label}"
            confusion[key] = confusion.get(key, 0.0) + STEP
    out = _extension_metrics(truth_segments, guesses, duration_sec)
    conf = sorted(
        ({"gt_det": k, "sec": round(v, 2)} for k, v in confusion.items()),
        key=lambda x: -x["sec"],
    )[:8]
    out.update({
        "rootAccuracy": _ratio(root_ok, counted),
        "triadAccuracy": _ratio(triad_ok, triad_counted),
        "triadCountedSec": round(triad_counted, 2),
        "coreAccuracy": _ratio(core_ok, core_counted),
        "coreCountedSec": round(core_counted, 2),
        "countedSec": round(counted, 2),
        "ncShare": nc_time / duration_sec if duration_sec > 0 else 0.0,
        "realConfusions": conf,
    })
    return out
