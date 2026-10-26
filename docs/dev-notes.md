# 開発メモ

## GitHub Pages 公開
- リポジトリの Settings → Pages → Build and deployment → Source を **GitHub Actions** に設定する。
- `.github/workflows/deploy.yml` は `main` への push（および手動の workflow_dispatch）で build → Pages へデプロイする。作業ブランチ（`claude/10000-horse-race`）は main へマージされたときに公開される。

## URL パラメータ（検証用）
| パラメータ | 内容 |
|---|---|
| `?seed=12345` | レースシード（数値または任意文字列） |
| `?debug=1` | FPS / CPU時間 / LOD 頭数 / 三角形数 / インスタンス数を表示 |
| `?autoplay=1` | ボット（上級者相当）がプレイヤーを操作。タイトルを省略 |
| `?q=0..3` | 初期の描画 LOD レベル（0 = 最低。自動調整は有効のまま） |
| `?pr=1` | ピクセル比を固定（自動画質を無効化） |
| `?ff=20` | レース開始直後にシミュレーションを 20 秒早送り（タイトルを省略） |
| `?start=1` | タイトルを省略してすぐレース開始 |

## 実機での性能計測手順（Phase 0 の中止／設計変更判断用）
1. `npm run build && npx vite preview --host` を起動し、同じ LAN のスマホで `http://<PCのIP>:4173/horse10-000/?debug=1&autoplay=1&seed=1234` を開く（横持ち）。
2. 30 秒走らせ、オーバーレイの次の値を記録する。
   - `FPS` / `frame`（実フレーム間隔）、`cpu`（sim + prep + draw の CPU 時間/フレーム）、`refresh`（推定リフレッシュ周期）
   - `px`（ピクセル比）と `Q`（LOD レベル）：自動調整が落ち着いた値
   - `tris` / `inst`（描画三角形数・アップロードしたインスタンス数）
3. 最低画質の確認：`?debug=1&autoplay=1&seed=1234&q=0&pr=0.6`。この条件で 30FPS を下回る端末は、表示手法（遠景の疑似群衆化など）を見直す対象（設計書 §9 Phase 0 の中止基準）。
4. 低電力モード（iOS）でも、`refresh` が 33ms と推定され、Q が下がり続けないことを確認する。

LOD レベル 0 の上限は約 195k 三角形・1,750 インスタンス（`tests/Quality.test.ts` で固定）。

### 起動時ベンチ（Phase 2）
`?q` を指定しない場合、起動時に 2,000 頭のレースをスタート直後まで回し（`src/game/StartupBench.ts`、デスクトップで約 40ms）、1 tick あたりの時間を 10,000 頭に換算して初期 LOD レベルを選ぶ（PC: ≤6ms→2、≤12ms→1、それ以上→0／タッチ端末: ≤4ms→2、≤10ms→1、それ以上→0）。同時に sim コードの JIT ウォームアップにもなる。以降は従来どおり自動画質が調整する。

### sim の負荷（`npm run bench:sim`）
- vitest 上の計測は変換オーバーヘッド込み（平均約 3.5ms/tick）。本番ビルド相当（rolldown でバンドルして node 実行）では平均約 2.0ms/tick。
- 10–20ms のスパイクの主因は V8 のフィールド表現の一般化（整数で初期化した値に初めて小数が入る→最適化コードの破棄）だった。`HorseSimulation` のコンストラクタで小数を持つスカラーを double として初期化し、グループイベントのオブジェクト形状を統一して解消（最大 tick 約 20ms → 約 7ms）。ゲート開放直後のスパイクは出走演出中のウォームアップ（小さな捨てレース）で抑えている。

## 操作とゲームフロー（Phase 1）
- タイトル（背景で中級ボットの模擬レース）→ 出走演出 3 秒（超広角→後方カメラ、`10,000位 / 10,000頭`、3-2-1-GO）→ レース → 残り 200m でラストスパート表示 → ゴール（WIN / PERFECT / 順位 / TIME UP）→ リザルト。
- キー：A/D・←/→ 左右、Space ジャンプ、Shift ダッシュ、Esc/P ポーズ、R 同じシードでやり直し、Enter タイトル/リザルトで開始。
- 設定（音・揺れ軽減）と自己ベスト・最近のシードは localStorage（`h10k.*`）。

## iOS 実機 QA 項目（Phase 4 の QA 表に転記）
Safari（縦・横）と「ホーム画面に追加」した起動の両方で確認する。
- **ズーム**: ピンチ、ダブルタップ、ボタン連打（ジャンプ・ダッシュ・ポーズ）でページが拡大しないこと。`visualViewport.scale` が 1 のまま（`?debug=1` で表示）。
- **UI ボタンの素早い2回押し**: リザルトの「もう一度」などを素早く2回押しても2回目が効くこと（`noZoom` はボタン上の touchend を対象外にしている）。
- **全画面**: 「全画面」ボタン（iOS では非対応のため非表示/無効になること）、ホーム画面起動時に safe-area（ノッチ・ホームバー）にボタンが掛からないこと。
- **回転**: 縦→横→縦で HUD とタッチ操作の位置が追従し、レースが止まらないこと（回転プロンプトの表示/閉じる）。
- **バックグラウンド復帰**: ホームに戻る→復帰で自動ポーズされ、再開できること。音が復帰すること。
- **低電力モード**: `?debug=1` の `refresh` が 33ms と推定され、Q（画質）が下がり続けないこと。30Hz の sim が実時間で進むこと。
- **発熱/長時間**: 5 レース連続で FPS が大きく落ちないこと。
- **入力欄なし**: フォーカスで自動ズームする input が存在しないこと（現状なし）。

## リザルト・共有（Phase 3）
- カード: `src/share/CardRenderer.ts`（2D Canvas、1200×630 / 1080×1350、システムフォント、`document.fonts.ready` 待ち）。表示する文字はすべて `src/share/CardText.ts` の純関数 `cardModel(result)` から作る（`tests/Share.test.ts` でゲーム結果と一致を検証）。
- 共有: `src/share/Share.ts`。保存 = `<a download>`（iOS は共有シート →「画像を保存」、不可なら新規タブで画像を開いて長押し保存）。画像共有 = `navigator.canShare({files})` → `navigator.share({files,text,url})`（非対応時は保存＋投稿文コピー）。X = Web Intent（テキスト＋URL。画像は自動添付できないので「保存画像を添付」と案内）。
- PNG はリザルト表示時に先に作っておき、ボタンのタップ内で同期的に `window.open` / `share` を呼ぶ（ポップアップブロック・iOS 対策）。
- 固定 OGP: `public/assets/ogp.png`（1200×630）。作り直す場合は `npm run build && npx vite preview --port 4317` を起動して `NODE_PATH=<playwright の node_modules> node scripts/gen-ogp.mjs`（`?ogp=1` で描いたカードを保存）。OGP / Twitter カードのメタタグは index.html（絶対 URL）。
