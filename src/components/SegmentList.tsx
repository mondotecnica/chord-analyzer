import { useEffect, useRef, useState } from "react";
import { displaySegmentChord } from "../lib/chordDisplay";
import { followScrollDelta } from "../lib/followScroll";
import {
  allChordOptionsSpelled,
  formatTime,
  type SpellingFamily,
} from "../lib/notes";
import type { ChordSegment } from "../types";

interface Props {
  segments: ChordSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  onEdit: (id: number, chord: string) => void;
  /** 音名のスペル系（移調表示用）。未指定は従来の ♯ 系 */
  spelling?: SpellingFamily;
  /**
   * セグメントごとの度数表記（lib/degrees.ts、segments と同じ並び）。
   * null のセグメント（N.C. 等）には出さない。未指定は度数表示なし。
   */
  degrees?: ReadonlyArray<string | null>;
  /**
   * セグメントごとの開始小節番号（lib/barGrid.ts、segments と同じ
   * 並び）。ユーザー設定グリッドから導出した表示専用の値。
   * 未指定は小節表示なし。
   */
  bars?: ReadonlyArray<number>;
  /** 再生中かどうか。true の間だけ追随スクロールが働く */
  isPlaying?: boolean;
  /**
   * 追随の再開シグナル。値が変わるたびに追随が再び有効になる。
   * 呼び出し側（App）は再生開始とシークのたびに増やす。
   */
  followSignal?: number;
}

/**
 * セグメント一覧。各行で再生位置へジャンプでき、コードを手動修正できる。
 * 移調表示中は移調済みセグメントを受け取り、セレクタの選択肢も
 * 表示中のスペル系で出す。onEdit へ渡るのは表示中のラベルであり、
 * 元の表記への逆変換は呼び出し側（App）が担う。
 *
 * 再生中はアクティブ行への追随スクロールを行う: 行が可視バンド
 * （画面下端の固定再生バーの上まで）の外に出たときだけ、はみ出し分を
 * 滑らかにスクロールする。ユーザーがホイール／タッチ／ページキーで
 * 自分でスクロールしたら追随は一時停止し、再生の再開やシーク
 * （followSignal の変化）で再び有効になる。
 */
export default function SegmentList({
  segments,
  currentTime,
  onSeek,
  onEdit,
  spelling,
  degrees,
  bars,
  isPlaying,
  followSignal,
}: Props) {
  const options = allChordOptionsSpelled(spelling ?? "sharps");
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  const [follow, setFollow] = useState(true);

  const activeId =
    segments.find((s) => currentTime >= s.start && currentTime < s.end)
      ?.id ?? null;

  // シーク（followSignal の変化）で追随を再開する
  useEffect(() => {
    setFollow(true);
  }, [followSignal]);

  // 再生が始まったら追随を再開する（一時停止→再生の押し直しを含む）
  useEffect(() => {
    if (isPlaying) setFollow(true);
  }, [isPlaying]);

  // ユーザー自身のスクロール操作を検知したら追随を止める。
  // プログラムによるスクロールは wheel / touchmove を発しないため、
  // 自分のスクロールで自分を止めることはない。
  useEffect(() => {
    const stop = () => setFollow(false);
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) stop();
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // アクティブ行が可視バンドの外に出たら、はみ出し分だけ追随する。
  // バンドの下端は固定再生バーの上端（バー実高をその都度測る）。
  useEffect(() => {
    if (!isPlaying || !follow || activeId == null) return;
    const row = rowRefs.current.get(activeId);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const bar = document.querySelector(".playback-bar");
    const barHeight = bar ? bar.getBoundingClientRect().height : 0;
    const bandTop = 8;
    const bandBottom = window.innerHeight - barHeight - 8;
    const delta = followScrollDelta(rect.top, rect.bottom, bandTop, bandBottom);
    if (delta !== 0) {
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      window.scrollBy({
        top: delta,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, [activeId, follow, isPlaying, segments]);

  return (
    <ul className="segment-list">
      {segments.map((seg, i) => {
        const active = seg.id === activeId;
        const display = displaySegmentChord(seg, spelling);
        const degree = degrees?.[i] ?? null;
        const bar = bars?.[i] ?? null;
        return (
          <li
            key={seg.id}
            ref={(el) => {
              if (el) rowRefs.current.set(seg.id, el);
              else rowRefs.current.delete(seg.id);
            }}
            className={`segment-row${active ? " active" : ""}`}
          >
            <button
              type="button"
              className="segment-time"
              onClick={() => onSeek(seg.start + 0.01)}
              title="この位置から再生"
            >
              {formatTime(seg.start)} – {formatTime(seg.end)}
            </button>
            {display !== seg.chord && (
              <span className="segment-slash" title="分数コード（ベース音つき表示）">
                {display}
              </span>
            )}
            <select
              className="segment-chord"
              value={seg.chord}
              onChange={(e) => onEdit(seg.id, e.target.value)}
              aria-label={`セグメント ${seg.id + 1} のコード`}
            >
              {!options.includes(seg.chord) && (
                <option value={seg.chord}>{seg.chord}</option>
              )}
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {bar !== null && (
              <span
                className="segment-bar"
                title="小節番号（ユーザー設定の小節グリッドに基づく表示）"
              >
                {bar}小節
              </span>
            )}
            {degree !== null && (
              <span
                className="segment-degree"
                title="度数（キーから見た機能和声表記）"
              >
                {degree}
              </span>
            )}
            <span className="segment-conf" title="信頼度">
              {Math.round(seg.confidence * 100)}%
            </span>
            {seg.edited && <span className="segment-edited">修正済み</span>}
          </li>
        );
      })}
    </ul>
  );
}
