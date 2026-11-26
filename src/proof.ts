// Proof that a registration comes from one of our own builds.
const WINDOW = 300; // seconds
const enc = new TextEncoder();
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fresh = (seconds: number) => Math.abs(Math.floor(Date.now() / 1000) - seconds) <= WINDOW;

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
