// Black-box HTTP tests. Local by default; BASE_URL=https://... tests a deployment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remote = process.env.BASE_URL;
const base = remote?.replace(/\/$/, "") ?? "http://localhost:8787";
const wrangler = "node_modules/.bin/wrangler";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, PUT, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Signature",
  "access-control-max-age": "86400",
};
// Fresh local state per run: rate limit counts and objects would otherwise carry over.
const state = remote ? undefined : mkdtempSync(join(tmpdir(), "playtrail-"));
let server, a, b;

const register = async () => {
  const res = await fetch(`${base}/v1/register`, { method: "POST" });
  assert.equal(res.status, 200);
  return res.json();
};

const sign = (key, id, batch, body) =>
  createHmac("sha256", Buffer.from(key, "base64")).update(`${id}\n${batch}\n`).update(body).digest("base64");

// signature: undefined = sign correctly, null = omit the header
const put = (client, body, { batch = randomUUID(), key = client.key, signature, signed = body, stream = false } = {}) => {
  const sig = signature === undefined ? sign(key, client.client_id, batch, signed) : signature;
  return fetch(`${base}/v1/logs/${client.client_id}/${batch}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...(sig === null ? {} : { "x-signature": sig }) },
    ...(stream ? { body: new Blob([body]).stream(), duplex: "half" } : { body }),
  });
};

const readObject = (path) =>
  execFileSync(wrangler, ["r2", "object", "get", `playtrail-logs/${path}`, "--pipe", ...(remote ? ["--remote"] : ["--local", "--persist-to", state])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const assertCors = (res) => {
  for (const [name, value] of Object.entries(CORS)) assert.equal(res.headers.get(name), value, name);
};

before(async () => {
  if (!remote) {
    server = spawn(wrangler, ["dev", "--port", "8787", "--var", "MASTER_KEY:test-only-key", "--persist-to", state], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = Date.now() + 30_000;
    while (!(await fetch(base).catch(() => null))) {
      assert.ok(Date.now() < deadline && server.exitCode === null, "wrangler dev did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // Only two registrations are shared: the limit is 5 per minute.
  a = await register();
  b = await register();
}, { timeout: 60_000 });

after(() => {
  if (server && server.exitCode === null) process.kill(-server.pid);
  if (state) rmSync(state, { recursive: true, force: true });
});

test("register returns id and key", () => {
  assert.match(a.client_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(Buffer.from(a.key, "base64").length, 32);
  assert.notEqual(a.client_id, b.client_id);
});

test("first upload 201, retry 200, object unchanged", async () => {
  const batch = randomUUID();
  const first = '{"seq":1}\n';
  assert.equal((await put(a, first, { batch })).status, 201);
  assert.equal((await put(a, '{"seq":2}\n', { batch })).status, 200);
  assert.equal(readObject(`${a.client_id}/${batch}.ndjson`), first);
});

test("bad signature, altered body, other client's id", async () => {
  assert.equal((await put(a, "x\n", { signature: Buffer.alloc(32).toString("base64") })).status, 401);
  assert.equal((await put(a, "x\n", { signed: "y\n" })).status, 401);
  assert.equal((await put(a, "x\n", { key: b.key })).status, 401);
});

test("missing or non-base64 signature", async () => {
  assert.equal((await put(a, "x\n", { signature: null })).status, 401);
  assert.equal((await put(a, "x\n", { signature: "!!not base64!!" })).status, 401);
});

test("size limits", async () => {
  assert.equal((await put(a, "")).status, 400);
  assert.equal((await put(a, "x".repeat(32768))).status, 201);
  assert.equal((await put(a, "x".repeat(32769))).status, 413);
});

test("streamed oversize body", async () => {
  assert.equal((await put(a, "x".repeat(40000), { stream: true })).status, 413);
});

// A body that never ends: only a Worker that stops reading at the cap can answer.
// Local only: it timed out against a deployment, where finite oversize bodies get 413.
test("oversize body is rejected without reading it all", { skip: !!remote }, async () => {
  const body = new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(40000)) });
  const res = await fetch(`${base}/v1/logs/a/b`, {
    method: "PUT",
    body,
    duplex: "half",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 413);
});

test("bad paths", async () => {
  const cases = [
    ["PUT", `/v1/logs/${"a".repeat(65)}/b`],
    ["PUT", "/v1/logs/a%2Fb/c"],
    ["PUT", "/v1/logs/a/b.c"],
    ["PUT", "/v1/logs/a/b/c"],
    ["POST", "/v1/nope"],
    ["GET", "/v1/logs/a/b"],
    ["GET", "/v1/register"],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 404, `${method} ${path}`);
    assertCors(res);
  }
});

test("cors", async () => {
  const preflight = await fetch(`${base}/v1/logs/a/b`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assertCors(preflight);
  const denied = await put(a, "x\n", { signature: null });
  assert.equal(denied.status, 401);
  assertCors(denied);
});

// The deployed limit is approximate and per location, so this is local only.
test("register is rate limited", { skip: !!remote }, async () => {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${base}/v1/register`, { method: "POST" });
    if (res.status === 429) return assertCors(res);
  }
  assert.fail("no 429 after 10 registrations");
});
