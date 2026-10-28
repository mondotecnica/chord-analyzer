import { describe, expect, it } from "vitest";
import type { GenreProfile } from "../types";
import { genreSummaryText, summarizeGenre } from "./genreSummary";

/** Phase 3 後半: 様式プロファイルの表示用サマリ（混合比率）の単体テスト */

function profile(
  scores: { style: GenreProfile["top"]; score: number }[],
): GenreProfile {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  return {
    scores: sorted,
    top: sorted[0].style,
    confidence: sorted[0].score,
    margin: sorted.length > 1 ? sorted[0].score - sorted[1].score : sorted[0].score,
    features: {
      harmony: {
        maj7Presence: null,
        dom7Presence: null,
        m7Presence: null,
        diatonicShare: 0,
        secondaryDominantShare: 0,
        fifthDescentShare: 0,
        minorShare: 0,
        slashShare: 0,
        flatVIIShare: null,
        vocabSize: 0,
      },
      rhythm: { changesPerMinute: 0, onsetDensity: null, pulseRegularity: null },
      melody: { scaleConformance: null, chordToneRatio: null, activityShare: null },
      timbre: { bassShare: null, vocalShare: null, drumsShare: null, otherShare: null },
    },
    channels: { harmony: true, rhythm: false, melody: false, timbre: false },
  };
}

describe("summarizeGenre / genreSummaryText", () => {
  it("記録が無ければ null", () => {
    expect(summarizeGenre(undefined)).toBeNull();
    expect(genreSummaryText(undefined)).toBeNull();
  });

  it("混合比率を % で並べる（10% 以上・最大3つ）", () => {
    const p = profile([
      { style: "pop", score: 0.7 },
      { style: "rock", score: 0.2 },
      { style: "jazz", score: 0.1 },
    ]);
    expect(genreSummaryText(p)).toBe("ポップ 70% · ロック 20% · ジャズ 10%");
  });

  it("拮抗した混合はそのまま並べて見せる（単一ラベルにしない）", () => {
    const p = profile([
      { style: "jazz", score: 0.42 },
      { style: "soul", score: 0.41 },
      { style: "pop", score: 0.17 },
    ]);
    expect(genreSummaryText(p)).toBe("ジャズ 42% · ソウル 41% · ポップ 17%");
  });

  it("10% 未満の様式は表示から落とす", () => {
    const p = profile([
      { style: "blues", score: 0.93 },
      { style: "pop", score: 0.05 },
      { style: "rock", score: 0.02 },
    ]);
    expect(genreSummaryText(p)).toBe("ブルース 93%");
  });
});
