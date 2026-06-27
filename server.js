const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const app = express();
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
// 1. IMAGE PROXY (Spritesheet zuschnitt für Ruhezustand)
// =========================================================================
app.get('/info/:icon.bmp', async (req, res) => {
    const iconName = req.params.icon.toLowerCase();
    const userAgent = req.headers['user-agent'] || '';
    let targetSize = userAgent.toLowerCase().includes('pro') || userAgent.toLowerCase().includes('n510') ? 128 : 32;
    const sheetPath = path.join(__dirname, 'static', 'icons', '_spritesheet.png');
    
    if (!fs.existsSync(sheetPath)) return res.sendStatus(404);

    try {
        const size = 42; 
        // Fallback-Koordinaten (z.B. 0,0), falls kein Begriff matcht
        let col = 0, row = 0; 

        if (iconName.includes('sun') || iconName.includes('clear')) { col = 1; row = 1; }
        else if (iconName.includes('cloud')) { col = 3; row = 2; }
        else if (iconName.includes('rain') || iconName.includes('shower')) { col = 2; row = 3; }
        else if (iconName.includes('snow')) { col = 4; row = 0; }
        else if (iconName.includes('thunder') || iconName.includes('bolt')) { col = 0; row = 1; }
        else {
            // OPTIONAL: Definiere hier abweichende Standard-Koordinaten für unbekannte Wetterlagen
            col = 1; row = 1; // Standardmäßig z.B. Sonne/Clear
        }

        const imageBuffer = await sharp(sheetPath)
            .extract({ left: col * size, top: row * size, width: size, height: size })
            .resize(targetSize, targetSize, { kernel: 'bilinear' })
            .toFormat('bmp')
            .toBuffer();

        res.set({ 
            'Content-Type': 'image/bmp', 
            'Content-Length': imageBuffer.length, 
            'Cache-Control': 'no-cache, no-store, must-revalidate' 
        });
        res.send(imageBuffer);
    } catch (err) { res.sendStatus(500); }
});

// =========================================================================
// 2. TELEFON-EINSTIEG & AUTODISCOVERY (request.do)
// =========================================================================
app.get('/info/request.do', (req, res) => {
    const ua = req.headers['user-agent'] || ''; const macRaw = req.query.mac || ''; const hsid = req.query.handsetid || '';
    if (req.query.data) return res.redirect(`/info/${req.query.data}.bmp`);

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

    res.set('Content-Type', 'application/xhtml+xml');
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://wapforum.org">
<html xmlns="http://w3.org"><head><title>Menue</title></head><body><ul><li><a href="/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}">Wetter-Ort einstellen</a></li></ul></body></html>`);
});

// =========================================================================
// 3. ORTSSUCHE & LISTENAUSWAHL
// =========================================================================
app.get('/info/weather_search', (req, res) => {
    const mac = req.query.mac || ''; const hsid = req.query.handsetid || ''; let cities = [];
    if (fs.existsSync(CITIES_PATH)) { try { cities = JSON.parse(fs.readFileSync(CITIES_PATH, 'utf8')).cities || []; } catch(e){} }

    res.set('Content-Type', 'application/xhtml+xml');
    let html = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://wapforum.org">
<html xmlns="http://w3.org"><head><title>Ort waehlen</title></head><body bgcolor="#ffffff"><p style="text-align:center; font-weight:bold; color:#ff9900;">Ort waehlen</p><ul>`;
    cities.forEach(c => { html += `<li><a href="/info/weather_save?mac=${encodeURIComponent(mac)}&amp;handsetid=${encodeURIComponent(hsid)}&amp;city=${encodeURIComponent(c.name || 'Unbekannt')}">${c.name}</a></li>`; });
    html += `</ul><p style="text-align:center; font-size:small;"><a href="/info/request.do?mac=${encodeURIComponent(mac)}&amp;handsetid=${encodeURIComponent(hsid)}">Zurueck</a></p></body></html>`;
    res.send(html);
});

// =========================================================================
// 4. SPEICHERN & KORREKTER REFRESH
// =========================================================================
app.get('/info/weather_save', (req, res) => {
    const macRaw = req.query.mac || ''; const hsid = req.query.handsetid || ''; const city = req.query.city;
    if (macRaw && hsid) {
        const mac = macRaw.replace(/:/g, '').toUpperCase().trim(); let config = getConfig();
        if (config.gateways[mac] && config.gateways[mac].handsets[hsid]) { config.gateways[mac].handsets[hsid].city = city || "Unbekannt"; saveConfig(config); }
    }
    
    // Generiere saubere Rücksprung-URL statt dem unzuverlässigen 'url=prev'
    const redirectUrl = `/info/weather_search?mac=${encodeURIComponent(macRaw)}&amp;handsetid=${encodeURIComponent(hsid)}`;

    res.set({ 
        'Content-Type': 'application/xhtml+xml', 
        'Refresh': `1; url=${redirectUrl.replace(/&amp;/g, '&')}` // HTTP-Header verlangt echtes &
    });
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://wapforum.org">
<html xmlns="http://w3.org"><head><title>Gespeichert</title><meta http-equiv="refresh" content="1; URL=${redirectUrl}" /></head><body><p style="text-align:center; font-weight:bold; color:#2ecc71;">STADT GESPEICHERT!</p></body></html>`);
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