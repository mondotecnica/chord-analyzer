import type { MeterBeatsPerBar, MeterEstimate } from "../types";

/**
 * Phase 3 §5: 拍子・小節推定（PHASE3_PLAN.md §5、理論レイヤーの規則は §2）。
 *
 * 役割: 検出済みの拍（BPM）を前提に、「テンポスケール × 拍子」の
 * 候補を信号証拠で裁定し、拍子・小節位相・（仲裁後の）テンポを
 * 共有プロファイルへ供給する小さな部品。局所キー（localKey.ts）と
 * 同じく「記録」と「消費」の2層に分かれる:
 * - 記録（既定 ON、meterRecord）: 結果の meterEstimate への格納と
 *   表示・書き出し。コードラベルにも結果の bpm にも触れない
 * - 消費（meterArbitrate）: 勝者のテンポスケールを結果の bpm に
 *   反映するだけ。コードラベルはどちらの層でも変えない
 *   （§5 の非目標: 拍子は文脈情報である）
 *
 * 背景: BPM の比率取り違え（倍取り・3:2）は実曲でも Suno でも
 * 発生している。SUNO_05 では検出 108 を「3:2 取り違えで実テンポ
 * 72」と誤解釈したが、信号検証では 72 のパルスは存在せず、
 * 本曲は 3/4・108 だった（measurements/SUNO_05_ANALYSIS.md 末尾）。
 * 拍周期だけでは「108 の 3 拍」と「72 の 2 拍」のように小節長が
 * 衝突する組を区別できないため、候補は拍子と組で評価する。
 *
 * 証拠は SUNO_05 の拍子訂正で実際に決め手になった系統を使う:
 * 1. 拍周期の自己相関（拍そのものの実在。72 仮説はここで落ちた）
 * 2. 小節周期の自己相関（アクセント構造の裏付け）
 * 3. コード変化境界の小節線への乗り（位相最適化つき。
 *    ただし境界だけでは決着しなかった経緯から、信号側と併用する）
 * 4. 境界列そのものの自己相関（stems で真の小節長にのみ正の
 *    ピークが出た系統。境界を許容幅ぶん広げたインパルス列で
 *    測るため、ラグ量子化や境界ジッタに壊れにくい。間隔が
 *    不規則な境界列では、真の小節長の整数倍のラグは「短い間隔に
 *    先に使われる」分だけ相関が下がるため、小節の整数倍
 *    グリッドへの識別にも効く）
 *
 * あわせて、検出テンポそのものが証拠であることへの小さな prior
 * として、スケール 1 から離れる候補に段階的な減点を入れる
 * （parsimony: 証拠が互角なら検出値を覆さない。実証拠の差が
 * これより大きい場合は仲裁が普通に勝つ）。
 *
 * ラグの精密化: 候補の拍・小節ラグは検出拍周期の倍数に固定される
 * ため、検出誤差（数 %）があると自己相関の鋭いピークを外して
 * しまう（実測: 正解小節でも 2.5% の誤差で r が 0.82 → 0.18 に
 * 崩れた）。そこで自己相関は候補ラグの近傍（±5%、フレーム単位）
 * の最大を取り、小節長は精密化後の値を境界証拠にも使う。
 *
 * 勝者の選び方（二段の分離）:
 * - 小節長は「小節レベルの証拠」（小節自己相関＋境界整列＋境界列
 *   自己相関 = barScore）だけで決める。拍の自己相関（pulse）は
 *   小節長の決定には使わない — 信号の最強周期は半小節である
 *   ことも多く（実測: 合成曲では拍ラグの相関がほぼ 0 で半小節
 *   ラグが最大）、pulse を小節決定に入れると 2 倍小節が勝って
 *   しまうため。
 * - 同じ小節長を持つ候補同士（例: 96 の 4 拍子と 48 の 2 拍子）は
 *   小節証拠を共有し、違いは拍レベルの解釈だけになる。拍レベルは
 *   テンポ検出器（60–180 BPM へのオクターブ補正込み）の領分で
 *   あるため、同一小節グループ内ではスケール 1 に最も近い候補を
 *   採用する（拍レベルの仲裁は小節を跨ぐ場合にのみ起きる）。
 * - マージン（判定保留の物差し）は小節グループ同士の barScore 差。
 * - 基本周期の prior: 周期信号では小節長の整数倍でも自己相関が
 *   ほぼ同等に出る（実測: 正確に周期的な包絡で 2 倍小節との差は
 *   0.02 程度）。「信号を説明できる最短の周期が小節」という原則
 *   として、グループ比較では小節長が 2 倍になるごとに小さな
 *   減点（fundamentalPenalty）を入れる。証拠差がこれより大きい
 *   場合は通常の証拠が勝つ。
 *
 * 自己相関系の成分（pulse / barSignal）は「相対 × 絶対」の
 * ゲート付き相対値でスコア化する。自己相関の絶対水準は包絡の
 * 性質（フラックスの疎密）で大きく変わり、固定の正規化上限では
 * 密な包絡で全候補が飽和して小節の対比が消えるためである:
 * 成分 = clamp(r / 候補中の最大 r) × clamp(最大 r / 正規化上限)。
 * 最大 r 自体が小さい（証拠が薄い）曲では絶対側のゲートが
 * 成分全体を押し下げ、判定保留の規則が効く。
 *
 * 判定保留: 勝者のスコア不足・次点との接戦・拍の実在証拠の欠如の
 * いずれかでは拍子を確定せず beatsPerBar = null とする。誤った
 * 自信のある拍子より「不明」が正直である（事前登録基準は
 * measurements/phase3/PHASE3_METER_RESULTS.md）。
 */

export const METER_CONFIG = {
  /** テンポスケール候補（検出 BPM に対する比） */
  scales: [0.5, 2 / 3, 1, 1.5, 2] as const,
  /** 拍子候補（1小節の拍数。6 は 6/8） */
  meters: [2, 3, 4, 6] as const,
  /** 候補テンポの許容範囲（estimateTempo の探索範囲に合わせる） */
  minTempo: 40,
  maxTempo: 200,
  /** 小節長の許容範囲（秒） */
  minBarSec: 0.8,
  maxBarSec: 10,
  /** 候補として認める最小の小節数（曲長 / 小節長） */
  minBars: 3,
  /** 境界ヒットの許容誤差（秒。SUNO_05 検証と同じ ±0.15） */
  boundaryToleranceSec: 0.15,
  /** 境界証拠を有効とする最小の境界数 */
  minBoundaries: 4,
  /**
   * スコアの重み（合計 1）。小節レベルの証拠（barScore）の中では
   * 包絡の小節自己相関が主（0.75 相当）で、境界系は補助 —
   * 境界は和声リズムの格子を測るもので、半小節のコード変化が
   * 実在する曲では半小節グリッドを支持してしまうため
   * （較正時の実測: 境界整列は部分格子で飽和し、境界列自己相関は
   * セグメント分割の癖で真の小節に負の値すら出した）。
   */
  weights: { pulse: 0.25, barSignal: 0.5625, boundary: 0.075, boundaryAc: 0.1125 },
  /** 自己相関の正規化上限（この値でスコア 1 に飽和） */
  pulseNorm: 0.3,
  barNorm: 0.2,
  /** 境界列自己相関の正規化上限（実測レンジ: Suno +0.06、周期的な境界列で 0.3〜0.45） */
  boundaryAcNorm: 0.3,
  /** スケール parsimony: スケール 1 の候補への最大ボーナス（|log2 s| で線形に減る） */
  scalePriorMax: 0.06,
  /** 判定保留の規則: 勝者スコアの下限 */
  scoreFloor: 0.3,
  /** 判定保留の規則: 小節グループ同士の最小マージン */
  marginMin: 0.05,
  /** 判定保留の規則: 勝者の拍自己相関（生値）の下限 */
  pulseFloor: 0.02,
  /** 自己相関のピーク探索範囲（候補ラグに対する比） */
  lagRefineRatio: 0.05,
  /** 同一小節グループとみなす小節長の相対差 */
  barGroupTolerance: 0.015,
  /** 基本周期 prior: 小節長が最小候補の 2 倍になるごとの減点（グループ比較時） */
  fundamentalPenalty: 0.02,
} as const;

export interface MeterInput {
  /** オンセット包絡（混合音、またはステム経路では drums 優先） */
  onsetEnvelope: Float32Array;
  frameDuration: number;
  /** 第1段の確定セグメント（境界 = コード変化時刻として使う） */
  segments: readonly { start: number; end: number }[];
  /** 検出器の生 BPM（keyTempo.estimateTempo の戻り値） */
  detectedBpm: number | null;
  durationSec: number;
  onsetSource: "mixture" | "drums";
}

export interface MeterCandidate {
  scale: number;
  beatsPerBar: MeterBeatsPerBar;
  tempoBpm: number;
  /** 小節長（ラグ精密化後の測定値、秒） */
  barSec: number;
  /** 小節グループのキー（精密化前の公称小節長、秒） */
  groupBarSec: number;
  phaseSec: number;
  score: number;
  /** 小節レベルの証拠だけのスコア（0..1 目安）。小節グループの順位付けに使う */
  barScore: number;
  /** 生の証拠値 */
  pulse: number;
  barAutocorr: number;
  boundary: number;
  boundaryAutocorr: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * 平均を引いた系列の正規化自己相関 r(k)（k はフレーム数）。
 * 分母は全区間の二乗和で、r(0) = 1、無相関 ≈ 0、反相関 < 0。
 * SUNO_05 検証の r（ピーク 0.27、存在しない拍で −0.03）と
 * 同じ物差しになるよう、ピアソン型の定義に寄せている。
 */
function autocorrelation(env: Float32Array, mean: number, lagFrames: number): number {
  const n = env.length;
  const k = Math.round(lagFrames);
  if (k <= 0 || k >= n) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = env[i] - mean;
    den += d * d;
    if (i + k < n) num += d * (env[i + k] - mean);
  }
  return den > 0 ? num / den : 0;
}

/**
 * 候補ラグ近傍の自己相関ピーク（ラグ精密化）。
 * 中心ラグの ±lagRefineRatio（フレーム単位、1〜3 フレーム）の
 * 最大と、そのラグ（秒）を返す。検出誤差とフレーム量子化で
 * 鋭いピークを外すことを防ぐ。
 */
function autocorrelationPeak(
  env: Float32Array,
  mean: number,
  centerLagSec: number,
  frameDuration: number,
): { r: number; lagSec: number } {
  const centerFrames = centerLagSec / frameDuration;
  const radius = Math.min(
    3,
    Math.max(1, Math.round(centerFrames * METER_CONFIG.lagRefineRatio)),
  );
  let bestR = -Infinity;
  let bestLag = centerLagSec;
  for (let k = -radius; k <= radius; k++) {
    const lagSec = (Math.round(centerFrames) + k) * frameDuration;
    if (lagSec <= 0) continue;
    const r = autocorrelation(env, mean, lagSec / frameDuration);
    if (r > bestR) {
      bestR = r;
      bestLag = lagSec;
    }
  }
  return { r: bestR === -Infinity ? 0 : bestR, lagSec: bestLag };
}

/** コード変化境界（セグメント開始時刻。先頭の 0 は変化ではないので除く） */
function changeBoundaries(
  segments: readonly { start: number; end: number }[],
  durationSec: number,
): number[] {
  const out: number[] = [];
  for (const s of segments) {
    if (s.start > 0.05 && s.start < durationSec - 0.05) out.push(s.start);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 境界列の小節線ヒット（位相最適化）。戻り値は位相と超過ヒット率。
 * 超過ヒット率 = (hitRate − chance) / (1 − chance)（chance = 2·tol/L）。
 * 単純なヒット率やリフト比だと、小節の整数倍グリッドでも高い値が
 * 出て真の小節と競合するため、中間線に落ちる境界を減点できる
 * この形を使う。
 */
function boundaryAlignment(
  boundaries: number[],
  barSec: number,
  frameDuration: number,
): { phaseSec: number; excess: number } {
  const tol = METER_CONFIG.boundaryToleranceSec;
  const chance = Math.min(1, (2 * tol) / barSec);
  if (boundaries.length === 0 || chance >= 1) return { phaseSec: 0, excess: 0 };
  const step = Math.max(frameDuration, 0.01);
  let bestPhase = 0;
  let bestHits = -1;
  for (let phase = 0; phase < barSec; phase += step) {
    let hits = 0;
    for (const t of boundaries) {
      const d = (((t - phase) % barSec) + barSec) % barSec;
      if (Math.min(d, barSec - d) <= tol) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestPhase = phase;
    }
  }
  const hitRate = bestHits / boundaries.length;
  return { phaseSec: bestPhase, excess: clamp01((hitRate - chance) / (1 - chance)) };
}

/**
 * 境界列のインパルス列を作る。各境界を許容幅（±tol）の三角バンプ
 * として描くことで、フレーム量子化や境界ジッタで自己相関が
 * 壊れないようにする（幅ゼロのインパルスでは、検出テンポの
 * 数 % の誤差で相関が消えてしまうため）。
 */
function boundaryTrain(
  boundaries: number[],
  frameCount: number,
  frameDuration: number,
): { train: Float32Array; mean: number } {
  const tol = METER_CONFIG.boundaryToleranceSec;
  const train = new Float32Array(frameCount);
  const halfFrames = Math.max(1, Math.round(tol / frameDuration));
  for (const t of boundaries) {
    const center = Math.round(t / frameDuration);
    for (let k = -halfFrames; k <= halfFrames; k++) {
      const idx = center + k;
      if (idx < 0 || idx >= frameCount) continue;
      train[idx] += 1 - Math.abs(k) / (halfFrames + 1);
    }
  }
  const mean = train.reduce((s, x) => s + x, 0) / frameCount;
  return { train, mean };
}

/** 候補を全て评分し、スコア降順で返す（較正・診断用にも使う） */
export function rankMeterCandidates(input: MeterInput): MeterCandidate[] {
  const { onsetEnvelope, frameDuration, detectedBpm, durationSec } = input;
  if (
    detectedBpm === null ||
    detectedBpm <= 0 ||
    frameDuration <= 0 ||
    onsetEnvelope.length < 10 ||
    durationSec <= 0
  ) {
    return [];
  }
  // オンセット包絡の前処理は estimateTempo と同じ（平均引き＋半波整流）
  const n = onsetEnvelope.length;
  const rawMean = onsetEnvelope.reduce((s, x) => s + x, 0) / n;
  if (rawMean === 0) return [];
  const env = Float32Array.from(onsetEnvelope, (x) => Math.max(0, x - rawMean));
  const envMean = env.reduce((s, x) => s + x, 0) / n;

  const boundaries = changeBoundaries(input.segments, durationSec);
  const hasBoundaries = boundaries.length >= METER_CONFIG.minBoundaries;
  const bTrain = hasBoundaries
    ? boundaryTrain(boundaries, n, frameDuration)
    : null;

  const detectedPeriod = 60 / detectedBpm;
  const w = METER_CONFIG.weights;
  // 第1パス: 生の証拠だけを集める（スコア化には候補全体の最大が要る）
  const raw: Omit<MeterCandidate, "score" | "barScore">[] = [];
  for (const scale of METER_CONFIG.scales) {
    const tempo = detectedBpm * scale;
    if (tempo < METER_CONFIG.minTempo || tempo > METER_CONFIG.maxTempo) continue;
    const beatSec = detectedPeriod / scale;
    const pulse = autocorrelationPeak(env, envMean, beatSec, frameDuration).r;
    for (const meter of METER_CONFIG.meters) {
      const nominalBarSec = beatSec * meter;
      if (nominalBarSec < METER_CONFIG.minBarSec || nominalBarSec > METER_CONFIG.maxBarSec) continue;
      if (durationSec / nominalBarSec < METER_CONFIG.minBars) continue;
      const barPeak = autocorrelationPeak(env, envMean, nominalBarSec, frameDuration);
      const barAutocorr = barPeak.r;
      const barSec = barPeak.lagSec;
      let boundary = 0;
      let boundaryAutocorr = 0;
      let phaseSec = 0;
      if (hasBoundaries && bTrain) {
        const aligned = boundaryAlignment(boundaries, barSec, frameDuration);
        boundary = aligned.excess;
        phaseSec = aligned.phaseSec;
        boundaryAutocorr = autocorrelationPeak(
          bTrain.train,
          bTrain.mean,
          nominalBarSec,
          frameDuration,
        ).r;
      }
      raw.push({
        scale,
        beatsPerBar: meter,
        tempoBpm: Math.round(tempo),
        barSec,
        groupBarSec: nominalBarSec,
        phaseSec,
        pulse,
        barAutocorr,
        boundary,
        boundaryAutocorr,
      });
    }
  }
  // ゲート付き相対スコア（冒頭コメント参照）
  const maxPulse = Math.max(0, ...raw.map((c) => c.pulse));
  const maxBar = Math.max(0, ...raw.map((c) => c.barAutocorr));
  const gated = (r: number, max: number, norm: number) =>
    max > 0 ? clamp01(r / max) * clamp01(max / norm) : 0;
  const barWeightSum = w.barSignal + w.boundary + w.boundaryAc;
  const candidates: MeterCandidate[] = raw.map((c) => {
    const scalePrior =
      METER_CONFIG.scalePriorMax * (1 - Math.abs(Math.log2(c.scale)));
    // 小節レベルの証拠（barScore の材料）。候補グループの順位はこれだけで決める
    const barPart =
      w.barSignal * gated(c.barAutocorr, maxBar, METER_CONFIG.barNorm) +
      w.boundary * c.boundary +
      w.boundaryAc * clamp01(c.boundaryAutocorr / METER_CONFIG.boundaryAcNorm);
    const score =
      barPart +
      w.pulse * gated(c.pulse, maxPulse, METER_CONFIG.pulseNorm) +
      scalePrior;
    return { ...c, barScore: barPart / barWeightSum, score };
  });
  // 安定ソート（同点は走査順 = スケール昇順・拍子昇順を保つ）
  return candidates.sort((a, b) => b.score - a.score);
}

const NOTATION: Record<MeterBeatsPerBar, string> = {
  2: "2/4",
  3: "3/4",
  4: "4/4",
  6: "6/8",
};

export interface MeterSelection {
  winner: MeterCandidate;
  /** 小節グループ同士の差（barScore に基本周期 prior を調整した値で測る） */
  margin: number;
  /** 勝ちグループ外の最良候補（次点の解釈） */
  runnerUp: MeterCandidate | null;
}

/**
 * 勝者の選択（冒頭コメントの二段の分離）。
 * 候補を公称小節長でグループ化し、小節レベルの証拠（barScore）で
 * 勝ちグループを決め、グループ内では「スケール 1 に最も近い候補」
 * （検出器の拍レベル）を勝者とする。
 */
export function selectMeterWinner(ranked: MeterCandidate[]): MeterSelection | null {
  if (ranked.length === 0) return null;
  const byBar = [...ranked].sort((a, b) => a.groupBarSec - b.groupBarSec);
  const groups: { barSec: number; members: MeterCandidate[]; barScore: number }[] = [];
  for (const c of byBar) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Math.abs(c.groupBarSec - last.barSec) / last.barSec <=
        METER_CONFIG.barGroupTolerance
    ) {
      last.members.push(c);
      last.barScore = Math.max(last.barScore, c.barScore);
    } else {
      groups.push({ barSec: c.groupBarSec, members: [c], barScore: c.barScore });
    }
  }
  // グループの順位: 基本周期 prior 調整後の barScore 降順
  const minBarSec = Math.min(...groups.map((g) => g.barSec));
  const adjusted = groups.map((g) => ({
    group: g,
    adj:
      g.barScore -
      METER_CONFIG.fundamentalPenalty * Math.log2(g.barSec / minBarSec),
  }));
  const ordered = [...adjusted].sort(
    (a, b) => b.adj - a.adj || a.group.barSec - b.group.barSec,
  );
  const winGroup = ordered[0].group;
  const margin =
    ordered.length > 1 ? ordered[0].adj - ordered[1].adj : ordered[0].adj;
  const winner = winGroup.members.reduce((a, b) => {
    const da = Math.abs(Math.log2(a.scale));
    const db = Math.abs(Math.log2(b.scale));
    if (db < da - 1e-9) return b;
    if (Math.abs(db - da) <= 1e-9 && b.score > a.score) return b;
    return a;
  });
  const inWinGroup = new Set(winGroup.members);
  const runnerUp =
    ranked.find((c) => !inWinGroup.has(c)) ?? null;
  return { winner, margin, runnerUp };
}

/**
 * 拍子・小節を推定する。候補が作れない場合（検出 BPM が無い等）は
 * null を返す（呼び出し側はフィールド自体を付けない）。
 * 証拠が足りない場合は「判定保留」の記録を返す。
 */
export function estimateMeter(input: MeterInput): MeterEstimate | null {
  const ranked = rankMeterCandidates(input);
  const selection = selectMeterWinner(ranked);
  if (!selection || input.detectedBpm === null) return null;
  const { winner: best, margin, runnerUp } = selection;
  const determined =
    best.score >= METER_CONFIG.scoreFloor &&
    margin >= METER_CONFIG.marginMin &&
    best.pulse > METER_CONFIG.pulseFloor;
  return {
    beatsPerBar: determined ? best.beatsPerBar : null,
    notation: determined ? NOTATION[best.beatsPerBar] : null,
    barPhaseSec: determined ? best.phaseSec : null,
    barSec: determined ? best.barSec : null,
    tempoBpm: determined ? best.tempoBpm : Math.round(input.detectedBpm),
    detectedBpm: input.detectedBpm,
    tempoScale: determined ? best.scale : 1,
    score: best.score,
    margin,
    onsetSource: input.onsetSource,
    evidence: {
      pulse: best.pulse,
      barAutocorr: best.barAutocorr,
      boundary: best.boundary,
      boundaryAutocorr: best.boundaryAutocorr,
    },
    runnerUp: runnerUp
      ? {
          beatsPerBar: runnerUp.beatsPerBar,
          tempoBpm: runnerUp.tempoBpm,
          score: runnerUp.score,
        }
      : null,
  };
}
