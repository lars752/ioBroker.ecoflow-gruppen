'use strict';
/**
 * JSON-Import/-Export der Instanz-Konfiguration für die Admin-Oberfläche.
 * Rückgabeformat passt zu jsonConfig-sendTo mit useNative.
 */
const { DEFAULTS, normalizeConfig, rowsOf } = require('./model');

const ADAPTER = 'ecoflow-gruppen';
const FORMAT = 1;
const MAX_CHARS = 200000;

const collector = () => {
    const msgs = [];
    return { msgs, log: { debug() {}, info() {}, warn: (m) => msgs.push(m), error: (m) => msgs.push(m) } };
};
const flat = (cfg) => ({
    sourceAdapters: cfg.adapters.join(','),
    staleTimeoutSec: cfg.staleTimeoutSec,
    pruneOnStart: cfg.pruneOnStart,
    powerScale: cfg.powerScale,
    outputScale: cfg.outputScale,
    maxPowerW: cfg.maxPowerW,
    logWrites: cfg.logWrites,
    devices: rowsOf(cfg.devices),
});

function exportConfig(native) {
    const c = collector();
    const { cfg, errors } = normalizeConfig(native, c.log);
    const text = JSON.stringify({ adapter: ADAPTER, version: FORMAT, config: flat(cfg) }, null, 2);
    const notes = [];
    if (errors.length) notes.push(`${errors.length} ungültige Einstellung(en) – im Export steht der Standardwert bzw. der unveränderte Wert`);
    if (c.msgs.length) notes.push(`${c.msgs.length} ungültige Geräte-Zeile(n) nicht exportiert`);
    return {
        native: { configJson: text },
        result: `Konfiguration mit ${cfg.devices.length} Gerät(en) exportiert. Text aus dem Feld kopieren und sichern.${notes.length ? ` Hinweis: ${notes.join('; ')}.` : ''}`,
    };
}

function importConfig(text) {
    const raw = String(text || '').trim();
    if (!raw) return { error: 'Das Feld „Konfiguration (JSON)“ ist leer.' };
    if (raw.length > MAX_CHARS) return { error: 'Der Text ist zu groß (max. 200 000 Zeichen).' };
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return { error: `Kein gültiges JSON: ${e.message}` };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Erwartet wird ein JSON-Objekt.' };
    if (data.adapter !== undefined && data.adapter !== ADAPTER) return { error: `Export gehört zu „${data.adapter}“, erwartet „${ADAPTER}“.` };
    if (data.version !== undefined && data.version !== FORMAT) return { error: `Nicht unterstützte Formatversion ${data.version}.` };
    const src = data.config && typeof data.config === 'object' ? data.config : data;
    if (src.devices !== undefined && !Array.isArray(src.devices)) return { error: '„devices“ muss eine Liste sein.' };
    const c = collector();
    const { cfg, errors } = normalizeConfig(src, c.log);
    if (errors.length) return { error: `Ungültige Werte: ${errors.join('; ')}` };
    let result = `${cfg.devices.length} Gerät(e) übernommen. Bitte „Speichern und schließen“ drücken, um die Konfiguration zu aktivieren.`;
    if (c.msgs.length) result += ` Übersprungen: ${c.msgs.slice(0, 5).join('; ')}${c.msgs.length > 5 ? ` … (+${c.msgs.length - 5})` : ''}`;
    return { native: { ...flat(cfg), configJson: '' }, result };
}

module.exports = { exportConfig, importConfig, DEFAULTS };
