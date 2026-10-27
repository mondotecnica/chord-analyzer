import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { loadAudioFile, type LoadedAudio } from "./audio/loadAudio";
import { analyzeAudio, type AnalyzeProgress } from "./analysis/analyze";
import { analyzeStemsAudio } from "./analysis/analyzeStems";
import {
  baseName,
  downloadTextFile,
  resultToJson,
  resultToText,
} from "./analysis/exportResult";
import {
  downmixToMono,
  extractStereoChannels,
  resampleChannel,
  resampleStereo,
} from "./stems/audioPrep";
import { SEPARATION_SAMPLE_RATE } from "./stems/config";
import { detectEnvironment } from "./stems/environment";
import { OnnxStemSeparator } from "./stems/onnxSeparator";
import {
  clearSeparationMarker,
  markSeparationStarted,
  takeSeparationMarker,
  type SeparationInProgressMarker,
} from "./stems/separationMarker";
import {
  estimateSeparationSeconds,
  formatApproxDuration,
  loadSeparationCalibration,
  recordSeparationCalibration,
  type SeparationCalibration,
} from "./stems/separationCalibration";
import { SeparationCancelledError } from "./stems/types";
import { displayChordName } from "./lib/chordDisplay";
import { formatTime, noteName } from "./lib/notes";
import type { AnalysisResult, ChordSegment } from "./types";
import Timeline from "./components/Timeline";
import SegmentList from "./components/SegmentList";

type Status = "idle" | "loading" | "analyzing" | "done" | "error";
/** 解析モード（MODES.md）。簡易 = 混合音そのまま、高精度 = ステム分離 */
type AnalysisMode = "simple" | "high-accuracy";

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10-6.86a1.02 1.02 0 0 0 0-1.76l-10-6.86A1.02 1.02 0 0 0 8 5.14Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function SkipBackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="6" width="2.4" height="12" rx="1" />
      <path d="M19 7.1v9.8c0 .8-.9 1.3-1.58.87L9.9 12.87a1.02 1.02 0 0 1 0-1.74l7.52-4.9c.68-.43 1.58.07 1.58.87Z" />
    </svg>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audio, setAudio] = useState<LoadedAudio | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [segments, setSegments] = useState<ChordSegment[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>("simple");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [cancellable, setCancellable] = useState(false);
  const [interruptedRun, setInterruptedRun] =
    useState<SeparationInProgressMarker | null>(null);
  // 待ち時間見積もりの較正記録（この端末での直近の分離実績）
  const [calibration, setCalibration] = useState<SeparationCalibration | null>(
    () => loadSeparationCalibration(),
  );

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const prevObjectUrl = useRef<string | null>(null);
  const separatorRef = useRef<OnnxStemSeparator | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastLoadedRef = useRef<{ loaded: LoadedAudio; fileName: string } | null>(
    null,
  );

  const environment = useMemo(() => detectEnvironment(), []);

  useEffect(() => {
    return () => {
      if (prevObjectUrl.current) URL.revokeObjectURL(prevObjectUrl.current);
    };
  }, []);

  // 起動時チェック: 前回の高精度モードがページの強制終了（メモリ不足に
  // よる再読み込み等）で中断されていたら、マーカーが残っている。
  // ハンドル済みの終了では必ず消えるため、残っていれば無言で終わった
  // ということであり、その旨をユーザーへ知らせる（取り除いて一度だけ表示）。
  useEffect(() => {
    const marker = takeSeparationMarker();
    if (marker) setInterruptedRun(marker);
  }, []);

  /** 簡易モード: 混合音をそのまま解析する（従来動作） */
  const runSimpleAnalysis = useCallback(
    async (loaded: LoadedAudio, fileName: string) => {
      setStatus("analyzing");
      const res = await analyzeAudio(
        loaded.monoSamples,
        loaded.sampleRate,
        fileName,
        setProgress,
      );
      setResult(res);
      setSegments(res.segments);
      setStatus("done");
    },
    [],
  );

  /**
   * 高精度モード: ステム分離（ONNX、端末内）→ ステム解析（s-conditional）。
   * 分離のどの段階で失敗しても簡易モードへフォールバックし、
   * キャンセル時はその旨を知らせて止める（行き止まりにしない）。
   */
  const runHighAccuracyAnalysis = useCallback(
    async (loaded: LoadedAudio, fileName: string) => {
      // 実行中マーカー: ページが強制再読み込みされても、次回起動時に
      // 「前回は完了せずに終了した」と知らせるために立てる。
      // ハンドル済みの全経路（成功・失敗・キャンセル）では finally が
      // 必ず消すため、マーカーが残るのはページ自体が死んだ場合だけになる。
      markSeparationStarted(fileName);
      const controller = new AbortController();
      abortRef.current = controller;
      setCancellable(true);
      try {
        if (!separatorRef.current) {
          separatorRef.current = new OnnxStemSeparator();
        }
        const separator = separatorRef.current;
        setStatus("analyzing");
        setProgress({ stage: "ステム分離の準備中…", ratio: 0 });
        const stereo = resampleStereo(
          extractStereoChannels(loaded.buffer),
          SEPARATION_SAMPLE_RATE,
        );
        const stems = await separator.separate(stereo, {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.stage === "model-download") {
              setProgress({
                stage: `分離モデルをダウンロード中…（初回のみ）${p.detail ? ` ${p.detail}` : ""}`,
                ratio: (p.ratio ?? 0) * 0.05,
              });
            } else {
              setProgress({
                stage: `ステム分離中…${p.detail ? `（${p.detail}）` : ""}`,
                ratio: 0.05 + (p.ratio ?? 0) * 0.75,
              });
            }
          },
        });
        // 分離が終わればキャンセル対象は無い（解析段は短時間）
        setCancellable(false);
        abortRef.current = null;
        // 実測が取れていれば、この端末の待ち時間較正として記録する
        // （分離本体のみ。ダウンロード時間は含めない）
        if (stems.timings) {
          const rec = recordSeparationCalibration(
            stems.timings.separationSeconds,
            loaded.duration,
            stems.timings.provider,
          );
          if (rec) setCalibration(rec);
        }
        setProgress({ stage: "ステムからコードを解析中…", ratio: 0.85 });
        const mixSamples = resampleChannel(
          loaded.monoSamples,
          loaded.sampleRate,
          SEPARATION_SAMPLE_RATE,
        );
        const res = await analyzeStemsAudio(
          {
            mixSamples,
            otherSamples: downmixToMono(stems.stems.other),
            bassSamples: downmixToMono(stems.stems.bass),
            sampleRate: SEPARATION_SAMPLE_RATE,
            fileName,
            separationModel: separator.modelId,
            ...(stems.timings
              ? { separationSeconds: stems.timings.separationSeconds }
              : {}),
          },
          (p) =>
            setProgress({ stage: p.stage, ratio: 0.85 + p.ratio * 0.15 }),
        );
        setResult(res);
        setSegments(res.segments);
        setStatus("done");
      } catch (e) {
        if (e instanceof SeparationCancelledError) {
          setStatus("idle");
          setNotice(
            "高精度モードをキャンセルしました。簡易モードで解析できます。",
          );
          return;
        }
        // 失敗時は簡易モードで解析し直す
        setNotice("高精度モードを開始できませんでした。簡易モードで解析します。");
        await runSimpleAnalysis(loaded, fileName);
      } finally {
        setCancellable(false);
        abortRef.current = null;
        clearSeparationMarker();
      }
    },
    [runSimpleAnalysis],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setResult(null);
      setSegments([]);
      setCurrentTime(0);
      setIsPlaying(false);
      setStatus("loading");
      setProgress({ stage: "ファイルを読み込み中…", ratio: 0 });
      try {
        const loaded = await loadAudioFile(file);
        if (prevObjectUrl.current) URL.revokeObjectURL(prevObjectUrl.current);
        prevObjectUrl.current = loaded.objectUrl;
        setAudio(loaded);
        lastLoadedRef.current = { loaded, fileName: file.name };
        if (mode === "high-accuracy") {
          await runHighAccuracyAnalysis(loaded, file.name);
        } else {
          await runSimpleAnalysis(loaded, file.name);
        }
      } catch (e) {
        setStatus("error");
        setError(
          e instanceof Error ? e.message : "解析中に不明なエラーが発生しました。",
        );
      } finally {
        setProgress(null);
      }
    },
    [mode, runHighAccuracyAnalysis, runSimpleAnalysis],
  );

  /** 読み込み済みのファイルを、現在選択中のモードで解析し直す */
  const reanalyze = useCallback(() => {
    const last = lastLoadedRef.current;
    if (!last) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setSegments([]);
    void (async () => {
      try {
        if (mode === "high-accuracy") {
          await runHighAccuracyAnalysis(last.loaded, last.fileName);
        } else {
          await runSimpleAnalysis(last.loaded, last.fileName);
        }
      } catch (e) {
        setStatus("error");
        setError(
          e instanceof Error ? e.message : "解析中に不明なエラーが発生しました。",
        );
      } finally {
        setProgress(null);
      }
    })();
  }, [mode, runHighAccuracyAnalysis, runSimpleAnalysis]);

  const cancelSeparation = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const seek = useCallback((time: number) => {
    const el = audioRef.current;
    if (el) {
      el.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const editSegment = useCallback((id: number, chord: string) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === id ? { ...s, chord, edited: true } : s)),
    );
  }, []);

  const effectiveResult: AnalysisResult | null = result
    ? { ...result, segments }
    : null;

  const currentChord = segments.find(
    (s) => currentTime >= s.start && currentTime < s.end,
  );

  const busy = status === "loading" || status === "analyzing";

  // 高精度モードの分離所要時間の目安。較正記録（この端末の前回実績）が
  // あればそれから見積もり、無ければ端末差の大きい範囲を正直に示す
  // （非力な端末では 20 分以上かかる実測があるため「数分」とは言わない）。
  const separationEstimateSec = audio
    ? estimateSeparationSeconds(calibration, audio.duration)
    : null;
  const separationEstimateNote = audio
    ? separationEstimateSec !== null
      ? `この曲（${formatTime(audio.duration)}）の分離には${formatApproxDuration(separationEstimateSec)}かかる見込みです（この端末での前回実績に基づく目安。モデルのダウンロード時間は含みません）。`
      : `この曲（${formatTime(audio.duration)}）の分離時間は端末性能で大きく変わります。速い端末では数分程度ですが、非力な端末では20分以上かかることもあります（目安）。`
    : null;

  // 処理中の経過時間（高精度モードは待ち時間が長いため常時見せる）
  useEffect(() => {
    if (!busy) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(id);
  }, [busy]);

  return (
    <div className={`app${audio ? " has-playback" : ""}`}>
      <header className="header">
        <h1>コード解析（Phase 0 試作）</h1>
        <p className="privacy-note">
          音声ファイルは<strong>ブラウザ内でのみ処理</strong>され、
          サーバーへアップロード・保存されることはありません。
        </p>
      </header>

      {interruptedRun && (
        <section className="panel notice" role="status">
          <div className="notice-row">
            <p>
              前回の高精度モード解析は完了せずに終了しました（端末のメモリ不足の可能性があります）。簡易モードはそのまま使えます。
              {interruptedRun.fileName && (
                <span className="notice-file">
                  対象ファイル: {interruptedRun.fileName}
                </span>
              )}
            </p>
            <button type="button" onClick={() => setInterruptedRun(null)}>
              閉じる
            </button>
          </div>
        </section>
      )}

      <section className="mode-section" aria-label="解析モード">
        <div className="segmented" role="tablist" aria-label="解析モード">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "simple"}
            className={mode === "simple" ? "active" : ""}
            disabled={busy}
            onClick={() => setMode("simple")}
          >
            簡易
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "high-accuracy"}
            className={mode === "high-accuracy" ? "active" : ""}
            disabled={busy}
            onClick={() => setMode("high-accuracy")}
          >
            高精度
          </button>
        </div>
        <p className="mode-desc">
          {mode === "simple"
            ? "混合音をそのまま解析します。待ち時間はほぼなく、スマホでも使えます。"
            : "ドラム／ベース／その他／ボーカルに分離してから解析します。精度は上がりますが、端末性能によっては時間がかかります（非力な端末では20分以上かかることもあります）。初回のみ分離モデル（約172MB）のダウンロードがあります。"}
        </p>
        {mode === "high-accuracy" && environment.recommendDesktop && (
          <p className="mode-note">
            この端末では処理に時間がかかったり、メモリ不足で失敗したりすることがあります。デスクトップ環境を推奨します（失敗した場合は簡易モードで解析し直します）。
          </p>
        )}
        {mode === "high-accuracy" && audio && !busy && separationEstimateNote && (
          <p className="mode-note">{separationEstimateNote}</p>
        )}
        {audio && !busy && (
          <button type="button" onClick={reanalyze}>
            このファイルを再解析
          </button>
        )}
      </section>

      <section
        className={`dropzone${dragOver ? " dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <p>ここに音声ファイルをドラッグ＆ドロップ</p>
        <p className="dropzone-sub">または</p>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          ファイルを選ぶ
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <p className="dropzone-sub">
          対応形式: mp3 / wav / m4a / ogg / flac など（ブラウザがデコードできる形式）
        </p>
      </section>

      {busy && (
        <section className="panel" aria-live="polite">
          <p>{progress?.stage ?? "処理中…"}</p>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }}
            />
          </div>
          <div className="progress-actions">
            <span className="progress-elapsed">
              経過 {formatTime(elapsedSec)}
            </span>
            {cancellable && (
              <button type="button" onClick={cancelSeparation}>
                キャンセル
              </button>
            )}
          </div>
        </section>
      )}

      {status === "error" && error && (
        <section className="panel error" role="alert">
          <p>{error}</p>
        </section>
      )}

      {notice && (
        <section className="panel notice" role="status">
          <p>{notice}</p>
        </section>
      )}

      {audio && (
        <div className="playback-bar" role="region" aria-label="再生コントロール">
          <audio
            ref={audioRef}
            src={audio.objectUrl}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />
          <div className="playback-inner">
            <input
              className="playback-seek"
              type="range"
              min={0}
              max={audio.duration || 0}
              step={0.1}
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="再生位置"
            />
            <div className="playback-row">
              <button
                type="button"
                className="play-btn"
                onClick={togglePlay}
                aria-label={isPlaying ? "一時停止" : "再生"}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => seek(0)}
                aria-label="先頭へ"
              >
                <SkipBackIcon />
              </button>
              <div className="playback-meta">
                <span className="playback-chord">
                  {currentChord
                    ? displayChordName(currentChord.chord, currentChord.bassPc)
                    : "—"}
                </span>
                <span className="playback-file">
                  {result?.fileName ?? "読み込み中"}
                </span>
              </div>
              <span className="playback-time">
                {formatTime(currentTime)} / {formatTime(audio.duration)}
              </span>
            </div>
          </div>
        </div>
      )}

      {effectiveResult && status === "done" && (
        <>
          <section className="panel summary">
            <div className="summary-row">
              <div className="summary-item">
                <span className="summary-label">キー（推定）</span>
                <span className="summary-value">
                  {noteName(effectiveResult.keyRoot)}{" "}
                  {effectiveResult.keyMode === "major" ? "メジャー" : "マイナー"}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">BPM（推定）</span>
                <span className="summary-value">
                  {effectiveResult.bpm ?? "不明"}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">セグメント数</span>
                <span className="summary-value">{segments.length}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">モード</span>
                <span className="summary-value summary-value-small">
                  {effectiveResult.mode === "high-accuracy"
                    ? "高精度モードで解析"
                    : "簡易モードで解析"}
                </span>
              </div>
            </div>
            {effectiveResult.mode === "high-accuracy" &&
              typeof effectiveResult.separationSeconds === "number" && (
                <p className="hint">
                  この解析のステム分離には
                  {formatApproxDuration(effectiveResult.separationSeconds)}
                  かかりました（モデルのダウンロード時間は含みません。この実績は次回以降の目安表示に使われます）。
                </p>
              )}
            <div className="summary-actions">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${baseName(effectiveResult.fileName)}-chords.json`,
                    resultToJson(effectiveResult),
                    "application/json",
                  )
                }
              >
                JSONで書き出し
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${baseName(effectiveResult.fileName)}-chords.txt`,
                    resultToText(effectiveResult),
                    "text/plain",
                  )
                }
              >
                テキスト譜で書き出し
              </button>
            </div>
            <p className="hint">
              書き出しに音声データは含まれません。セグメントのコードは下の一覧で
              手動修正できます（正解データとの比較＝正解率測定の土台です）。
            </p>
          </section>

          <section className="panel">
            <h2>タイムライン</h2>
            <Timeline
              segments={segments}
              duration={effectiveResult.duration}
              currentTime={currentTime}
              onSeek={seek}
            />
          </section>

          <section className="panel">
            <h2>コードセグメント</h2>
            <SegmentList
              segments={segments}
              currentTime={currentTime}
              onSeek={seek}
              onEdit={editSegment}
            />
          </section>
        </>
      )}

      <footer className="footer">
        <p>
          現在の制限: 対象はメジャー／マイナーの三和音のみです（7th／
          テンション・ジャンル傾向は今後のフェーズで対応）。
          高精度モード（ステム分離）はデスクトップ推奨の実装で、
          分離も解析もブラウザ内で完結し、音声が端末の外に出ることはありません。
        </p>
      </footer>
    </div>
  );
}
