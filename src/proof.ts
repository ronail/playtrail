// Proof that a registration comes from one of our own builds.
export const hmacKey = (raw: BufferSource, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [use]);

const WINDOW = 300; // seconds
const enc = new TextEncoder();
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fresh = (seconds: number) => Math.abs(Math.floor(Date.now() / 1000) - seconds) <= WINDOW;

const toBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Stateless: the challenge carries its own time and MAC. The newline cannot appear in a
// client ID, so a challenge MAC is never anyone's upload key.
export async function newChallenge(masterKey: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await hmacKey(enc.encode(masterKey), "sign");
  return `${ts}.${toBase64Url(await crypto.subtle.sign("HMAC", key, enc.encode(`challenge\n${ts}`)))}`;
}

// A web release signs with the key it ships with. Extractable, so a deterrent only.
export async function fromBuild(headers: Headers, env: { BUILD_KEYS?: string }): Promise<boolean> {
  const build = headers.get("X-Build");
  const ts = headers.get("X-Timestamp");
  const signature = headers.get("X-Build-Signature");
  if (!env.BUILD_KEYS || !build || !ts || !signature || !/^\d+$/.test(ts) || !fresh(Number(ts))) return false;
  // Outside any try: bad configuration is a 500, not the client's fault.
  const keys = JSON.parse(env.BUILD_KEYS) as Record<string, string>;
  if (!Object.hasOwn(keys, build)) return false;
  const key = await crypto.subtle.importKey("raw", fromBase64(keys[build]), "Ed25519", false, ["verify"]);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(signature);
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false; // verify throws on any other length
  return crypto.subtle.verify("Ed25519", key, bytes, enc.encode(`register\n${build}\n${ts}`));
}

async function validChallenge(value: string, masterKey: string): Promise<boolean> {
  const [ts, mac = ""] = value.split(".");
  if (!/^\d+$/.test(ts) || !fresh(Number(ts))) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(mac.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return false;
  }
  const key = await hmacKey(enc.encode(masterKey), "verify");
  return crypto.subtle.verify("HMAC", key, bytes, enc.encode(`challenge\n${ts}`));
}

export interface PlayEnv {
  MASTER_KEY: string;
  ANDROID_APPS?: string; // {"<package>":["<certificate digest>"]}
  GOOGLE_SA_KEY?: string; // service account JSON
  GOOGLE_BASE?: string; // tests only: replaces both Google origins
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

async function serviceJwt(account: { client_email: string; private_key: string }): Promise<string> {
  const part = (value: object) => toBase64Url(enc.encode(JSON.stringify(value)));
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/playintegrity",
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(account.private_key.replace(/-----[^-]+-----|\s/g, "")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${unsigned}.${toBase64Url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)))}`;
}

interface Verdict {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

// Google decodes the token and clears the verdicts if it is decoded again, so replays fail
// without us storing anything. 503 means try again; 401 means this proof is no good.
export async function fromPlay(body: Uint8Array, env: PlayEnv): Promise<200 | 401 | 503> {
  if (!env.ANDROID_APPS || !env.GOOGLE_SA_KEY) return 401;
  const apps = JSON.parse(env.ANDROID_APPS) as Record<string, string[]>;
  let request: { package_name?: unknown; challenge?: unknown; integrity_token?: unknown } | null;
  try {
    request = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return 401;
  }
  const { package_name: pkg, challenge, integrity_token } = request ?? {};
  if (typeof pkg !== "string" || typeof challenge !== "string" || typeof integrity_token !== "string") return 401;
  // Both before calling Google, so junk does not use up the decode quota.
  if (!Object.hasOwn(apps, pkg) || !(await validChallenge(challenge, env.MASTER_KEY))) return 401;

  const assertion = await serviceJwt(JSON.parse(env.GOOGLE_SA_KEY)); // bad key: 500
  let verdict: Verdict;
  try {
    const token = await fetch(env.GOOGLE_BASE ? `${env.GOOGLE_BASE}/token` : TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!token.ok) throw new Error(`Google token: ${token.status}`);
    const { access_token } = (await token.json()) as { access_token: string };
    const origin = env.GOOGLE_BASE ?? "https://playintegrity.googleapis.com";
    const decoded = await fetch(`${origin}/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ integrity_token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (decoded.status === 400) return 401; // not a token Google can read
    if (!decoded.ok) throw new Error(`Google decode: ${decoded.status}`);
    verdict = ((await decoded.json()) as { tokenPayloadExternal?: Verdict }).tokenPayloadExternal ?? {};
  } catch (err) {
    console.error(err);
    return 503;
  }

  const { requestDetails, appIntegrity, deviceIntegrity } = verdict;
  const hash = toBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(challenge)));
  const ok =
    requestDetails?.requestPackageName === pkg &&
    requestDetails.requestHash === hash &&
    Math.abs(Date.now() - Number(requestDetails.timestampMillis)) <= WINDOW * 1000 &&
    appIntegrity?.appRecognitionVerdict === "PLAY_RECOGNIZED" &&
    appIntegrity.certificateSha256Digest?.some((digest) => apps[pkg].includes(digest)) &&
    deviceIntegrity?.deviceRecognitionVerdict?.includes("MEETS_DEVICE_INTEGRITY");
  return ok ? 200 : 401;
}
