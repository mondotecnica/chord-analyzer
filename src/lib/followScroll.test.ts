import { describe, expect, it } from "vitest";
import { followScrollDelta } from "./followScroll";

// バンドは [100, 500] に固定して検証する（高さ 400）
const TOP = 100;
const BOTTOM = 500;

describe("followScrollDelta", () => {
  it("行が完全にバンド内なら 0（動かさない）", () => {
    expect(followScrollDelta(200, 240, TOP, BOTTOM)).toBe(0);
  });

  it("行がバンドの端に接しているだけでも 0", () => {
    expect(followScrollDelta(100, 140, TOP, BOTTOM)).toBe(0);
    expect(followScrollDelta(460, 500, TOP, BOTTOM)).toBe(0);
  });

  it("行が下にはみ出したら、はみ出し分だけ下へスクロールする", () => {
    expect(followScrollDelta(470, 530, TOP, BOTTOM)).toBe(30);
  });

  it("行全体がバンドより下なら、下端がバンド下端に合うまで動かす", () => {
    expect(followScrollDelta(700, 740, TOP, BOTTOM)).toBe(240);
  });

  it("行が上にはみ出したら、はみ出し分だけ上へスクロールする", () => {
    expect(followScrollDelta(60, 110, TOP, BOTTOM)).toBe(-40);
  });

  it("行全体がバンドより上なら、上端がバンド上端に合うまで動かす", () => {
    expect(followScrollDelta(-300, -260, TOP, BOTTOM)).toBe(-400);
  });

  it("行がバンドより高い場合は行頭をバンド上端に揃える", () => {
    expect(followScrollDelta(150, 700, TOP, BOTTOM)).toBe(50);
    expect(followScrollDelta(-50, 700, TOP, BOTTOM)).toBe(-150);
  });
});
