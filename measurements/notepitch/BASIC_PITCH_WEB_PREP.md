# Basic Pitch ブラウザ実測 — ハーネス準備記録

実施日: 2026-10-29
位置づけ: オーナーが選択した次の一手「ブラウザで Basic Pitch 推論を
実測する」のための測定基盤の構築。**本書の範囲はハーネスとサーバ側
参照出力の用意まで**で、実ブラウザでの実行と照合は後段（親エージェント）
が行う。製品コード（src/）は無変更、push なし。

## 配置（tools/basic-pitch-web/ — tools/ は gitignore 対象）

```
tools/basic-pitch-web/
  index.html                  ハーネスページ（読み込みで自動実行）
  js/main.js                  計測ドライバ（ORT Web セッション管理・計時・DOM 出力）
  js/basicpitch.js            推論パイプラインの JS ポート（後述）
  model/nmp.onnx              Basic Pitch 本体モデル（230,444 bytes）
  vendor/ort/                 ONNX Runtime Web 1.31.1 一式（後述）
  audio/song-e.wav            テスト音源1（合成曲 Song E、そのままコピー）
  audio/yoi-mix-first60.wav   テスト音源2（宵のひかり合計ミックス先頭 60 秒）
  reference/
    song-e.reference.json           サーバ側参照出力（170 音）
    yoi-mix-first60.reference.json  サーバ側参照出力（329 音）
```

## サーバ起動手順（後段の実行者向け）

```sh
cd ~/workspace/chord-analyzer-phase0/tools/basic-pitch-web
python3 -m http.server 8931
# → http://127.0.0.1:8931/ を開くと自動で計測が始まる
```

- 全アセットが相対パスで揃っていることを配信スモークテストで確認済み
  （全 URL 200、`.wasm` は `application/wasm` で配信される）。
- ページは計測完了時に `<pre id="result">` へ結果 JSON を書き、
  `document.title` を `BP-WEB-RESULT-COMPLETE` に変える（失敗時は
  `BP-WEB-RESULT-ERROR` で、エラー内容も同ブロックに JSON で残る）。
- python http.server は COOP/COEP ヘッダを送らないため
  SharedArrayBuffer が使えず、WASM は単一スレッドに固定している
  （`ort.env.wasm.numThreads = 1` を明示）。スレッド並列の速度は
  このハーネスでは測れない（制約として記録）。

## ONNX Runtime Web

- バージョン: **1.31.1**。プロジェクトの `package.json` が固定している
  `onnxruntime-web`（`node_modules/onnxruntime-web/dist/`）から
  ローカルコピーした。CDN ではなく同梱にした理由は再現性（バージョン
  固定・オフライン可）と、製品が将来使う場合と同一ビルドで測るため。
- 同梱ファイル: `ort.all.min.mjs`（WASM/WebGL/WebGPU を含む all ビルド）、
  `ort-wasm-simd-threaded.wasm/.mjs`、`ort-wasm-simd-threaded.jsep.wasm/.mjs`
  （JSEP は WebGPU 実行プロバイダ用）。合計約 45MB と大きいが、
  ローカル計測専用であり製品バンドルとは無関係。
- 計測は `wasm` → `webgpu` の順にセッションを作り、片方が失敗しても
  もう片方で続行し、失敗自体を結果 JSON に記録する。

## モデル

- `nmp.onnx` は basic-pitch パッケージ同梱の実物のコピー
  （出所: `~/.venvs/notepitch/.../basic_pitch/saved_models/icassp_2022/nmp.onnx`、
  サーバ側検証 NOTEPITCH_VERIFICATION.md で使ったのと同一ファイル）。
- 入力: `serving_default_input_2:0`、float32 `[batch, 43844, 1]`。
  出力: note = `StatefulPartitionedCall:1`、onset = `StatefulPartitionedCall:2`、
  contour = `StatefulPartitionedCall:0`（いずれも `[batch, 172, 88]`、
  contour のみ末尾 264）。Python 側 `Model.predict` の対応づけと同一。

## パイプラインの同一性（js/basicpitch.js）

サーバ側 Python 実装（basic_pitch の inference.py / note_creation.py、
`extract_basic_pitch.py` の既定引数）を正として逐語移植した。

- 前処理: モノラル 22050 Hz 化 → 先頭に 3840 サンプルの無音を付け、
  43844 サンプル窓をホップ 36164 で走査（末尾はゼロ詰め）。
- アンラップ: 各窓の出力 172 フレームから前後 15 フレームずつを捨て、
  `floor(原長 × 86 / 22050)` フレームに切り詰める。
- 後処理: onset 0.5 / frame 0.3 / 最小音長 11 フレーム / energy_tol 11、
  infer_onsets（n_diff=2 のフレーム差分を onset 最大値に再スケール）、
  argrelmax 相当のピーク抽出（処理順は Python と同じく時間逆行）、
  残存エネルギーの貪欲消費、melodia trick、の全てを再現。
  時刻換算は `model_frames_to_time`（マジックオフセット含む）そのまま。
  ピッチベンドはサーバ側抽出スクリプトも捨てているため計算しない。
- **唯一の意図的な差異はリサンプリング**: サーバ側は librosa（soxr）で
  22050 Hz 化するが、ブラウザ側は Web Audio の
  decodeAudioData + OfflineAudioContext（ブラウザ内蔵リサンプラ）を使う。
  ダウンミックスは両者ともチャンネル平均で一致。リサンプラの違いによる
  微小な数値差が境界近くの音符に影響しうる点は、照合時の許容差として
  考慮すること。

### ポートの検証（実施済み）

ブラウザ実行を待たずに、後処理ポートの正確さを Node で検証した。
サーバ側で song-e の未加工モデル出力（アンラップ済み note/onset 行列、
1614 フレーム×88）をダンプし、JS ポートに通した結果:

- イベント数 **170 = Python の 170**、全イベントがピッチ一致で対応し、
  開始・終了時刻の最大偏差は **0.0005 秒**（Python 側保存値の丸め誤差以内）。
- ピッチクラス別総持続時間（12 次元）も全成分で 0.003 秒以内に一致。
- 窓分割とアンラップも合成信号で Python の定義どおりであることを確認
  （窓数 12、先行無音 3840、フレーム切り詰め 1614）。

つまり残る未知数は「ブラウザの ORT Web がどれだけ速く/正しくモデルを
実行するか」と「ブラウザ内蔵リサンプラの影響」の2点に絞られている。

## テスト音源

| 音源 | 内容 | 長さ | 形式 |
|---|---|---|---|
| song-e.wav | test-audio/song-e.wav のコピー（合成・7th 曲、44.1kHz モノラル） | 18.78 秒 | WAV PCM16 |
| yoi-mix-first60.wav | stem-work/suno-yoi/mix.wav（9ステム合計ミックス）の先頭 60 秒を無変換で切り出し（48kHz ステレオ） | 60.00 秒 | WAV PCM16 |

実音源は著作権・容量の観点で抜粋に留めた。ブラウザ側では両者とも
22050 Hz モノラルに変換されてから推論される（song-e は 12 窓、
yoi 抜粋は 38 窓になる見込み）。

## サーバ側参照出力（reference/）

- 生成方法: 既存の `scripts/notepitch/extract_basic_pitch.py` を
  ハーネスに配置した**同一の音源ファイル**に対して実行
  （`~/.venvs/notepitch/bin/python`、CPU、既定しきい値）。
- 結果: song-e = **170 音**、yoi-mix-first60 = **329 音**。
- JSON 形式: 抽出スクリプトの生出力 `notes`（{s, e, p, a}）に加え、
  照合用に `noteCount`、`pcDurations`（ピッチクラス別総持続時間・12 次元）、
  `eventsRounded`（開始・終了を 0.05 秒格子に丸めた {s, e, p}）を付した。

## 照合の定義（後段の照合で使う）

- ブラウザ側の結果 JSON も同じ形（`noteCount` / `pcDurations` /
  `eventsRounded` / `firstNotes`）を各実行プロバイダ別に出す。
- 一致の判定は `eventsRounded` の集合比較（開始 0.05 秒丸め＋MIDI
  ノート番号）を基本とし、`pcDurations` の差分を補助指標とする。
  リサンプラ差異のため完全一致は期待せず、「イベント数の差が数%以内、
  pcDurations の大勢が一致するか」を後段で判断する想定。

## 計測項目（ページが出力するもの）

- モデル取得時間・バイト数、プロバイダ別セッション生成時間
- プロバイダ別: 推論総時間（run 呼び出し合計）と壁時計時間、
  実時間比（壁時計 / 音源長）、後処理時間
- `performance.memory` が取れる環境では JS ヒープ使用量（実行前後）
- プロバイダ別: 音符イベント数、先頭 10 件、pcDurations、eventsRounded 全件
- 窓単位のチャンク処理＋進捗表示（4 窓ごとにイベントループへ yield）

## 既知の制約

- WASM は単一スレッド固定（COOP/COEP なし環境のため）。製品化時に
  スレッド並列を使える配信形態なら、速度はここでの実測より良くなりうる。
- WebGPU は環境依存（ブラウザ・GPU・ドライバ）。失敗しても記録だけして
  WASM の結果で計測は完結する。
- ハーネスの音源は 60 秒まで。実曲フル尺でのメモリ挙動（タブ落ち）は
  この段階では測っていない（関門はまず速度と一致）。
- ORT Web の .wasm が合計約 45MB あるため、初回ロード時間はローカル
  配信前提の数値になる（製品の 172MB モデル問題とは別レイヤーの話）。
