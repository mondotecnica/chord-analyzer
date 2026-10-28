/**
 * 正解（グラウンドトゥルース）が既知の合成テスト音源ジェネレータ。
 *
 * 単なる正弦波の重ね合わせではなく、最低限「楽器らしい」音にする:
 * - コードトーンは基本波＋倍音（2倍音 0.5 / 3倍音 0.25 / 4倍音 0.12）で合成し、
 *   指数減衰エンベロープ（プラック感）を持たせる
 * - ルートのベース音を 1・3 拍目に別途鳴らす（オクターブ下、減衰は長め）
 * - 小節頭にストラム（構成音同時発音）、8分音符のアルペジオを重ねる
 * - ベロシティは固定パターンで変化させる（再現性のため乱数は使わない）
 *
 * テンポと 1 コード = 1 小節は全曲共通の設計で、正解セグメントは小節境界と一致する。
 */
import { chordName, noteName, NOTE_NAMES } from "../src/lib/notes";

/** 進行の 1 コード分。bassPc を指定するとベース音をルートと別に鳴らせる（分数コード用） */
export interface ProgressionChord {
  root: number;
  mode: "major" | "minor";
  /** ベース音のピッチクラス（省略時はルートと同じ） */
  bassPc?: number;
  /** 7th の種類（Phase 3 用。省略時は三和音）。maj7=長7度、m7/dom7=短7度 */
  seventh?: "maj7" | "m7" | "dom7";
  /** add9（9th の付加音、Phase 3.2 用。省略時はなし）。7th とは併用しない */
  add9?: boolean;
}

export interface SongSpec {
  id: string;
  /** ファイル名・レポート表示用タイトル */
  title: string;
  /** 正解キー表示（例: "C major" / "A minor"） */
  trueKey: string;
  bpm: number;
  beatsPerBar: number;
  /** 進行（ピッチクラス＋モードの列）。この順に繰り返す */
  progression: ProgressionChord[];
  /** 進行を何周するか */
  repeats: number;
}

export interface GroundTruthSegment {
  startSec: number;
  endSec: number;
  /** コード名（ルート＋モードのみ。分数表記は含まない） */
  chord: string;
  /** 7th を含む完全なコード名（Phase 3 用。三和音の場合は省略） */
  fullChord?: string;
  /** ベース音の音名（ルートと別フィールドで保持する） */
  bass: string;
  /** ベース音のピッチクラス */
  bassPc: number;
}

export interface GroundTruth {
  songId: string;
  title: string;
  key: string;
  bpm: number;
  sampleRate: number;
  durationSec: number;
  segments: GroundTruthSegment[];
}

function pc(note: string): number {
  const i = NOTE_NAMES.indexOf(note as (typeof NOTE_NAMES)[number]);
  if (i < 0) throw new Error(`未知の音名: ${note}`);
  return i;
}

const M = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "major",
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const m = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "minor",
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const M7 = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "major",
  seventh: "maj7",
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const m7 = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "minor",
  seventh: "m7",
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const dom7 = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "major",
  seventh: "dom7",
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const Madd9 = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "major",
  add9: true,
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});
const madd9 = (root: string, bass?: string): ProgressionChord => ({
  root: pc(root),
  mode: "minor",
  add9: true,
  ...(bass !== undefined ? { bassPc: pc(bass) } : {}),
});

/** テスト曲3曲の定義（すべて Phase 0 の語彙＝major/minor 三和音のみ） */
export const SONGS: SongSpec[] = [
  {
    id: "song-a",
    title: "Song A — C major (I–vi–IV–V)",
    trueKey: "C major",
    bpm: 120,
    beatsPerBar: 4,
    progression: [M("C"), m("A"), M("F"), M("G")],
    repeats: 2,
  },
  {
    id: "song-b",
    title: "Song B — G major (I–ii–vi–IV / I–ii–IV–V)",
    trueKey: "G major",
    bpm: 108,
    beatsPerBar: 4,
    progression: [
      M("G"), m("A"), m("E"), M("C"),
      M("G"), m("A"), M("C"), M("D"),
    ],
    repeats: 1,
  },
  {
    id: "song-c",
    title: "Song C — A minor (i–VI–III–VII / i–iv–v–i)",
    trueKey: "A minor",
    bpm: 100,
    beatsPerBar: 4,
    progression: [
      m("A"), M("F"), M("C"), M("G"),
      m("A"), m("D"), m("E"), m("A"),
    ],
    repeats: 1,
  },
];

/**
 * 分数コード用のテスト曲（Phase 1 Step 2）。
 * SONGS（A–C）とは分けて持ち、既存の測定（ベースライン／Step 1）の対象範囲を変えない。
 * ベース音はいずれもコード構成音（3rd または 5th）:
 * C/E（3rd）– F/A（3rd）– G/B（3rd）– Am/E（5th）
 */
export const SLASH_SONGS: SongSpec[] = [
  {
    id: "song-d",
    title: "Song D — C major slash chords (C/E–F/A–G/B–Am/E)",
    trueKey: "C major",
    bpm: 112,
    beatsPerBar: 4,
    progression: [M("C", "E"), M("F", "A"), M("G", "B"), m("A", "E")],
    repeats: 2,
  },
];

/**
 * 7th コード用のテスト曲（Phase 3.1 の測定土台）。
 * SONGS（A–C）・SLASH_SONGS（D）とは分けて持ち、既存の測定の対象範囲を変えない。
 * 前半は Suno 05 の Q3 窓（CM7–B7–E7–Am7）そのもの、後半は ii–V–I 型
 * （Dm7–G7–CM7–Am7）。テンポ 108 は Suno 05 と同じ。
 * 正解セグメントの chord は三和音コア（既存ハーネスの「コア正解」と一致）、
 * fullChord が 7th を含む完全な正解。
 */
export const SEVENTH_SONGS: SongSpec[] = [
  {
    id: "song-e",
    title: "Song E — 7th chords (CM7–B7–E7–Am7 / Dm7–G7–CM7–Am7)",
    trueKey: "A minor",
    bpm: 108,
    beatsPerBar: 4,
    progression: [
      M7("C"), dom7("B"), dom7("E"), m7("A"),
      m7("D"), dom7("G"), M7("C"), m7("A"),
    ],
    repeats: 1,
  },
];

/**
 * Song F: 二次ドミナント中心の 7th 曲（Phase 3.1 の測定土台、Song E と対）。
 * C major で A7（V/V）を含む。前半は全小節 7th、後半に三和音の
 * 小節（C／F）を混ぜ、第2段の誤発火（false-fire）を同じ曲の中で
 * 測れるようにしてある。SEVENTH_SONGS とは分けて持ち、
 * measureSeventh.ts のベースライン対象（Song E のみ）を変えない。
 */
export const SECONDARY_DOMINANT_SONGS: SongSpec[] = [
  {
    id: "song-f",
    title: "Song F — secondary dominants (CM7–A7–Dm7–G7 / C–F–G7–Am7)",
    trueKey: "C major",
    bpm: 96,
    beatsPerBar: 4,
    progression: [
      M7("C"), dom7("A"), m7("D"), dom7("G"),
      M("C"), M("F"), dom7("G"), m7("A"),
    ],
    repeats: 1,
  },
];

/**
 * Song G: add9 と分数層のテスト曲（Phase 3.2 の測定土台）。
 * 先頭小節は Suno 05 の Q4（上層 Am＋9th／ベース C#）の合成ミラー。
 * add9 のルート位置（Cadd9／Am(add9)／Fadd9）と三和音の対照
 * （G／Em）を同じ曲に入れ、付加音検出の真陽性と誤発火を同時に測る。
 * Cadd9 と Am(add9) は構成音が近いため、第1段のセグメント分割が
 * 小節を跨いで結合しないよう、間に対照の G を挟む配列にしてある
 * （分割自体は Phase 0 の守備範囲で、3.2 の測定対象ではない）。
 * SEVENTH_SONGS 等とは分けて持ち、既存の測定の対象範囲を変えない。
 */
export const ADD9_SONGS: SongSpec[] = [
  {
    id: "song-g",
    title: "Song G — add9 layers (Am(add9)/C# / Cadd9 / G / Am(add9) / Fadd9 / Em)",
    trueKey: "A minor",
    bpm: 112,
    beatsPerBar: 4,
    progression: [
      madd9("A", "C#"),
      Madd9("C"),
      M("G"),
      madd9("A"),
      Madd9("F"),
      m("E"),
    ],
    repeats: 2,
  },
];

const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** 8分音符ごとのベロシティパターン（固定、再現性のため） */
const ARP_VELOCITY = [1.0, 0.72, 0.88, 0.66, 0.94, 0.7, 0.84, 0.62];

interface PluckOpts {
  harmonics: number[];
  tau: number; // 減衰時定数（秒）
  gain: number;
}

/** 1音をバッファに加算する（アタック付き指数減衰＋倍音） */
function addPluck(
  buf: Float32Array,
  sampleRate: number,
  startSec: number,
  durSec: number,
  midi: number,
  velocity: number,
  opts: PluckOpts,
) {
  const freq = midiToFreq(midi);
  const start = Math.floor(startSec * sampleRate);
  const len = Math.floor(durSec * sampleRate);
  const attack = Math.max(1, Math.floor(0.008 * sampleRate));
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / sampleRate;
    const env =
      (i < attack ? i / attack : 1) * Math.exp(-t / opts.tau);
    let v = 0;
    for (let h = 0; h < opts.harmonics.length; h++) {
      v += opts.harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t);
    }
    buf[idx] += v * env * velocity * opts.gain;
  }
}

/**
 * 曲を合成して PCM と正解セグメントを返す。
 * 末尾に最終コードの余韻用として 1 秒の無音に近いテールを足すが、
 * 正解セグメントは最終小節の終わりまでとし、テールは正解の対象外とする
 * （呼び出し側で duration は正解セグメントの終端までとして扱う）。
 */
export function synthSong(spec: SongSpec, sampleRate: number): {
  samples: Float32Array;
  truth: GroundTruth;
} {
  const beatSec = 60 / spec.bpm;
  const barSec = beatSec * spec.beatsPerBar;
  const chords: ProgressionChord[] = [];
  for (let r = 0; r < spec.repeats; r++) chords.push(...spec.progression);
  const musicSec = chords.length * barSec;
  const tailSec = 1.0;
  const totalSamples = Math.ceil((musicSec + tailSec) * sampleRate);
  const buf = new Float32Array(totalSamples);

  const chordOpts: PluckOpts = {
    harmonics: [1, 0.5, 0.25, 0.12],
    tau: 0.38,
    gain: 0.16,
  };
  const bassOpts: PluckOpts = {
    harmonics: [1, 0.42, 0.16],
    tau: 0.85,
    gain: 0.34,
  };

  chords.forEach((ch, barIdx) => {
    const barStart = barIdx * barSec;
    const third = ch.mode === "major" ? 4 : 3;
    const rootMidi = 60 + ch.root; // C4..B4
    const tones = [rootMidi, rootMidi + third, rootMidi + 7, rootMidi + 12];
    // 7th がある場合は 5th の後ろに 7th 音を挿入する（アルペジオにも回る）
    const seventhInterval =
      ch.seventh === "maj7" ? 11 : ch.seventh === undefined ? null : 10;
    if (seventhInterval !== null) tones.splice(3, 0, rootMidi + seventhInterval);
    // add9 がある場合は 9th 音（ルートの1オクターブ＋長2度）も同じ位置に入れる
    if (ch.add9) tones.splice(3, 0, rootMidi + 14);
    const colorCount =
      (seventhInterval !== null ? 1 : 0) + (ch.add9 ? 1 : 0);
    // ベース音はルートと別指定が可能（分数コード）。未指定ならルートを鳴らす
    const bassMidi = 36 + (ch.bassPc ?? ch.root); // C2..B2

    // ベース: 1拍目と3拍目
    addPluck(buf, sampleRate, barStart, beatSec * 1.9, bassMidi, 1.0, bassOpts);
    addPluck(buf, sampleRate, barStart + beatSec * 2, beatSec * 1.9, bassMidi, 0.85, bassOpts);

    // ストラム: 小節頭に構成音をほぼ同時に（10ms ずつずらす）
    // 三和音は 3 音、色付け音（7th / add9）がある場合はその音まで
    tones.slice(0, 3 + colorCount).forEach((mt, i) => {
      addPluck(buf, sampleRate, barStart + i * 0.011, beatSec * 1.1, mt, 0.9, chordOpts);
    });

    // アルペジオ: 8分音符で構成音＋オクターブを循環
    const eighth = beatSec / 2;
    for (let e = 0; e < spec.beatsPerBar * 2; e++) {
      const mt = tones[e % tones.length];
      const vel = ARP_VELOCITY[e % ARP_VELOCITY.length];
      addPluck(buf, sampleRate, barStart + e * eighth, eighth * 1.6, mt, vel, chordOpts);
    }
  });

  // ピーク正規化（クリッピング防止）
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const scale = 0.85 / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= scale;
  }

  const segments: GroundTruthSegment[] = chords.map((ch, i) => {
    const bassPc = ch.bassPc ?? ch.root;
    const core = chordName(ch.root, ch.mode);
    const fullChord =
      ch.seventh === "maj7"
        ? `${noteName(ch.root)}M7`
        : ch.seventh === "dom7"
          ? `${noteName(ch.root)}7`
          : ch.seventh === "m7"
            ? `${noteName(ch.root)}m7`
            : ch.add9
              ? ch.mode === "major"
                ? `${noteName(ch.root)}add9`
                : `${noteName(ch.root)}m(add9)`
              : undefined;
    return {
      startSec: Number((i * barSec).toFixed(3)),
      endSec: Number(((i + 1) * barSec).toFixed(3)),
      chord: core,
      ...(fullChord !== undefined ? { fullChord } : {}),
      bass: noteName(bassPc),
      bassPc,
    };
  });

  return {
    samples: buf,
    truth: {
      songId: spec.id,
      title: spec.title,
      key: spec.trueKey,
      bpm: spec.bpm,
      sampleRate,
      durationSec: Number(musicSec.toFixed(3)),
      segments,
    },
  };
}
