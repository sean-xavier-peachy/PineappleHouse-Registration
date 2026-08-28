/**
 * build-content.mjs — turns the Notion guide page into content.json.
 *
 * Notion is the source of truth for copy: admins edit the page, re-run this,
 * and the site updates. Structure contract (see BUILD-NOTES):
 *   H2       -> a site section, numbered by document order
 *   H3       -> a card within that section
 *   bullet   -> a line in the current card
 *   toggle   -> progressive disclosure: title is the visible line,
 *               children become the expandable detail
 *   callout  -> highlighted note
 *   table    -> the room/price grid
 * Images are skipped — the site's photography is curated separately.
 *
 * Run: node build-content.mjs   (needs NOTION_TOKEN + NOTION_PAGE_ID in .env)
 */
import { writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";

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

const TOKEN = process.env.NOTION_TOKEN;
const PAGE  = process.env.NOTION_PAGE_ID || "3c9bc34c2ab28117980dcba94f79a6a5";
if (!TOKEN) { console.error("Set NOTION_TOKEN in .env"); process.exit(1); }
const H = { Authorization:`Bearer ${TOKEN}`, "Notion-Version":"2022-06-28", "Content-Type":"application/json" };

const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// Notion rich text -> a small, safe HTML string (links and bold survive).
function rich(a){
  return (a||[]).map(t=>{
    let x = esc(t.plain_text);
    if (t.annotations?.code) x = `<code>${x}</code>`;
    if (t.annotations?.bold) x = `<strong>${x}</strong>`;
    if (t.annotations?.italic) x = `<em>${x}</em>`;
    const href = t.href || t.text?.link?.url;
    if (href) x = `<a href="${esc(href)}" target="_blank" rel="noopener">${x}</a>`;
    return x;
  }).join("");
}
const plain = a => (a||[]).map(t=>t.plain_text).join("");

async function children(id){
  let out=[], cur;
  do{
    const u=new URL(`https://api.notion.com/v1/blocks/${id}/children`);
    u.searchParams.set("page_size","100"); if(cur)u.searchParams.set("start_cursor",cur);
    const r=await fetch(u,{headers:H});
    if(!r.ok) throw new Error(`Notion ${r.status}: ${(await r.json()).message}`);
    const d=await r.json(); out.push(...d.results); cur=d.has_more?d.next_cursor:null;
  }while(cur);
  return out;
}
// Split a leading emoji off a heading so the site can show it separately.
const splitEmoji = s => {
  const m = s.match(/^\s*([\p{Extended_Pictographic}‍️]+)\s*(.*)$/u);
  return m ? { emoji:m[1], title:m[2].trim() } : { emoji:"", title:s.trim() };
};

const top = await children(PAGE);
const doc = { intro:[], highlights:[], sections:[] };
let section=null, group=null;

async function detailOf(b){
  const kids = b.has_children ? await children(b.id) : [];
  return kids.filter(k=>["paragraph","bulleted_list_item","numbered_list_item"].includes(k.type))
             .map(k=>rich(k[k.type].rich_text)).filter(Boolean);
}
function pushItem(it){
  if(!section) return;
  if(!group){ group={title:"",emoji:"",items:[]}; section.groups.push(group); }
  group.items.push(it);
}

for (const b of top){
  const t=b.type, v=b[t]||{};
  if (t==="image" || t==="divider" || t==="column_list") continue;

  if (t==="callout"){
    const text = rich(v.rich_text);
    // A callout before the first H2 is a page-level highlight (the Pineapple
    // band). Inside a section it stays a highlighted note.
    if (!section){
      doc.highlights.push({ emoji: v.icon?.emoji||"", html:text, detail: await detailOf(b) });
      continue;
    }
    section.callouts.push({ emoji: v.icon?.emoji||"", html:text });
    continue;
  }
  if (t==="heading_2"){
    const {emoji,title}=splitEmoji(plain(v.rich_text));
    section={ emoji, title, intro:[], groups:[], callouts:[], table:null };
    doc.sections.push(section); group=null; continue;
  }
  if (t==="heading_3"){
    const {emoji,title}=splitEmoji(plain(v.rich_text));
    group={ emoji, title, items:[] }; section?.groups.push(group); continue;
  }
  if (t==="paragraph"){
    const html=rich(v.rich_text); if(!html) continue;
    if(!section) doc.intro.push(html);
    else if(!group) section.intro.push(html);
    else pushItem({type:"note",html});
    continue;
  }
  if (t==="bulleted_list_item" || t==="numbered_list_item"){
    pushItem({type:"line",html:rich(v.rich_text)}); continue;
  }
  if (t==="toggle"){
    pushItem({type:"toggle",html:rich(v.rich_text),detail:await detailOf(b)}); continue;
  }
  if (t==="table"){
    const rows=(await children(b.id)).filter(r=>r.type==="table_row")
      .map(r=>r.table_row.cells.map(c=>plain(c)));
    if(section) section.table={ header:rows[0]||[], rows:rows.slice(1) };
    continue;
  }
}

// Room table -> the site's tier cards, collapsing rooms that share a price.
const rooms = doc.sections.find(s=>s.table)?.table;
if (rooms){
  const byPrice=new Map();
  for(const [room,bed,sleeps,price] of rooms.rows){
    const k=`${price}|${bed}|${sleeps}`;
    if(!byPrice.has(k)) byPrice.set(k,{rooms:[],bed,sleeps,price});
    byPrice.get(k).rooms.push(room);
  }
  doc.tiers=[...byPrice.values()].map(t=>{
    const n=t.rooms.map(r=>r.replace(/^Bedroom\s*/,""));
    const label = n.length===1 ? `Bedroom ${n[0]}` : `Bedrooms ${n[0]}–${n[n.length-1]}`;
    // beds in the tier = rooms x sleeps, so the table stays the source of truth
    const capacity = t.rooms.length * (parseInt(t.sleeps, 10) || 0);
    return { label, price:t.price, capacity,
             bed:`${t.bed} · sleeps ${t.sleeps}${t.rooms.length>1?" each":""}` };
  });
}

await writeFile("content.json", JSON.stringify(doc,null,2));
const n=s=>s.groups.reduce((a,g)=>a+g.items.length,0);
console.log(`Wrote content.json`);
console.log(`  intro: ${doc.intro.length} paras · highlights: ${doc.highlights.length} · tiers: ${doc.tiers?.length||0}`);
for(const s of doc.sections) console.log(`  ${s.emoji} ${s.title.padEnd(34)} ${s.groups.length} groups, ${n(s)} items, ${s.callouts.length} callouts`);
