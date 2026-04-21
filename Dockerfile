FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/data/auth
ENV DB_PATH=/data/messages.db
EXPOSE 3000
CMD ["node", "src/index.js"]
