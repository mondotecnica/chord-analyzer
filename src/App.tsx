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
import {
  barDurationSec,
  DEFAULT_BEATS_PER_BAR,
  defaultBarGrid,
  normalizeBarGrid,
  normalizeBarGridSections,
  segmentStartBar,
  type BarGridSection,
  type BarGridSettings,
} from "./lib/barGrid";
import { displaySegmentChord } from "./lib/chordDisplay";
import { segmentDegreeInResult } from "./lib/degrees";
import { summarizeGenre } from "./lib/genreSummary";
import { summarizeLocalKeys } from "./lib/localKeySummary";
import { meterSummaryText } from "./lib/meterSummary";
import { modelFetchSummaryLine } from "./lib/modelFetchSummary";
import {
  formatTime,
  noteNameSpelled,
  type SpellingFamily,
} from "./lib/notes";
import {
  capoFretForShift,
  keySpelling,
  transposeAnalysisResult,
  transposeChordLabel,
} from "./lib/transpose";
import type { AnalysisResult, ChordSegment } from "./types";
import Timeline from "./components/Timeline";
import SegmentList from "./components/SegmentList";

type Status = "idle" | "loading" | "analyzing" | "done" | "error";
/** 解析モード（MODES.md）。簡易 = 混合音そのまま、高精度 = ステム分離 */
type AnalysisMode = "simple" | "high-accuracy";

/** 移調 UI の操作範囲（半音）。変換自体は lib/transpose.ts が任意量を受ける */
const TRANSPOSE_MIN = -6;
const TRANSPOSE_MAX = 6;

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
  // セグメント一覧の追随スクロールの再開シグナル。再生開始とシークの
  // たびに増やし、SegmentList はこの変化で追随を再び有効にする
  // （ユーザーが自分でスクロールしている間の追随は止まる）。
  const [followSignal, setFollowSignal] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>("simple");
  // 移調量（半音、表示・書き出し専用）。解析結果そのものは書き換えず、
  // 表示用に移調済み結果を導出する（lib/transpose.ts）。
  const [transposeShift, setTransposeShift] = useState(0);
  // 小節グリッド（表示・書き出し専用、lib/barGrid.ts）。拍子は推定
  // しないためユーザーが設定する。BPM の初期値は解析の推定値で、
  // 新しい解析結果が入るたびに既定へ戻す（各 run*Analysis 内）。
  const [barGrid, setBarGrid] = useState<BarGridSettings>(() =>
    defaultBarGrid(null),
  );
  // 拍子変更の区間宣言（lib/barGrid.ts）の追加フォーム用の入力値。
  // 宣言そのものは barGrid.sections に保持する。
  const [sectionStartBarInput, setSectionStartBarInput] = useState("");
  const [sectionBeatsInput, setSectionBeatsInput] =
    useState(DEFAULT_BEATS_PER_BAR);
  const [sectionBpmInput, setSectionBpmInput] = useState("");

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
      // 小節グリッドは新しい結果ごとに既定（BPM = 解析値）へ戻す
      setBarGrid(defaultBarGrid(res.bpm));
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
              // キャッシュから読んでいる回は「ダウンロード中」と
              // 表示しない（実態と食い違う表示の是正、2026-10-28）。
              setProgress({
                stage:
                  p.fromCache === true
                    ? "分離モデルを読み込み中…（キャッシュから）"
                    : `分離モデルをダウンロード中…${p.detail ? ` ${p.detail}` : ""}`,
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
        // モデル取得の記録（取得元・秒数・保存の成否）を結果に残す。
        // 「毎回ダウンロードしているのか」をユーザーが切り分けられる
        // ようにするためのもので、判定には使わない。
        const modelFetch = stems.modelFetch
          ? {
              source: stems.modelFetch.source,
              seconds: stems.timings?.modelDownloadSeconds ?? 0,
              persisted: stems.modelFetch.persisted,
              ...(stems.modelFetch.cacheLost ? { cacheLost: true } : {}),
              ...(stems.storage
                ? {
                    storagePersisted: stems.storage.persistGranted,
                    storageUsageBytes: stems.storage.usageBytes,
                    storageQuotaBytes: stems.storage.quotaBytes,
                  }
                : {}),
            }
          : undefined;
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
            ...(modelFetch ? { modelFetch } : {}),
          },
          (p) =>
            setProgress({ stage: p.stage, ratio: 0.85 + p.ratio * 0.15 }),
        );
        setResult(res);
        setSegments(res.segments);
        // 小節グリッドは新しい結果ごとに既定（BPM = 解析値）へ戻す
        setBarGrid(defaultBarGrid(res.bpm));
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
      setTransposeShift(0);
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
    setTransposeShift(0);
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
      setFollowSignal((n) => n + 1);
    }
  }, []);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      setFollowSignal((n) => n + 1);
      void el.play();
    } else el.pause();
  };

  const editSegment = useCallback((id: number, chord: string) => {
    setSegments((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        // Phase 3.2: ユーザーがコードを決めたセグメントでは、機械の
        // 読み由来の層（upperChord / upperExtension / addTones）は
        // 根拠を失うため落とす（表示はユーザーのコードが土台になる）
        const next = { ...s, chord, edited: true };
        delete next.upperChord;
        delete next.upperExtension;
        delete next.addTones;
        return next;
      }),
    );
  }, []);

  const effectiveResult: AnalysisResult | null = result
    ? { ...result, segments }
    : null;

  // 移調表示（表示・書き出し専用、lib/transpose.ts）。移調量 0 では
  // transposeAnalysisResult が入力と同一オブジェクトを返すため、
  // 表示・書き出しは従来と完全一致する。表示・書き出し・再生バーの
  // コード名は全て viewResult / viewSpelling 経由に統一する。
  const transposedView = useMemo(
    () =>
      effectiveResult
        ? transposeAnalysisResult(effectiveResult, transposeShift)
        : null,
    [effectiveResult, transposeShift],
  );
  const viewResult = transposedView?.result ?? null;
  const viewSpelling: SpellingFamily = transposedView?.family ?? "sharps";

  // セグメント一覧での手動修正は表示中（移調済み）のラベルで届くため、
  // 保存前に逆移調して解析側の表記（♯ 系）へ戻す。保存される
  // セグメントは常に原曲キーの表記のままになる。
  const editSegmentFromView = useCallback(
    (id: number, displayedChord: string) => {
      const original =
        transposeShift === 0
          ? displayedChord
          : transposeChordLabel(displayedChord, -transposeShift, "sharps");
      editSegment(id, original);
    },
    [editSegment, transposeShift],
  );

  // 局所キー（Phase 3.3、記録・表示のみ既定 ON）の要約表示。
  // 窓列は記録専用で、ラベル判定には使われていない。
  // 移調表示中は移調済み窓列（viewResult）から要約し、スペルも揃える。
  const localKeySummary = useMemo(
    () => summarizeLocalKeys(viewResult?.localKeys),
    [viewResult?.localKeys],
  );
  const localKeyLabel = (root: number, mode: "major" | "minor") =>
    `${noteNameSpelled(root, viewSpelling)} ${mode === "major" ? "メジャー" : "マイナー"}`;

  // 度数表示（lib/degrees.ts、表示専用）。セグメントの局所キーを
  // 優先し、無ければ全体キーから算出する。移調表示中は移調済みの
  // viewResult から計算するため、度数は移調量によらず保存される。
  const viewDegrees = useMemo(
    () =>
      viewResult
        ? viewResult.segments.map((s) => segmentDegreeInResult(s, viewResult))
        : null,
    [viewResult],
  );

  // 小節番号表示（lib/barGrid.ts、表示専用）。ユーザー設定グリッド
  // から各セグメントの開始小節を導出する。グリッドは表示・書き出し
  // だけに効き、解析結果には影響しない。
  const viewBarGrid = useMemo(() => normalizeBarGrid(barGrid), [barGrid]);
  const viewBars = useMemo(
    () =>
      viewResult
        ? viewResult.segments.map((s) => segmentStartBar(s, viewBarGrid))
        : null,
    [viewResult, viewBarGrid],
  );
  // グリッドが既定（BPM = 解析値、拍子 4、オフセット 0、区間なし）から
  // 変わっているかどうか（リセットボタンの表示判定）
  const barGridChanged =
    viewResult !== null &&
    (viewBarGrid.bpm !== defaultBarGrid(viewResult.bpm).bpm ||
      viewBarGrid.beatsPerBar !== DEFAULT_BEATS_PER_BAR ||
      viewBarGrid.offsetSec !== 0 ||
      (viewBarGrid.sections !== undefined &&
        viewBarGrid.sections.length > 0));

  // 拍子変更の区間宣言の追加・削除。宣言は barGrid.sections に正規化
  // された形（startBar 昇順、重複は後勝ち）で保持する。追加時は
  // フォームの BPM が空なら継承（bpm を持たない宣言）にする。
  const addBarGridSection = () => {
    const startBar = Math.floor(Number(sectionStartBarInput));
    if (!Number.isFinite(startBar) || startBar < 2) return;
    const bpmValue = Number(sectionBpmInput);
    const section: BarGridSection = {
      startBar,
      beatsPerBar: sectionBeatsInput,
      ...(sectionBpmInput.trim() !== "" &&
      Number.isFinite(bpmValue) &&
      bpmValue > 0
        ? { bpm: bpmValue }
        : {}),
    };
    setBarGrid((g) => {
      const kept = normalizeBarGridSections(g.sections).filter(
        (s) => s.startBar !== startBar,
      );
      return { ...g, sections: [...kept, section] };
    });
    setSectionStartBarInput("");
    setSectionBpmInput("");
  };
  const removeBarGridSection = (startBar: number) => {
    setBarGrid((g) => {
      const kept = normalizeBarGridSections(g.sections).filter(
        (s) => s.startBar !== startBar,
      );
      const { sections: _dropped, ...base } = g;
      return kept.length > 0 ? { ...base, sections: kept } : base;
    });
  };

  // 様式プロファイル（Phase 3 後半、記録・表示のみ既定 ON）の表示。
  // 混合比率（特徴空間での様式プロトタイプへの類似度）の記録であり、
  // ラベル判定への消費は既定 OFF のまま。
  const genreSummary = useMemo(
    () => summarizeGenre(effectiveResult?.genreProfile),
    [effectiveResult?.genreProfile],
  );

  // 拍子（Phase 3 §5、記録・表示のみ既定 ON）の要約表示。
  // 拍子は文脈情報の記録であり、ラベル判定には使われていない
  // （BPM 仲裁が有効な場合のみ、表示される BPM が仲裁後の値になる）。
  const meterSummary = useMemo(
    () => meterSummaryText(effectiveResult?.meterEstimate),
    [effectiveResult?.meterEstimate],
  );

  // 高精度モードのモデル取得の記録（ダウンロードか、キャッシュか、
  // 保存できたか）を結果サマリに1行で正直に伝える。
  const modelFetchLine = useMemo(
    () => modelFetchSummaryLine(effectiveResult?.modelFetch),
    [effectiveResult?.modelFetch],
  );

  const currentChord = viewResult?.segments.find(
    (s) => currentTime >= s.start && currentTime < s.end,
  );

  // 移調コントロールの表示用: 移調先キー名（移調先の代表スペル）と
  // カポ換算（実用範囲にある場合のみ提示される）。
  const viewKeyName = viewResult
    ? keySpelling(viewResult.keyRoot, viewResult.keyMode).name
    : null;
  const viewKeyModeJa = viewResult
    ? viewResult.keyMode === "major"
      ? "メジャー"
      : "マイナー"
    : null;
  const capoFret = capoFretForShift(transposeShift);

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
                    ? displaySegmentChord(currentChord, viewSpelling)
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

      {viewResult && status === "done" && (
        <>
          <section className="panel summary">
            <div className="summary-row">
              <div className="summary-item">
                <span className="summary-label">キー（推定）</span>
                <span className="summary-value">
                  {noteNameSpelled(viewResult.keyRoot, viewSpelling)}{" "}
                  {viewResult.keyMode === "major" ? "メジャー" : "マイナー"}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">BPM（推定）</span>
                <span className="summary-value">
                  {viewResult.bpm ?? "不明"}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">セグメント数</span>
                <span className="summary-value">{segments.length}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">モード</span>
                <span className="summary-value summary-value-small">
                  {viewResult.mode === "high-accuracy"
                    ? "高精度モードで解析"
                    : "簡易モードで解析"}
                </span>
              </div>
            </div>
            <div className="transpose-row">
              <span className="summary-label">移調（表示・書き出し）</span>
              <div className="transpose-controls">
                <button
                  type="button"
                  className="transpose-stepper"
                  aria-label="半音下げる"
                  disabled={transposeShift <= TRANSPOSE_MIN}
                  onClick={() =>
                    setTransposeShift((v) => Math.max(TRANSPOSE_MIN, v - 1))
                  }
                >
                  −
                </button>
                <span className="transpose-value" aria-live="polite">
                  {transposeShift > 0
                    ? `+${transposeShift}`
                    : `${transposeShift}`}
                </span>
                <button
                  type="button"
                  className="transpose-stepper"
                  aria-label="半音上げる"
                  disabled={transposeShift >= TRANSPOSE_MAX}
                  onClick={() =>
                    setTransposeShift((v) => Math.min(TRANSPOSE_MAX, v + 1))
                  }
                >
                  +
                </button>
                {transposeShift !== 0 && (
                  <button type="button" onClick={() => setTransposeShift(0)}>
                    リセット
                  </button>
                )}
              </div>
              <span className="transpose-note">
                {transposeShift === 0
                  ? "原曲キーのまま表示しています"
                  : `表示キー: ${viewKeyName} ${viewKeyModeJa}${
                      capoFret !== null
                        ? ` · Capo ${capoFret} で原曲のキーになります`
                        : ""
                    }`}
              </span>
            </div>
            <div className="bar-grid-row">
              <span className="summary-label">小節グリッド（表示・書き出し）</span>
              <div className="bar-grid-controls">
                <label className="bar-grid-field">
                  <span className="bar-grid-field-label">拍子</span>
                  <select
                    value={viewBarGrid.beatsPerBar}
                    onChange={(e) =>
                      setBarGrid((g) => ({
                        ...g,
                        beatsPerBar: Number(e.target.value),
                      }))
                    }
                    aria-label="拍子（1小節の拍数）"
                  >
                    {[2, 3, 4, 5, 6, 7].map((n) => (
                      <option key={n} value={n}>
                        {n}/4
                      </option>
                    ))}
                  </select>
                </label>
                <label className="bar-grid-field">
                  <span className="bar-grid-field-label">BPM</span>
                  <input
                    type="number"
                    className="bar-grid-number"
                    min={1}
                    step={1}
                    value={Number.isFinite(barGrid.bpm) ? barGrid.bpm : ""}
                    onChange={(e) =>
                      setBarGrid((g) => ({
                        ...g,
                        bpm: e.target.valueAsNumber,
                      }))
                    }
                    aria-label="小節グリッドの BPM"
                  />
                </label>
                <span className="bar-grid-field">
                  <span className="bar-grid-field-label">オフセット</span>
                  <span className="bar-grid-offset">
                    <button
                      type="button"
                      className="transpose-stepper"
                      aria-label="オフセットを0.1秒戻す"
                      onClick={() =>
                        setBarGrid((g) => {
                          const n = normalizeBarGrid(g);
                          return {
                            ...n,
                            offsetSec: Math.max(
                              0,
                              Math.round((n.offsetSec - 0.1) * 100) / 100,
                            ),
                          };
                        })
                      }
                    >
                      −
                    </button>
                    <span className="bar-grid-offset-value" aria-live="polite">
                      {viewBarGrid.offsetSec.toFixed(2)}秒
                    </span>
                    <button
                      type="button"
                      className="transpose-stepper"
                      aria-label="オフセットを0.1秒進める"
                      onClick={() =>
                        setBarGrid((g) => {
                          const n = normalizeBarGrid(g);
                          return {
                            ...n,
                            offsetSec: Math.round((n.offsetSec + 0.1) * 100) / 100,
                          };
                        })
                      }
                    >
                      +
                    </button>
                  </span>
                </span>
                {barGridChanged && (
                  <button
                    type="button"
                    onClick={() =>
                      setBarGrid(defaultBarGrid(viewResult.bpm))
                    }
                  >
                    リセット
                  </button>
                )}
              </div>
              <div className="bar-grid-sections">
                {(viewBarGrid.sections ?? []).length > 0 && (
                  <ul className="bar-grid-section-list">
                    {(viewBarGrid.sections ?? []).map((s) => (
                      <li key={s.startBar} className="bar-grid-section-item">
                        <span>
                          {s.startBar}小節から {s.beatsPerBar}/4
                          {s.bpm !== undefined ? ` · ${s.bpm} BPM` : ""}
                        </span>
                        <button
                          type="button"
                          className="bar-grid-section-remove"
                          aria-label={`${s.startBar}小節からの拍子変更を削除`}
                          onClick={() => removeBarGridSection(s.startBar)}
                        >
                          削除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="bar-grid-controls">
                  <label className="bar-grid-field">
                    <span className="bar-grid-field-label">拍子変更</span>
                    <input
                      type="number"
                      className="bar-grid-number"
                      min={2}
                      step={1}
                      placeholder="小節"
                      value={sectionStartBarInput}
                      onChange={(e) => setSectionStartBarInput(e.target.value)}
                      aria-label="拍子変更が始まる小節番号"
                    />
                  </label>
                  <span className="bar-grid-field">
                    <span className="bar-grid-field-label">小節から</span>
                    <select
                      value={sectionBeatsInput}
                      onChange={(e) =>
                        setSectionBeatsInput(Number(e.target.value))
                      }
                      aria-label="変更後の拍子（1小節の拍数）"
                    >
                      {[2, 3, 4, 5, 6, 7].map((n) => (
                        <option key={n} value={n}>
                          {n}/4
                        </option>
                      ))}
                    </select>
                  </span>
                  <label className="bar-grid-field">
                    <span className="bar-grid-field-label">BPM（任意）</span>
                    <input
                      type="number"
                      className="bar-grid-number"
                      min={1}
                      step={1}
                      placeholder="継承"
                      value={sectionBpmInput}
                      onChange={(e) => setSectionBpmInput(e.target.value)}
                      aria-label="変更後の BPM（空欄で基準グリッドから継承）"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={addBarGridSection}
                    disabled={
                      !Number.isFinite(Number(sectionStartBarInput)) ||
                      Math.floor(Number(sectionStartBarInput)) < 2 ||
                      sectionStartBarInput.trim() === ""
                    }
                  >
                    拍子変更を追加
                  </button>
                </div>
              </div>
              <span className="transpose-note">
                拍子は自動推定しません。1小節 ={" "}
                {barDurationSec(viewBarGrid).toFixed(2)}{" "}
                秒。小節の頭がずれる場合はオフセットで合わせてください
              </span>
            </div>
            {localKeySummary && (
              <p className="local-key-summary">
                <span className="summary-label">局所キー（推定）</span>
                <span>
                  {localKeyLabel(
                    localKeySummary.dominantRoot,
                    localKeySummary.dominantMode,
                  )}
                  を中心に推移
                  {localKeySummary.changes.length > 0 &&
                    ` · ${localKeySummary.changes
                      .map(
                        (c) =>
                          `${formatTime(c.atSec)} ${localKeyLabel(c.root, c.mode)}`,
                      )
                      .join(" · ")}`}
                </span>
              </p>
            )}
            {genreSummary && (
              <p className="local-key-summary">
                <span className="summary-label">様式（推定）</span>
                <span>{genreSummary.blendText}</span>
              </p>
            )}
            {meterSummary && (
              <p className="local-key-summary">
                <span className="summary-label">拍子（推定）</span>
                <span>{meterSummary}</span>
              </p>
            )}
            {viewResult.mode === "high-accuracy" &&
              typeof viewResult.separationSeconds === "number" && (
                <p className="hint">
                  この解析のステム分離には
                  {formatApproxDuration(viewResult.separationSeconds)}
                  かかりました（モデルのダウンロード時間は含みません。この実績は次回以降の目安表示に使われます）。
                </p>
              )}
            {viewResult.mode === "high-accuracy" && modelFetchLine && (
              <p className="hint">{modelFetchLine}</p>
            )}
            <div className="summary-actions">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${baseName(viewResult.fileName)}-chords.json`,
                    resultToJson(viewResult, {
                      spelling: viewSpelling,
                      transposeSemitones: transposeShift,
                      barGrid: viewBarGrid,
                    }),
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
                    `${baseName(viewResult.fileName)}-chords.txt`,
                    resultToText(viewResult, {
                      spelling: viewSpelling,
                      transposeSemitones: transposeShift,
                      barGrid: viewBarGrid,
                    }),
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
              {transposeShift !== 0 &&
                "移調表示中の書き出しには移調したラベルが入り、移調の記録も併記されます。一覧での修正は原曲キーの表記に直して保存されます。"}
            </p>
          </section>

          <section className="panel">
            <h2>タイムライン</h2>
            <Timeline
              segments={viewResult.segments}
              duration={viewResult.duration}
              currentTime={currentTime}
              onSeek={seek}
              spelling={viewSpelling}
            />
          </section>

          <section className="panel">
            <h2>コードセグメント</h2>
            <SegmentList
              segments={viewResult.segments}
              currentTime={currentTime}
              onSeek={seek}
              onEdit={editSegmentFromView}
              spelling={viewSpelling}
              degrees={viewDegrees ?? undefined}
              bars={viewBars ?? undefined}
              isPlaying={isPlaying}
              followSignal={followSignal}
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
