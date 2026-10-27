import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { normalizeBasePath } from './src/lib/basePath.ts'

// https://vite.dev/config/
//
// base は相対 ('./') を既定にする: GitHub Pages のプロジェクトサイト
// (https://<user>.github.io/<repo>/) のようなサブパス配置でも、
// ルート配置でも、同一ビルドがそのまま動くようにするため。
// これにより Vite が出力する JS/CSS、Web Worker チャンク、
// onnxruntime-web の WASM アセット参照はすべて base 相対になり、
// MODES.md §8 で未確認だった「サブパス配置時の整合」が解消する。
// 固定サブパスへ置く場合は VITE_BASE_PATH=/<repo>/ のように上書きできる。
export default defineConfig({
  base: normalizeBasePath(process.env.VITE_BASE_PATH),
  plugins: [react()],
})
