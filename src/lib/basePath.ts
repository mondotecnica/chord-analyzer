/**
 * デプロイ時の base パス正規化（GitHub Pages のサブパス対応）。
 *
 * GitHub Pages のプロジェクトサイトは https://<user>.github.io/<repo>/
 * のようにサブパスで配信されるため、絶対パス (/assets/...) で
 * アセットを参照すると別リポジトリやルートを指して壊れる。
 * そこで既定の base は相対 ('./') とし、同一ビルドがルート配置でも
 * サブパス配置でも動くようにする。固定のサブパスへ置きたい場合だけ
 * 環境変数 VITE_BASE_PATH（例: /chord-analyzer/）で上書きできる。
 *
 * この関数は vite.config.ts から使うため、DOM やブラウザ API には
 * 一切依存しない純粋関数として保つ。
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "./";
  if (trimmed === "./" || trimmed === ".") return "./";
  // 末尾スラッシュを必ず付ける（Vite の base 仕様）
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}
