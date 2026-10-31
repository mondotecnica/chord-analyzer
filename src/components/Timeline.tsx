import { displaySegmentChord } from "../lib/chordDisplay";
import type { SpellingFamily } from "../lib/notes";
import type { ChordSegment } from "../types";

interface Props {
  segments: ChordSegment[];
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
  /** 音名のスペル系（移調表示用）。未指定は従来の ♯ 系 */
  spelling?: SpellingFamily;
}

/** コードのタイムライン。再生活動位置のセグメントをハイライトし、クリックでシークする。 */
export default function Timeline({ segments, duration, currentTime, onSeek, spelling }: Props) {
  if (duration <= 0) return null;
  return (
    <div className="timeline" role="list" aria-label="コードタイムライン">
      {segments.map((seg) => {
        const widthPct = ((seg.end - seg.start) / duration) * 100;
        const active = currentTime >= seg.start && currentTime < seg.end;
        const label = displaySegmentChord(seg, spelling);
        return (
          <button
            key={seg.id}
            type="button"
            role="listitem"
            className={`timeline-seg${active ? " active" : ""}${seg.chord === "N.C." ? " nc" : ""}`}
            style={{ width: `${widthPct}%` }}
            title={`${label} (${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s)`}
            onClick={() => onSeek(seg.start + 0.01)}
          >
            <span className="timeline-seg-label">{label}</span>
          </button>
        );
      })}
      <div
        className="timeline-playhead"
        style={{ left: `${(currentTime / duration) * 100}%` }}
      />
    </div>
  );
}
