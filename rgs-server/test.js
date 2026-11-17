/* ============================================================================
 * RGS 後端自動化測試（Node 內建 node:test，無額外依賴）
 * 執行：node --test test.js
 * 覆蓋：初始餘額、roundId 冪等、查局、settle、Provably Fair 驗證、
 *       併發 double-spend 防護、PENDING、重連還原
 * ==========================================================================*/
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.TEST_PORT || 8799;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const DB_PATH = path.join(os.tmpdir(), `rgs-test-${Date.now()}-${process.pid}.db`);
let child;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/session`); if (r.ok) return; } catch (_) {}
    await sleep(100);
  }
  throw new Error("server did not start in time");
}
function req(p, opts = {}) {
  return fetch(BASE + p, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (opts.player || "demo"),
      ...(opts.roundId ? { "Idempotency-Key": opts.roundId } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
}
const json = async r => ({ status: r.status, body: await r.json() });
const uuid = () => crypto.randomUUID();

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH },
    stdio: "ignore"
  });
  await waitReady();
});

after(async () => {
  if (child) child.kill();
  await sleep(150);
  try { fs.unlinkSync(DB_PATH); } catch (_) {}
  try { fs.unlinkSync(DB_PATH + "-wal"); } catch (_) {}
  try { fs.unlinkSync(DB_PATH + "-shm"); } catch (_) {}
});

/* ---------- 測試 ---------- */

test("session：初始餘額為 1000", async () => {
  const { status, body } = await json(await req("/session"));
  assert.equal(status, 200);
  assert.equal(body.balance, 1000);
});

test("下注：回傳結果、扣款並寫入 roundId", async () => {
  const roundId = "t-bet-" + uuid();
  const { status, body } = await json(await req("/rounds", {
    method: "POST", roundId, body: { betAmount: 10, nonce: "n1" }
  }));
  assert.equal(status, 200);
  assert.equal(body.roundId, roundId);
  assert.equal(body.status, "SETTLED");
  assert.equal(body.outcome.reels.length, 3);
  assert.equal(body.balanceAfter, 1000 - 10 + body.outcome.winAmount);
  assert.ok(body.serverSeedHash && body.signature);
});

test("冪等：同一 roundId 重送，結果與餘額不變（不重複扣款）", async () => {
  const roundId = "t-idem-" + uuid();
  const before = (await json(await req("/session"))).body.balance;
  const first = (await json(await req("/rounds", { method: "POST", roundId, body: { betAmount: 20 } }))).body;
  const second = (await json(await req("/rounds", { method: "POST", roundId, body: { betAmount: 20 } }))).body;
  assert.deepEqual(second.outcome, first.outcome);
  assert.equal(second.balanceAfter, first.balanceAfter);
  assert.equal(second.serverSeedHash, first.serverSeedHash);
  const after = (await json(await req("/session"))).body.balance;
  // 只扣一次注額：after = before - 20 + winAmount
  assert.equal(after, before - 20 + first.outcome.winAmount);
});

test("查局 GET /rounds/{roundId} 回傳相同結果", async () => {
  const roundId = "t-get-" + uuid();
  const created = (await json(await req("/rounds", { method: "POST", roundId, body: { betAmount: 5 } }))).body;
  const got = (await json(await req("/rounds/" + roundId))).body;
  assert.equal(got.roundId, roundId);
  assert.deepEqual(got.outcome, created.outcome);
  assert.equal(got.balanceAfter, created.balanceAfter);
});

test("未知 roundId 回 202 PENDING（重連輪詢用）", async () => {
  const { status, body } = await json(await req("/rounds/not-exist-" + uuid()));
  assert.equal(status, 202);
  assert.equal(body.status, "PENDING");
  assert.equal(body.retryAfterMs, 800);
});

test("settle 冪等", async () => {
  const roundId = "t-set-" + uuid();
  const created = (await json(await req("/rounds", { method: "POST", roundId, body: { betAmount: 3 } }))).body;
  const a = await json(await req(`/rounds/${roundId}/settle`, { method: "POST", body: { roundId }, roundId }));
  const b = await json(await req(`/rounds/${roundId}/settle`, { method: "POST", body: { roundId }, roundId }));
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.body.balanceAfter, created.balanceAfter);
});

test("Provably Fair：verify 回傳 valid=true", async () => {
  const roundId = "t-pf-" + uuid();
  await req("/rounds", { method: "POST", roundId, body: { betAmount: 7 } });
  const { status, body } = await json(await req(`/rounds/${roundId}/verify`));
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.hash, body.serverSeedHash);
});

test("併發 double-spend：大額下注全數拒絕，餘額不變", async () => {
  const before = (await json(await req("/session"))).body.balance;
  const tasks = Array.from({ length: 12 }, () => req("/rounds", {
    method: "POST", roundId: "t-ds-" + uuid(), body: { betAmount: before + 1000 }
  }).then(r => r.status));
  const statuses = await Promise.all(tasks);
  assert.ok(statuses.every(s => s === 400), "所有超額下注應回 400");
  const after = (await json(await req("/session"))).body.balance;
  assert.equal(after, before);
});

test("重連還原：模擬回傳遺失後用同一 roundId 查回結果", async () => {
  const roundId = "t-re-" + uuid();
  const created = (await json(await req("/rounds", { method: "POST", roundId, body: { betAmount: 4 } }))).body;
  // 假設前端遺失回傳，直接走 resume 查局
  const resumed = (await json(await req("/rounds/" + roundId))).body;
  assert.deepEqual(resumed.outcome, created.outcome);
  assert.equal(resumed.balanceAfter, created.balanceAfter);
});

test("不同玩家帳本隔離", async () => {
  const { status, body } = await json(await req("/session", { player: "player-A" }));
  assert.equal(status, 200);
  assert.equal(body.balance, 1000);
  assert.equal(body.playerId, "player-A");
  const demo = (await json(await req("/session"))).body;
  assert.notEqual(demo.balance, body.balance);
});
