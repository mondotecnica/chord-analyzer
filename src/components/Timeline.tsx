import { displayChordName } from "../lib/chordDisplay";
import type { ChordSegment } from "../types";

interface Props {
  segments: ChordSegment[];
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
}

/** コードのタイムライン。再生活動位置のセグメントをハイライトし、クリックでシークする。 */
export default function Timeline({ segments, duration, currentTime, onSeek }: Props) {
  if (duration <= 0) return null;
  return (
    <div className="timeline" role="list" aria-label="コードタイムライン">
      {segments.map((seg) => {
        const widthPct = ((seg.end - seg.start) / duration) * 100;
        const active = currentTime >= seg.start && currentTime < seg.end;
        const label = displayChordName(seg.chord, seg.bassPc);
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
