FROM oven/bun:1 AS app
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .

EXPOSE 3000
# Exec form: Bun is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["bun", "src/main.ts"]
