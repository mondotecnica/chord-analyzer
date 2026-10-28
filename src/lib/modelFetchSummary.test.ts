import { describe, expect, it } from "vitest";
import { modelFetchSummaryLine } from "./modelFetchSummary";
import type { ModelFetchSummary } from "../types";

describe("modelFetchSummaryLine（モデル取得の結果表示行）", () => {
  it("記録が無ければ null", () => {
    expect(modelFetchSummaryLine(undefined)).toBeNull();
  });

  it("キャッシュ読み込みはその旨と時間を伝える", () => {
    const mf: ModelFetchSummary = {
      source: "cache",
      seconds: 12,
      persisted: null,
    };
    expect(modelFetchSummaryLine(mf)).toBe(
      "モデル: キャッシュから読み込み（約12秒）",
    );
  });

  it("ダウンロード＋保存成功はその旨を伝える", () => {
    const mf: ModelFetchSummary = {
      source: "download",
      seconds: 180,
      persisted: true,
    };
    expect(modelFetchSummaryLine(mf)).toBe(
      "モデル: ダウンロード（約3分）／キャッシュに保存しました",
    );
  });

  it("保存失敗は次回もダウンロードが必要だと正直に伝える", () => {
    const mf: ModelFetchSummary = {
      source: "download",
      seconds: 180,
      persisted: false,
    };
    expect(modelFetchSummaryLine(mf)).toBe(
      "モデルを保存できませんでした（ブラウザの保存容量の制限の可能性があります）。次回もダウンロードが必要になります。",
    );
  });

  it("キャッシュ消失＋再保存できた回は、消えていた事実を伝える", () => {
    const mf: ModelFetchSummary = {
      source: "download",
      seconds: 180,
      persisted: true,
      cacheLost: true,
    };
    expect(modelFetchSummaryLine(mf)).toContain("前回のキャッシュが消えていたため再ダウンロードしました");
    expect(modelFetchSummaryLine(mf)).toContain("キャッシュに保存しました");
  });

  it("保存先が無い構成ではダウンロードの事実だけを伝える", () => {
    const mf: ModelFetchSummary = {
      source: "download",
      seconds: 95,
      persisted: null,
    };
    expect(modelFetchSummaryLine(mf)).toBe("モデル: ダウンロード（約2分）");
  });
});
