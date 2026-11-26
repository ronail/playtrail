// Black-box HTTP tests. Local by default; BASE_URL=https://... tests a deployment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const remote = process.env.BASE_URL;
const base = remote?.replace(/\/$/, "") ?? "http://localhost:8787";
const wrangler = "node_modules/.bin/wrangler";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, PUT, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Signature, X-Build, X-Timestamp, X-Build-Signature",
  "access-control-max-age": "86400",
};
// Fresh local state per run: rate limit counts and objects would otherwise carry over.
const state = remote ? undefined : mkdtempSync(join(tmpdir(), "playtrail-"));
// Local runs expect the limits `npm run dev` would use: wrangler.toml unless overridden.
const limits = {
  register: Number(process.env.REGISTER_LIMIT || 5),
  upload: Number(process.env.UPLOAD_LIMIT || 10),
};
let server, a, b;
let ips = 0;

// A low limit can refuse the suite's own requests: wait for the next window.
const retry = async (send) => {
  let res = await send();
  for (let i = 0; res.status === 429 && i < 14; i++) {
    await sleep(5000);
    res = await send();
  }
  return res;
};

// Release key that proves a web build. Local runs make one; a deployment needs one it already lists.
if (remote) assert.ok(process.env.BUILD_ID && process.env.BUILD_SEED, "BASE_URL tests need BUILD_ID and BUILD_SEED");
const BUILD_ID = remote ? process.env.BUILD_ID : "test";
const buildKey = remote
  ? createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(process.env.BUILD_SEED, "base64")]),
      format: "der",
      type: "pkcs8",
    })
  : generateKeyPairSync("ed25519").privateKey;
const buildPublic = Buffer.from(createPublicKey(buildKey).export({ format: "jwk" }).x, "base64url").toString("base64");

const now = () => Math.floor(Date.now() / 1000);
const buildHeaders = (ts = now(), build = BUILD_ID) => ({
  "X-Build": build,
  "X-Timestamp": String(ts),
  "X-Build-Signature": edSign(null, Buffer.from(`register\n${build}\n${ts}`), buildKey).toString("base64"),
});

// The local server trusts CF-Connecting-IP, so each address gets its own register allowance.
// A deployment sets the header itself.
const postRegister = (ip = `203.0.113.${++ips}`, { headers = buildHeaders(), body } = {}) =>
  fetch(`${base}/v1/register`, { method: "POST", headers: remote ? headers : { ...headers, "CF-Connecting-IP": ip }, body });

const register = async () => {
  const res = await retry(() => postRegister());
  assert.equal(res.status, 200);
  return res.json();
};

const sign = (key, id, batch, body) =>
  createHmac("sha256", Buffer.from(key, "base64")).update(`${id}\n${batch}\n`).update(body).digest("base64");

// signature: undefined = sign correctly, null = omit the header
const put = (client, body, { batch = randomUUID(), key = client.key, signature, signed = body, stream = false, wait = true } = {}) => {
  const sig = signature === undefined ? sign(key, client.client_id, batch, signed) : signature;
  const send = () => fetch(`${base}/v1/logs/${client.client_id}/${batch}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...(sig === null ? {} : { "x-signature": sig }) },
    ...(stream ? { body: new Blob([body]).stream(), duplex: "half" } : { body }),
  });
  return wait ? retry(send) : send();
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
    const args = ["scripts/wrangler.mjs", "dev", "--port", "8787", "--var", "MASTER_KEY:test-only-key", "--var", `BUILD_KEYS:${JSON.stringify({ test: buildPublic })}`, "--persist-to", state];
    server = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "inherit"], // shows why it did not start
      detached: true,
    });
    const deadline = Date.now() + 30_000;
    while (!(await fetch(base).catch(() => null))) {
      assert.ok(Date.now() < deadline && server.exitCode === null, "wrangler dev did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // Only two registrations are shared, to stay within a deployment's limit.
  a = await register();
  b = await register();
}, { timeout: 150_000 });

after(() => {
  if (server && server.exitCode === null) process.kill(-server.pid);
  if (state) rmSync(state, { recursive: true, force: true });
});

// The response carries the key, so nothing may keep a copy.
test("register response is not cacheable", async () => {
  const res = await retry(() => postRegister());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// fetch cannot set Host, which is how the local server is told it is not on localhost.
const plainHttp = (method, path) =>
  new Promise((resolve, reject) => {
    const url = remote ? new URL(path, base.replace(/^https:/, "http:")) : new URL(path, base);
    request(url, { method, headers: remote ? {} : { host: "example.com" } }, (res) => {
      res.resume();
      resolve(res);
    })
      .on("error", reject)
      .end();
  });

test("plain HTTP is refused", async () => {
  for (const [method, path] of [["POST", "/v1/register"], ["PUT", "/v1/logs/a/b"], ["OPTIONS", "/v1/register"]]) {
    const res = await plainHttp(method, path);
    // A zone set to always use HTTPS redirects at the edge, before the Worker.
    if (remote && [301, 308].includes(res.statusCode)) continue;
    assert.equal(res.statusCode, 403, `${method} ${path}`);
    assert.equal(res.headers["access-control-allow-origin"], "*");
  }
});

test("register returns id and key", () => {
  assert.match(a.client_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(Buffer.from(a.key, "base64").length, 32);
  assert.notEqual(a.client_id, b.client_id);
});

test("register without a proof is refused", async () => {
  const res = await retry(() => postRegister(undefined, { headers: {} }));
  assert.equal(res.status, 401);
  assertCors(res);
});

// Local only: this many registrations would hit a deployment's limit.
test("bad build proof is refused", { skip: !!remote }, async () => {
  const good = buildHeaders();
  const without = (name) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
  const cases = {
    "wrong signature": { ...good, "X-Build-Signature": Buffer.alloc(64).toString("base64") },
    "non-base64 signature": { ...good, "X-Build-Signature": "!!not base64!!" },
    "short signature": { ...good, "X-Build-Signature": Buffer.alloc(10).toString("base64") },
    "old timestamp": buildHeaders(now() - 301),
    // 302, so a second ticking over cannot bring it inside the window.
    "future timestamp": buildHeaders(now() + 302),
    "timestamp not a number": buildHeaders("abc"),
    "unknown build": buildHeaders(now(), "nope"),
    "__proto__": buildHeaders(now(), "__proto__"),
    "constructor": buildHeaders(now(), "constructor"),
    "no X-Build": without("X-Build"),
    "no X-Timestamp": without("X-Timestamp"),
    "no X-Build-Signature": without("X-Build-Signature"),
  };
  for (const [name, headers] of Object.entries(cases))
    assert.equal((await postRegister(undefined, { headers })).status, 401, name);
});

const getChallenge = async () => {
  const res = await fetch(`${base}/v1/challenge`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  return (await res.json()).challenge;
};

test("challenge has the expected shape", async () => {
  assert.match(await getChallenge(), /^\d+\.[\w-]{43}$/);
});

// Both are HMACs under MASTER_KEY: a challenge must never double as an upload key.
test("a challenge is not a client key", async () => {
  const [ts, mac] = (await getChallenge()).split(".");
  const forged = { client_id: ts, key: Buffer.from(mac, "base64url").toString("base64") };
  assert.equal((await put(forged, "x\n")).status, 401);
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
  assert.equal(preflight.headers.get("strict-transport-security"), "max-age=31536000");
  const denied = await put(a, "x\n", { signature: null });
  assert.equal(denied.status, 401);
  assertCors(denied);
});

test("an invalid limit override stops before wrangler runs", () => {
  const env = { ...process.env, REGISTER_LIMIT: "", UPLOAD_LIMIT: "abc" };
  const run = spawnSync(process.execPath, ["scripts/wrangler.mjs", "deploy", "--dry-run"], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /UPLOAD_LIMIT must be a positive whole number/);
  assert.equal(run.stdout, "");
});

// Exactly `limit` requests succeed, then 429. The local simulator counts in fixed windows
// aligned to the clock, so don't start just before one ends.
// ponytail: assumes `limit` requests take under 10 s; huge overrides could straddle a window.
const assertLimit = async (limit, status, send) => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await sleep(left + 100);
  for (let i = 1; i <= limit; i++) assert.equal((await send()).status, status, `request ${i} of ${limit}`);
  const refused = await send();
  assert.equal(refused.status, 429, `request ${limit + 1}`);
  assertCors(refused);
};

// Deployed limits are approximate and per location, so these are local only.
test("register is rate limited", { skip: !!remote }, async () => {
  await assertLimit(limits.register, 200, () => postRegister("198.51.100.1"));
});

test("upload is rate limited", { skip: !!remote }, async () => {
  const client = await register();
  await assertLimit(limits.upload, 201, () => put(client, "x\n", { wait: false }));
});

// One host usually holds a whole IPv6 /64, so the /64 shares one allowance.
test("register limit covers a whole IPv6 /64", { skip: !!remote }, async () => {
  // Different spellings and hosts, all inside 2001:db8:0:1::/64.
  const same = ["2001:db8:0:1::1", "2001:db8:0:1::2", "2001:db8::1:0:0:0:3", "2001:db8:0:1:ffff:ffff:ffff:ffff"];
  let limited = false;
  for (let i = 0; i <= 2 * limits.register && !limited; i++)
    limited = (await postRegister(same[i % same.length])).status === 429;
  assert.ok(limited, "no 429 within one /64");
  assert.equal((await postRegister("2001:db8:0:2::1")).status, 200, "neighbouring /64");
});
