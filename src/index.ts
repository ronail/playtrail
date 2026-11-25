interface Env {
  BUCKET: R2Bucket;
  MASTER_KEY: string;
  REGISTER_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
}

const MAX = 32 * 1024;
const LOG_PATH = /^\/v1\/logs\/([\w-]{1,64})\/([\w-]{1,64})$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signature",
  "Access-Control-Max-Age": "86400",
};
const enc = new TextEncoder();

const reply = (status: number, text?: string) => new Response(text ?? null, { status });

const hmacKey = (raw: BufferSource, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [use]);

// The client's key is derived from its ID, so nothing is stored.
const clientKey = async (env: Env, id: string) =>
  crypto.subtle.sign("HMAC", await hmacKey(enc.encode(env.MASTER_KEY), "sign"), enc.encode(id));

async function register(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.REGISTER_LIMIT.limit({ key: ip })).success) return reply(429, "slow down");
  const client_id = crypto.randomUUID();
  const key = btoa(String.fromCharCode(...new Uint8Array(await clientKey(env, client_id))));
  return Response.json({ client_id, key });
}

async function upload(req: Request, env: Env, id: string, batch: string): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX) return reply(413, "too large"); // early reject only
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return reply(400, "empty");
  if (body.byteLength > MAX) return reply(413, "too large"); // the real check

  const prefix = enc.encode(`${id}\n${batch}\n`);
  const msg = new Uint8Array(prefix.length + body.byteLength);
  msg.set(prefix);
  msg.set(new Uint8Array(body), prefix.length);
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
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return reply(204);
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
    return res;
  },
};
