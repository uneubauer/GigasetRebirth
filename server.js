const express = require('express');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 8080;

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

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    const xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><ul><li><a href="/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}">Wetter</a></li><li><a href="#">Nachrichten</a></li><li><a href="#">Horoskop</a></li></ul></body></html>`;

    return res.send(xml);
});

// Fallback für die alten Pfade (zur Sicherheit)
app.get('/info/', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });
app.get('/info/menu', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });




// =========================================================================
// SCREENSAVER-EINSTIEG / WEATHER DATA & IMAGE PROXY (request.do)
// =========================================================================
// =========================================================================
// SCREENSAVER-EINSTIEG / WEATHER DATA & IMAGE PROXY (request.do)
// =========================================================================
app.get('/info/request.do', async (req, res) => {
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '1';
    const macClean = normMac(macRaw);

    // ---------------------------------------------------------------------
    // WEICHENSTELLUNG - WENN EIN BILD ANGEFORDERT WIRD (Bleibt für Menü/Fallback aktiv)
    // ---------------------------------------------------------------------
    if (req.query.action === 'image') {
        try {
            const col = parseInt(req.query.col || req.query['amp;col']) || 0;
            const row = parseInt(req.query.row || req.query['amp;row']) || 0;
            
            console.log(`[Spritesheet-Proxy] BILD-AUFRUF DIREKT ÜBER REQUEST.DO! Spalte: ${col}, Reihe: ${row}`);
            
            const w = 16;
            const h = 16;
            const rowBytes = 2;
            const chunks = [];

            const spritesheetPath = path.join(__dirname, 'public', '_spritesheet.png'); 

            if (!fs.existsSync(spritesheetPath)) {
                console.error(`[Spritesheet-Proxy] Bilddatei nicht gefunden unter: ${spritesheetPath}`);
                return res.status(404).end();
            }

            const extractX = col * w;
            const extractY = row * h;

            const rawPixelBuffer = await sharp(spritesheetPath)
                .extract({ left: extractX, top: extractY, width: w, height: h })
                .ensureAlpha()
                .raw()
                .toBuffer();

            const header = Buffer.from([0x00, 0x10, 0x00, 0x10]); 
            
            for (let y = 0; y < h; y++) {
                const rowBuffer = Buffer.alloc(rowBytes, 0);
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 4;
                    const r = rawPixelBuffer[idx];
                    const g = rawPixelBuffer[idx + 1];
                    const b = rawPixelBuffer[idx + 2];
                    const a = rawPixelBuffer[idx + 3];

                    if (a < 30 || (r > 240 && g > 240 && b > 240)) {
                        const byteIndex = Math.floor(x / 8);
                        const bitIndex = x % 8;
                        rowBuffer[byteIndex] |= (0x80 >> bitIndex);
                    }
                }
                chunks.push(rowBuffer);
            }

            const fntBuffer = Buffer.concat([header, ...chunks]);
            
            res.writeHead(200, {
                'Content-Type': 'image/fnt',
                'Content-Length': fntBuffer.length,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Connection': 'close'
            });
            return res.end(fntBuffer);

        } catch (error) {
            console.error("[Spritesheet-Proxy] Fehler in request.do Image-Weiche:", error.message);
            if (!res.headersSent) res.status(500).end();
            return;
        }
    }

    // ---------------------------------------------------------------------
    // AB HIER FOLGT DIE NORMALE XML-GENERIERUNG
    // ---------------------------------------------------------------------
    const ua = req.headers['user-agent'] || ''; 

    // --- AUTODISCOVERY ENDE ---

    let cityName = "WETTER";
    let weatherArray = null;

    try {
        let config = getConfig();
        if (config.gateways && config.gateways[macClean] && config.gateways[macClean].handsets[hsid]) {
            cityName = config.gateways[macClean].handsets[hsid].city || "WETTER";
        }

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

    const displayCity = cityName.replace(/ü/g, "UE").replace(/ä/g, "AE").replace(/ö/g, "OE").replace(/ß/g, "SS").toUpperCase();

    // Cache-Verbot für das Mobilteil verschärfen
    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="pragma" content="no-cache" />
    <meta name="expires" content="0" />
    <title>${displayCity}</title>
</head>
<body bgcolor="#ffffff">`;

    if (weatherArray && weatherArray.length > 0) {
        const now = new Date();
        const tageNamen = ["SONNTAG", "MONTAG", "DIENSTAG", "MITTWOCH", "DONNERSTAG", "FREITAG", "SAMSTAG"];
        
        // Kompakter Sammelabsatz für das Mobilteil
        xml += `<p style="text-align:center;">`;

        // Die 3-Tage Schleife sauber durchlaufen
        for (let d = 0; d < 3; d++) {
            const targetDate = new Date(now);
            targetDate.setDate(now.getDate() + d);
            const targetStr = targetDate.toISOString().split('T')[0];
            
            let dayEntry = null;
            let nightEntry = null;

            for (let i = 0; i < weatherArray.length; i++) {
                const e = weatherArray[i];
                const ts = e.timestamp || '';
                if (ts.startsWith(targetStr)) {
                    if (ts.includes("T12:00")) dayEntry = e;
                    if (ts.includes("T03:00")) nightEntry = e;
                }
            }

            if (!dayEntry) {
                dayEntry = weatherArray.find(e => (e.timestamp || '').startsWith(targetStr)) || null;
            }

            if (dayEntry) {
                const tD = Math.round(dayEntry.temperature || 0);
                const tN = nightEntry ? Math.round(nightEntry.temperature || (tD - 5)) : (tD - 5);
                const cond = translateCondition(dayEntry.condition);
                
                // Wochentags-Logik (Nur eine einzige Deklaration!)
                let label = "";
                if (d === 0) {
                    label = "HEUTE";
                } else if (d === 1) {
                    label = "MORGEN";
                } else {
                    label = tageNamen[targetDate.getDay()];
                }

                // Robuste ASCII-Icons (Verhindert das "?" auf dem Mobilteil)
                let icon = "[*]"; 
                const condLower = cond.toLowerCase();
                
                if (condLower.includes("wolk") || condLower.includes("nebel") || condLower.includes("bedeckt")) {
                    icon = "(oo)"; 
                } else if (condLower.includes("regen") || condLower.includes("niesel") || condLower.includes("schauer")) {
                    icon = "///"; 
                } else if (condLower.includes("schnee")) {
                    icon = "***"; 
                } else if (condLower.includes("gewitter")) {
                    icon = "/\\/"; 
                }

                // Kompakter Zeilenaufbau mit Umbruch
                xml += `<b>${label}:</b>${tD}/${tN}°C`;
            }
        }
        
        xml += `</p>`;
    } else {
        xml += `<p style="text-align:center;">Lade Daten...<br/>Bitte warten</p>`;
    }

    xml += `</body></html>`;
    return res.send(xml);
});
// =========================================================================
// 3. ORTSSUCHE & LISTENAUSWAHL (Abfang für beide URL-Varianten)
// =========================================================================
const handleWeatherSearch = (req, res) => {
    let macRaw = req.query.mac || '';
    let hsid = req.query.handsetid || '';
    
    // SRE-FIX: Falls das Telefon die Parameter doppelt schickt (Array), nimm das erste Element
    if (Array.isArray(macRaw)) macRaw = String(macRaw[0]);
    if (Array.isArray(hsid)) hsid = String(hsid[0]);

    // Falls durch doppelte Parameter ein Komma im String landet, schneide es ab
    if (macRaw.includes(',')) macRaw = macRaw.split(',')[0];

    const mac = macRaw.replace(/:/g, '').toUpperCase().trim();

    // AUTOMATISCHE ERKENNUNG INNERHALB DER ORTSSUCHE
    if (mac && hsid) {
        // ... HIER GEHT DER REST DER FUNKTION UNVERÄNDERT WEITER ...
        const userAgent = req.headers['user-agent'] || ''; 
        let config = getConfig();
        if (config.gateways && config.gateways[mac] && config.gateways[mac].handsets[hsid]) {
            let hs = config.gateways[mac].handsets[hsid];
            let changed = false;

            if (userAgent.includes('Gigaset')) {
                const uaParts = userAgent.split(' ');
                if (uaParts[0] && uaParts[0].includes('/')) {
                    const [rawBoxModel, boxFw] = uaParts[0].split('/');
                    const cleanBoxModel = rawBoxModel.replace(/_/g, ' ');
                    if (hs.box_model !== cleanBoxModel) { hs.box_model = cleanBoxModel; changed = true; }
                    if (hs.box_fw !== boxFw) { hs.box_fw = boxFw; changed = true; }
                }

                let detectedModel = '';
                const modelMatch = userAgent.match(/Gigaset_([A-Za-z0-9]+)/);
                if (modelMatch && modelMatch[1]) {
                    detectedModel = modelMatch[1].replace('IP', '').trim();
                }

                const currentName = hs.hs_model || '';
                if (detectedModel && (currentName.startsWith('Mobilteil') || currentName === '')) {
                    hs.hs_model = `Gigaset ${detectedModel}`;
                    changed = true;
                }
            }

            if (changed) {
                saveConfig(config);
                console.log(`[Sync] Gerätedaten aktualisiert für HS ${hsid}: ${hs.hs_model}`);
            }
        }
    }
    
    let cities = [];
    if (fs.existsSync(CITIES_PATH)) { 
        try { 
            cities = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8')).cities || []; 
        } catch(e) {
            console.error("Fehler beim Lesen der cities.json:", e);
        } 
    }

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    let xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ort waehlen</title></head><body><p><b>Ort waehlen</b></p><ul>`;
    
    cities.forEach(c => { 
        const cityName = c.name || 'Unbekannt';
        xml += `<li><a href="/info/weather_save.jsp?mac=${encodeURIComponent(mac)}&amp;handsetid=${encodeURIComponent(hsid)}&amp;city=${encodeURIComponent(cityName)}">${cityName}</a></li>`; 
    });
    
    xml += `</ul></body></html>`;
    return res.send(xml);
};

app.get('/info/weather_search', handleWeatherSearch);
app.get('/info/weather_search.jsp', handleWeatherSearch);

// =========================================================================
// 4. SPEICHERN & REFRESH (Absolut XML-konform escaped)
// =========================================================================
app.get('/info/weather_save.jsp', (req, res) => {
    let macRaw = req.query.mac || '';
    let hsid = req.query.handsetid || '';
    let city = req.query.city || '';
    let mode = req.query.mode || 'weather';
    const fromAdmin = req.query.fromAdmin === 'true';

    if (Array.isArray(macRaw)) macRaw = String(macRaw[0]);
    if (Array.isArray(hsid)) hsid = String(hsid[0]);
    if (Array.isArray(city)) city = String(city[0]);

    if (macRaw.includes(',')) macRaw = macRaw.split(',')[0];
    if (macRaw.includes('%2C')) macRaw = macRaw.split('%2C')[0];

    if (macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim();
        let config = getConfig();

        if (config.gateways && config.gateways[mac] && config.gateways[mac].handsets[hsid]) {
            config.gateways[mac].handsets[hsid].city = city;
            config.gateways[mac].handsets[hsid].mode = mode;

            if (fs.existsSync(CITIES_PATH)) {
                try {
                    const citiesData = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8')).cities || [];
                    const foundCity = citiesData.find(c => c.name.toLowerCase() === city.toLowerCase());
                    if (foundCity) {
                        config.gateways[mac].handsets[hsid].lat = foundCity.lat;
                        config.gateways[mac].handsets[hsid].lon = foundCity.lon;
                    }
                } catch (e) {
                    console.error("Fehler beim cities.json Match:", e);
                }
            }
            saveConfig(config);
        }
    }

    if (fromAdmin) {
        return res.redirect(`/admin.html?mac=${macRaw}&hsid=${hsid}`);
    }

    const cleanMac = encodeURIComponent(macRaw);
    const cleanHs = encodeURIComponent(hsid);
    const xmlRedirectUrl = `/info/weather_search?mac=${cleanMac}&amp;handsetid=${cleanHs}`;

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    const xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Gespeichert</title><meta http-equiv="refresh" content="1; URL=${xmlRedirectUrl}" /></head><body><p style="text-align:center;"><b>STADT GESPEICHERT!</b></p></body></html>`;

    return res.send(xml);
});

// =========================================================================
// 5. WEB-ADMIN CONFIG API (Liefert Daten für admin.html)
// =========================================================================
app.get('/api/config', (req, res) => {
    const config = getConfig();
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
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 3);
        const end = endDate.toISOString().split('T')[0];

        let updates = 0;

        for (const mac of Object.keys(config.gateways)) {
            const safeMac = mac.replace(/:/g, '').toUpperCase().trim();
            const handsets = config.gateways[mac].handsets || {};

            const cacheRoot = { handsets: {}, updated: new Date().toISOString() };
            let hasDataForBase = false;

            for (const hsid of Object.keys(handsets)) {
                const hs = handsets[hsid];
                const lat = hs.lat || "49.4";
                const lon = hs.lon || "10.4";
                const city = hs.city || "Wetter";

                const apiUrl = `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${today}&last_date=${end}&units=dwd`;

                try {
                    const response = await fetch(apiUrl);
                    if (response.status === 200) {
                        const weatherData = await response.json();
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

            if (hasDataForBase) {
                const cacheFilePath = path.join(__dirname, 'WEB-INF', `cache_${safeMac}.json`);
                fs.writeFileSync(cacheFilePath, JSON.stringify(cacheRoot, null, 2), 'utf8');
            }
        }

        return res.send(`UPDATED: ${updates}`);
    } catch (error) {
        console.error("Schwerwiegender Fehler im weather_update:", error);
        return res.status(500).send("UPDATED: 0 (Error)");
    }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// =========================================================================
// AUTOMATISCHES WETTER-UPDATE IM CONTAINER (Alle 30 Minuten)
// =========================================================================
const DREISSIG_MINUTEN = 30 * 60 * 1000;

async function triggerInternalWeatherUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Automatisches Wetterupdate im Container gestartet...`);
        const response = await fetch(`http://localhost:${PORT}/info/weather_update`);
        const result = await response.text();
        console.log(`[${new Date().toISOString()}] Update-Ergebnis: ${result}`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Fehler beim automatischen Wetterupdate:`, e.message);
    }
}

setTimeout(() => {
    triggerInternalWeatherUpdate();
}, 5000);

setInterval(triggerInternalWeatherUpdate, DREISSIG_MINUTEN);
// =========================================================================
// HILFSFUNKTION: MAPPT DEINE WEATHER-CONDITIONS AUF DAS SPRITESHEET
// =========================================================================
function getWeatherCoords(condition) {
    const cond = (condition || '').toLowerCase();

    // Standard-Fallback (Sonne hinter kleiner Wolke / Heiter)
    let coords = { col: 3, row: 2 }; 

    if (cond.includes('clear') || cond.includes('sonne') || cond.includes('heiter')) {
        coords = { col: 1, row: 1 }; // Volle Sonne (Zeile 2, Spalte 2)
    } else if (cond.includes('thunder') || cond.includes('gewitter')) {
        coords = { col: 0, row: 1 }; // Blitz (Zeile 2, Spalte 1)
    } else if (cond.includes('snow') || cond.includes('schnee')) {
        coords = { col: 4, row: 0 }; // Schneeflocke groß (Zeile 1, Spalte 5)
    } else if (cond.includes('rain') || cond.includes('regen') || cond.includes('schauer')) {
        coords = { col: 1, row: 0 }; // Regen / Tropfen (Zeile 1, Spalte 2)
    } else if (cond.includes('cloud') || cond.includes('wolk')) {
        coords = { col: 4, row: 1 }; // Sonne hinter dicken Wolken (Zeile 2, Spalte 5)
    }

    return coords;
}
app.listen(PORT, () => { console.log(`Schlanker Gigaset Rebirth Container laeuft auf Port ${PORT}`); });
