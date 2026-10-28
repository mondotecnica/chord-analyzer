/**
 * 音符証拠の TS 集計と、検証時の Python 実装（scripts/notepitch/
 * chordinfer.py）との数値整合テスト。
 *
 * 同じ音符キャッシュ（measurements/notepitch/notes/）・同じ窓で、
 * ピッチクラスシェア（pc_shares）とベース v2（ピッチクラス合算
 * argmax）が Python の出力と一致することを確認する。参照値は
 * 2026-10-29 に chordinfer.py で計算した実測値（Suno 05 の
 * Q1／Q4 窓、bass プールは検証と同じ MIDI 60 以下）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bassPoolNotes,
  noteBassEvidence,
  notePcShares,
  type NoteEvent,
} from "../src/analysis/noteEvidence";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadCacheNotes(name: string): NoteEvent[] {
  const raw = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "measurements/notepitch/notes", name), "utf-8"),
  ) as { notes: { s: number; e: number; p: number; a: number }[] };
  return raw.notes.map((n) => ({
    start: n.s,
    end: n.e,
    pitch: n.p,
    amplitude: n.a,
  }));
}

// Python（chordinfer.pc_shares / bass_pc_v2）の参照出力
const PY_Q1_OTHER_SHARES = [
  0.20933219714352752, 0.0, 0.04096033255137634, 0.0, 0.22959442296922764, 0.0,
  0.024478451385874216, 0.1915351613280746, 0.0, 0.08319502323589738, 0.0,
  0.220904411386022,
];
const PY_Q4_OTHER_SHARES = [
  0.1448021228662072, 0.09164865597316502, 0.0, 0.0, 0.3272576877370494, 0.0,
  0.0, 0.20085491835639113, 0.0, 0.038103515144238355, 0.0, 0.19733309992294895,
];
const PY_Q4_BASS_SHARES = [
  0.0, 0.5856923968175569, 0.0, 0.0, 0.06143330270181629, 0.0, 0.0, 0.0, 0.0,
  0.35287430048062673, 0.0, 0.0,
];

describe("音符集計の Python 整合（Suno フィクスチャ窓）", () => {
  const bassAll = loadCacheNotes("suno05-bass.bp.json");
  const other = loadCacheNotes("suno05-other.bp.json");
  const pool = bassPoolNotes({ harmony: other, bass: bassAll });

  it("Q1（51–56秒）: other のシェアが Python と一致し、ベース v2 は D", () => {
    const shares = notePcShares(other, 51, 56)!;
    for (let p = 0; p < 12; p++) {
      expect(shares[p]).toBeCloseTo(PY_Q1_OTHER_SHARES[p], 6);
    }
    const ev = noteBassEvidence(pool, 51, 56)!;
    expect(ev.topPc).toBe(2); // D（Python bass_pc_v2 と一致）
    expect(ev.topShare).toBeCloseTo(0.37797028860276477, 6);
  });

  it("Q4（62–65秒）: other／bass のシェアが Python と一致し、ベース v2 は C#", () => {
    const shares = notePcShares(other, 62, 65)!;
    for (let p = 0; p < 12; p++) {
      expect(shares[p]).toBeCloseTo(PY_Q4_OTHER_SHARES[p], 6);
    }
    const bassShares = notePcShares(pool, 62, 65)!;
    for (let p = 0; p < 12; p++) {
      expect(bassShares[p]).toBeCloseTo(PY_Q4_BASS_SHARES[p], 6);
    }
    const ev = noteBassEvidence(pool, 62, 65)!;
    expect(ev.topPc).toBe(1); // C#（Python bass_pc_v2 と一致）
  });
});
