FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "server/src/index.ts"]
