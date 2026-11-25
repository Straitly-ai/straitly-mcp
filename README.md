# Straitly MCP Server

[![Straitly MCP server](https://glama.ai/mcp/servers/@Straitly-ai/straitly-mcp/badge.svg)](https://glama.ai/mcp/servers/@Straitly-ai/straitly-mcp)

Official Model Context Protocol (MCP) server for [Straitly](https://straitly.ai) — one OpenAI-compatible API gateway for 150+ models (Claude, GPT, Gemini, Grok, DeepSeek, Kimi, Qwen).

## Tools

- `list_models`: Search Straitly's live catalog of 150+ models by lab, name, or ID with context window and per-million-token pricing.
- `get_model`: Fetch live metadata, pricing, and documentation URL for a specific model.
- `chat_completion`: Run a completion against any model on `https://api.straitly.ai/v1` using your `STRAITLY_API_KEY`.

## Setup (Claude Desktop, Cursor, Claude Code)

```json
{
  "mcpServers": {
    "straitly": {
      "command": "node",
      "args": ["/path/to/straitly-mcp/index.js"],
      "env": {
        "STRAITLY_API_KEY": "sk-..."
      }
    }
  }
}
```

`list_models` and `get_model` work with no API key. `chat_completion` requires `STRAITLY_API_KEY` from [straitly.ai](https://straitly.ai).

## Links

- Website: https://straitly.ai
- Quickstart: https://straitly.ai/docs/quickstart
- Models: https://straitly.ai/models
- Pricing: https://straitly.ai/pricing
- SDKs: https://github.com/Straitly-ai/straitly

## License

MIT. See [LICENSE](LICENSE).
