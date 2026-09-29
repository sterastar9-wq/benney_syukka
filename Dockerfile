FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "run", "goq:review"]
