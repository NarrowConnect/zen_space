FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

RUN mkdir -p /app/data
VOLUME ["/app/data"]

CMD ["node", "local-server.js"]