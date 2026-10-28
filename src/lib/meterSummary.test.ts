import { describe, expect, it } from "vitest";
import type { MeterEstimate } from "../types";
import { meterSummaryText } from "./meterSummary";

function meter(partial: Partial<MeterEstimate>): MeterEstimate {
  return {
    beatsPerBar: 3,
    notation: "3/4",
    barPhaseSec: 0.1,
    barSec: 1.667,
    tempoBpm: 108,
    detectedBpm: 108,
    tempoScale: 1,
    score: 0.8,
    margin: 0.2,
    onsetSource: "mixture",
    evidence: { pulse: 0.27, barAutocorr: 0.11, boundary: 0.5, boundaryAutocorr: 0.4 },
    runnerUp: null,
    ...partial,
  };
}

describe("拍子サマリ表示", () => {
  it("記録が無ければ null", () => {
    expect(meterSummaryText(undefined)).toBeNull();
  });

  it("確定時は「3/4 · テンポ 108」", () => {
    expect(meterSummaryText(meter({}))).toBe("3/4 · テンポ 108");
  });

  it("仲裁で変わった場合は検出値を併記する", () => {
    expect(
      meterSummaryText(
        meter({
          beatsPerBar: 4,
          notation: "4/4",
          tempoBpm: 65,
          detectedBpm: 129,
          tempoScale: 0.5,
        }),
      ),
    ).toBe("4/4 · テンポ 65（検出 129）");
  });

  it("判定保留時はその旨を示す", () => {
    expect(
      meterSummaryText(
        meter({ beatsPerBar: null, notation: null, tempoScale: 1 }),
      ),
    ).toBe("判定保留（証拠不足）");
  });
});
