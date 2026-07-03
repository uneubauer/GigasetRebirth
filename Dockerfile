# Nutzen der schlanken Node.js-Version auf Alpine Linux
FROM node:20-alpine

# Setzen der Zeitzone im Container (wichtig für die korrekten Wetter-Aktualisierungsintervalle)
RUN apk add --no-cache tzdata
ENV TZ=Europe/Berlin

# Arbeitsverzeichnis im Container festlegen
WORKDIR /app

# Package-Dateien kopieren und Abhängigkeiten installieren
COPY package*.json ./
RUN npm install --production

# Die restlichen App-Dateien kopieren
COPY server.js ./
COPY WEB-INF/ ./WEB-INF/

# NEU: Den kompletten public-Ordner (für admin.html und den img/-Ordner) mit ins Image brennen
COPY public/ ./public/

# Port freigeben, auf dem deine server.js lauscht (z.B. 80 oder 8080)
EXPOSE 80

# App starten
CMD ["node", "server.js"]