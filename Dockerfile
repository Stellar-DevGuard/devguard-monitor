FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save --package-lock=false pg@8

COPY src/ ./src/
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "src/service.js"]
