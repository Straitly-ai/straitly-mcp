FROM node:22-alpine

WORKDIR /app

COPY package.json index.js README.md LICENSE ./

# Zero runtime dependencies; the server speaks MCP over stdio.
ENTRYPOINT ["node", "index.js"]
