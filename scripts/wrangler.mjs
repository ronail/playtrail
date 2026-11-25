// `wrangler dev|deploy` with rate limits overridden by REGISTER_LIMIT / UPLOAD_LIMIT.
// Rate limit bindings are deploy-time config, so a Worker env var cannot change them.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
let config = readFileSync(path("wrangler.toml"), "utf8");
let overridden = false;
for (const name of ["REGISTER_LIMIT", "UPLOAD_LIMIT"]) {
  const value = process.env[name];
  if (!value) continue; // an unset GitHub variable arrives as ""
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail(`${name} must be a positive whole number, got ${JSON.stringify(value)}`);
  const limit = new RegExp(`(name = "${name}"\\s+namespace_id = "\\d+"\\s+simple = \\{ limit = )\\d+`);
  if (!limit.test(config)) fail(`cannot find the ${name} limit in wrangler.toml`);
  config = config.replace(limit, (_, before) => before + value);
  console.log(`${name} overridden: ${value} per period`);
  overridden = true;
}
if (overridden) {
  // Next to wrangler.toml, because paths in it are relative to the config file.
  writeFileSync(path("wrangler.limits.toml"), config);
  args.push("--config", path("wrangler.limits.toml"));
}
const { status, error } = spawnSync(path("node_modules/.bin/wrangler"), args, { stdio: "inherit" });
if (error) fail(`cannot run wrangler: ${error.message}`);
process.exit(status ?? 1);
