/**
 * build-roster.mjs — generates roster.json for the static site from Notion.
 *
 * Notion is the single source of truth: admins edit the Models DB, re-run this,
 * and the site updates. Un-setting a performer's status or deleting their page
 * removes them from the site on the next build. Headshots are downloaded
 * locally because Notion's file URLs are signed and expire within the hour.
 *
 * Setup: cp .env.example .env   then fill in NOTION_TOKEN and NOTION_DB_ID.
 * Run:   node build-roster.mjs
 * Check: node build-roster.mjs --check    (verifies property names, writes nothing)
 *
 * Requires Node 18+ (global fetch). No dependencies.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Local secrets. `.env` sits next to this script, is gitignored, and never
// leaves the machine. Anything already in the real environment wins, so CI
// can inject the token without a .env present.
// ---------------------------------------------------------------------------
function loadEnv(file = new URL(".env", import.meta.url)) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const TOKEN   = process.env.NOTION_TOKEN;
const DB_ID   = process.env.NOTION_DB_ID;
const VERSION = process.env.NOTION_VERSION || "2022-06-28";
// Which Status value means "in the house". Case-insensitive.
const BOOKED  = (process.env.BOOKED_STATUS || "Booked").toLowerCase();

// ---------------------------------------------------------------------------
// PROPERTY MAP — the ONLY place to edit if the Notion property names differ.
// Run with --check to see the real names side by side with these.
// ---------------------------------------------------------------------------
const PROP = {
  name:        "Name",
  status:      "Status",
  headshot:    "Headshot",
  headshotUrl: "Headshot URL",   // imported ballot headshots are external links
  votes:       "Votes",          // orders the invited pool; never published
  instagram:   "Instagram",
  x:           "X",
  onlyfans:    "OnlyFans",
  justforfans: "JustForFans",
};

const OUT_JSON = "roster.json";
const IMG_DIR  = "assets/headshots";
const CHECK    = process.argv.includes("--check");

// --- guards ----------------------------------------------------------------
const problems = [];
if (!TOKEN) problems.push("NOTION_TOKEN is not set");
else if (!/^(ntn_|secret_)/.test(TOKEN))
  problems.push(`NOTION_TOKEN doesn't look like a Notion integration token (expected it to start with "ntn_" or "secret_")`);
if (!DB_ID) problems.push("NOTION_DB_ID is not set");
if (problems.length) {
  console.error("Cannot run:\n  - " + problems.join("\n  - "));
  console.error("\nCopy .env.example to .env and fill it in.");
  console.error("Create an integration at https://www.notion.so/my-integrations,");
  console.error("then share the Models database with it (••• → Connections).");
  process.exit(1);
}

const HDR = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": VERSION,
  "Content-Type": "application/json",
};

async function notion(path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { ...init, headers: HDR });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.message || JSON.stringify(body).slice(0, 200);
    if (res.status === 404)
      throw new Error(`Notion 404 — the integration can't see this database.\n` +
        `  Open the Models DB in Notion, click ••• → Connections → add your integration.`);
    if (res.status === 401)
      throw new Error(`Notion 401 — the token was rejected. Check NOTION_TOKEN in .env.`);
    throw new Error(`Notion ${res.status}: ${msg}`);
  }
  return body;
}

// --- property readers ------------------------------------------------------
// Reads a Notion property regardless of its type, so a field typed as `url`
// and one typed as `rich_text` both come back as a usable string.
function readProp(props, key) {
  const p = props?.[key];
  if (!p) return null;
  switch (p.type) {
    case "title":       return p.title.map(t => t.plain_text).join("").trim();
    case "rich_text":   return p.rich_text.map(t => t.plain_text).join("").trim();
    case "url":         return (p.url || "").trim();
    case "email":       return (p.email || "").trim();
    case "phone_number":return (p.phone_number || "").trim();
    case "number":      return p.number;
    case "checkbox":    return p.checkbox;
    case "select":      return p.select?.name ?? "";
    case "status":      return p.status?.name ?? "";
    case "multi_select":return p.multi_select.map(s => s.name).join(", ");
    case "formula":     return p.formula?.string ?? p.formula?.number ?? p.formula?.boolean ?? "";
    case "rollup":      return p.rollup?.number ?? "";
    case "files":       return p.files.map(f => f.file?.url || f.external?.url).filter(Boolean);
    case "people":      return p.people.map(x => x.name).filter(Boolean).join(", ");
    default:            return "";
  }
}

// Instagram and X are TEXT fields — models type a bare username, which is what
// they actually know, and the canonical URL is rebuilt here. Whatever they enter
// (`foo`, `@foo`, `instagram.com/foo`, a full pasted profile URL, or one with a
// trailing slash or tracking query) reduces to the username first, so a mistyped
// URL still produces a correct link.
//
// OnlyFans and JustForFans are URL fields and are used EXACTLY as entered — on
// those platforms a profile URL is not always username-equivalent, so rebuilding
// one from a username would produce a broken link. See asUrl() below.
function username(value) {
  let s = (value ?? "").toString().trim();
  if (!s) return "";
  s = s.replace(/^@+/, "");
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (s.includes("/")) {                       // they pasted a URL after all
    const parts = s.split(/[?#]/)[0].split("/").filter(Boolean);
    s = parts[parts.length - 1] || "";
  }
  return s.split(/[?#]/)[0].replace(/^@+/, "").trim();
}
const profileUrl = (value, base) => {
  const u = username(value);
  return u ? base + u : "";
};

// Pass a typed URL through untouched, only supplying a protocol if it's missing
// (Notion URL properties can store `onlyfans.com/x` without one).
function asUrl(value) {
  const v = (value ?? "").toString().trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : "https://" + v.replace(/^\/+/, "");
}

// --- preflight: do the property names actually exist? ----------------------
async function preflight() {
  const db = await notion(`/databases/${DB_ID}`);
  const actual = Object.keys(db.properties || {});
  const title  = db.title?.map(t => t.plain_text).join("") || "(untitled)";
  console.log(`Database: "${title}"`);
  console.log(`Properties found: ${actual.length}\n`);

  const missing = [];
  for (const [slot, want] of Object.entries(PROP)) {
    const ok = actual.includes(want);
    if (!ok) missing.push([slot, want]);
    const type = ok ? db.properties[want].type : "";
    console.log(`  ${ok ? "OK  " : "MISS"}  ${slot.padEnd(12)} -> ${JSON.stringify(want).padEnd(16)} ${type}`);
  }

  if (missing.length) {
    console.log(`\nThese property names are not in the database:`);
    for (const [slot, want] of missing) console.log(`   ${slot}: ${JSON.stringify(want)}`);
    console.log(`\nActual property names:`);
    for (const a of actual) console.log(`   ${JSON.stringify(a)}  (${db.properties[a].type})`);
    console.log(`\nEdit the PROP map at the top of this script to match, then re-run.`);
  }

  // Show the Status options so BOOKED_STATUS can be set correctly.
  const st = db.properties?.[PROP.status];
  const choices = st?.select?.options || st?.status?.options;
  if (choices) {
    console.log(`\n${PROP.status} options: ${choices.map(c => JSON.stringify(c.name)).join(", ")}`);
    const hit = choices.some(c => c.name.toLowerCase() === BOOKED);
    console.log(hit
      ? `BOOKED_STATUS ${JSON.stringify(process.env.BOOKED_STATUS || "Booked")} matches one of them.`
      : `BOOKED_STATUS ${JSON.stringify(process.env.BOOKED_STATUS || "Booked")} matches NONE of them — set it in .env.`);
  }
  return missing.length === 0;
}

// --- fetch -----------------------------------------------------------------
async function fetchAll() {
  const pages = [];
  let cursor;
  do {
    const body = await notion(`/databases/${DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    pages.push(...body.results);
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);
  return pages;
}

// Shared by the roster and the invited grid: pull an image local so the
// deployed site never depends on an expiring Notion or Airtable URL.
async function saveImage(url, key) {
  if (!url) return "";
  await mkdir(IMG_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) { console.warn(`  ! headshot download failed (${res.status}) for ${key}`); return ""; }
  const type = res.headers.get("content-type") || "";
  const ext  = (type.split("/")[1] || "jpg").split(";")[0].replace("jpeg", "jpg");
  const path = `${IMG_DIR}/${key}.${ext}`;
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

async function downloadHeadshot(page) {
  const files = readProp(page.properties, PROP.headshot);
  const url = (Array.isArray(files) ? files[0] : files) || readProp(page.properties, PROP.headshotUrl) || "";
  return saveImage(url, page.id.replace(/-/g, ""));
}

// --- main ------------------------------------------------------------------
const clean = await preflight();
if (CHECK) { console.log("\n--check: nothing written."); process.exit(clean ? 0 : 1); }
if (!clean) { console.error("\nRefusing to build with unmatched property names. Fix PROP above."); process.exit(1); }

const pages = await fetchAll();
const statusOf = p => (readProp(p.properties, PROP.status) ?? "").toString().trim().toLowerCase();
const nameOf   = p => readProp(p.properties, PROP.name) || "";

// Status is the single switch: Booked shows in "Who's in the house",
// Invited and Interested feed the "Have a buddy?" pool, anything else is off
// the site entirely.
const booked  = pages.filter(p => statusOf(p) === BOOKED);
const pool    = pages.filter(p => ["invited", "interested"].includes(statusOf(p)));
console.log(`\n${pages.length} rows: ${booked.length} booked, ${pool.length} in the invited pool.`);

async function entry(page) {
  const f = page.properties;
  return {
    name:     nameOf(page),
    headshot: await downloadHeadshot(page),
    ig:  profileUrl(readProp(f, PROP.instagram), "https://instagram.com/"),
    x:   profileUrl(readProp(f, PROP.x),         "https://x.com/"),
    of:  asUrl(readProp(f, PROP.onlyfans)),
    jff: asUrl(readProp(f, PROP.justforfans)),
  };
}

// ---- roster.json: the booked house ----
const roster = [];
for (const page of booked) roster.push(await entry(page));
await writeFile(OUT_JSON, JSON.stringify(roster, null, 2));
console.log(`Wrote ${OUT_JSON} with ${roster.length} performers.`);
const noShot = roster.filter(r => !r.headshot).length;
if (noShot) console.log(`Note: ${noShot} have no headshot, so the site shows their initials in the gradient ring.`);

// ---- invited.json: the pool, ordered here so the front-end just renders ----
// Interested outranks the whole voted pool: they have raised their hand, which
// counts for more than a ballot score. Votes order the rest and are never
// published; name breaks ties so builds are deterministic.
const OUT_INVITED = "invited.json";
const rank = p => (statusOf(p) === "interested" ? 0 : 1);
const sorted = pool
  .map(p => ({ page: p, rank: rank(p), votes: Number(readProp(p.properties, PROP.votes)) || 0, name: nameOf(p) }))
  .sort((a, b) => a.rank - b.rank || b.votes - a.votes || a.name.localeCompare(b.name));

const invited = [];
for (const s of sorted) invited.push(await entry(s.page));
await writeFile(OUT_INVITED, JSON.stringify({ count: invited.length, invited }, null, 2));
const interested = sorted.filter(s => s.rank === 0).length;
console.log(`Wrote ${OUT_INVITED}: ${invited.length} in the pool (${interested} interested pinned to the top).`);
