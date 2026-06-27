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
app.get('/info/request.do', (req, res) => {
    const ua = req.headers['user-agent'] || ''; 
    const macRaw = req.query.mac || ''; 
    const hsid = req.query.handsetid || '';

    // Autodiscovery & Registrierung in der Config
    if (ua && macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim();
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
        if (!config.gateways[mac]) { config.gateways[mac] = { handsets: {} }; changed = true; }
        if (!config.gateways[mac].handsets[hsid]) {
            config.gateways[mac].handsets[hsid] = { mode: "weather", city: "Mitteldachstetten", box_model: baseModel, box_fw: fwVersion, hs_model: hsModel };
            changed = true;
        } else {
            let hs = config.gateways[mac].handsets[hsid];
            if (hs.box_fw !== fwVersion || hs.box_model !== baseModel || hs.hs_model !== hsModel) {
                hs.box_model = baseModel; hs.box_fw = fwVersion; hs.hs_model = hsModel; changed = true;
            }
        }
        if (changed) saveConfig(config);
    }

    // Antwort für den Wetter-Screensaver (valides XML)
    res.set('Content-Type', 'application/xhtml+xml');
    return res.send(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Wetter</title></head>
<body>
    <div>
        <p style="text-align:center; font-weight:bold;">Mitteldachstetten</p>
        <p style="text-align:center;">18 Grad - Heiter</p>
    </div>
</body>
</html>`);
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