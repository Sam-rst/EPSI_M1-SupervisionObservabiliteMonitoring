FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js traffic-generator.js tracing.js ./

EXPOSE 8000

CMD ["node", "server.js"]
