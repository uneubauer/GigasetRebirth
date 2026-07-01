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

// =========================================================================
// AUTOMATISCHE INITIALISIERUNG (SELBSTHEILUNG FÜR DOCKER-VOLUMES)
// =========================================================================
const webInfDir = path.join(__dirname, 'WEB-INF');
const CONFIG_PATH = path.join(webInfDir, 'config.json');
const CITIES_PATH = path.join(webInfDir, 'cities.json');

// Sorge dafür, dass der WEB-INF Ordner existiert (falls leer von außen gemountet)
if (!fs.existsSync(webInfDir)) {
    console.log("[Setup] Erstelle fehlenden WEB-INF Ordner...");
    fs.mkdirSync(webInfDir, { recursive: true });
}

// 1. Automatische config.json Erstellung, falls nicht vorhanden
if (!fs.existsSync(CONFIG_PATH)) {
    console.log("[Setup] config.json nicht gefunden. Erstelle Standard-Konfiguration...");
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ gateways: {} }, null, 4), 'utf8');
    } catch (err) {
        console.error("[Setup-Fehler] Keine Schreibrechte für config.json:", err.message);
    }
}

// 2. Automatische cities.json Erstellung mit Standard-Städten, falls nicht vorhanden
if (!fs.existsSync(CITIES_PATH)) {
    console.log("[Setup] cities.json nicht gefunden. Erstelle Standard-Städteliste...");
    const defaultCities = {
        cities: [
            { name: "Ansbach", lat: "49.30", lon: "10.58" },
            { name: "Nuernberg", lat: "49.45", lon: "11.08" },
            { name: "Muenchen", lat: "48.13", lon: "11.57" },
            { name: "Berlin", lat: "52.52", lon: "13.40" }
        ]
    };
    try {
        fs.writeFileSync(CITIES_PATH, JSON.stringify(defaultCities, null, 4), 'utf8');
    } catch (err) {
        console.error("[Setup-Fehler] Keine Schreibrechte für cities.json:", err.message);
    }
}

// Aktiviert den statischen Ordner für dein WebUI (admin.html)
app.use(express.static(path.join(__dirname, 'public')));

// Hilfsfunktion zum Normalweisen der MAC
function normMac(mac) {
    if (!mac) return "UNKNOWN";
    return mac.replace(/[:\-]/g, '').toUpperCase().trim();
}

// Wetterkonditionen übersetzen
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
    return "Heiter";
}

// Deutschen Wochentag ermitteln
function getGermanDayLabel(dayIndex, offset) {
    if (offset === 0) return "HEUTE";
    const days = ["SO", "MO", "DI", "MI", "DO", "FR", "SA"];
    return days[dayIndex];
}

function getConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return { gateways: {} };
    try { 
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); 
    } catch (e) { 
        return { gateways: {} }; 
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
    } catch (err) {
        console.error("[Rechte-Fehler] Konnte config.json nicht speichern:", err.message);
    }
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

app.get('/info/', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });
app.get('/info/menu', (req, res) => { res.redirect(`/info/menu.jsp?mac=${req.query.mac || ''}&handsetid=${req.query.handsetid || ''}`); });

// =========================================================================
// SCREENSAVER-EINSTIEG / WEATHER DATA & IMAGE PROXY (request.do)
// =========================================================================
app.get('/info/request.do', async (req, res) => {
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '1';
    const macClean = normMac(macRaw);

    // BILD-WEICHE (action=image) - Bleibt unverändert für das Menü
    if (req.query.action === 'image') {
        try {
            const col = parseInt(req.query.col || req.query['amp;col']) || 0;
            const row = parseInt(req.query.row || req.query['amp;row']) || 0;
            const w = 16, h = 16, rowBytes = 2, chunks = [];
            const spritesheetPath = path.join(__dirname, 'public', '_spritesheet.png'); 

            if (!fs.existsSync(spritesheetPath)) return res.status(404).end();

            const rawPixelBuffer = await sharp(spritesheetPath)
                .extract({ left: col * w, top: row * h, width: w, height: h })
                .ensureAlpha().raw().toBuffer();

            const header = Buffer.from([0x00, 0x10, 0x00, 0x10]); 
            for (let y = 0; y < h; y++) {
                const rowBuffer = Buffer.alloc(rowBytes, 0);
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 4;
                    if (rawPixelBuffer[idx + 3] < 30 || (rawPixelBuffer[idx] > 240 && rawPixelBuffer[idx + 1] > 240 && rawPixelBuffer[idx + 2] > 240)) {
                        rowBuffer[Math.floor(x / 8)] |= (0x80 >> (x % 8));
                    }
                }
                chunks.push(rowBuffer);
            }
            res.writeHead(200, { 'Content-Type': 'image/fnt', 'Cache-Control': 'no-cache', 'Connection': 'close' });
            return res.end(Buffer.concat([header, ...chunks]));
        } catch (error) {
            if (!res.headersSent) res.status(500).end();
            return;
        }
    }

    // XML-GENERIERUNG FÜR REINES WETTER
    let cityName = "WETTER";
    let weatherArray = null;
    let config = getConfig();

    // 1. Suche nach den konfigurierten Daten für diese spezifische ID
    if (config.gateways && config.gateways[macClean] && config.gateways[macClean].handsets && config.gateways[macClean].handsets[hsid]) {
        cityName = config.gateways[macClean].handsets[hsid].city || "WETTER";
    }

    // 2. Versuche den Cache zu laden
    const cachePath = path.join(webInfDir, `cache_${macClean}.json`);
    if (fs.existsSync(cachePath)) {
        try {
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cacheData.handsets && cacheData.handsets[hsid]) {
                weatherArray = cacheData.handsets[hsid].weather || null;
                cityName = cacheData.handsets[hsid].city || cityName;
            } else if (cacheData.handsets) {
                // Fallback: Wenn unter der langen ID kein Cache da ist, nimm das erste verfügbare Mobilteil aus dem Cache
                const firstKey = Object.keys(cacheData.handsets)[0];
                if (firstKey && cacheData.handsets[firstKey]) {
                    weatherArray = cacheData.handsets[firstKey].weather || null;
                    cityName = cacheData.handsets[firstKey].city || cityName;
                }
            }
        } catch (e) {
            console.error("Fehler beim Lesen des Caches:", e.message);
        }
    }

    // 3. NEU: LIVE-FETCH FALLBACK, falls die Config existiert, aber noch kein Cache gebaut wurde!
    if (!weatherArray && config.gateways && config.gateways[macClean] && config.gateways[macClean].handsets && config.gateways[macClean].handsets[hsid]) {
        const hs = config.gateways[macClean].handsets[hsid];
        if (hs.lat && hs.lon) {
            console.log(`[Live-Fetch] Kein Cache für HS ${hsid}. Rufe Wetter direkt von BrightSky ab...`);
            const today = new Date().toISOString().split('T')[0];
            const endDate = new Date(); endDate.setDate(endDate.getDate() + 3);
            const end = endDate.toISOString().split('T')[0];
            const apiUrl = `https://api.brightsky.dev/weather?lat=${hs.lat}&lon=${hs.lon}&date=${today}&last_date=${end}&units=dwd`;

            try {
                const response = await fetch(apiUrl);
                if (response.status === 200) {
                    const weatherData = await response.json();
                    weatherArray = weatherData.weather || null;
                    
                    // Schreibt das Ergebnis direkt in den Cache, damit beim nächsten Tick Ruhe ist
                    const cacheRoot = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : { handsets: {}, updated: "" };
                    cacheRoot.updated = new Date().toISOString();
                    cacheRoot.handsets[hsid] = { city: cityName, lat: hs.lat, lon: hs.lon, weather: weatherArray || [] };
                    fs.writeFileSync(cachePath, JSON.stringify(cacheRoot, null, 2), 'utf8');
                }
            } catch (apiErr) {
                console.error(`[Live-Fetch Fehler] BrightSky direkt fehlgeschlagen:`, apiErr.message);
            }
        }
    }

    // XML Zusammenbau (Umlaute bereinigen)
    const displayCity = cityName.replace(/ü/g, "UE").replace(/ä/g, "AE").replace(/ö/g, "OE").replace(/ß/g, "SS").toUpperCase();

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta name="expires" content="1800" />
    <title>${displayCity}</title>
</head>
<body bgcolor="#ffffff">`;

    if (weatherArray && weatherArray.length > 0) {
        const now = new Date();
        const tageNamen = ["SONNTAG", "MONTAG", "DIENSTAG", "MITTWOCH", "DONNERSTAG", "FREITAG", "SAMSTAG"];
        
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

            if (!dayEntry) dayEntry = weatherArray.find(e => (e.timestamp || '').startsWith(targetStr)) || null;

            if (dayEntry) {
                const tD = Math.round(dayEntry.temperature || 0);
                const tN = nightEntry ? Math.round(nightEntry.temperature || (tD - 5)) : (tD - 5);
                const cond = translateCondition(dayEntry.condition);
                
                let label = (d === 0) ? "HEUTE" : (d === 1) ? "MORGEN" : tageNamen[targetDate.getDay()];
                xml += `<p style="text-align:center;">\n    ${label}<br/>\n    ${cond}&nbsp;${tD}°C/${tN}°C\n</p>`;
            }
        }
    } else {
        xml += `<p style="text-align:center;">Lade Daten...<br/>Bitte warten</p>`;
    }

    xml += `</body></html>`;
    return res.send(xml);
});

// =========================================================================
// 3. ORTSSUCHE & LISTENAUSWAHL
// =========================================================================
const handleWeatherSearch = (req, res) => {
    let macRaw = req.query.mac || '';
    let hsid = req.query.handsetid || '';
    
    if (Array.isArray(macRaw)) macRaw = String(macRaw[0]);
    if (Array.isArray(hsid)) hsid = String(hsid[0]);
    if (macRaw.includes(',')) macRaw = macRaw.split(',')[0];

    const mac = macRaw.replace(/:/g, '').toUpperCase().trim();

    // Automatische Erfassung bei Aufruf der Suche
    if (mac && hsid) {
        const userAgent = req.headers['user-agent'] || ''; 
        let config = getConfig();
        
        if (!config.gateways) config.gateways = {};
        if (!config.gateways[mac]) config.gateways[mac] = { handsets: {} };
        if (!config.gateways[mac].handsets[hsid]) {
            config.gateways[mac].handsets[hsid] = { city: "", mode: "weather", lat: "", lon: "", hs_model: `Mobilteil ${hsid}`, box_model: "", box_fw: "" };
        }

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

            const modelMatch = userAgent.match(/Gigaset_([A-Za-z0-9]+)/);
            if (modelMatch && modelMatch[1]) {
                const detectedModel = modelMatch[1].replace('IP', '').trim();
                if (hs.hs_model.startsWith('Mobilteil') || hs.hs_model === '') {
                    hs.hs_model = `Gigaset ${detectedModel}`;
                    changed = true;
                }
            }
        }

        if (changed) {
            saveConfig(config);
            console.log(`[Sync] Gerätedaten aktualisiert für HS ${hsid}: ${hs.hs_model}`);
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
// 4. SPEICHERN & REFRESH
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

    if (macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim();
        let config = getConfig();

        if (!config.gateways) config.gateways = {};
        if (!config.gateways[mac]) config.gateways[mac] = { handsets: {} };
        if (!config.gateways[mac].handsets[hsid]) config.gateways[mac].handsets[hsid] = {};

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

    if (fromAdmin) {
        return res.redirect(`/admin.html?mac=${macRaw}&hsid=${hsid}`);
    }

    const xmlRedirectUrl = `/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}`;

    res.header('Content-Type', 'application/xhtml+xml; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');

    const xml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//OMA//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtmlmobile12.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Gespeichert</title><meta http-equiv="refresh" content="1; URL=${xmlRedirectUrl}" /></head><body><p style="text-align:center;"><b>STADT GESPEICHERT!</b></p></body></html>`;

    return res.send(xml);
});

// =========================================================================
// 5. WEB-ADMIN CONFIG API (Für admin.html)
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
// 6. WETTER-UPDATE DATA FETCH (Mit abgesichertem File-Schreibrecht-Check)
// =========================================================================
app.get('/info/weather_update', async (req, res) => {
    try {
        const config = getConfig();
        if (!config.gateways || Object.keys(config.gateways).length === 0) {
            return res.send("UPDATED: 0 (Keine Boxen registriert)");
        }

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
                // Falls noch kein Ort gewählt wurde, skippen, um API-Müll zu vermeiden
                if (!hs.lat || !hs.lon) continue;

                const apiUrl = `https://api.brightsky.dev/weather?lat=${hs.lat}&lon=${hs.lon}&date=${today}&last_date=${end}&units=dwd`;

                try {
                    const response = await fetch(apiUrl);
                    if (response.status === 200) {
                        const weatherData = await response.json();
                        cacheRoot.handsets[hsid] = {
                            city: hs.city || "Wetter",
                            lat: hs.lat,
                            lon: hs.lon,
                            weather: weatherData.weather || []
                        };
                        hasDataForBase = true;
                        updates++;
                    }
                } catch (apiErr) {
                    console.error(`Fehler beim BrightSky-Abruf für MAC ${safeMac}, HS ${hsid}:`, apiErr.message);
                }
            }

            // HIER IST DIE ABGESICHERTE RECHTE-KONTROLLE FÜR DIE CACHE-DATEI
            if (hasDataForBase) {
                const cacheFilePath = path.join(webInfDir, `cache_${safeMac}.json`);
                try {
                    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheRoot, null, 2), 'utf8');
                    console.log(`[Cache] Datei erfolgreich geschrieben: cache_${safeMac}.json`);
                } catch (writeErr) {
                    console.error(`[CRITICAL - RECHTE FEHLER] Keine Schreibrechte für Cache-Datei '${cacheFilePath}':`, writeErr.message);
                }
            }
        }

        return res.send(`UPDATED: ${updates}`);
    } catch (error) {
        console.error("Schwerwiegender Fehler im weather_update:", error);
        return res.status(500).send("UPDATED: 0 (Error)");
    }
});

// Root-Verzeichnis liefert die Admin-Oberfläche aus
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// =========================================================================
// AUTOMATISCHES WETTER-UPDATE IM CONTAINER (Alle 30 Minuten)
// =========================================================================
const DREISSIG_MINUTEN = 30 * 60 * 1000;

async function triggerInternalWeatherUpdate() {
    try {
        const response = await fetch(`http://localhost:${PORT}/info/weather_update`);
        const result = await response.text();
        console.log(`[Cron] Automatisches Update-Ergebnis: ${result}`);
    } catch (e) {
        console.error(`[Cron] Fehler bei automatischem Wetterupdate:`, e.message);
    }
}

// Erster Start verzögert nach 5 Sekunden
setTimeout(triggerInternalWeatherUpdate, 5000);
setInterval(triggerInternalWeatherUpdate, DREISSIG_MINUTEN);

app.listen(PORT, () => { console.log(`Schlanker Gigaset Rebirth Container laeuft auf Port ${PORT}`); });