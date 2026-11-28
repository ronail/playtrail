import { fromBuild, fromGoogle, fromPlay, hmacKey, newChallenge, toBase64Url, type GoogleEnv, type PlayEnv } from "./proof";

interface Env extends PlayEnv, GoogleEnv {
  BUCKET: R2Bucket;
  BUILD_KEYS?: string;
  REGISTER_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
}

const MAX = 32 * 1024;
const LOG_PATH = /^\/v1\/logs\/([\w-]{1,64})\/([\w-]{1,64})$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signature, X-Build, X-Timestamp, X-Build-Signature",
  "Access-Control-Max-Age": "86400",
};
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]; // where plain HTTP is allowed
const enc = new TextEncoder();

const reply = (status: number, text?: string) => new Response(text ?? null, { status });

const masterMac = async (env: Env, text: string) =>
  crypto.subtle.sign("HMAC", await hmacKey(enc.encode(env.MASTER_KEY), "sign"), enc.encode(text));
// The client's key is derived from its ID, so nothing is stored.
const clientKey = masterMac;

// One host usually holds a whole IPv6 /64, so limit by that, not by address.
function limitKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip; // IPv4, or IPv4-mapped
  const [head, tail] = ip.split("::").map((part) => (part ? part.split(":") : []));
  const groups = tail ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return groups.slice(0, 4).join(":");
}

// Stops at the cap: anyone can send a body, so never buffer more than we accept.
async function readBody(req: Request): Promise<Uint8Array | null> {
  const buf = new Uint8Array(MAX);
  let size = 0;
  for await (const chunk of req.body ?? []) {
    if (size + chunk.byteLength > MAX) return null;
    buf.set(chunk, size);
    size += chunk.byteLength;
  }
  return buf.subarray(0, size);
}

// The parsed body, if it is a Google sign-in request.
function googleRequest(body: Uint8Array): { google_id_token: unknown } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return value && Object.hasOwn(value, "google_id_token") ? value : null;
  } catch {
    return null;
  }
}

async function register(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.REGISTER_LIMIT.limit({ key: limitKey(ip) })).success) return reply(429, "slow down");

  // One proof: a Google or Play Integrity body, or the three build headers. Never two.
  const body = await readBody(req);
  if (!body) return reply(413, "too large");
  const hasBuild = ["X-Build", "X-Timestamp", "X-Build-Signature"].some((name) => req.headers.has(name));
  const refuse = (status: number) => reply(status, status === 503 ? "try again" : "unauthorized");
  let client_id: string = crypto.randomUUID();
  const google = body.byteLength ? googleRequest(body) : null;
  if (google) {
    if (hasBuild || ["package_name", "challenge", "integrity_token"].some((field) => field in google)) return refuse(401);
    const account = await fromGoogle(google.google_id_token, env);
    if (typeof account === "number") return refuse(account);
    // Same account, same ID. The newline cannot appear in a client ID, so this is nobody's upload key.
    client_id = toBase64Url(await masterMac(env, `google\n${account.sub}`));
  } else {
    let status: number;
    if (body.byteLength) status = hasBuild ? 401 : await fromPlay(body, env);
    else status = (await fromBuild(req.headers, env)) ? 200 : 401;
    if (status !== 200) return refuse(status);
  }
  const key = btoa(String.fromCharCode(...new Uint8Array(await clientKey(env, client_id))));
  return Response.json({ client_id, key }, { headers: { "Cache-Control": "no-store" } });
}

async function upload(req: Request, env: Env, id: string, batch: string): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX) return reply(413, "too large"); // early reject only
  const body = await readBody(req);
  if (!body) return reply(413, "too large"); // the real check
  if (body.byteLength === 0) return reply(400, "empty");

  const prefix = enc.encode(`${id}\n${batch}\n`);
  const msg = new Uint8Array(prefix.length + body.byteLength);
  msg.set(prefix);
  msg.set(body, prefix.length);
  let ok = false;
  try {
    const sig = Uint8Array.from(atob(req.headers.get("x-signature") ?? ""), (c) => c.charCodeAt(0));
    ok = await crypto.subtle.verify("HMAC", await hmacKey(await clientKey(env, id), "verify"), sig, msg);
  } catch {
    // bad base64
  }
  if (!ok) return reply(401, "unauthorized");

  // After the signature, so nobody else can use up this client's allowance.
  if (!(await env.UPLOAD_LIMIT.limit({ key: id })).success) return reply(429, "slow down");

  const key = `${id}/${batch}.ndjson`;
  const put = await env.BUCKET.put(key, body, { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (put) return reply(201);
  // Only report success if the object really exists, so a client never drops data.
  return reply((await env.BUCKET.head(key)) ? 200 : 500);
}

async function handle(req: Request, env: Env): Promise<Response> {
  const { protocol, hostname, pathname } = new URL(req.url);
  // Refused, not redirected: a client on http:// must be fixed, or it keeps sending in the clear.
  if (protocol === "http:" && !LOCAL_HOSTS.includes(hostname)) return reply(403, "use https");
  if (req.method === "OPTIONS") return reply(204);
  if (req.method === "GET" && pathname === "/v1/challenge")
    return Response.json({ challenge: await newChallenge(env.MASTER_KEY) }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "POST" && pathname === "/v1/register") return register(req, env);
  const log = req.method === "PUT" && LOG_PATH.exec(pathname);
  if (log) return upload(req, env, log[1], log[2]);
  return reply(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await handle(req, env);
    } catch (err) {
      console.error(err);
      res = reply(500, "error");
    }
    for (const [name, value] of Object.entries(CORS)) res.headers.set(name, value);
    res.headers.set("Strict-Transport-Security", "max-age=31536000");
    return res;
  },
};
