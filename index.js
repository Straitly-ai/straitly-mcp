#!/usr/bin/env node
// Straitly MCP server (stdio JSON-RPC 2.0, zero external dependencies).
// Exposes live model catalog lookup, maker vs Straitly prices, model comparison, and chat completions
// via https://api.straitly.ai/v1.

import readline from "node:readline";

process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

const VERSION = "0.2.0";
const BASE_URL = process.env.STRAITLY_BASE_URL || "https://api.straitly.ai/v1";
const SITE_URL = (process.env.STRAITLY_SITE_URL || "https://straitly.ai").replace(/\/+$/, "");
const CATALOG_URL = `${SITE_URL}/api/catalog`;
const VALUE_INDEX_URL = `${SITE_URL}/llm-value-index.json`;
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
// Public links in tool output always point at the real site, even when tests read a local mock.
const PUBLIC_SITE = "https://straitly.ai";
const SERVER_INFO = { name: "straitly-mcp", version: VERSION };
const PROTOCOL_VERSION = "2024-11-05";
const UA = { "User-Agent": `straitly-mcp/${VERSION}` };

// Models whose Straitly rate is not published anywhere (mirrors straitly.ai's held list). For these the
// tools return the maker's price and a link to the model page, never a Straitly figure.
const HELD_IDS = new Set(["gemini-4-neon"]);

const slugOf = (id) => String(id || "").slice(String(id || "").lastIndexOf("/") + 1).toLowerCase();
const isHeld = (m) => HELD_IDS.has(slugOf(m?.id)) || HELD_IDS.has(slugOf(m?.key));
const modelUrl = (m) => `${PUBLIC_SITE}/models/${m.id}`;

const TOOLS = [
  {
    name: "list_models",
    description: "Search Straitly's live catalog of 100+ LLM models by name, lab, or ID. Returns context length and per-million-token pricing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional filter matched against model ID, name, or lab (e.g. claude, gpt, gemini, deepseek)." },
        limit: { type: "integer", description: "Max models to return (default 20, max 100).", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_model",
    description: "Get full live metadata, pricing, and links for one Straitly model ID or slug.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model ID or slug (e.g. anthropic/claude-sonnet-5-5 or claude-sonnet-5-5)." },
      },
      required: ["model"],
    },
  },
  {
    name: "model_prices",
    description: "Free, no API key. Maker list price and Straitly price per 1M tokens for one or more models, read live from the Straitly catalog. Some models show only the maker price plus a link to their Straitly page.",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          description: "Model IDs, slugs, or names (e.g. claude-opus-5-5, gpt-6-astra, deepseek). Each entry may match several models.",
          maxItems: 20,
        },
        query: { type: "string", description: "Alternative to models: filter by ID, name, or lab (e.g. anthropic, gemini)." },
        limit: { type: "integer", description: "Max rows to return (default 20, max 100).", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "compare_models",
    description: "Free, no API key. Compare 2 to 5 models side by side: live maker and Straitly prices, benchmark rows from Straitly's LLM value index when published, and links to Straitly's head-to-head comparison pages.",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
          description: "Model IDs or slugs to compare (e.g. [\"claude-opus-5-5\", \"gpt-6-astra\"]).",
        },
      },
      required: ["models"],
    },
  },
  {
    name: "chat_completion",
    description: "Run a chat completion through Straitly (requires STRAITLY_API_KEY env var).",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Straitly model key (e.g. deepseek/deepseek-v4-1-flash)." },
        prompt: { type: "string", description: "User prompt." },
        system: { type: "string", description: "Optional system prompt." },
        max_tokens: { type: "integer", description: "Optional max output tokens." },
      },
      required: ["model", "prompt"],
    },
  },
];

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL, { headers: UA });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  const data = await res.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  return { models: models.filter((m) => m && m.id), generatedAt: data?.meta?.generatedAt ?? null };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The maker's own list price: the catalog's list field, else its official direct price.
function makerPrice(m) {
  if (m.list && (num(m.list.input) !== null || num(m.list.output) !== null)) {
    return { input: num(m.list.input), output: num(m.list.output), source: "maker list price (Straitly catalog)" };
  }
  const d = m.direct;
  if (d?.basis === "official" && d.price && (num(d.price.input) !== null || num(d.price.output) !== null)) {
    return {
      input: num(d.price.input),
      output: num(d.price.output),
      cache_read: num(d.price.cacheRead),
      source: `${d.provider || "maker"} official price (Straitly catalog)`,
    };
  }
  return null;
}

function straitlyPrice(m) {
  if (isHeld(m) || !m.price) return null;
  return { input: num(m.price.input), output: num(m.price.output), cache_read: num(m.price.cacheRead) };
}

function formatModel(m) {
  const held = isHeld(m);
  const maker = makerPrice(m);
  return {
    key: m.key,
    id: m.id,
    name: m.name,
    author: m.author?.label || m.author?.slug || null,
    context: m.context ?? null,
    released: m.released ?? null,
    price_per_1m_usd: held ? null : m.price ? { input: num(m.price.input), output: num(m.price.output) } : null,
    list_per_1m_usd: maker ? { input: maker.input, output: maker.output } : null,
    ...(held ? { straitly_price: `See ${modelUrl(m)}` } : {}),
    url: modelUrl(m),
  };
}

function priceRow(m) {
  const held = isHeld(m);
  const maker = makerPrice(m);
  const row = {
    id: m.id,
    key: m.key,
    name: m.name,
    lab: m.author?.label || m.author?.slug || null,
    maker_price_per_1m_usd: maker ? { input: maker.input, output: maker.output, ...(maker.cache_read != null ? { cache_read: maker.cache_read } : {}) } : null,
    maker_price_source: maker ? maker.source : "No maker list price in the Straitly catalog for this model",
    straitly_price_per_1m_usd: straitlyPrice(m),
    url: modelUrl(m),
  };
  if (held) row.straitly_price = `See ${modelUrl(m)}`;
  return row;
}

const lc = (v) => String(v || "").toLowerCase();

// Exact ID, key, or slug match first; otherwise a substring match on ID, key, name, or lab.
function findModels(models, needle) {
  const n = lc(needle).trim();
  if (!n) return [];
  const exact = models.filter((m) => lc(m.id) === n || lc(m.key) === n || slugOf(m.id) === n || slugOf(m.key) === n);
  if (exact.length) return exact;
  return models.filter((m) =>
    [m.key, m.id, m.name, m.author?.label, m.author?.slug].filter(Boolean).some((v) => lc(v).includes(n)));
}

// Family name used in /compare/<a>-vs-<b> slugs: the ID's words without version tokens
// (claude-opus-5-5 -> claude-opus, gpt-6.2-astra -> gpt-astra, deepseek-v4-1-flash-1017 -> deepseek-flash).
function familySlug(m) {
  return slugOf(m.id)
    .split("-")
    .filter((t) => t && !/\d/.test(t))
    .join("-");
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: UA });
    return { status: res.status, text: res.ok ? await res.text() : null };
  } catch (err) {
    return { status: 0, text: null, error: err?.message || String(err) };
  }
}

async function comparePages(families) {
  const { text } = await fetchText(SITEMAP_URL);
  if (!text) return [];
  const urls = [...new Set(text.match(/https?:\/\/[^<\s]*\/compare\/[^<\s]+-vs-[^<\s]+/g) || [])];
  const want = new Set(families.filter(Boolean));
  const out = [];
  for (const u of urls) {
    const slug = u.slice(u.lastIndexOf("/compare/") + 9).replace(/\/$/, "");
    const [a, b] = slug.split("-vs-");
    if (a && b && a !== b && want.has(a) && want.has(b)) {
      out.push({ pair: [a, b], url: `${PUBLIC_SITE}/compare/${slug}` });
    }
  }
  return out;
}

// Rows from /llm-value-index.json for the requested models, or null when it is not published.
async function valueIndexRows(models) {
  const { status, text } = await fetchText(VALUE_INDEX_URL);
  if (!text) return { status, rows: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { status, rows: null };
  }
  const list = Array.isArray(data) ? data : data?.models || data?.rows || data?.data || [];
  if (!Array.isArray(list)) return { status, rows: null };
  const rows = [];
  for (const m of models) {
    const ids = new Set([lc(m.id), lc(m.key), slugOf(m.id)]);
    const hit = list.find((r) => r && [r.id, r.key, r.model, r.slug, r.model_id].some((v) => v && (ids.has(lc(v)) || ids.has(slugOf(v)))));
    if (!hit) continue;
    const row = { ...hit };
    // A held model's row keeps only its benchmark facts: anything priced or per-dollar is dropped.
    if (isHeld(m)) {
      for (const k of Object.keys(row)) {
        if (/straitly|price|cost|usd|dollar|value|per_\$|rate/i.test(k)) delete row[k];
      }
      row.straitly_price = `See ${modelUrl(m)}`;
    }
    rows.push(row);
  }
  return { status, rows, meta: Array.isArray(data) ? null : { updated: data?.updated || data?.updatedAt || data?.generatedAt || null, source: data?.source || null } };
}

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

function clampLimit(v) {
  return Math.min(Math.max(Number(v) || 20, 1), 100);
}

function dedupe(models) {
  const seen = new Set();
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

async function handleToolCall(name, args = {}) {
  if (name === "list_models") {
    const { models } = await fetchCatalog();
    const q = String(args.query || "").trim().toLowerCase();
    const limit = clampLimit(args.limit);
    const filtered = q
      ? models.filter((m) =>
          [m.key, m.id, m.name, m.author?.label, m.author?.slug]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)))
      : models;
    return {
      content: [{ type: "text", text: JSON.stringify({ total_matched: filtered.length, models: filtered.slice(0, limit).map(formatModel) }, null, 2) }],
    };
  }

  if (name === "get_model") {
    const needle = String(args.model || "").trim().toLowerCase();
    const { models } = await fetchCatalog();
    const found = models.find((m) => lc(m.key) === needle || lc(m.id) === needle || slugOf(m.id) === needle);
    if (!found) {
      return { isError: true, content: [{ type: "text", text: `Model not found: ${args.model}. Browse ${PUBLIC_SITE}/models` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(formatModel(found), null, 2) }] };
  }

  if (name === "model_prices") {
    const { models, generatedAt } = await fetchCatalog();
    const limit = clampLimit(args.limit);
    const wanted = Array.isArray(args.models) ? args.models.map(String).filter((s) => s.trim()).slice(0, 20) : [];
    let matched;
    const notFound = [];
    if (wanted.length) {
      matched = [];
      for (const w of wanted) {
        const hits = findModels(models, w);
        if (hits.length) matched.push(...hits);
        else notFound.push(w);
      }
    } else if (String(args.query || "").trim()) {
      matched = findModels(models, args.query);
    } else {
      matched = [...models].sort((a, b) => lc(b.released).localeCompare(lc(a.released)));
    }
    matched = dedupe(matched);
    return json({
      source: `${PUBLIC_SITE}/api/catalog`,
      catalog_generated_at: generatedAt,
      unit: "USD per 1M tokens",
      total_matched: matched.length,
      models: matched.slice(0, limit).map(priceRow),
      ...(notFound.length ? { not_found: notFound, browse: `${PUBLIC_SITE}/models` } : {}),
    });
  }

  if (name === "compare_models") {
    const wanted = Array.isArray(args.models) ? args.models.map(String).filter((s) => s.trim()) : [];
    if (wanted.length < 2 || wanted.length > 5) {
      return { isError: true, content: [{ type: "text", text: "compare_models needs 2 to 5 model IDs in `models`." }] };
    }
    const { models, generatedAt } = await fetchCatalog();
    const resolved = [];
    const notFound = [];
    for (const w of wanted) {
      const hits = findModels(models, w);
      if (!hits.length) {
        notFound.push(w);
        continue;
      }
      // Prefer the newest match when a name is ambiguous ("opus" -> newest Opus).
      resolved.push([...hits].sort((a, b) => lc(b.released).localeCompare(lc(a.released)))[0]);
    }
    const picked = dedupe(resolved);
    if (picked.length < 2) {
      return { isError: true, content: [{ type: "text", text: `Need at least 2 known models. Not found: ${notFound.join(", ") || "(duplicates)"}. Browse ${PUBLIC_SITE}/models` }] };
    }
    const [vi, pages] = await Promise.all([valueIndexRows(picked), comparePages(picked.map(familySlug))]);
    return json({
      prices: {
        source: `${PUBLIC_SITE}/api/catalog`,
        catalog_generated_at: generatedAt,
        unit: "USD per 1M tokens",
        models: picked.map(priceRow),
      },
      benchmarks: vi.rows
        ? { source: `${PUBLIC_SITE}/llm-value-index`, data: `${PUBLIC_SITE}/llm-value-index.json`, ...(vi.meta || {}), rows: vi.rows }
        : { available: false, note: "Benchmark index not published yet; see the comparison pages below." },
      comparison_pages: pages,
      all_comparisons: `${PUBLIC_SITE}/compare`,
      ...(notFound.length ? { not_found: notFound } : {}),
    });
  }

  if (name === "chat_completion") {
    const apiKey = process.env.STRAITLY_API_KEY;
    if (!apiKey) {
      return { isError: true, content: [{ type: "text", text: `STRAITLY_API_KEY is not set. Create a key at ${PUBLIC_SITE}` }] };
    }
    const messages = [];
    if (args.system) messages.push({ role: "system", content: String(args.system) });
    messages.push({ role: "user", content: String(args.prompt || "") });
    const body = { model: String(args.model), messages };
    if (args.max_tokens) body.max_tokens = Number(args.max_tokens);
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { isError: true, content: [{ type: "text", text: `Straitly API HTTP ${res.status}: ${text.slice(0, 500)}` }] };
    }
    const json = JSON.parse(text);
    const reply = json?.choices?.[0]?.message?.content ?? text;
    return { content: [{ type: "text", text: String(reply) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || id === undefined) return;
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const result = await handleToolCall(params?.name, params?.arguments);
      return send({ jsonrpc: "2.0", id, result });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || String(err) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  pending += 1;
  let p;
  try {
    p = Promise.resolve(handleMessage(JSON.parse(line)));
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    p = Promise.resolve();
  }
  p.finally(() => {
    pending -= 1;
    maybeExit();
  });
});

rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
