FROM node:20-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 ffmpeg curl ca-certificates \
      chromium fonts-noto-cjk \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p downloads uploads contact-messages

EXPOSE 3000
CMD ["node", "server.js"]
