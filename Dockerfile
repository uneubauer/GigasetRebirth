# 1. Ultra-schlanke Basis auf Alpine-Linux-Basis (ca. 43 MB)
FROM node:20-alpine

# 2. Arbeitsverzeichnis festlegen
WORKDIR /app

# 3. Abhängigkeiten installieren
COPY package*.json ./
RUN npm install --production

# 4. Quellcode kopieren
COPY . .

# 5. Ordner direkt beim Build erstellen (Root darf später schreiben)
RUN mkdir -p WEB-INF public static/icons

# 6. Das Start-Skript ausführbar machen
RUN chmod +x entrypoint.sh

# 7. Port freigeben
EXPOSE 80

# 8. Der Entrypoint fängt den Start ab, macht das Update und startet Node
ENTRYPOINT ["./entrypoint.sh"]