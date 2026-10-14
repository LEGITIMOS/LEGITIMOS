// build-feed.mjs
// Gera o feed.json do LEGITIMOS PRO a partir dos sites cadastrados no index.html.
//
// Como funciona:
//  1. Lê o catálogo direto do index.html (sites e repositórios). Site novo no catálogo = entra no feed.
//  2. Para cada site, procura um feed: o que estiver em feed-sources.json, a página de releases
//     (se for repositório do GitHub) ou o feed anunciado na página inicial do site.
//  3. Junta as novidades mais recentes em feed.json, que o app lê.
//
// Uso: node build-feed.mjs [index.html] [feed.json]

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const INDEX = process.argv[2] || "index.html";
const OUT = process.argv[3] || "feed.json";
const OVERRIDES = process.argv[4] || "feed-sources.json";
const PROMOS = process.argv[5] || "promos.json";

const UA = "LegitimosFeedBot/1.0";
const TIMEOUT_MS = 9000;
const MAX_PER_SOURCE = 3;
const MAX_AGE_DAYS = 180;
const MAX_ITEMS = 120;
const OG_LIMIT = 30;
const CONCURRENCY = 6;

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? "" : String(x));
const strip = (h) =>
  txt(h)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const httpUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const resolve = (u, base) => {
  try {
    return httpUrl(new URL(u, base).href);
  } catch {
    return "";
  }
};

async function get(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: accept || "*/*" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return { text: await r.text(), url: r.url };
  } finally {
    clearTimeout(timer);
  }
}

async function pool(list, worker, size = CONCURRENCY) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, list.length) }, async () => {
      while (i < list.length) {
        const k = i++;
        out[k] = await worker(list[k], k);
      }
    })
  );
  return out;
}

// ---------- catálogo ----------
async function readCatalogue() {
  const html = await readFile(INDEX, "utf8");
  const re = /\{\s*id:\s*"([^"]+)"(?:,\s*repo:\s*true)?,\s*name:\s*"([^"]+)",\s*url:\s*"([^"]+)"/g;
  const seen = new Set();
  const list = [];
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    list.push({ id: m[1], name: m[2], url: m[3] });
  }
  return list;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------- leitura de feeds (sem dependências) ----------
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// Conteúdo de <tag>...</tag> dentro de um bloco (aceita CDATA).
function inner(block, tag) {
  const m = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i").exec(block);
  if (!m) return "";
  const v = m[1].trim();
  const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return c ? c[1] : decode(v);
}

function attr(tag, name) {
  const m = new RegExp("\\b" + name + "=[\"']([^\"']*)[\"']", "i").exec(tag);
  return m ? decode(m[1]) : "";
}

function mediaImage(block, html, base) {
  for (const t of block.match(/<media:content\b[^>]*>/gi) || []) {
    const u = attr(t, "url");
    const isImg = attr(t, "medium") === "image" || /^image\//.test(attr(t, "type")) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);
    if (u && isImg) return resolve(u, base);
  }
  for (const t of block.match(/<media:thumbnail\b[^>]*>/gi) || []) {
    const u = attr(t, "url");
    if (u) return resolve(u, base);
  }
  for (const t of block.match(/<enclosure\b[^>]*>/gi) || []) {
    if (/^image\//.test(attr(t, "type")) && attr(t, "url")) return resolve(attr(t, "url"), base);
  }
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || "");
  return m ? resolve(decode(m[1]), base) : "";
}

function atomLink(block) {
  const tags = block.match(/<link\b[^>]*>/gi) || [];
  const alt = tags.find((t) => !attr(t, "rel") || attr(t, "rel") === "alternate") || tags[0];
  return alt ? attr(alt, "href") : "";
}

function parseFeed(xml, base) {
  const out = [];
  if (/<entry\b/i.test(xml)) {
    for (const b of xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []) {
      const html = inner(b, "content") || inner(b, "summary");
      out.push({
        title: strip(inner(b, "title")),
        link: resolve(atomLink(b), base),
        date: inner(b, "published") || inner(b, "updated"),
        html,
        image: mediaImage(b, html, base),
      });
    }
  } else {
    for (const b of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
      const html = inner(b, "content:encoded") || inner(b, "description");
      out.push({
        title: strip(inner(b, "title")),
        link: resolve(inner(b, "link") || inner(b, "guid"), base),
        date: inner(b, "pubDate") || inner(b, "dc:date") || inner(b, "updated"),
        html,
        image: mediaImage(b, html, base),
      });
    }
  }
  return out.filter((i) => i.title && i.link);
}

function discover(html, base) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const h = /href=["']([^"']+)["']/i.exec(tag);
    if (h) {
      const u = resolve(h[1], base);
      if (u) out.push(u);
    }
  }
  return out;
}

async function itemsFor(src, overrides) {
  const o = overrides[src.id] || {};
  if (o.skip) return { items: [], note: "ignorado" };

  const candidates = [...arr(o.feed)];
  const gh = src.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/i);
  let ghImage = "";
  if (gh) {
    candidates.push(`https://github.com/${gh[1]}/${gh[2]}/releases.atom`, `https://github.com/${gh[1]}/${gh[2]}/tags.atom`);
    ghImage = `https://opengraph.githubassets.com/1/${gh[1]}/${gh[2]}`;
  } else if (!candidates.length) {
    try {
      const page = await get(src.url, "text/html");
      candidates.push(...discover(page.text, page.url));
    } catch {}
    try {
      const origin = new URL(src.url).origin;
      candidates.push(...["/feed", "/rss", "/feed.xml", "/rss.xml", "/blog/feed", "/blog/rss.xml"].map((p) => origin + p));
    } catch {}
  }

  for (const c of [...new Set(candidates)]) {
    try {
      const r = await get(c, "application/rss+xml, application/atom+xml, application/xml, text/xml");
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(r.text.slice(0, 3000))) continue;
      const items = parseFeed(r.text, r.url);
      if (items.length) return { items, feed: c, ghName: !!gh, ghImage };
    } catch {}
  }
  return { items: [], note: "sem feed" };
}

async function ogImage(url) {
  try {
    const r = await get(url, "text/html");
    const head = r.text.slice(0, 120000);
    const m =
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(head) ||
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(head) ||
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i.exec(head);
    return m ? resolve(m[1].replace(/&amp;/g, "&"), r.url) : "";
  } catch {
    return "";
  }
}

// ---------- principal ----------
const catalogue = await readCatalogue();
const overrides = await readJson(OVERRIDES, {});
const promos = await readJson(PROMOS, []);
const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
const report = {};

const perSource = await pool(catalogue, async (src) => {
  const r = await itemsFor(src, overrides);
  report[src.id] = r.items.length ? { feed: r.feed, itens: r.items.length } : { aviso: r.note || "sem itens" };
  const mapped = r.items
    .map((i) => {
      const t = Date.parse(i.date);
      return { ...i, t: Number.isNaN(t) ? 0 : t };
    })
    .filter((i) => i.t === 0 || i.t >= cutoff)
    .sort((a, b) => b.t - a.t)
    .slice(0, MAX_PER_SOURCE)
    .map((i) => ({
      id: createHash("sha1").update(i.link).digest("hex").slice(0, 12),
      sourceId: src.id,
      sourceName: src.name,
      title: clip(r.ghName ? `${src.name} · ${i.title}` : i.title, 200),
      summary: clip(strip(i.html), 240),
      url: i.link,
      image: i.image || r.ghImage || "",
      date: i.t ? new Date(i.t).toISOString() : null,
    }));
  return mapped;
});

let items = perSource.flat().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, MAX_ITEMS);

const needImg = items.filter((i) => !i.image).slice(0, OG_LIMIT);
await pool(needImg, async (i) => {
  i.image = await ogImage(i.url);
});

const sponsored = arr(promos)
  .filter((p) => p && p.title && httpUrl(p.url))
  .map((p, k) => ({
    id: p.id || "promo-" + k,
    sourceId: p.sourceId || "",
    sourceName: p.sourceName || "Patrocinado",
    title: clip(String(p.title), 200),
    summary: clip(String(p.summary || ""), 240),
    url: p.url,
    image: httpUrl(p.image),
    date: p.date || null,
    sponsored: true,
  }));

const all = [...items, ...sponsored];
const previous = await readJson(OUT, null);
if (previous && JSON.stringify(previous.items) === JSON.stringify(all)) {
  console.log(`Sem mudanças (${all.length} itens). feed.json mantido.`);
} else {
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items: all, report }, null, 1) + "\n");
  console.log(`feed.json gravado com ${all.length} itens.`);
}
for (const [id, r] of Object.entries(report)) console.log(` - ${id}: ${r.itens ? r.itens + " itens" : r.aviso}`);
