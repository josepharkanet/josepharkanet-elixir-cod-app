FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js register-webhook.mjs ./
EXPOSE 3000
CMD ["node", "server.js"]
