# Straitly MCP Server

[![Straitly MCP server](https://glama.ai/mcp/servers/Straitly-ai/straitly-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Straitly-ai/straitly-mcp)

Official Model Context Protocol (MCP) server for [Straitly](https://straitly.ai): one OpenAI-compatible API gateway for 100+ models (Claude, GPT, Gemini, Grok, DeepSeek, Kimi, Qwen).

## Tools

- `list_models`: Search Straitly's live catalog of 100+ models by lab, name, or ID with context window and per-million-token pricing.
- `get_model`: Fetch live metadata, pricing, and documentation URL for a specific model.
- `model_prices`: The maker's list price and the Straitly price per 1M tokens for one or more models, read live from the [Straitly catalog](https://straitly.ai/api/catalog). Some models show only the maker price and a link to their Straitly page.
- `compare_models`: Compare 2 to 5 models side by side: live prices, benchmark rows from Straitly's LLM value index when it is published, and links to Straitly's [head-to-head comparison pages](https://straitly.ai/compare).
- `chat_completion`: Run a completion against any model on `https://api.straitly.ai/v1` using your `STRAITLY_API_KEY`.

Example questions an agent can answer with no key: "What does Claude Opus cost per million tokens from the maker and on Straitly?", "Compare GPT Astra and Claude Opus."

## Setup (Claude Desktop, Cursor, Claude Code)

```json
{
  "mcpServers": {
    "straitly": {
      "command": "npx",
      "args": ["-y", "straitly-mcp"],
      "env": {
        "STRAITLY_API_KEY": "sk-..."
      }
    }
  }
}
```

Claude Code: `claude mcp add straitly -e STRAITLY_API_KEY=sk-... -- npx -y straitly-mcp`

Docker: `docker build -t straitly-mcp . && docker run -i --rm -e STRAITLY_API_KEY straitly-mcp`

`list_models`, `get_model`, `model_prices` and `compare_models` work with no API key. `chat_completion` requires `STRAITLY_API_KEY` from [straitly.ai](https://straitly.ai).

## Development

`npm test` runs the server against a local mock of straitly.ai (Node 18+, no dependencies).

## Links

- Website: https://straitly.ai
- Quickstart: https://straitly.ai/docs/quickstart
- Models: https://straitly.ai/models
- SDKs: https://github.com/Straitly-ai/straitly

## License

MIT. See [LICENSE](LICENSE).
