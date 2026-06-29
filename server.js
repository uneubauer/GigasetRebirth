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
// 2. SCREENSAVER-EINSTIEG / WEATHER DATA (request.do)
// =========================================================================
app.get('/info/request.do', (req, res) => {
    const ua = req.headers['user-agent'] || ''; 
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '1';
    const macClean = normMac(macRaw);

    // --- AUTODISCOVERY START ---
    if (ua && macRaw && hsid) {
        let config = getConfig(); if (!config.gateways) config.gateways = {};
        const parts = ua.replace(/_/g, ' ').split('/');
        
        let baseModel = (parts && parts[0]) ? parts[0].replace('Gigaset ', '').trim() : "GO-Box / N510";
        let fwVersion = "---";
        let hsModel = "";

        if (parts && parts.length > 1) {
            let secondPart = parts[1].replace(/\(/g, '').replace(/\)/g, '');
            if (secondPart.includes(';')) {
                const subParts = secondPart.split(';'); 
                fwVersion = subParts[0] ? subParts[0].trim() : "---";
                for (let sub of subParts) { 
                    if (sub.includes('HS=')) hsModel = sub.replace('HS=', '').trim(); 
                }
            } else { 
                fwVersion = secondPart.trim(); 
            }
        }

        if (!hsModel) {
            const modelMatch = ua.match(/Gigaset_([A-Za-z0-9]+)/);
            if (modelMatch && modelMatch[1]) {
                hsModel = `Gigaset ${modelMatch[1].replace('IP', '').trim()}`;
            } else {
                hsModel = `Mobilteil ${hsid}`;
            }
        } else if (!hsModel.startsWith('Gigaset')) {
            hsModel = `Gigaset ${hsModel}`;
        }

        let changed = false;
        if (!config.gateways[macClean]) { config.gateways[macClean] = { handsets: {} }; changed = true; }
        
        if (!config.gateways[macClean].handsets[hsid]) {
            config.gateways[macClean].handsets[hsid] = { 
                mode: "weather", 
                city: "Mitteldachstetten", 
                box_model: baseModel, 
                box_fw: fwVersion, 
                hs_model: hsModel 
            };
            changed = true;
        } else {
            let hs = config.gateways[macClean].handsets[hsid];
            if (!hs.hs_model || hs.hs_model.startsWith('Mobilteil')) {
                hs.hs_model = hsModel;
                changed = true;
            }
            if (hs.box_model !== baseModel) { hs.box_model = baseModel; changed = true; }
            if (hs.box_fw !== fwVersion) { hs.box_fw = fwVersion; changed = true; }
        }

        if (changed) {
            saveConfig(config);
            console.log(`[Sync] Gerätedaten via Screensaver aktualisiert für HS ${hsid}: ${hsModel}`);
        }
    }
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

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    // --- NEU: META-TAGS NACH KAPITEL 2.5.3 INJIZIEREN ---
    let xml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta name="expires" content="1800" />
    <meta name="imageproxy" content="http://gigaset.net/proxy/image.do" />
    <title>${displayCity}</title>
</head>
<body bgcolor="#ffffff">`;

    if (weatherArray && weatherArray.length > 0) {
        const now = new Date();
        
        // Für den allerersten Eintrag (heute) zeigen wir das Icon groß im Screensaver
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
                const label = getGermanDayLabel(targetDate.getDay(), d);

                // --- NEU: RASTER-KOORDINATEN ERMITTELN ---
                let coords = getWeatherCoords(dayEntry.condition);

                // --- NEU: ICON IN JEDER ZEILE EINBINDEN ---
                xml += `<p style="text-align:center;">
    <b>${label}</b><br/>
    <img src="http://inof.gigaset.net/proxy/image.do?col=${coords.col}&amp;row=${coords.row}" width="16" height="16" alt="*" /><br/>
    ${cond}&nbsp;${tD}°C/${tN}°C
</p>`;
            }
        }
    } else {
        xml += `<p style="text-align:center;">Lade Daten...<br/>Bitte warten</p>`;
    }

    xml += `</body></html>`;
    return res.send(xml);
});
// =========================================================================
// NEU: GIGASET SPRITESHEET PROXY (Wandelt PNG-Kacheln in .fnt um)
// =========================================================================
app.get('/proxy/image.do', async (req, res) => {
    const col = parseInt(req.query.col) || 0;
    const row = parseInt(req.query.row) || 0;
    const COLS_TOTAL = 5;
    const ROWS_TOTAL = 4;
    
    const spritesheetPath = path.join(__dirname, 'public', '_spritesheet.png');

    try {
        // 1. Metadaten des Spritesheets auslesen, um Kachelgröße zu berechnen
        const image = sharp(spritesheetPath);
        const metadata = await image.metadata();

        const tileWidth = Math.floor(metadata.width / COLS_TOTAL);
        const tileHeight = Math.floor(metadata.height / ROWS_TOTAL);

        const startX = col * tileWidth;
        const startY = row * tileHeight;
        const w = 16;
        const h = 16;

        // 2. Kachel ausschneiden, auf 16x16 skalieren und rohe RGBA-Pixel extrahieren
        const rawPixelBuffer = await image
            .extract({ left: startX, top: startY, width: tileWidth, height: tileHeight })
            .resize(w, h)
            .raw()
            .toBuffer();

        // 3. Gigaset FNT-Header vorbereiten (16x16)
        const header = Buffer.alloc(4);
        header.writeUInt16LE(w, 0);
        header.writeUInt16LE(h, 2);

        const chunks = [];
        const rowBytes = Math.floor((w + 7) / 8);

        // 4. Durch die rohen RGBA-Pixel wandern (4 Bytes pro Pixel: R, G, B, A)
        for (let y = 0; y < h; y++) {
            const rowBuffer = Buffer.alloc(rowBytes, 0);
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const r = rawPixelBuffer[idx];
                const g = rawPixelBuffer[idx + 1];
                const b = rawPixelBuffer[idx + 2];
                const a = rawPixelBuffer[idx + 3];

                let luma = 255;
                if (a > 10) {
                    luma = 0.299 * r + 0.587 * g + 0.114 * b;
                }

                // Wenn der Pixel dunkel genug ist -> Bit im Gigaset-Format setzen
                if (luma < 180) {
                    const byteIndex = Math.floor(x / 8);
                    const bitIndex = x % 8;
                    rowBuffer[byteIndex] |= (0x80 >> bitIndex);
                }
            }
            chunks.push(rowBuffer);
        }

        const fntBuffer = Buffer.concat([header, ...chunks]);
        
        res.header('Content-Type', 'image/fnt');
        res.header('Content-Length', fntBuffer.length);
        return res.send(fntBuffer);

    } catch (error) {
        console.error("[Spritesheet-Proxy] Fehler:", error.message);
        return res.status(500).send('Fehler beim Verarbeiten des Bild-Rasters mit Sharp');
    }
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