FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (aproveita cache do Docker)
COPY package*.json ./
RUN npm install --production

# Copia o restante do código
COPY . .

# Cria pasta de logs
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "server.js"]
