import type { GenreProfile, GenreStyleId } from "../types";

/**
 * 様式プロファイル（AnalysisResult.genreProfile）の表示用サマリ。
 *
 * プロファイルは単一ラベルではなく混合比率（分布）であり、
 * 表示もその混合のまま見せる: 比率が 10% 以上の様式を上位から
 * 最大3つ、「ジャズ 42% · ソウル 41%」の形で並べる。
 * ここでいう % は特徴空間での様式プロトタイプへの類似度であり、
 * 文化的系譜の比率ではない（genreProfile.ts の冒頭コメント）。
 * 判定には使わない（lib/localKeySummary.ts と同じ考え方）。
 */

export const GENRE_STYLE_LABELS: Record<GenreStyleId, string> = {
  jazz: "ジャズ",
  blues: "ブルース",
  soul: "ソウル",
  pop: "ポップ",
  rock: "ロック",
};

/** 表示に含める混合比率の下限と最大件数 */
export const GENRE_BLEND_MIN_SCORE = 0.1;
export const GENRE_BLEND_MAX_ITEMS = 3;

export interface GenreSummary {
  /** 例: 「ジャズ 42% · ソウル 41%」 */
  blendText: string;
  topLabel: string;
  confidence: number;
}

export function summarizeGenre(
  profile: GenreProfile | undefined,
): GenreSummary | null {
  if (!profile || profile.scores.length === 0) return null;
  const items = profile.scores
    .filter((s) => s.score >= GENRE_BLEND_MIN_SCORE)
    .slice(0, GENRE_BLEND_MAX_ITEMS);
  const shown = items.length > 0 ? items : [profile.scores[0]];
  return {
    blendText: shown
      .map((s) => `${GENRE_STYLE_LABELS[s.style]} ${Math.round(s.score * 100)}%`)
      .join(" · "),
    topLabel: GENRE_STYLE_LABELS[profile.scores[0].style],
    confidence: profile.confidence,
  };
}

/** 表示・書き出し共用の混合比率テキスト */
export function genreSummaryText(profile: GenreProfile | undefined): string | null {
  return summarizeGenre(profile)?.blendText ?? null;
}
