# 1. Nutzung von Debian-Slim statt Alpine (Verhindert Sharp-Kompilierungsfehler)
FROM node:20-slim

# 2. Arbeitsverzeichnis festlegen
WORKDIR /app

# 3. Paketdateien kopieren
COPY package*.json ./

# 4. Abhängigkeiten installieren (Debian benötigt keine zusätzlichen Compiler für Sharp)
RUN npm install --production

# 5. Restlichen Quellcode kopieren
COPY . .

# 6. Sicherstellen, dass die WEB-INF und public Ordner existieren
RUN mkdir -p WEB-INF public static/icons

# 7. Port freigeben
EXPOSE 80

# 8. Server starten
CMD ["node", "server.js"]
