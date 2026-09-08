FROM node:24-alpine

WORKDIR /app
COPY server.js ./server.js
USER 65534:65534
EXPOSE 8790
CMD ["node", "server.js"]
