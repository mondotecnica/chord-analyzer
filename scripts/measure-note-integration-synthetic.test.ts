/**
 * 音符レベル統合の測定（合成スイート、混合音）。
 * 実行: npm run measure:note-integration
 * 結果は measurements/notepitch/notepitch-integration-synthetic.json。
 * 判定は NOTEPITCH_INTEGRATION.md に事前登録した基準で行う
 * （ここではベースライン再現と不変性のトリップワイヤのみ assert）。
 */
import { describe, expect, it } from "vitest";
import { analyzeAudio } from "../src/analysis/analyze";
import { loadNotes, runIntegrationSynthetic } from "./measureNoteIntegration";
import { SONGS, synthSong } from "./synth";
import { readWav16 } from "./wav";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOL = 0.005;

describe("音符統合: 合成スイート", () => {
  it(
    "全アームを測定し、OFF ベースラインが現行記録を再現する",
    async () => {
      const entries = await runIntegrationSynthetic();
      expect(entries).toHaveLength(9);
      const byId = new Map(entries.map((e) => [e.songId, e]));

      // OFF の再現確認（混合音はゲート不変。Phase 3.1 の記録値）
      const e = byId.get("song-e")!.arms.off;
      expect(Math.abs(e.core.rootAccuracy - 0.917)).toBeLessThan(TOL);
      expect(Math.abs(e.core.triadAccuracy - 0.885)).toBeLessThan(TOL);
      const d = byId.get("song-d")!.arms.off;
      expect(Math.abs(d.core.rootAccuracy - 0.267)).toBeLessThan(0.01);

      // フラグ ON でも音符証拠が無ければ何も変わらない（不変性）:
      // song-a を noteEvidence なしで全フラグ ON にして OFF と比較
      const spec = SONGS[0];
      const { samples } = synthSong(spec, 44100);
      const wavPath = join(
        fileURLToPath(new URL("..", import.meta.url)),
        "test-audio",
        `${spec.id}.wav`,
      );
      const wav = readWav16(wavPath);
      void samples;
      const withNotes = await analyzeAudio(wav.samples, wav.sampleRate, "a.wav", undefined, {
        noteEvidence: { harmony: loadNotes("song-a.bp.json") },
      });
      const withoutNotes = await analyzeAudio(wav.samples, wav.sampleRate, "a.wav", undefined, {
        noteBass: true,
        noteBoundaries: true,
        extensions: true,
        noteTension: true,
      });
      const plain = await analyzeAudio(wav.samples, wav.sampleRate, "a.wav", undefined, {
        extensions: true,
      });
      // 音符証拠なしのフラグ ON は拡張のみ ON と完全一致する
      expect(JSON.stringify(withoutNotes.segments)).toBe(JSON.stringify(plain.segments));
      // 音符証拠あり（境界スナップ等が効き得る）でも解析自体は完走する
      expect(withNotes.segments.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});
