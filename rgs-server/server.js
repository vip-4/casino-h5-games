/* ============================================================================
 * RGS 後端範例（Express + SQLite）
 * 職責：玩家帳本、伺服器 RNG、roundId 冪等、Provably Fair、結算與查局
 * 前端永不參與結果決定；此程式才是唯一信任根。
 *
 * SQLite 驅動：
 *   - Node 22+：優先使用內建 node:sqlite（無須安裝原生模組）
 *   - Node 20 / 其他：退回 better-sqlite3（選用依賴）
 * ==========================================================================*/
"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");

/* ---------- SQLite 适配層（兩套 API 的共用子集） ---------- */
let DBClass;
try {
  // Node 22+ 內建；會有 ExperimentalWarning，可忽略
  DBClass = require("node:sqlite").DatabaseSync;
} catch (_) {
  DBClass = require("better-sqlite3");
}

// DB_PATH 可供自動化測試指向暫存檔，避免污染正式帳本
const db = new DBClass(process.env.DB_PATH || path.join(__dirname, "rgs.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id    TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 1000
  );
  CREATE TABLE IF NOT EXISTS rounds (
    roundId        TEXT PRIMARY KEY,
    playerId       TEXT NOT NULL,
    bet            INTEGER NOT NULL,
    reels          TEXT NOT NULL,
    winAmount      INTEGER NOT NULL DEFAULT 0,
    balanceAfter   INTEGER NOT NULL,
    serverSeed     TEXT NOT NULL,
    serverSeedHash TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'SETTLED',
    settled        INTEGER NOT NULL DEFAULT 0,
    createdAt      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rounds_player ON rounds(playerId);
`);
db.prepare("INSERT OR IGNORE INTO players(id, balance) VALUES (?, ?)").run("demo", 1000);

/* ---------- 交易封裝（兩套驅動都支援 exec） ---------- */
function transact(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
}

/* ---------- Provably Fair：結果完全由 serverSeed 推導 ---------- */
const PAYOUT = [50, 30, 20, 15, 10, 100]; // 索引對應前端 SYMBOLS
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

function deriveReels(hash) {
  // 取 hash 前 6 個 hex 字節，各 mod 6 → 3 個符號索引
  return [0, 1, 2].map(i => parseInt(hash.substr(i * 2, 2), 16) % 6);
}
function calcWin(reels, bet) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) return PAYOUT[reels[0]] * bet;
  if (reels.filter(i => i === 2).length >= 2) return 2 * bet;
  return 0;
}
const SECRET = process.env.RGS_SECRET || "dev-secret-change-me";
function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex");
}

function toResponse(r) {
  const reels = JSON.parse(r.reels);
  const payload = {
    roundId: r.roundId,
    status: r.status,
    outcome: {
      reels,
      paylines: reels[0] === reels[1] && reels[1] === reels[2]
        ? [{ line: 1, symbol: reels[0], payout: r.winAmount }] : [],
      winAmount: r.winAmount
    },
    balanceAfter: r.balanceAfter,
    serverSeedHash: r.serverSeedHash,
    // 局已結束才揭露 seed，供玩家驗證（此範例立即結算，故直接回傳）
    serverSeed: r.serverSeed
  };
  payload.signature = sign(payload);
  return payload;
}

/* ---------- Express ---------- */
const app = express();
app.use(express.json());
// CORS：讓 file:// 或本機前端 demo 可直接串接（正式環境請改為白名單）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const playerId = req => {
  const h = req.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "demo";
};
function ensurePlayer(pid) {
  db.prepare("INSERT OR IGNORE INTO players(id, balance) VALUES (?, ?)").run(pid, 1000);
}

/* ---------- API ---------- */

// 查詢(session)：前端每次操作後都應以 balanceAfter 覆寫本地快取
app.get("/api/v1/session", asyncRoute((req, res) => {
  const pid = playerId(req); ensurePlayer(pid);
  const row = db.prepare("SELECT balance FROM players WHERE id=?").get(pid);
  res.json({ playerId: pid, balance: row.balance, currency: "TWD" });
}));

// 下注 + 結果一次回傳；Idempotency-Key 即 roundId
app.post("/api/v1/rounds", asyncRoute((req, res) => {
  const pid = playerId(req); ensurePlayer(pid);
  const roundId = req.get("idempotency-key") || req.body.roundId;
  const bet = Number(req.body.betAmount);

  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "缺少 roundId / Idempotency-Key");
  if (!Number.isInteger(bet) || bet <= 0 || bet > 100000) throw new HttpError(400, "INVALID_BET", "注額必須為正整數");

  // 冪等：同一 roundId 直接回傳既有結果，不重複扣款
  const exist = db.prepare("SELECT * FROM rounds WHERE roundId=?").get(roundId);
  if (exist) return res.json(toResponse(exist));

  const serverSeed = crypto.randomBytes(32).toString("hex");
  const serverSeedHash = sha256(serverSeed);
  const reels = deriveReels(serverSeedHash);
  const winAmount = calcWin(reels, bet);

  try {
    const rec = transact(() => {
      const p = db.prepare("SELECT balance FROM players WHERE id=?").get(pid);
      if (p.balance < bet) throw new HttpError(400, "INSUFFICIENT_FUNDS", "餘額不足");
      const balanceAfter = p.balance - bet + winAmount;
      db.prepare(`INSERT INTO rounds
        (roundId,playerId,bet,reels,winAmount,balanceAfter,serverSeed,serverSeedHash,status,settled,createdAt)
        VALUES (?,?,?,?,?,?,?,?,'SETTLED',1,?)`)
        .run(roundId, pid, bet, JSON.stringify(reels), winAmount, balanceAfter,
             serverSeed, serverSeedHash, Date.now());
      db.prepare("UPDATE players SET balance=? WHERE id=?").run(balanceAfter, pid);
      return db.prepare("SELECT * FROM rounds WHERE roundId=?").get(roundId);
    });
    res.json(toResponse(rec));
  } catch (e) {
    // 併發下同一 roundId：另一請求已寫入 → 回傳既有結果
    if (String(e.code || "").includes("CONSTRAINT") || /UNIQUE|PRIMARY/i.test(String(e.message))) {
      const r2 = db.prepare("SELECT * FROM rounds WHERE roundId=?").get(roundId);
      if (r2) return res.json(toResponse(r2));
    }
    throw e;
  }
}));

// 斷線重連查局：GET /api/v1/rounds/{roundId}
app.get("/api/v1/rounds/:roundId", asyncRoute((req, res) => {
  const pid = playerId(req);
  const rec = db.prepare("SELECT * FROM rounds WHERE roundId=? AND playerId=?").get(req.params.roundId, pid);
  if (!rec) return res.status(202).json({ roundId: req.params.roundId, status: "PENDING", retryAfterMs: 800 });
  res.json(toResponse(rec));
}));

// 確認結算（冪等）
app.post("/api/v1/rounds/:roundId/settle", asyncRoute((req, res) => {
  const pid = playerId(req);
  const rec = db.prepare("SELECT * FROM rounds WHERE roundId=? AND playerId=?").get(req.params.roundId, pid);
  if (!rec) throw new HttpError(404, "ROUND_NOT_FOUND", "查無此局");
  if (!rec.settled) db.prepare("UPDATE rounds SET settled=1 WHERE roundId=?").run(rec.roundId);
  res.json({ roundId: rec.roundId, settled: true, balanceAfter: rec.balanceAfter });
}));

// Provably Fair 驗證：用揭露的 serverSeed 重算結果是否與當局一致
app.get("/api/v1/rounds/:roundId/verify", asyncRoute((req, res) => {
  const pid = playerId(req);
  const rec = db.prepare("SELECT * FROM rounds WHERE roundId=? AND playerId=?").get(req.params.roundId, pid);
  if (!rec) throw new HttpError(404, "ROUND_NOT_FOUND", "查無此局");
  const hash = sha256(rec.serverSeed);
  const reels = deriveReels(hash);
  const win = calcWin(reels, rec.bet);
  const ok = hash === rec.serverSeedHash &&
    JSON.stringify(reels) === rec.reels && win === rec.winAmount;
  res.json({ roundId: rec.roundId, valid: ok, hash, reels, winAmount: win,
    serverSeedHash: rec.serverSeedHash, serverSeed: rec.serverSeed });
}));

/* ---------- 錯誤處理 ---------- */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[RGS ERROR]", err);
  res.status(status).json({ error: err.code || "INTERNAL", message: err.message || "伺服器錯誤" });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`RGS demo listening on http://localhost:${PORT}`));
