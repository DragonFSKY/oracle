FROM node:24-alpine

WORKDIR /app

COPY package.json ./package.json
COPY dist ./dist

ENV NODE_ENV=production \
    ORACLE_RELAY_HOST=0.0.0.0 \
    ORACLE_RELAY_PORT=19476 \
    ORACLE_RELAY_DATA_DIR=/data

EXPOSE 19476

USER node

CMD ["node", "dist/src/relay/main.js"]
