// Runs the server over stdio against a local mock of straitly.ai. Figures here are made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));

// The held model's Straitly figures: they must never appear in any tool output.
const HELD_IN = 9.87;
const HELD_OUT = 65.43;

const catalog = {
  meta: { generatedAt: "2026-01-01T00:00:00.000Z" },
  models: [
    {
      key: "anthropic/claude-opus-9", id: "claude-opus-9", name: "Claude Opus 9", released: "2026-01-02",
      author: { label: "Anthropic" }, context: 1000000,
      price: { input: 3, output: 15, cacheRead: 0.3 }, list: null,
      direct: { provider: "Anthropic", basis: "official", price: { input: 5, output: 25, cacheRead: 0.5 } },
    },
    {
      key: "openai/gpt-9-astra", id: "gpt-9-astra", name: "GPT-9 Astra", released: "2026-01-01",
      author: { label: "OpenAI" }, context: 400000,
      price: { input: 6, output: 30 }, list: { input: 10, output: 50 }, direct: null,
    },
    {
      key: "google/gemini-4-neon", id: "gemini-4-neon", name: "Gemini 4 Neon", released: "2026-01-03",
      author: { label: "Google" }, context: 1048576,
      price: { input: HELD_IN, output: HELD_OUT, cacheRead: 1.11 }, list: null, discountPct: 15,
      direct: { provider: "Google", basis: "official", price: { input: 20, output: 80 } },
    },
    {
      key: "lab/no-list-1", id: "no-list-1", name: "No List 1", released: null,
      author: { label: "Lab" }, price: { input: 1, output: 2 }, list: null, direct: null,
    },
  ],
};

const sitemap = `<?xml version="1.0"?><urlset>
<url><loc>https://straitly.ai/compare/gemini-neon-vs-claude-opus</loc></url>
<url><loc>https://straitly.ai/compare/gpt-astra-vs-claude-opus</loc></url>
<url><loc>https://straitly.ai/compare/grok-vs-claude-sonnet</loc></url>
</urlset>`;

let valueIndex = null; // null -> 404
let server;
let site;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/catalog") return res.end(JSON.stringify(catalog));
    if (req.url === "/sitemap.xml") return res.end(sitemap);
    if (req.url === "/llm-value-index.json" && valueIndex) return res.end(JSON.stringify(valueIndex));
    res.statusCode = 404;
    res.end("<html>not found</html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  site = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Sends each request on one server process and returns the responses by id.
function rpc(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, STRAITLY_SITE_URL: site, STRAITLY_API_KEY: "", ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => {
      const byId = {};
      for (const line of out.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        byId[msg.id] = msg;
      }
      resolve({ byId, raw: out });
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
    child.stdin.end();
  });
}

const call = (id, name, args) => ({ id, method: "tools/call", params: { name, arguments: args } });
const body = (msg) => JSON.parse(msg.result.content[0].text);

function assertNoHeldFigure(raw) {
  for (const f of [HELD_IN, HELD_OUT, 1.11]) {
    assert.ok(!raw.includes(String(f)), `held figure ${f} leaked`);
  }
}

test("initialize and tools/list expose five tools at 0.2.0", async () => {
  const { byId } = await rpc([{ id: 1, method: "initialize", params: {} }, { id: 2, method: "tools/list" }]);
  assert.equal(byId[1].result.serverInfo.version, "0.2.0");
  const names = byId[2].result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_models", "get_model", "model_prices", "compare_models", "chat_completion"]);
});

test("model_prices returns maker and Straitly prices, with fallbacks", async () => {
  const { byId, raw } = await rpc([call(1, "model_prices", { models: ["claude-opus-9", "gpt-9-astra", "no-list-1", "nope-x"] })]);
  const b = body(byId[1]);
  assert.equal(b.catalog_generated_at, "2026-01-01T00:00:00.000Z");
  const [opus, astra, nolist] = b.models;
  assert.deepEqual(opus.maker_price_per_1m_usd, { input: 5, output: 25, cache_read: 0.5 });
  assert.match(opus.maker_price_source, /Anthropic official/);
  assert.deepEqual(opus.straitly_price_per_1m_usd, { input: 3, output: 15, cache_read: 0.3 });
  assert.deepEqual(astra.maker_price_per_1m_usd, { input: 10, output: 50 });
  assert.equal(nolist.maker_price_per_1m_usd, null);
  assert.match(nolist.maker_price_source, /No maker list price/);
  assert.deepEqual(b.not_found, ["nope-x"]);
  assert.equal(opus.url, "https://straitly.ai/models/claude-opus-9");
  assertNoHeldFigure(raw);
});

test("held model: maker price and a link, never a Straitly figure", async () => {
  const { byId, raw } = await rpc([
    call(1, "model_prices", { models: ["gemini-4-neon"] }),
    call(2, "model_prices", {}),
    call(3, "get_model", { model: "google/gemini-4-neon" }),
    call(4, "list_models", { query: "gemini" }),
  ]);
  const neon = body(byId[1]).models[0];
  assert.equal(neon.straitly_price_per_1m_usd, null);
  assert.equal(neon.straitly_price, "See https://straitly.ai/models/gemini-4-neon");
  assert.deepEqual(neon.maker_price_per_1m_usd, { input: 20, output: 80 });
  assert.equal(body(byId[3]).price_per_1m_usd, null);
  assert.equal(body(byId[4]).models[0].price_per_1m_usd, null);
  assert.ok(!raw.includes("discount"));
  assertNoHeldFigure(raw);
});

test("compare_models without a value index links the vs pages", async () => {
  valueIndex = null;
  const { byId, raw } = await rpc([call(1, "compare_models", { models: ["claude-opus-9", "gpt-9-astra", "gemini-4-neon"] })]);
  const b = body(byId[1]);
  assert.equal(b.benchmarks.available, false);
  assert.deepEqual(b.comparison_pages.map((p) => p.url).sort(), [
    "https://straitly.ai/compare/gemini-neon-vs-claude-opus",
    "https://straitly.ai/compare/gpt-astra-vs-claude-opus",
  ]);
  assert.equal(b.prices.models.length, 3);
  assertNoHeldFigure(raw);
});

test("compare_models reads value index rows and strips priced fields for held models", async () => {
  valueIndex = {
    updated: "2026-01-01",
    models: [
      { id: "claude-opus-9", terminal_bench: 70.1, straitly_value_per_dollar: 4.2 },
      { id: "gemini-4-neon", terminal_bench: 66.6, straitly_price_blend: HELD_IN, value_per_dollar_straitly: 3.3 },
    ],
  };
  const { byId, raw } = await rpc([call(1, "compare_models", { models: ["opus", "neon"] })]);
  valueIndex = null;
  const b = body(byId[1]);
  assert.equal(b.benchmarks.updated, "2026-01-01");
  const neon = b.benchmarks.rows.find((r) => r.id === "gemini-4-neon");
  assert.deepEqual(Object.keys(neon).sort(), ["id", "straitly_price", "terminal_bench"]);
  const opus = b.benchmarks.rows.find((r) => r.id === "claude-opus-9");
  assert.equal(opus.straitly_value_per_dollar, 4.2);
  assertNoHeldFigure(raw);
});

test("compare_models rejects fewer than 2 models", async () => {
  const { byId } = await rpc([call(1, "compare_models", { models: ["claude-opus-9"] })]);
  assert.equal(byId[1].result.isError, true);
});

test("chat_completion without a key returns an error, not a crash", async () => {
  const { byId } = await rpc([call(1, "chat_completion", { model: "x", prompt: "hi" })]);
  assert.equal(byId[1].result.isError, true);
});
