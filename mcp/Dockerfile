FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json ./
RUN pnpm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

ENV MEM0_HOST=http://mem0:8000
ENV MEM0_USER_ID=default
ENV MCP_PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
