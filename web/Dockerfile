FROM oven/bun:1 AS build
WORKDIR /web
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
