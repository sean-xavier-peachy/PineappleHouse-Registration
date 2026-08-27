/**
 * build-roster.mjs — generates roster.json for the static site from Airtable.
 *
 * This is the "backend → frontend" link: the site renders roster.json, so
 * un-booking or DELETING a performer in Airtable removes them from the site
 * on the next build. Headshots are downloaded locally (Airtable attachment
 * URLs expire), so the deployed images never break.
 *
 * Setup: cp .env.example .env   then paste your token into .env (gitignored).
 * Run:   node build-roster.mjs
 * Then commit roster.json + assets/headshots/ and deploy (GitHub Pages).
 *
 * Requires Node 18+ (global fetch).  No dependencies.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Local secrets. `.env` sits next to this script, is gitignored, and never
// leaves the machine. Anything already in the real environment wins, so CI
// (e.g. a GitHub Actions secret) can inject the token without a .env present.
// ---------------------------------------------------------------------------
function loadEnv(file = new URL(".env", import.meta.url)) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;                                    // blank line or # comment
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();            // strip trailing comment
    if (!(m[1] in process.env)) process.env[m[1]] = v;   // never override real env
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Config — override via env vars.
// ---------------------------------------------------------------------------
const TOKEN   = process.env.AIRTABLE_TOKEN;   // a NEW, read-only PAT (rotate the exposed one!)
const BASE_ID = process.env.BASE_ID;          // the ballot base — kept out of source, see .env
const TABLE   = process.env.TABLE || "Performers";
// Only include performers actually in the house. Point this at whatever field
// you use to mark that — e.g. a "House status" single-select = "Booked", or a
// checkbox. Default below reads a checkbox field named "In House".
const BOOKED_FORMULA = process.env.BOOKED_FORMULA || "{In House}";

const OUT_JSON = "roster.json";
const IMG_DIR  = "assets/headshots";

const missing = [!TOKEN && "AIRTABLE_TOKEN", !BASE_ID && "BASE_ID"].filter(Boolean);
if (missing.length) {
  console.error(`Missing ${missing.join(" and ")}.`);
  console.error("Copy .env.example to .env and fill it in (use a fresh, read-scoped token).");
  process.exit(1);
}

const HDR = { Authorization: `Bearer ${TOKEN}` };
const api = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;

// Build a full profile URL from a handle (strip any leading @ / URL).
const handle = h => (h || "").toString().trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+\//, "");
const url = (base, h) => handle(h) ? base + handle(h) : "";

// Pick the biggest follower count across platforms for the headline stat.
function headlineFollowers(f) {
  const nums = [
    [f["IG followers"], "IG"], [f["X followers"], "X"], [f["Bsky followers"], "Bsky"],
  ].filter(([n]) => n != null);
  if (!nums.length) return "";
  const [n, label] = nums.map(([n, l]) => [Number(String(n).replace(/[^\d.]/g, "")) || 0, l, n])
                          .sort((a, b) => b[0] - a[0])[0];
  return `${nums.find(([v]) => v === f[`${label} followers`]) ? f[`${label} followers`] : n} followers`;
}

async function fetchAll() {
  let records = [], offset;
  do {
    const u = new URL(api);
    u.searchParams.set("pageSize", "100");
    if (BOOKED_FORMULA) u.searchParams.set("filterByFormula", BOOKED_FORMULA);
    if (offset) u.searchParams.set("offset", offset);
    const res = await fetch(u, { headers: HDR });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const data = await res.json();
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

async function downloadHeadshot(rec) {
  const att = rec.fields.Headshot?.[0];
  if (!att?.url) return "";
  await mkdir(IMG_DIR, { recursive: true });
  const ext = (att.type?.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${IMG_DIR}/${rec.id}.${ext}`;
  const buf = Buffer.from(await (await fetch(att.url)).arrayBuffer());
  await writeFile(path, buf);
  return path;
}

const recs = await fetchAll();
const roster = [];
for (const rec of recs) {
  const f = rec.fields;
  roster.push({
    name:      f.Name || "",
    followers: headlineFollowers(f),
    headshot:  await downloadHeadshot(rec),
    ig:  url("https://instagram.com/", f["IG handle"]),
    x:   url("https://x.com/",         f["X handle"]),
    of:  url("https://onlyfans.com/",  f["OnlyFans handle"]),
    jff: url("https://justfor.fans/",  f["JustForFans handle"]),
  });
}

await writeFile(OUT_JSON, JSON.stringify(roster, null, 2));
console.log(`Wrote ${OUT_JSON} with ${roster.length} performers.`);
