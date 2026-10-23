'use strict';
/**
 * Konfigurationsprüfung und Datenmodell.
 * Struktur: <gruppe>.<WRn>.<Power|InvOutputWatts>, <gruppe>.info.<Count|Total_Power>
 * Der Anzeigename WR1, WR2, … wird je Gruppe in Tabellenreihenfolge automatisch vergeben.
 */
const SEG = /^[A-Za-z0-9_-]+$/;
const SERIAL = /^[A-Za-z0-9]{6,32}$/;
const INSTANCE = /^[A-Za-z0-9_-]+\.\d+$/;

// Schlüssel = letzter Pfadabschnitt des Quell-Datenpunkts, KLEIN geschrieben
const METRICS = {
    permanentwatts: { key: 'Power', name: 'Soll-Leistung (permanentWatts)', scaleKey: 'powerScale', writable: true, role: 'level' },
    invoutputwatts: { key: 'InvOutputWatts', name: 'Ausgangsleistung (invOutputWatts)', scaleKey: 'outputScale', writable: false, role: 'value.power' },
};
const SUM_KEY = 'InvOutputWatts';

const DEFAULTS = {
    sourceAdapters: 'ecoflow-mqtt.0',
    staleTimeoutSec: 0,
    pruneOnStart: true,
    powerScale: 1,
    outputScale: 1,
    maxPowerW: 800,
    logWrites: false,
    devices: [],
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Prüft die komplette Konfiguration: Fehler in globalen Werten -> errors, ungültige Zeilen -> Warnung + übersprungen. */
function normalizeConfig(native, log = silent) {
    const n = native || {};
    const errors = [];
    const warnings = [];
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const cfg = {};

    const adapters = String(n.sourceAdapters === undefined ? DEFAULTS.sourceAdapters : n.sourceAdapters).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = adapters.find((a) => !INSTANCE.test(a));
    if (!adapters.length || bad) errors.push(`Quell-Instanz „${bad || ''}“ ungültig (erwartet z. B. ecoflow-mqtt.0)`);
    cfg.adapters = adapters;

    const number = (key, label, min, max) => {
        const raw = n[key] === undefined || n[key] === '' ? DEFAULTS[key] : n[key];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label} muss zwischen ${min} und ${max} liegen (ist: ${raw})`); cfg[key] = DEFAULTS[key]; return; }
        cfg[key] = v;
    };
    number('staleTimeoutSec', 'Stale-Timeout', 0, 86400);
    number('powerScale', 'Skalierung Sollwert', 0.000001, 1000000);
    number('outputScale', 'Skalierung Ausgangsleistung', 0.000001, 1000000);
    number('maxPowerW', 'Maximale Sollleistung', 0, 100000);
    cfg.pruneOnStart = n.pruneOnStart !== false && n.pruneOnStart !== 'false';
    cfg.logWrites = n.logWrites === true || n.logWrites === 'true';

    cfg.devices = [];
    const serials = new Set();
    const counters = {};
    for (const [i, row] of (Array.isArray(n.devices) ? n.devices : []).entries()) {
        const group = String((row && row.group) || '').trim();
        const serial = String((row && row.serial) || '').trim();
        const where = `Zeile ${i + 1}`;
        if (!group && !serial) continue;
        if (!SEG.test(group) || group.toLowerCase() === 'info') { warn(`${where}: Gruppe „${group}“ ungültig (erlaubt: A-Z, 0-9, _, -; „info“ ist reserviert) – übersprungen`); continue; }
        if (!SERIAL.test(serial)) { warn(`${where}: Seriennummer „${serial}“ ungültig (6–32 Zeichen, A-Z, 0-9) – übersprungen`); continue; }
        const up = serial.toUpperCase();
        if (serials.has(up)) { warn(`${where}: Seriennummer ${serial} doppelt zugeordnet – übersprungen`); continue; }
        serials.add(up);
        counters[group] = (counters[group] || 0) + 1;
        cfg.devices.push({ group, name: `WR${counters[group]}`, serial, up });
    }
    return { cfg, errors, warnings };
}

const rowsOf = (devices) => devices.map((d) => ({ group: d.group, serial: d.serial }));

/** Kanäle und Datenpunkte (IDs relativ zum Namensraum der Instanz). */
function buildModel(devices) {
    const channels = [];
    const states = [];
    const groups = {};
    for (const d of devices) (groups[d.group] = groups[d.group] || []).push(d);
    for (const [group, list] of Object.entries(groups)) {
        channels.push({ id: group, name: `Gruppe ${group}` }, { id: `${group}.info`, name: `Information ${group}` });
        states.push(
            { id: `${group}.info.Count`, common: { name: `Anzahl Geräte in ${group}`, type: 'number', role: 'value', read: true, write: false, def: list.length } },
            { id: `${group}.info.Total_Power`, common: { name: `Gesamt-Ausgangsleistung ${group}`, type: 'number', unit: 'W', role: 'value.power', read: true, write: false, def: 0 } },
        );
        for (const d of list) {
            channels.push({ id: `${group}.${d.name}`, name: `${d.name} (${d.serial})` });
            for (const m of Object.values(METRICS)) {
                states.push({ id: `${group}.${d.name}.${m.key}`, common: { name: `${d.name} (${d.serial}) - ${m.name}`, type: 'number', unit: 'W', role: m.role, read: true, write: m.writable, def: 0 } });
            }
        }
    }
    return { channels, states, groups };
}

/** Ergänzt die Tabelle um gefundene, noch nicht eingetragene Seriennummern (Gruppe bleibt leer). */
function mergeSerials(rows, serials) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
    const have = new Set(out.map((r) => String(r.serial || '').trim().toUpperCase()));
    const added = [];
    for (const s of [...serials].sort()) {
        if (have.has(s.toUpperCase())) continue;
        out.push({ group: '', serial: s });
        added.push(s);
    }
    return { rows: out, added };
}

/** Seriennummern aus Objekt-IDs <adapter>.<seriennummer>.…; adapters = erlaubte Quell-Instanzen. */
function serialsFromIds(ids, adapters) {
    const out = new Set();
    for (const id of ids) {
        const parts = String(id).split('.');
        if (parts.length >= 4 && adapters.includes(`${parts[0]}.${parts[1]}`) && SERIAL.test(parts[2]) && parts[2].toLowerCase() !== 'info') out.add(parts[2]);
    }
    return out;
}

module.exports = { serialsFromIds, METRICS, SUM_KEY, DEFAULTS, normalizeConfig, rowsOf, buildModel, mergeSerials, SERIAL };
