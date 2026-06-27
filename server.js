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
// 3. ORTSSUCHE & LISTENAUSWAHL
// =========================================================================
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
// 4. SPEICHERN & REFRESH (Zurück zur Ortssuche)
// =========================================================================
app.get('/info/weather_save', (req, res) => {
    const macRaw = req.query.mac || ''; const hsid = req.query.handsetid || ''; const city = req.query.city;
    if (macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim(); let config = getConfig();
        if (config.gateways[mac] && config.gateways[mac].handsets[hsid]) { config.gateways[mac].handsets[hsid].city = city || "Unbekannt"; saveConfig(config); }
    }
    
    const redirectUrl = `/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}`;

    res.set({ 
        'Content-Type': 'application/xhtml+xml', 
        'Refresh': `1; url=${redirectUrl.replace(/&amp;/g, '&')}`
    });
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Gespeichert</title><meta http-equiv="refresh" content="1; URL=${redirectUrl}" /></head><body><p style="text-align:center; font-weight:bold; color:#2ecc71;">STADT GESPEICHERT!</p></body></html>`);
});

// =========================================================================
// 5. REST-API FÜR DAS KUNDENCENTER
// =========================================================================
app.get('/api/config', (req, res) => { res.json(getConfig()); });
app.post('/api/save', (req, res) => {
    const { mac, hsid, city } = req.body; if (!mac || !hsid) return res.status(400).json({ error: 'Missing params' });
    let config = getConfig(); const cleanMac = mac.replace(/:/g, '').toUpperCase().trim();
    if (config.gateways[cleanMac] && config.gateways[cleanMac].handsets[hsid]) {
        config.gateways[cleanMac].handsets[hsid].city = city || "Unbekannt"; saveConfig(config); return res.json({ success: true });
    }
    res.status(404).json({ error: 'Device not found' });
});

// Start-Routing für PC-Browser
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Schlanker Gigaset Rebirth Container laeuft auf Port ${PORT}`); });