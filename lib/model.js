'use strict';
/**
 * Konfigurationsprüfung und Datenmodell.
 * Struktur: <gruppe>.<WRn>.<Power|InvOutputWatts>, <gruppe>.info.<Count|Total_Power>
 * Der Anzeigename WR1, WR2, … wird je Gruppe in Tabellenreihenfolge automatisch vergeben.
 * Ein Gerät wird in der Quell-Instanz über das dritte ID-Segment (<adapter>.<N>.<segment>.…) erkannt:
 * Seriennummer (ecoflow-mqtt) und/oder frei vergebene Geräte-ID (z. B. ecoflow-ps-ble). Mindestens eines von beiden ist nötig.
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
        const sourceId = String((row && row.sourceId) || '').trim();
        const where = `Zeile ${i + 1}`;
        if (!group && !serial && !sourceId) continue;
        if (!SEG.test(group) || group.toLowerCase() === 'info') { warn(`${where}: Gruppe „${group}“ ungültig (erlaubt: A-Z, 0-9, _, -; „info“ ist reserviert) – übersprungen`); continue; }
        if (!serial && !sourceId) { warn(`${where}: Seriennummer oder Geräte-ID der Quelle fehlt – übersprungen`); continue; }
        if (serial && !SERIAL.test(serial)) { warn(`${where}: Seriennummer „${serial}“ ungültig (6–32 Zeichen, A-Z, 0-9) – übersprungen`); continue; }
        if (sourceId && (!SEG.test(sourceId) || sourceId.toLowerCase() === 'info')) { warn(`${where}: Geräte-ID „${sourceId}“ ungültig (erlaubt: A-Z, 0-9, _, -; „info“ ist reserviert) – übersprungen`); continue; }
        const keys = [...new Set([serial, sourceId].filter(Boolean).map((s) => s.toUpperCase()))];
        const dup = keys.find((k) => serials.has(k));
        if (dup) { warn(`${where}: ${serial || sourceId} doppelt zugeordnet – übersprungen`); continue; }
        for (const k of keys) serials.add(k);
        counters[group] = (counters[group] || 0) + 1;
        cfg.devices.push({ group, name: `WR${counters[group]}`, serial, sourceId, up: keys[0], keys });
    }
    return { cfg, errors, warnings };
}

const rowsOf = (devices) => devices.map((d) => (d.sourceId ? { group: d.group, serial: d.serial, sourceId: d.sourceId } : { group: d.group, serial: d.serial }));
const labelOf = (d) => d.serial || d.sourceId;

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
            channels.push({ id: `${group}.${d.name}`, name: `${d.name} (${labelOf(d)})` });
            for (const m of Object.values(METRICS)) {
                states.push({ id: `${group}.${d.name}.${m.key}`, common: { name: `${d.name} (${labelOf(d)}) - ${m.name}`, type: 'number', unit: 'W', role: m.role, read: true, write: m.writable, def: 0 } });
            }
        }
    }
    return { channels, states, groups };
}

/** Ergänzt die Tabelle um gefundene, noch nicht eingetragene Seriennummern bzw. Geräte-IDs (Gruppe bleibt leer). */
function mergeSerials(rows, serials) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
    const have = new Set();
    for (const r of out) for (const k of [r.serial, r.sourceId]) if (k && String(k).trim()) have.add(String(k).trim().toUpperCase());
    const added = [];
    for (const s of [...serials].sort()) {
        if (have.has(s.toUpperCase())) continue;
        out.push(SERIAL.test(s) ? { group: '', serial: s } : { group: '', serial: '', sourceId: s });
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

/**
 * Geräte-Kennungen aus Objekt-IDs <adapter>.<N>.<segment>.…: Seriennummern wie bisher; zusätzlich frei vergebene Geräte-IDs
 * (z. B. PS1 bei ecoflow-ps-ble), sofern der Datenpunkt eine der gespiegelten Metriken ist.
 */
function sourceKeysFromIds(ids, adapters) {
    const out = new Set();
    for (const id of ids) {
        const parts = String(id).split('.');
        if (parts.length < 4 || !adapters.includes(`${parts[0]}.${parts[1]}`)) continue;
        const seg = parts[2];
        if (seg.toLowerCase() === 'info') continue;
        if (SERIAL.test(seg) || (SEG.test(seg) && METRICS[parts[parts.length - 1].toLowerCase()])) out.add(seg);
    }
    return out;
}

module.exports = { serialsFromIds, sourceKeysFromIds, labelOf, METRICS, SUM_KEY, DEFAULTS, normalizeConfig, rowsOf, buildModel, mergeSerials, SERIAL };
