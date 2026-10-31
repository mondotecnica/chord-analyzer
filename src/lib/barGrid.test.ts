import { describe, expect, it } from "vitest";
import {
  barDurationSec,
  barNumberAt,
  barStartSec,
  beatDurationSec,
  defaultBarGrid,
  normalizeBarGrid,
  normalizeBarGridSections,
  segmentStartBar,
  type BarGridSettings,
} from "./barGrid";

/** 「宵のひかり」の実測グリッド: 3/4・108 BPM（1小節 = 5/3 秒） */
const YOI: BarGridSettings = { bpm: 108, beatsPerBar: 3, offsetSec: 0 };
/** 汎用の 4/4・120 BPM（1小節 = 2 秒） */
const STD: BarGridSettings = { bpm: 120, beatsPerBar: 4, offsetSec: 0 };

describe("グリッドの基本量", () => {
  it("1拍 = 60 / bpm 秒、1小節 = 拍数ぶん", () => {
    expect(beatDurationSec(YOI)).toBeCloseTo(60 / 108, 10);
    expect(barDurationSec(YOI)).toBeCloseTo(5 / 3, 10);
    expect(barDurationSec(STD)).toBe(2);
  });

  it("既定値: bpm は解析値、拍子 4、オフセット 0", () => {
    expect(defaultBarGrid(108)).toEqual({
      bpm: 108,
      beatsPerBar: 4,
      offsetSec: 0,
    });
    expect(defaultBarGrid(null).bpm).toBe(120); // 推定なしは仮置き
    expect(defaultBarGrid(0).bpm).toBe(120);
  });

  it("正規化: 不正な値はフォールバック、拍数は 1..12 の整数、オフセットは 0 以上", () => {
    expect(normalizeBarGrid({ bpm: NaN, beatsPerBar: 4, offsetSec: 0 }).bpm).toBe(120);
    expect(normalizeBarGrid({ bpm: 0, beatsPerBar: 4, offsetSec: 0 }).bpm).toBe(120);
    expect(normalizeBarGrid({ bpm: -90, beatsPerBar: 4, offsetSec: 0 }).bpm).toBe(120);
    expect(normalizeBarGrid({ bpm: 120, beatsPerBar: 3.6, offsetSec: 0 }).beatsPerBar).toBe(4);
    expect(normalizeBarGrid({ bpm: 120, beatsPerBar: 0, offsetSec: 0 }).beatsPerBar).toBe(1);
    expect(normalizeBarGrid({ bpm: 120, beatsPerBar: 99, offsetSec: 0 }).beatsPerBar).toBe(12);
    expect(normalizeBarGrid({ bpm: 120, beatsPerBar: 4, offsetSec: -1 }).offsetSec).toBe(0);
    // 有効な bpm には上限を設けない
    expect(normalizeBarGrid({ bpm: 500, beatsPerBar: 4, offsetSec: 0 }).bpm).toBe(500);
  });
});

describe("時刻 → 小節番号", () => {
  it("小節は 1 始まりで、境界ちょうどは次の小節", () => {
    expect(barNumberAt(0, STD)).toBe(1);
    expect(barNumberAt(1.999, STD)).toBe(1);
    expect(barNumberAt(2, STD)).toBe(2);
    expect(barNumberAt(4, STD)).toBe(3);
  });

  it("3/4・108 BPM: 歌詞アンカー 1:38（98 秒）は 59 小節", () => {
    // ユーザー確認済みの Aメロ2 歌い出し位置（58 小節 = 97.0–98.7 秒の
    // ゾーン表記と対応付け文書で整合）。97–99 秒は 59–60 小節に落ちる
    expect(barNumberAt(97.0, YOI)).toBe(59);
    expect(barNumberAt(98.0, YOI)).toBe(59);
    expect(barNumberAt(98.7, YOI)).toBe(60);
    expect(barNumberAt(99.0, YOI)).toBe(60);
  });

  it("拍子変更で小節番号が変わる（同じ 98 秒でも 4/4 では 45 小節）", () => {
    const four: BarGridSettings = { bpm: 108, beatsPerBar: 4, offsetSec: 0 };
    expect(barNumberAt(98, four)).toBe(45); // 98 / (60/108*4) = 44.1 → 45
    expect(barNumberAt(98, { bpm: 108, beatsPerBar: 2, offsetSec: 0 })).toBe(89);
  });

  it("BPM 変更で小節番号が変わる", () => {
    expect(barNumberAt(98, { bpm: 54, beatsPerBar: 3, offsetSec: 0 })).toBe(30);
    expect(barNumberAt(98, { bpm: 216, beatsPerBar: 3, offsetSec: 0 })).toBe(118);
  });

  it("負の時刻や NaN は小節 1 に倒す", () => {
    expect(barNumberAt(-5, STD)).toBe(1);
    expect(barNumberAt(NaN, STD)).toBe(1);
  });
});

describe("オフセット", () => {
  const OFF: BarGridSettings = { bpm: 108, beatsPerBar: 3, offsetSec: 2.0 };

  it("オフセットより前は小節 0 でなく「1小節目の途中」として小節 1", () => {
    expect(barNumberAt(0, OFF)).toBe(1);
    expect(barNumberAt(1.9, OFF)).toBe(1);
    expect(barNumberAt(2.0, OFF)).toBe(1); // 1小節目1拍目の開始ちょうど
  });

  it("オフセット以降はオフセット起点で数える", () => {
    expect(barNumberAt(2.0 + 5 / 3, OFF)).toBe(2);
    expect(barNumberAt(98.0, OFF)).toBe(58); // (98-2) / (5/3) = 57.6 → 58
  });

  it("小節番号 → 開始時刻はオフセットを含む", () => {
    expect(barStartSec(1, OFF)).toBe(2.0);
    expect(barStartSec(59, OFF)).toBeCloseTo(2.0 + 58 * (5 / 3), 10);
  });
});

describe("小節番号 → 開始時刻（逆変換）", () => {
  it("barStartSec と barNumberAt は往復する", () => {
    for (const grid of [STD, YOI, { bpm: 108, beatsPerBar: 3, offsetSec: 2 }]) {
      for (const n of [1, 2, 3, 59, 123]) {
        expect(barNumberAt(barStartSec(n, grid), grid)).toBe(n);
      }
    }
  });

  it("1 未満の小節番号は 1 として扱う", () => {
    expect(barStartSec(0, STD)).toBe(0);
    expect(barStartSec(-3, STD)).toBe(0);
  });
});

describe("セグメントの開始小節", () => {
  it("セグメントの開始時刻で数える（終了時刻では数えない）", () => {
    // 98.0–100.5 秒のセグメント: 終了は 61 小節だが開始は 59 小節
    expect(segmentStartBar({ start: 98.0 }, YOI)).toBe(59);
    expect(segmentStartBar({ start: 0 }, YOI)).toBe(1);
  });
});

describe("拍子変更の区間宣言", () => {
  // 「宵のひかり」3/4・108 の途中（59小節）から 4/4 に変わる想定。
  // 58小節 × 5/3 秒 = 96.667 秒で区間が切り替わり、以降は 20/9 秒/小節
  const YOI_44: BarGridSettings = {
    ...YOI,
    sections: [{ startBar: 59, beatsPerBar: 4 }],
  };

  it("区間境界の前後で小節の物差しが切り替わる", () => {
    expect(barStartSec(58, YOI_44)).toBeCloseTo(57 * (5 / 3), 10);
    expect(barStartSec(59, YOI_44)).toBeCloseTo(58 * (5 / 3), 10); // 96.667 秒
    expect(barStartSec(60, YOI_44)).toBeCloseTo(58 * (5 / 3) + 20 / 9, 10);
    // 境界ちょうどの時刻は新しい区間の先頭小節
    expect(barNumberAt(58 * (5 / 3), YOI_44)).toBe(59);
    expect(barNumberAt(58 * (5 / 3) - 0.01, YOI_44)).toBe(58);
    // 区間内: 98 秒はまだ 59 小節（4/4 の物差しでは 98.889 秒が 60 小節）
    expect(barNumberAt(98.0, YOI_44)).toBe(59);
    expect(barNumberAt(58 * (5 / 3) + 20 / 9, YOI_44)).toBe(60);
  });

  it("区間があると後方の小節番号が単一グリッドとずれる", () => {
    // 単一 3/4 では 130 秒 = 79 小節、4/4 区間ありでは 74 小節
    expect(barNumberAt(130, YOI)).toBe(79);
    expect(barNumberAt(130, YOI_44)).toBe(74);
    // セグメントの開始小節も区間込みで数える
    expect(segmentStartBar({ start: 130 }, YOI_44)).toBe(74);
  });

  it("区間をまたいでも barStartSec と barNumberAt は往復する", () => {
    for (const n of [1, 2, 58, 59, 60, 61, 100, 123]) {
      expect(barNumberAt(barStartSec(n, YOI_44), YOI_44)).toBe(n);
    }
  });

  it("区間の bpm 省略時は基準グリッドの bpm を引き継ぐ", () => {
    const grid: BarGridSettings = {
      bpm: 120,
      beatsPerBar: 4,
      offsetSec: 0,
      sections: [{ startBar: 3, beatsPerBar: 2 }],
    };
    expect(barStartSec(3, grid)).toBe(4); // 2小節 × 2 秒
    expect(barStartSec(4, grid)).toBe(5); // 区間内は (60/120)×2 = 1 秒/小節
    // 基準 bpm を変えると、引き継いだ区間の物差しも追随する
    const slower: BarGridSettings = { ...grid, bpm: 60 };
    expect(barStartSec(3, slower)).toBe(8);
    expect(barStartSec(4, slower)).toBe(10);
  });

  it("区間の bpm を明示すると基準グリッドから独立する", () => {
    const grid: BarGridSettings = {
      bpm: 120,
      beatsPerBar: 4,
      offsetSec: 0,
      sections: [{ startBar: 3, beatsPerBar: 2, bpm: 240 }],
    };
    expect(barStartSec(3, grid)).toBe(4);
    expect(barStartSec(5, grid)).toBe(5); // (60/240)×2 = 0.5 秒/小節
    expect(barNumberAt(5, grid)).toBe(5);
    // 基準 bpm を変えても明示した区間の物差しは変わらない
    const slower: BarGridSettings = { ...grid, bpm: 60 };
    expect(barStartSec(3, slower)).toBe(8); // 手前は基準グリッドで決まる
    expect(barStartSec(5, slower)).toBe(9); // 区間内は 0.5 秒/小節のまま
  });

  it("複数の区間を累積して計算する", () => {
    const grid: BarGridSettings = {
      bpm: 120,
      beatsPerBar: 4,
      offsetSec: 0,
      sections: [
        { startBar: 5, beatsPerBar: 3 },
        { startBar: 9, beatsPerBar: 2, bpm: 240 },
      ],
    };
    expect(barStartSec(5, grid)).toBe(8); // 4小節 × 2 秒
    expect(barStartSec(9, grid)).toBe(14); // + 4小節 × 1.5 秒
    expect(barStartSec(11, grid)).toBe(15); // + 2小節 × 0.5 秒
    expect(barNumberAt(13.9, grid)).toBe(8);
    expect(barNumberAt(14, grid)).toBe(9);
    expect(barNumberAt(14.6, grid)).toBe(10);
    for (const n of [1, 4, 5, 8, 9, 10, 40]) {
      expect(barNumberAt(barStartSec(n, grid), grid)).toBe(n);
    }
  });

  it("オフセットと区間は併用できる", () => {
    const grid: BarGridSettings = {
      bpm: 120,
      beatsPerBar: 4,
      offsetSec: 2,
      sections: [{ startBar: 3, beatsPerBar: 2 }],
    };
    expect(barNumberAt(1.0, grid)).toBe(1); // オフセット前は小節 1
    expect(barStartSec(1, grid)).toBe(2);
    expect(barStartSec(3, grid)).toBe(6); // 2 + 2小節 × 2 秒
    expect(barNumberAt(6, grid)).toBe(3);
  });

  it("区間の正規化: 並べ替え、startBar 1 の除外、重複は後勝ち、不正 bpm は継承に倒す", () => {
    expect(
      normalizeBarGridSections([
        { startBar: 9, beatsPerBar: 2 },
        { startBar: 5, beatsPerBar: 3 },
      ]),
    ).toEqual([
      { startBar: 5, beatsPerBar: 3 },
      { startBar: 9, beatsPerBar: 2 },
    ]);
    expect(normalizeBarGridSections([{ startBar: 1, beatsPerBar: 3 }])).toEqual([]);
    expect(normalizeBarGridSections([{ startBar: 0, beatsPerBar: 3 }])).toEqual([]);
    expect(
      normalizeBarGridSections([
        { startBar: 5, beatsPerBar: 3 },
        { startBar: 5, beatsPerBar: 2, bpm: 90 },
      ]),
    ).toEqual([{ startBar: 5, beatsPerBar: 2, bpm: 90 }]);
    expect(
      normalizeBarGridSections([{ startBar: 5, beatsPerBar: 3, bpm: 0 }]),
    ).toEqual([{ startBar: 5, beatsPerBar: 3 }]); // bpm キー自体が付かない
    expect(
      normalizeBarGridSections([{ startBar: 5, beatsPerBar: 99 }]),
    ).toEqual([{ startBar: 5, beatsPerBar: 12 }]);
    expect(normalizeBarGridSections(undefined)).toEqual([]);
    expect(normalizeBarGridSections([])).toEqual([]);
  });

  it("区間なし・空区間では従来の単一グリッドと完全に一致する", () => {
    const withEmpty: BarGridSettings = { ...YOI, sections: [] };
    const normalized = normalizeBarGrid(withEmpty);
    // sections キー自体が付かない（従来の形と一致）
    expect(normalized).toEqual({ bpm: 108, beatsPerBar: 3, offsetSec: 0 });
    expect(normalized).not.toHaveProperty("sections");
    for (const t of [0, 1.7, 96.6, 98, 130, 205]) {
      expect(barNumberAt(t, withEmpty)).toBe(barNumberAt(t, YOI));
    }
    for (const n of [1, 59, 123]) {
      expect(barStartSec(n, withEmpty)).toBe(barStartSec(n, YOI));
    }
  });

  it("正規化は入力の区間リストを変更しない", () => {
    const sections = Object.freeze([
      Object.freeze({ startBar: 9, beatsPerBar: 2 }),
      Object.freeze({ startBar: 5, beatsPerBar: 3 }),
    ]);
    const grid: BarGridSettings = { ...YOI, sections };
    expect(barStartSec(9, grid)).toBeGreaterThan(0);
    expect(sections[0].startBar).toBe(9); // 元の順序のまま
  });
});

describe("解析不変性（表示専用レイヤー）", () => {
  it("グリッド計算はセグメントや設定オブジェクトを変更しない", () => {
    const seg = Object.freeze({ start: 98.0, end: 100.5 });
    const grid = Object.freeze({ bpm: 108, beatsPerBar: 3, offsetSec: 0 });
    expect(segmentStartBar(seg, grid)).toBe(59);
    expect(segmentStartBar(seg, grid)).toBe(59); // 再計算しても同じ
    expect(seg.start).toBe(98.0);
    expect(grid.bpm).toBe(108);
  });
});
