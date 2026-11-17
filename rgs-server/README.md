# RGS 後端範例（Express + SQLite）

這是 `rgs-integration.md` 的後端實作：唯一信任根，負責玩家帳本、伺服器 RNG、`roundId` 冪等、Provably Fair 與結算。前端只拿回傳的 `outcome` 做視覺演繹。

> ⚠️ 本機開發環境沒有安裝 Node，因此此後端**未經本機實跑**；程式碼依 Node 20+ / Express 4 / SQLite 共用 API 編寫，請依下列步驟驗證。

---

## 1. 安裝與啟動

### Node 22+（推薦，內建 SQLite，無須原生編譯）
```bash
cd rgs-server
npm install --omit=optional
node server.js
```
> Node 22 會印出 `ExperimentalWarning: sqlite is an experimental feature`，可忽略。

### Node 20（使用 better-sqlite3）
```bash
cd rgs-server
npm install
npm start
```
若 `better-sqlite3` 編譯失敗，請安裝對應平台的 build tools（Windows：Visual Studio Build Tools + Python），或改用 Node 22+。

啟動後：`RGS demo listening on http://localhost:8787`

---

## 2. API 一覽

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/v1/session` | 取得玩家餘額（前端每次操作後以 `balanceAfter` 覆寫快取） |
| POST | `/api/v1/rounds` | 下注 + 結果一次回傳；`Idempotency-Key` = `roundId` |
| GET | `/api/v1/rounds/:roundId` | 斷線重連查局；未知局回 `202 PENDING` |
| POST | `/api/v1/rounds/:roundId/settle` | 確認結算（冪等） |
| GET | `/api/v1/rounds/:roundId/verify` | Provably Fair 驗證（用揭露的 `serverSeed` 重算） |

所有請求可用 `Authorization: Bearer <playerId>` 切換玩家；未提供時用 `demo`。

---

## 3. curl 驗證範例

```bash
# 查詢餘額
curl http://localhost:8787/api/v1/session

# 下注（重點：Idempotency-Key 就是 roundId）
curl -X POST http://localhost:8787/api/v1/rounds \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-round-001" \
  -d '{"betAmount":10,"nonce":"abc123"}'

# 用同一個 roundId 再送一次 → 回傳完全相同的結果，餘額不會再扣
curl -X POST http://localhost:8787/api/v1/rounds \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-round-001" \
  -d '{"betAmount":10,"nonce":"abc123"}'

# 斷線重連查局
curl http://localhost:8787/api/v1/rounds/test-round-001

# Provably Fair 驗證（valid 應為 true）
curl http://localhost:8787/api/v1/rounds/test-round-001/verify
```

預期回傳（節錄）：
```json
{
  "roundId": "test-round-001",
  "status": "SETTLED",
  "outcome": { "reels": [5, 5, 2], "paylines": [], "winAmount": 0 },
  "balanceAfter": 990,
  "serverSeedHash": "b2c1...",
  "serverSeed": "3f9a...",
  "signature": "3045..."
}
```

---

## 4. 前端對接改动

把 `rgs-client-demo.html` / `crash-rgs-demo.html` 裡的 `MockRGS` 換成真實 HTTP 呼叫即可，Adapter 邏輯不必改：

```js
const RGS_BASE = "http://localhost:8787/api/v1";

async function createRound({ roundId, betAmount, nonce }) {
  const res = await fetch(`${RGS_BASE}/rounds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + playerId,
      "Idempotency-Key": roundId
    },
    body: JSON.stringify({ betAmount, nonce })
  });
  if (!res.ok) throw new Error("HTTP_" + res.status);
  return res.json();
}
```

其餘 `getRound` / `settle` / `resume` 比照辦理，指數退避與 FSM 維持不變。

---

## 5. 上線前必做（合規 / 安全）

1. **不要把 `serverSeed` 直接回傳給前端直到局結束**；此範例立即結算所以一同回傳。若改為延遲結算，請在 `settle` 後才揭露 seed。
2. **HMAC `signature` 只防傳輸竄改，不代表結果可信**；信任根是後端 DB 的 `rounds` 表。
3. `RGS_SECRET` 用環境變數注入，且与前端完全隔離。
4. 把 `demo` 玩家換成真實 session/JWT 驗證；`playerId` 不可由前端任意指定（目前是範例方便測試）。
5. 補上 GLI / 監管要求的不可竄改日誌：至少記錄 `roundId, playerId, bet, winAmount, serverSeedHash, timestamp`。
6. 交易已用 `BEGIN IMMEDIATE` 序列化寫入，避免併發 double-spend；高並發場景再換連線池 + WAL 模式。
7. CORS 目前 `*` 仅供本機 demo；上線改白名單。

---

## 6. 自動化測試

```bash
node --test test.js
```

測試會自行 spawn 一個使用暫存 DB 的 server（不同连接埠），結束後清理，不影響正式帳本。覆蓋項目：

- 初始餘額 = 1000
- 下注回傳結果並扣款
- **roundId 冪等**：同一局重送，結果與餘額不變（不重複扣款）
- GET 查局回傳相同結果；未知局回 `202 PENDING`
- settle 冪等
- Provably Fair：`verify` 回傳 `valid: true`
- **併發 double-spend**：12 筆超額下注全數 400，餘額不變
- **重連還原**：模擬回傳遺失後用同一 roundId 查回結果
- 不同玩家帳本隔離

> 需 Node 20+（內建 `fetch` / `node:test` / `crypto.randomUUID`）。

---

## 7. 檔案

```
rgs-server/
├── package.json
├── server.js
├── test.js        ← node --test test.js
├── README.md
└── rgs.db         ← 首次啟動自動建立（SQLite 帳本）
```
