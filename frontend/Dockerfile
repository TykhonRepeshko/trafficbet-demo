FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.30-alpine-slim
# Apply stable Alpine security updates without adding the unused curl/XML modules
# from the full Nginx variant. Keep the final worker unprivileged.
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/trafficbet-frontend/browser /usr/share/nginx/html
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
