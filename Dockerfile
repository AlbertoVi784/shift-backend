# Usa l'immagine Node.js ufficiale
FROM node:18-slim

# Crea directory di lavoro
WORKDIR /app

# Copia i file di dipendenza
COPY package*.json ./

# Installa le dipendenze
RUN npm install --production

# Copia il codice dell'applicazione
COPY index.js ./

# Esponi la porta 8080 (richiesta da Cloud Run)
EXPOSE 8080

# Avvia l'applicazione
CMD ["npm", "start"]
