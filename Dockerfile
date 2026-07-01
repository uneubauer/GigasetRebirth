# 1. Stabile Basis (Debian-Bookworm-Slim) mit Node 20
FROM node:20.18-bookworm-slim

# 2. Arbeitsverzeichnis festlegen
WORKDIR /app

# 3. Abhängigkeiten installieren
COPY package*.json ./
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN npm install --production

# 4. Quellcode kopieren
COPY . .

# 5. Ordner erstellen und Besitzrechte an den 'node'-User übergeben
#    Dadurch darf der eingeschränkte User später die JSON-Dateien erzeugen.
RUN mkdir -p WEB-INF public static/icons && \
    chown -R node:node /app

# 6. Sicherheits-Best-Practice: Zu Non-Root wechseln
USER node

# 7. Port & Startbefehl
EXPOSE 80
CMD ["node", "server.js"]