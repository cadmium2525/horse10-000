# 開発メモ

## GitHub Pages 公開
- リポジトリの Settings → Pages → Build and deployment → Source を **GitHub Actions** に設定する。
- `.github/workflows/deploy.yml` は `main` への push（および手動の workflow_dispatch）で build → Pages へデプロイする。作業ブランチ（`claude/10000-horse-race`）は main へマージされたときに公開される。

## URL パラメータ（検証用）
| パラメータ | 内容 |
|---|---|
| `?seed=12345` | レースシード（数値または任意文字列） |
| `?debug=1` | FPS / CPU時間 / LOD 頭数 / 三角形数 / インスタンス数を表示 |
| `?autoplay=1` | ボットがプレイヤーを操作 |
| `?q=0..3` | 初期の描画 LOD レベル（0 = 最低。自動調整は有効のまま） |
| `?pr=1` | ピクセル比を固定（自動画質を無効化） |
| `?ff=20` | 描画開始前にシミュレーションを 20 秒早送り |

## 実機での性能計測手順（Phase 0 の中止／設計変更判断用）
1. `npm run build && npx vite preview --host` を起動し、同じ LAN のスマホで `http://<PCのIP>:4173/horse10-000/?debug=1&autoplay=1&seed=1234` を開く（横持ち）。
2. 30 秒走らせ、オーバーレイの次の値を記録する。
   - `FPS` / `frame`（実フレーム間隔）、`cpu`（sim + prep + draw の CPU 時間/フレーム）、`refresh`（推定リフレッシュ周期）
   - `px`（ピクセル比）と `Q`（LOD レベル）：自動調整が落ち着いた値
   - `tris` / `inst`（描画三角形数・アップロードしたインスタンス数）
3. 最低画質の確認：`?debug=1&autoplay=1&seed=1234&q=0&pr=0.6`。この条件で 30FPS を下回る端末は、表示手法（遠景の疑似群衆化など）を見直す対象（設計書 §9 Phase 0 の中止基準）。
4. 低電力モード（iOS）でも、`refresh` が 33ms と推定され、Q が下がり続けないことを確認する。

LOD レベル 0 の上限は約 195k 三角形・1,750 インスタンス（`tests/Quality.test.ts` で固定）。
