const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');

const app = express();

// Morgan für automatische Docker-Logs im 'dev'-Format
app.use(morgan('dev'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Aktiviert den statischen Ordner für dein WebUI (admin.html)
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_PATH = path.join(__dirname, 'WEB-INF', 'config.json');
const CITIES_PATH = path.join(__dirname, 'WEB-INF', 'cities.json');
// Hilfsfunktion zum Normalisieren der MAC (Analog zu normMac in der JSP)
function normMac(mac) {
    if (!mac) return "UNKNOWN";
    return mac.replace(/[:\-]/g, '').toUpperCase().trim();
}

// Wetterkonditionen übersetzen (Analog zu clean(t) in der JSP)
function translateCondition(t) {
    if (!t || !t.trim()) return "Heiter";
    const r = t.toLowerCase();
    if (r.includes("thunder") || r.includes("bolt")) return "Gewitter";
    if (r.includes("rain") || r.includes("shower")) return "Regen";
    if (r.includes("drizzle")) return "Niesel";
    if (r.includes("snow")) return "Schnee";
    if (r.includes("clear") || r.includes("sun")) return "Sonnig";
    if (r.includes("cloud")) return "Wolkig";
    if (r.includes("fog") || r.includes("mist")) return "Nebel";
    if (r.includes("wind")) return "Windig";
    if (r.includes("dry")) return "Heiter";
    return "Heiter";
}

// Deutschen Wochentag ermitteln
function getGermanDayLabel(dayIndex, offset) {
    if (offset === 0) return "Heute";
    const days = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    return days[dayIndex];
}
function getConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return { gateways: {} };
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return { gateways: {} }; }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
}

// =========================================================================
// 1. TELEFON-EINSTIEG: DIE VOM MOBILTEIL GEFORDERTE menu.jsp
// =========================================================================
app.get('/info/menu.jsp', (req, res) => {
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '';

    // Header exakt wie beim Tomcat-Server setzen
    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    // WICHTIG: Exakt die DOCTYPE-Zeile aus der JSP, komplett einzeilig ohne Leerzeichen am Anfang!
    const xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><ul><li><a href="/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}">Wetter</a></li><li><a href="#">Nachrichten</a></li><li><a href="#">Horoskop</a></li></ul></body></html>`;

    return res.send(xml);
});

// Fallback für die alten Pfade (zur Sicherheit)
app.get('/info/', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });
app.get('/info/menu', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });

// =========================================================================
// 2. SCREENSAVER-EINSTIEG / WEATHER DATA (request.do)
// =========================================================================
// =========================================================================
// 2. SCREENSAVER / WEATHER DATA (request.do) - Vollständige JSP-Übersetzung
// =========================================================================
app.get('/info/request.do', (req, res) => {
    const ua = req.headers['user-agent'] || ''; 
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '1';
    const macClean = normMac(macRaw);

    // --- AUTODISCOVERY START (Registrierung in config.json wie gehabt) ---
    if (ua && macRaw && hsid) {
        let config = getConfig(); if (!config.gateways) config.gateways = {};
        const parts = ua.replace(/_/g, ' ').split('/');
        let baseModel = (parts && parts[0]) ? parts[0].replace('Gigaset ', '').trim() : "GO-Box / N510";
        let fwVersion = "---", hsModel = "Mobilteil";
        if (parts && parts.length > 1) {
            let secondPart = parts[1].replace(/\(/g, '').replace(/\)/g, '');
            if (secondPart.includes(';')) {
                const subParts = secondPart.split(';'); fwVersion = subParts[0] ? subParts[0].trim() : "---";
                for (let sub of subParts) { if (sub.includes('HS=')) hsModel = sub.replace('HS=', '').trim(); }
            } else { fwVersion = secondPart.trim(); }
        }
        let changed = false;
        if (!config.gateways[macClean]) { config.gateways[macClean] = { handsets: {} }; changed = true; }
        if (!config.gateways[macClean].handsets[hsid]) {
            config.gateways[macClean].handsets[hsid] = { mode: "weather", city: "Mitteldachstetten", box_model: baseModel, box_fw: fwVersion, hs_model: hsModel };
            changed = true;
        }
        if (changed) saveConfig(config);
    }
    // --- AUTODISCOVERY ENDE ---

    // Standard-Stadt falls nichts gefunden wird
    let cityName = "WETTER";
    let weatherArray = null;

    try {
        // 1. Stadt aus Haupt-Config holen
        let config = getConfig();
        if (config.gateways && config.gateways[macClean] && config.gateways[macClean].handsets[hsid]) {
            cityName = config.gateways[macClean].handsets[hsid].city || "WETTER";
        }

        // 2. Wetterdaten aus der spezifischen cache_[MAC].json lesen
        const cachePath = path.join(__dirname, 'WEB-INF', `cache_${macClean}.json`);
        if (fs.existsSync(cachePath)) {
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cacheData.handsets) {
                const firstKey = Object.keys(cacheData.handsets)[0];
                if (firstKey && cacheData.handsets[firstKey]) {
                    weatherArray = cacheData.handsets[firstKey].weather || null;
                    cityName = cacheData.handsets[firstKey].city || cityName;
                }
            }
        }
    } catch (e) {
        console.error("Fehler beim Verarbeiten des Wettercaches:", e);
    }

    // Stadt-Namen für das Display umformatieren (Umlaute raus, Uppercase)
    const displayCity = cityName.replace(/ü/g, "UE").replace(/ä/g, "AE").replace(/ö/g, "OE").replace(/ß/g, "SS").toUpperCase();

    // Headers strikt setzen (Wichtig: OMA XHTML 1.2 Doctype Match)
    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    // XML Start-Skelett (Absolute Zeile 1, Byte 0)
    let xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${displayCity}</title></head><body bgcolor="#ffffff">`;

    if (weatherArray && weatherArray.length > 0) {
        const now = new Date();
        
        for (let d = 0; d < 3; d++) {
            const targetDate = new Date(now);
            targetDate.setDate(now.getDate() + d);
            
            // Format YYYY-MM-DD
            const targetStr = targetDate.toISOString().split('T')[0];
            
            let dayEntry = null;
            let nightEntry = null;

            // Einträge für Mittag und Nacht filtern
            for (let i = 0; i < weatherArray.length; i++) {
                const e = weatherArray[i];
                const ts = e.timestamp || '';
                if (ts.startsWith(targetStr)) {
                    if (ts.includes("T12:00")) dayEntry = e;
                    if (ts.includes("T03:00")) nightEntry = e;
                }
            }

            // Fallback falls kein exakter Mittagswert da ist
            if (!dayEntry) {
                dayEntry = weatherArray.find(e => (e.timestamp || '').startsWith(targetStr)) || null;
            }

            if (dayEntry) {
                const tD = Math.round(dayEntry.temperature || 0);
                const tN = nightEntry ? Math.round(nightEntry.temperature || (tD - 5)) : (tD - 5);
                const cond = translateCondition(dayEntry.condition);
                const label = getGermanDayLabel(targetDate.getDay(), d);

                xml += `<p style="text-align:center;">${label}<br/>${cond}&nbsp;${tD}°C/${tN}°C</p>`;
            }
        }
    } else {
        // Fallback falls der Cache (noch) leer ist
        xml += `<p style="text-align:center;">Lade Daten...<br/>Bitte warten</p>`;
    }

    xml += `</body></html>`;

    // Komplett flachgedrückt ohne störende Absätze absenden
    return res.send(xml);
});


// =========================================================================
// 3. ORTSSUCHE & LISTENAUSWAHL (Exakte Übersetzung der JSP)
// =========================================================================
app.get('/info/weather_search', (req, res) => {
    const mac = req.query.mac || ''; 
    const hsid = req.query.handsetid || ''; 
    
    let cities = [];
    if (fs.existsSync(CITIES_PATH)) { 
        try { 
            cities = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8')).cities || []; 
        } catch(e) {
            console.error("Fehler beim Lesen der cities.json:", e);
        } 
    }

    // Header sauber wie beim Tomcat setzen
    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    // 1. XML-Kopf und DTD (Exakt wie in der gelieferten JSP)
    let xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtml-mobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ort waehlen</title></head><body><p><b>Ort waehlen</b></p><ul>`;
    
    // 2. Dynamische Städteliste einbauen (Zielt auf die weather_save.jsp Route)
    cities.forEach(c => { 
        const cityName = c.name || 'Unbekannt';
        xml += `<li><a href="/info/weather_save.jsp?mac=${encodeURIComponent(mac)}&amp;handsetid=${encodeURIComponent(hsid)}&amp;city=${encodeURIComponent(cityName)}">${cityName}</a></li>`; 
    });
    
    // 3. Schließen der Tags
    xml += `</ul></body></html>`;

    // Alles ohne Zeilenumbrüche an das Telefon jagen
    return res.send(xml);
});

// =========================================================================
// 4. SPEICHERN & REFRESH (Sicher gegen Express-Arrays bei doppelten Querys)
// =========================================================================
app.get('/info/weather_save.jsp', (req, res) => {
    // Wenn ein Parameter doppelt kommt, nimmt req.query.X das Array. 
    // Wir zwingen es hier knallhart auf das erste Element als String.
    let macRaw = Array.isArray(req.query.mac) ? String(req.query.mac[0]) : String(req.query.mac || '');
    let hsid = Array.isArray(req.query.handsetid) ? String(req.query.handsetid[0]) : String(req.query.handsetid || '');
    let city = Array.isArray(req.query.city) ? String(req.query.city[0]) : String(req.query.city || '');

    // Falls im ersten Element immer noch ein Komma drinsteckt, wegschneiden
    if (macRaw.includes(',')) macRaw = macRaw.split(',')[0];
    if (macRaw.includes('%2C')) macRaw = macRaw.split('%2C')[0];

    if (macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim(); 
        let config = getConfig();
        if (config.gateways && config.gateways[mac] && config.gateways[mac].handsets[hsid]) { 
            config.gateways[mac].handsets[hsid].city = city || "Unbekannt"; 
            saveConfig(config); 
        }
    }
    
    const redirectUrl = `/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}`;

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    const xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Gespeichert</title><meta http-equiv="refresh" content="1; URL=${redirectUrl.replace(/&amp;/g, '&')}" /></head><body><p style="text-align:center;"><b>STADT GESPEICHERT!</b></p></body></html>`;

    return res.send(xml);
});
// =========================================================================
// 5. WEB-ADMIN CONFIG API (Liefert Daten für admin.html)
// =========================================================================
app.get('/api/config', (req, res) => {
    const config = getConfig();
    // Falls ein bestimmtes Mobilteil abgefragt wird, liefern wir dessen Details mit
    const selMac = req.query.mac || '';
    const selHs = req.query.hsid || '';
    
    let activeHandset = null;
    if (selMac && selHs && config.gateways && config.gateways[selMac] && config.gateways[selMac].handsets) {
        activeHandset = config.gateways[selMac].handsets[selHs] || null;
    }

    return res.json({
        gateways: config.gateways || {},
        activeHandset: activeHandset
    });
});
// =========================================================================
// 6. WETTER-UPDATE DATA FETCH (BrightSky API / DWD Übersetzung)
// =========================================================================
app.get('/info/weather_update', async (req, res) => {
    try {
        const config = getConfig();
        if (!config.gateways) return res.status(400).json({ error: "Keine Gateways in config.json" });

        const today = new Date().toISOString().split('T')[0];
        
        // End-Datum berechnen (heute + 3 Tage)
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 3);
        const end = endDate.toISOString().split('T')[0];

        let updates = 0;

        // Alle Basisstationen durchgehen
        for (const mac of Object.keys(config.gateways)) {
            const safeMac = mac.replace(/:/g, '').toUpperCase().trim();
            const handsets = config.gateways[mac].handsets || {};

            const cacheRoot = { handsets: {}, updated: new Date().toISOString() };
            let hasDataForBase = false;

            // Jedes Mobilteil dieser Basis abfragen
            for (const hsid of Object.keys(handsets)) {
                const hs = handsets[hsid];

                // Koordinaten direkt aus dem Mobilteil-Objekt ziehen (Fallback auf deine Defaults)
                const lat = hs.lat || "49.4";
                const lon = hs.lon || "10.4";
                const city = hs.city || "Wetter";

                // BrightSky API-URL zusammenbauen
                const apiUrl = `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${today}&last_date=${end}&units=dwd`;

                try {
                    const response = await fetch(apiUrl);
                    if (response.status === 200) {
                        const weatherData = await response.json();

                        // Cache-Struktur exakt wie in deiner JSP aufbauen
                        cacheRoot.handsets[hsid] = {
                            city: city,
                            lat: lat,
                            lon: lon,
                            weather: weatherData.weather || []
                        };

                        hasDataForBase = true;
                        updates++;
                    }
                } catch (apiErr) {
                    console.error(`Fehler beim BrightSky-Abruf für MAC ${safeMac}, HS ${hsid}:`, apiErr.message);
                }
            }

            // Cache-Datei für diese Basis schreiben, wenn mindestens ein Mobilteil erfolgreich war
            if (hasDataForBase) {
                const cacheFilePath = path.join(__dirname, 'WEB-INF', `cache_${safeMac}.json`);
                fs.writeFileSync(cacheFilePath, JSON.stringify(cacheRoot, null, 2), 'utf8');
            }
        }

        // Response exakt wie bei der JSP ("UPDATED: X")
        return res.send(`UPDATED: ${updates}`);

    } catch (error) {
        console.error("Schwerwiegender Fehler im weather_update:", error);
        return res.status(500).send("UPDATED: 0 (Error)");
    }
});
// Start-Routing für PC-Browser
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
// =========================================================================
// AUTOMATISCHES WETTER-UPDATE IM CONTAINER (Alle 30 Minuten)
// =========================================================================
const DREISSIG_MINUTEN = 30 * 60 * 1000;

// Funktion, die die Logik von /info/weather_update intern ausführt
async function triggerInternalWeatherUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Automatisches Wetterupdate im Container gestartet...`);
        
        // Da wir uns im selben Prozess befinden, rufen wir die Route einfach lokal auf
        const response = await fetch(`http://localhost:${PORT}/info/weather_update`);
        const result = await response.text();
        
        console.log(`[${new Date().toISOString()}] Update-Ergebnis: ${result}`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Fehler beim automatischen Wetterupdate:`, e.message);
    }
}

// 1. Sofort beim Container-Start einmal ausführen, damit der Cache direkt da ist
setTimeout(() => {
    triggerInternalWeatherUpdate();
}, 5000); // 5 Sekunden Verzögerung nach Boot, damit der Server sicher bereit ist

// 2. Danach alle 30 Minuten endlos wiederholen
setInterval(triggerInternalWeatherUpdate, DREISSIG_MINUTEN);
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Schlanker Gigaset Rebirth Container laeuft auf Port ${PORT}`); });