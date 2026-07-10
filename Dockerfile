FROM node:20-alpine AS test
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js test.js index.html sycamore-logo.jpg ./
COPY data/ ./data/
COPY wiki/ ./wiki/
RUN node test.js

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server.js index.html sycamore-logo.jpg ./
COPY data/ ./data/
COPY wiki/ ./wiki/
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
