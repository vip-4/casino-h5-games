# Casino H5 Games Lab

H5 博弈遊戲的前端範例與技術文件站。部署於 [casino-h5-games.pages.dev](https://casino-h5-games.pages.dev)。

> 本站僅供開發技術研究，**不提供任何實際博彩服務**。所有结果由伺服器 RNG 決定，前端僅負責視覺演繹。

## 內容

| 檔案 | 說明 |
|---|---|
| `slot-machine-demo.html` | Canvas 2D 老虎機：FSM、緩動停輪、金幣粒子、Web Audio |
| `slot-pixi-demo.html` | PixiJS v8 WebGL 老虎機：Sprite Atlas、Glow Filter、Bloom |
| `fish-game-demo.html` | 捕魚機：物件池魚群、碰撞、炮台倍率、BOSS |
| `baccarat-demo.html` | 百家樂：8 副牌、標準補牌規則、發牌動畫 |
| `roulette-demo.html` | 歐式輪盤：37 格、減速曲線、多種投注 |
| `crash-demo.html` | Crash 崩盤：倍數曲線、兌現、Provably Fair |
| `crash-rgs-demo.html` | Crash + RGS：roundId 冪等、重連、兌現驗證 |
| `engine.js` / `engine-demo.html` | 共用引擎：GameLoop、FSM、Audio、Particle、ObjectPool、Stage |
| `rgs-integration.md` | RGS 串接規格、API、Mermaid 流程圖 |
| `rgs-client-demo.html` / `rgs-client-http.html` | RGS 前端 Adapter 與真實 HTTP Client |
| `rgs-server/` | Express + SQLite 後端範例與 `node --test` 自動化測試 |

## 本機執行

直接用瀏覽器開啟任一 `.html` 即可。`slot-pixi-demo.html` 需與 `pixi.min.js` 放在同一目錄。

後端：

```bash
cd rgs-server
npm install
node server.js
node --test test.js
```

## 部署

`dist/` 是部署專用副本（含 SEO/GEO 優化的 `index.html`、`robots.txt`、`sitemap.xml`、`llms.txt`、`_headers`、`og-image.svg`）。

- 本機 Direct Upload：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy-pages.ps1`
- CI/CD：推送到 `main` 會觸發 `.github/workflows/deploy.yml`，以 Wrangler 部署 `dist/`。

CI/CD 設定：

- GitHub Actions **Secret**：`CLOUDFLARE_API_TOKEN`（具備 `Pages:Edit` 權限的 Cloudflare API Token）
- GitHub Actions **Variable**：`CLOUDFLARE_ACCOUNT_ID`（Cloudflare Account ID，已由部署腳本自動寫入）
