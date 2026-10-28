/** コード解析パイプライン全体で使う共通型定義 */

export interface ChordFrame {
  /** フレーム中心の時刻（秒） */
  time: number;
  /** 推定したコード名。無音・低信頼の場合は "N.C." */
  chord: string;
  /** 0..1 の信頼度 */
  confidence: number;
  /** そのフレームの RMS エネルギー（無音判定用） */
  energy: number;
}

/**
 * Phase 3.1: 二段判定の第2段が付ける拡張音の種類（初期語彙はこの3種のみ）。
 * コードの三和音コア（chord フィールド）とは別フィールドで持つ
 * （bassPc と同じ「別フィールド」方針、DESIGN_NOTES.md）。
 * 表示名（例: "B7"）の組み立ては表示側（lib/chordDisplay.ts）の責務。
 */
export type ChordExtension = "maj7" | "7" | "m7";

/**
 * Phase 3.2: 付加音（カラートーン）の種類。7th を伴わない付加音だけを
 * 語彙にする（7th がある場合は 9th 等の別表記になるため対象外）。
 * extension と同じく、コードの三和音コアとは別フィールドで持つ。
 */
export type AddTone = "add9";

export interface ChordSegment {
  id: number;
  start: number; // 秒
  end: number; // 秒
  chord: string;
  /** セグメント内のフレーム信頼度の平均 */
  confidence: number;
  /** ユーザーが手動修正したかどうか */
  edited?: boolean;
  /**
   * Phase 3.1: 7th の拡張音（maj7 / 7 / m7）。二段判定の第2段
   * （analysis/extensionDetection.ts）が証拠のあるセグメントにだけ付ける。
   * 未設定は三和音のまま、という意味（従来の書き出しと互換）。
   */
  extension?: ChordExtension;
  /**
   * Phase 1: 低域から推定したベース音のピッチクラス（0=C .. 11=B）。
   * コードのルートとは別フィールドで持つ（分数コード方針、DESIGN_NOTES.md）。
   * 表示名の組み立て（例: C/E）は UI 側の責務。証拠が乏しいセグメントでは未設定。
   */
  bassPc?: number;
  /**
   * Phase 3.2: 分数コードの「上層」のコード名（ルート＋モードの三和音
   * コア文字列。chord と同じ形式）。ベース補正が強いベース証拠で
   * ルートを潰した（chord のルートをベース音へ書き換えた）セグメント
   * でのみ、潰される前の和声側の読みとして bassCorrection が記録し、
   * layerChord がベース音を除いた集計証拠で再読する場合がある。
   * 表示側は bassPc と組み合わせて Am7/D のような層表示を組み立てる。
   * 未設定は「層の分離なし＝従来表示」という意味（従来の書き出しと互換）。
   */
  upperChord?: string;
  /**
   * Phase 3.2: 上層コードに対する 7th 拡張（layerChord の再読が
   * テンプレート群の中で 7th 候補を選んだ場合のみ）。extension
   * （第2段が chord に対して付けるもの）とは別フィールドで、
   * 表示側は upperChord がある場合はこちらを使う。
   */
  upperExtension?: ChordExtension;
  /**
   * Phase 3.2: 付加音の証拠（addToneDetection.ts が付ける）。
   * 対象コード（upperChord があれば上層、無ければ chord）に 7th が
   * 無く、9th 音のシェア・持続性が床を超えた場合のみ。表示側が
   * "(add9)" を組み立てる。拡張音検出（extensions）有効時のみ付く。
   */
  addTones?: AddTone[];
  /**
   * N.C. 回復（analysis/ncRecovery.ts）: もともと N.C. だった区間を、
   * 直接のフレーム判定ではなく推論で充填した場合の出所。
   * - "segment-rematch": セグメント集計クロマの再照合（2つの視点の一致が条件）
   * - "stems-fallback": other ステムの証拠が薄く、混合音＋ベースの
   *   副次証拠で充填（ステム経路のみ）
   * - "gap-fill": 両隣が同一コードの短い欠落を、そのコードで充填
   * 充填ラベルは推論由来であることを隠さないため、信頼度も意図的に
   * 低く（< 0.55）抑えられる。未設定は通常のフレーム判定によるラベル。
   */
  ncFill?: "segment-rematch" | "stems-fallback" | "gap-fill";
}

/**
 * Phase 3.3: 局所キー推定（analysis/localKey.ts）の窓1件。
 * 曲全体キー（AnalysisResult.keyRoot/keyMode）とは別に、時間で
 * 滑らせた窓ごとのキー候補を持つための型（共有プロファイルへの
 * 加算的な格納。未設定の結果は従来どおり動作する）。
 */
export interface LocalKeyWindow {
  start: number; // 秒
  end: number; // 秒
  /** 窓内の最有力キー */
  root: number; // 0=C .. 11=B
  mode: "major" | "minor";
  /** 最有力キーの Krumhansl プロファイル相関 */
  correlation: number;
  /** 最有力 − 次点（別キー）の相関差。小さいほどキーが曖昧 */
  margin: number;
  /** 次点キーのルート／モード（相関が最有力に近い場合の第二解釈） */
  runnerUpRoot: number;
  runnerUpMode: "major" | "minor";
}

/** 高精度モードのモデル取得の記録（結果表示・書き出し用） */
export interface ModelFetchSummary {
  /** 取得元: キャッシュから読めたか、ダウンロードしたか */
  source: "cache" | "download";
  /** モデル取得にかかった秒数（キャッシュ読み込みの時間を含む） */
  seconds: number;
  /**
   * ダウンロード後の保存結果。true = 保存できた、false = 失敗した。
   * キャッシュ読み込みの回と保存先が無い場合は null。
   */
  persisted: boolean | null;
  /** 保存したはずのキャッシュが失われていて再取得した場合に true */
  cacheLost?: boolean;
  /** ブラウザに永続化が認められたか（診断用。不明な場合は null） */
  storagePersisted?: boolean | null;
  /** ストレージ使用量（バイト、診断用。不明な場合は null） */
  storageUsageBytes?: number | null;
  /** ストレージ上限（バイト、診断用。不明な場合は null） */
  storageQuotaBytes?: number | null;
}

/**
 * Phase 3 後半: ジャンル傾向モジュール（analysis/genreProfile.ts）が
 * 扱う広いスタイル分類。サブジャンル級の細分化は今の特徴量では
 * 裏付けが取れないため、検証コーパスが実際に跨ぐ5種に限る
 * （measurements/phase3/PHASE3_GENRE_RESULTS.md の設計節）。
 */
export type GenreStyleId = "jazz" | "blues" | "soul" | "pop" | "rock";

/**
 * Phase 3 後半: ジャンル傾向（様式プロファイル）の特徴量。
 * 音楽の三大要素（リズム／メロディ／コード＝和声）に音色を加えた
 * チャンネル構成で持つ（2026-10-28 のユーザーの設計観）。
 * 各チャンネルは「その信号が入力に存在するときだけ」埋まる。
 * 存在しないチャンネルの特徴量は null であり、推定はその欠落を
 * 欠落として扱う（混合音経路ではメロディ／音色は原則測れない。
 * 無いものをあるように見せない）。定義は genreProfile.ts。
 */

/** 和声チャンネル（第1段セグメント列＋証拠クロマから常に計算できる） */
export interface GenreHarmonyFeatures {
  /** major コード区間での長7度音の平均シェア */
  maj7Presence: number | null;
  /** major コード区間での短7度音の平均シェア */
  dom7Presence: number | null;
  /** minor コード区間での短7度音の平均シェア */
  m7Presence: number | null;
  /** 全体キーに対するダイアトニック度（plausibility の時間加重平均、0..1） */
  diatonicShare: number;
  /** 二次ドミナント形（非ダイアトニック長三和音→5度下行で解決）の時間割合 */
  secondaryDominantShare: number;
  /** コード遷移のうち5度下行（V→I 型の根音運動）が占める割合 */
  fifthDescentShare: number;
  /** minor コードの時間割合 */
  minorShare: number;
  /** ベース音 ≠ ルートのセグメントの時間割合 */
  slashShare: number;
  /**
   * 全体キーの ♭VII ルート長三和音の時間割合。短調キーでは
   * VII はダイアトニックそのもので借用の印にならないため null
   * （長調キーでのみ測る）
   */
  flatVIIShare: number | null;
  /** 使用されたコード種数（ルート×モードの distinct 数） */
  vocabSize: number;
}

/** リズムチャンネル（オンセット包絡から。ステム経路ではドラム優先） */
export interface GenreRhythmFeatures {
  /** コード変化率（同一コードの連続を畳んだラン数／分。和声リズム） */
  changesPerMinute: number;
  /** オンセット密度（閾値を超える局所ピーク数／秒）。包絡が無ければ null */
  onsetDensity: number | null;
  /** 拍の規則性（オンセット包絡の自己相関ピーク、0..1）。包絡が無ければ null */
  pulseRegularity: number | null;
}

/** メロディチャンネル（ボーカルステムがある場合のみ。無ければ全て null） */
export interface GenreMelodyFeatures {
  /** ボーカルクロマの質量のうち全体キーのスケール音にある割合 */
  scaleConformance: number | null;
  /** ボーカルクロマの質量のうち、その時点のコード構成音にある割合 */
  chordToneRatio: number | null;
  /** ボーカルの活動フレーム割合（記録専用。スコアリングには使わない） */
  activityShare: number | null;
}

/** 音色チャンネル（4ステム揃った場合のみ。無ければ全て null） */
export interface GenreTimbreFeatures {
  /** ステム RMS シェア（4ステム合計に対する割合） */
  bassShare: number | null;
  vocalShare: number | null;
  drumsShare: number | null;
  otherShare: number | null;
}

export interface GenreFeatures {
  harmony: GenreHarmonyFeatures;
  rhythm: GenreRhythmFeatures;
  melody: GenreMelodyFeatures;
  timbre: GenreTimbreFeatures;
}

/**
 * Phase 3 後半: ジャンル傾向＝様式プロファイルの推定結果
 * （共有プロファイルへの加算的な格納）。
 *
 * 表現は単一ラベルではなく、様式ファミリーへの混合比率（分布）
 * そのものである（ジャンルは歴史的に様式の混合で形成される、
 * という捉え方を受けた 2026-10-28 の設計判断）。ただしこの
 * パーセンテージは「特徴空間における様式プロトタイプへの
 * 類似度」であって、文化的系譜そのものの比率ではない
 * （音響特徴から系譜は測れない。genreProfile.ts の冒頭も参照）。
 * 下流の prior は分布で重み付けした混合として効く
 * （比率は装飾ではなく機能する）。
 */
export interface GenreProfile {
  /** スタイルごとの混合比率（合計 ≒ 1、降順） */
  scores: { style: GenreStyleId; score: number }[];
  /** 最有力スタイル（分布の読み取り用の便宜。判定ではない） */
  top: GenreStyleId;
  /** 最有力スタイルの比率 */
  confidence: number;
  /** 最有力 − 次点の差。小さいほど混合が拮抗している */
  margin: number;
  /** 推定に使った特徴量（チャンネル別。診断・将来の他用途向け） */
  features: GenreFeatures;
  /** どのチャンネルの信号が実在したか（欠落の正直な記録） */
  channels: { harmony: boolean; rhythm: boolean; melody: boolean; timbre: boolean };
}

/**
 * Phase 3 §5: 拍子・小節推定モジュール（analysis/meterEstimate.ts）が
 * 扱う候補拍子。6 は 6/8（検出拍を8分音符パルスとみなした1小節6拍）
 * として表示する。
 */
export type MeterBeatsPerBar = 2 | 3 | 4 | 6;

/**
 * Phase 3 §5: 拍子・小節推定の結果（共有プロファイルへの加算的な格納）。
 *
 * 検出 BPM の比率取り違え（倍取り・3:2）は「拍だけでは小節が
 * 決まらない」ことが構造的な原因であるため、本モジュールは
 * 「テンポスケール × 拍子」の候補を、小節線への境界の乗りと
 * 信号側の自己相関で裁定する（PHASE3_PLAN.md §5、検証の原型は
 * measurements/SUNO_05_ANALYSIS.md 末尾の拍子訂正）。
 * コードラベルには一切触れない（§5 の非目標）。
 *
 * 証拠が薄い場合は beatsPerBar を null（判定保留）にする。
 * 誤った自信のある拍子より「不明」が正直であるためであり、
 * その場合 tempoScale は 1（仲裁なし）に固定される。
 * 勝者・次点・証拠の内訳は保留時も診断用に残す。
 */
export interface MeterEstimate {
  /** 勝者の拍子。証拠不足・接戦の場合は null（判定保留） */
  beatsPerBar: MeterBeatsPerBar | null;
  /** 表示用表記（"2/4" / "3/4" / "4/4" / "6/8"）。判定保留時は null */
  notation: string | null;
  /** 小節グリッドの位相（最初の小節線の時刻、秒）。判定保留時は null */
  barPhaseSec: number | null;
  /** 勝者の小節長（秒）。判定保留時は null */
  barSec: number | null;
  /** 仲裁後のテンポ（検出 BPM × tempoScale、estimateTempo と同じ整数丸め）。検出 BPM が無い場合は null */
  tempoBpm: number | null;
  /** 検出器（keyTempo.estimateTempo）の生の BPM */
  detectedBpm: number | null;
  /** 勝者のテンポスケール（1 / 0.5 / 2/3 / 1.5 / 2）。判定保留時は 1 */
  tempoScale: number;
  /** 勝者のスコア（証拠の重み付き和＋スケールの parsimony prior。1 を少し超えることがある） */
  score: number;
  /** 勝者の小節グループと次点グループの差（barScore に基本周期 prior を調整して測る）。小さいほど小節の解釈が拮抗している */
  margin: number;
  /** オンセット包絡の出所（ステム経路では drums を優先） */
  onsetSource: "mixture" | "drums";
  /** 勝者の証拠内訳（生の自己相関と超過ヒット率） */
  evidence: {
    /** 候補拍周期での自己相関（生値） */
    pulse: number;
    /** 候補小節長での自己相関（生値） */
    barAutocorr: number;
    /** コード変化境界の超過ヒット率（0..1、偶然 = 0） */
    boundary: number;
    /** 境界列（許容幅で広げたインパルス列）の候補小節長での自己相関（生値） */
    boundaryAutocorr: number;
  };
  /** 次点候補（勝者と異なる解釈の最良）。無ければ null */
  runnerUp: {
    beatsPerBar: MeterBeatsPerBar;
    tempoBpm: number;
    score: number;
  } | null;
}

export interface AnalysisResult {
  fileName: string;
  duration: number; // 秒
  sampleRate: number;
  /** 推定キー（例: "C major" / "A minor"）。日本語表示は UI 側で変換 */
  keyName: string;
  keyRoot: number; // 0=C .. 11=B
  keyMode: "major" | "minor";
  /** BPM 推定値（あくまで推定） */
  bpm: number | null;
  segments: ChordSegment[];
  /** 解析にかかったミリ秒 */
  analyzedInMs: number;
  /**
   * 解析モード（MODES.md §6）。未設定は "simple"（簡易モード）として扱う。
   * 簡易モードの解析（analyzeAudio）はこのフィールドを設定しない
   * （従来動作のまま）。高精度モード（analyzeStemsAudio）だけが
   * "high-accuracy" と下記のメタ情報を付ける。
   */
  mode?: "simple" | "high-accuracy";
  /** 高精度モード時の分離モデル名（例: "htdemucs"） */
  separationModel?: string;
  /** 高精度モード時のステム帯域戦略（例: "s-conditional"） */
  stemStrategy?: string;
  /**
   * 高精度モード時のステム分離本体にかかった秒数（モデル取得は含まない）。
   * 分離器が実測した場合のみ設定される。待ち時間の較正と書き出し用。
   */
  separationSeconds?: number;
  /**
   * 高精度モード時のモデル取得の記録（stems 層の ModelFetchFacts に
   * 取得秒数を合わせたもの）。「ダウンロードだったのか、キャッシュ
   * から読めたのか、保存はできたのか」を結果表示と書き出しが
   * 正直に伝えるために持つ。簡易モードでは設定されない。
   */
  modelFetch?: ModelFetchSummary;
  /**
   * Phase 3.3: 局所キー推定の窓列（analysis/localKey.ts）。
   * 2026-10-28 の分割採用以降は既定で設定される加算的フィールド
   * （localKeyRecord: false のオプトアウト時と、消費部 OFF の
   * ハーネス固定時などを除く）。転調の有無や相対調の揺れはこの
   * 窓列に残り、コードラベル自体は変えない
   * （PHASE3_PLAN.md §2: 解釈の判定は出さない）。
   */
  localKeys?: LocalKeyWindow[];
  /**
   * Phase 3 後半: ジャンル傾向＝様式プロファイルの推定結果
   * （analysis/genreProfile.ts）。
   * 2026-10-28 の設計判断で「記録・表示は既定 ON（ラベル不変）、
   * 消費部（第2段への prior 供給）は既定 OFF の明示オプション」と
   * する想定の加算的フィールド（消費部の採用は測定結果を見て
   * ユーザーが判断する。PHASE3_GENRE_RESULTS.md）。
   * DESIGN_NOTES の共有プロファイル項目「ジャンル推定と信頼度」の
   * 実体であり、コード解析以外の将来用途（分離調整・MIDI 変換・
   * マスタリング基準）もこのフィールドを読む形で接続する。
   */
  genreProfile?: GenreProfile;
  /**
   * Phase 3 §5: 拍子・小節推定の結果（analysis/meterEstimate.ts）。
   * 「記録」は既定で設定される加算的フィールドであり、コード
   * ラベルには触れない。「消費」は BPM 仲裁のみで、結果の bpm を
   * 仲裁後テンポに差し替えるかどうかは meterArbitrate オプション
   * （およびその既定値の採用判定、PHASE3_METER_RESULTS.md）に従う。
   * 仲裁が有効な場合も、検出 BPM の生値は本フィールドの
   * detectedBpm に残り、差し替えは透明に追える。
   */
  meterEstimate?: MeterEstimate;
}
