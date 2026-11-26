import { fromBuild, hmacKey, newChallenge } from "./proof";

interface Env {
  BUCKET: R2Bucket;
  MASTER_KEY: string;
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

// The client's key is derived from its ID, so nothing is stored.
const clientKey = async (env: Env, id: string) =>
  crypto.subtle.sign("HMAC", await hmacKey(enc.encode(env.MASTER_KEY), "sign"), enc.encode(id));

// One host usually holds a whole IPv6 /64, so limit by that, not by address.
function limitKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip; // IPv4, or IPv4-mapped
  const [head, tail] = ip.split("::").map((part) => (part ? part.split(":") : []));
  const groups = tail ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return groups.slice(0, 4).join(":");
}

async function register(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.REGISTER_LIMIT.limit({ key: limitKey(ip) })).success) return reply(429, "slow down");
  if (!(await fromBuild(req.headers, env))) return reply(401, "unauthorized");
  const client_id = crypto.randomUUID();
  const key = btoa(String.fromCharCode(...new Uint8Array(await clientKey(env, client_id))));
  return Response.json({ client_id, key }, { headers: { "Cache-Control": "no-store" } });
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
