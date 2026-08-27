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
  followers:   "Followers",
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

// A social value may be a full URL or a bare handle — normalise either to a URL.
function socialUrl(value, base) {
  const v = (value ?? "").toString().trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return base + v.replace(/^@/, "").replace(/^\/+/, "");
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

async function downloadHeadshot(page) {
  const files = readProp(page.properties, PROP.headshot);
  const url = Array.isArray(files) ? files[0] : files;
  if (!url) return "";
  await mkdir(IMG_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) { console.warn(`  ! headshot download failed (${res.status}) for ${page.id}`); return ""; }
  const type = res.headers.get("content-type") || "";
  const ext  = (type.split("/")[1] || "jpg").split(";")[0].replace("jpeg", "jpg");
  const path = `${IMG_DIR}/${page.id.replace(/-/g, "")}.${ext}`;
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

// --- main ------------------------------------------------------------------
const clean = await preflight();
if (CHECK) { console.log("\n--check: nothing written."); process.exit(clean ? 0 : 1); }
if (!clean) { console.error("\nRefusing to build with unmatched property names. Fix PROP above."); process.exit(1); }

const pages = await fetchAll();
const booked = pages.filter(p => {
  const s = (readProp(p.properties, PROP.status) ?? "").toString().toLowerCase();
  return s === BOOKED;
});
console.log(`\n${pages.length} rows in the database, ${booked.length} with status "${process.env.BOOKED_STATUS || "Booked"}".`);

const roster = [];
for (const page of booked) {
  const f = page.properties;
  const followers = readProp(f, PROP.followers);
  roster.push({
    name:      readProp(f, PROP.name) || "",
    followers: followers ? `${followers}`.replace(/\s*followers$/i, "") + " followers" : "",
    headshot:  await downloadHeadshot(page),
    ig:  socialUrl(readProp(f, PROP.instagram),   "https://instagram.com/"),
    x:   socialUrl(readProp(f, PROP.x),           "https://x.com/"),
    of:  socialUrl(readProp(f, PROP.onlyfans),    "https://onlyfans.com/"),
    jff: socialUrl(readProp(f, PROP.justforfans), "https://justfor.fans/"),
  });
}

await writeFile(OUT_JSON, JSON.stringify(roster, null, 2));
console.log(`Wrote ${OUT_JSON} with ${roster.length} performers.`);
const noShot = roster.filter(r => !r.headshot).length;
if (noShot) console.log(`Note: ${noShot} have no headshot — the site will show an empty ring for them.`);
