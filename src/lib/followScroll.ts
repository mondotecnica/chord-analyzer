/**
 * 再生追随スクロールの計算（純関数）。
 *
 * アクティブなセグメント行の矩形 [rowTop, rowBottom]（ビューポート座標）が
 * 可視バンド [bandTop, bandBottom] に収まるために必要な window の
 * スクロール量（下方向が正）を返す。行が完全にバンド内なら 0。
 *
 * バンドは呼び出し側が決める: 上端は画面上端、下端は固定再生バーの
 * 上端（バーの高さ分を差し引く）。行がバンドより高い場合は上端を
 * 揃える（行頭が見えることを優先）。
 */
export function followScrollDelta(
  rowTop: number,
  rowBottom: number,
  bandTop: number,
  bandBottom: number,
): number {
  if (rowBottom - rowTop >= bandBottom - bandTop) {
    // 行がバンドより高い: 行頭をバンド上端に合わせる
    return rowTop - bandTop;
  }
  if (rowTop < bandTop) return rowTop - bandTop;
  if (rowBottom > bandBottom) return rowBottom - bandBottom;
  return 0;
}
