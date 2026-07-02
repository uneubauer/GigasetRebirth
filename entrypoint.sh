#!/bin/sh

echo "[Start] Suche nach aktuellen Sicherheits-Updates..."
apk update && apk upgrade

echo "[Start] Starte Gigaset Rebirth Server..."
# Führt den eigentlichen Node-Prozess aus
exec node server.js