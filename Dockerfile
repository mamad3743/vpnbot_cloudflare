FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY schema.sql server.js ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
CMD ["node", "--no-warnings", "server.js"]
