import { displayChordName } from "../lib/chordDisplay";
import { allChordOptions, formatTime } from "../lib/notes";
import type { ChordSegment } from "../types";

interface Props {
  segments: ChordSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  onEdit: (id: number, chord: string) => void;
}

const OPTIONS = allChordOptions();

/** セグメント一覧。各行で再生位置へジャンプでき、コードを手動修正できる。 */
export default function SegmentList({ segments, currentTime, onSeek, onEdit }: Props) {
  return (
    <ul className="segment-list">
      {segments.map((seg) => {
        const active = currentTime >= seg.start && currentTime < seg.end;
        const display = displayChordName(seg.chord, seg.bassPc);
        return (
          <li key={seg.id} className={`segment-row${active ? " active" : ""}`}>
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
              {!OPTIONS.includes(seg.chord) && (
                <option value={seg.chord}>{seg.chord}</option>
              )}
              {OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
