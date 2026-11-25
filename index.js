#!/usr/bin/env node
// Straitly MCP server (stdio JSON-RPC 2.0, zero external dependencies).
// Exposes live model catalog lookup, price comparison, and chat completions via https://api.straitly.ai/v1.

import readline from "node:readline";

process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

const BASE_URL = process.env.STRAITLY_BASE_URL || "https://api.straitly.ai/v1";
const CATALOG_URL = "https://straitly.ai/api/catalog";
const SERVER_INFO = { name: "straitly-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "list_models",
    description: "Search Straitly's live catalog of 150+ LLM models by name, lab, or ID. Returns context length and per-million-token pricing.",
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
  const res = await fetch(CATALOG_URL, { headers: { "User-Agent": "straitly-mcp/0.1.0" } });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  const data = await res.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.filter((m) => String(m?.id || "") !== "gemini-4-neon" && !String(m?.key || "").includes("gemini-4-neon"));
}

function formatModel(m) {
  return {
    key: m.key,
    id: m.id,
    name: m.name,
    author: m.author?.label || m.author?.slug || null,
    context: m.context ?? null,
    released: m.released ?? null,
    price_per_1m_usd: m.price ? { input: m.price.input ?? null, output: m.price.output ?? null } : null,
    list_per_1m_usd: m.list ? { input: m.list.input ?? null, output: m.list.output ?? null } : null,
    url: `https://straitly.ai/models/${m.id}`,
  };
}

async function handleToolCall(name, args = {}) {
  if (name === "list_models") {
    const models = await fetchCatalog();
    const q = String(args.query || "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
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
    const models = await fetchCatalog();
    const found = models.find((m) => String(m.key || "").toLowerCase() === needle || String(m.id || "").toLowerCase() === needle);
    if (!found) {
      return { isError: true, content: [{ type: "text", text: `Model not found: ${args.model}. Browse https://straitly.ai/models` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(formatModel(found), null, 2) }] };
  }

  if (name === "chat_completion") {
    const apiKey = process.env.STRAITLY_API_KEY;
    if (!apiKey) {
      return { isError: true, content: [{ type: "text", text: "STRAITLY_API_KEY is not set. Create a key at https://straitly.ai" }] };
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
