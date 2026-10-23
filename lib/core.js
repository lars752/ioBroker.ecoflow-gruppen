'use strict';
const { METRICS, SUM_KEY } = require('./model');

const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Kernlogik: ordnet Quell-Datenpunkte (<adapter>.<seriennummer>.….<metrik>) Gruppen zu, spiegelt Soll- und
 * Ausgangsleistung, bildet pro Gruppe die Summe und reicht Schreibzugriffe auf den Sollwert an die Quelle weiter.
 *
 * io.write(rel, val)       -> Promise   eigene Zustände (ack=true)
 * io.invalidate(rel)       -> void      Zwischenspeicher eines eigenen Zustands verwerfen
 * io.setSource(id, val)    -> Promise   Quelle beschreiben (ack=false)
 * io.isWritable(id)        -> Promise<boolean>  Objekt der Quelle ist beschreibbar
 */
class EcoflowCore {
    constructor({ cfg, io, log, now }) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.now = now || Date.now;
        this.bySerial = new Map(cfg.devices.map((d) => [d.up, d]));
        this.groups = {};
        for (const d of cfg.devices) (this.groups[d.group] = this.groups[d.group] || []).push(d);
        const alt = [...this.bySerial.keys()].map(esc).join('|');
        this.serialRe = alt ? new RegExp(`^(${alt})$`, 'i') : /(?!)/;
        this.targets = new Map(); // Ziel-ID (relativ) -> { device, metric }
        for (const d of cfg.devices) for (const m of Object.values(METRICS)) if (m.writable) this.targets.set(`${d.group}.${d.name}.${m.key}`, { device: d, metric: m });
        this.cache = new Map();      // SERIAL -> { val, ts } (Ausgangsleistung)
        this.candidates = new Map(); // Ziel-ID -> Map(Quell-ID -> beschreibbar true/false/null)
        this.lastSum = {};
        this.lastConn = null;
        this.seen = new Set();
    }

    parseId(id) {
        const parts = String(id).split('.');
        if (parts.length < 4 || !this.cfg.adapters.includes(`${parts[0]}.${parts[1]}`)) return null;
        const device = this.serialRe.test(parts[2]) ? this.bySerial.get(parts[2].toUpperCase()) : null;
        const metric = METRICS[parts[parts.length - 1].toLowerCase()];
        return device && metric ? { device, metric } : null;
    }

    targetOf(device, metric) { return `${device.group}.${device.name}.${metric.key}`; }

    addCandidate(srcId, writable) {
        const p = this.parseId(srcId);
        if (!p || !p.metric.writable) return;
        const t = this.targetOf(p.device, p.metric);
        const m = this.candidates.get(t) || new Map();
        if (writable !== null && writable !== undefined) m.set(srcId, writable);
        else if (!m.has(srcId)) m.set(srcId, null);
        this.candidates.set(t, m);
    }

    /** Spiegelt einen Quellwert auf den Zieldatenpunkt. */
    async handle(id, state) {
        if (!state || state.val === null || state.val === undefined) return 'skip';
        const p = this.parseId(id);
        if (!p) return 'ignored';
        const raw = Number(state.val);
        if (!Number.isFinite(raw)) return 'invalid';
        const { device, metric } = p;
        const val = round1(raw * this.cfg[metric.scaleKey]);
        this.seen.add(device.up);
        this.addCandidate(id, undefined);
        if (metric.key === SUM_KEY) this.cache.set(device.up, { val, ts: this.now() });
        await this.io.write(this.targetOf(device, metric), val);
        if (metric.key === SUM_KEY) {
            await this.updateGroupSum(device.group);
            await this.updateConnection();
        }
        return 'ok';
    }

    async updateGroupSum(group) {
        let sum = 0;
        for (const d of this.groups[group] || []) {
            const e = this.cache.get(d.up);
            if (!e || this.isStale(e)) continue;
            sum += e.val;
        }
        sum = round1(sum);
        if (this.lastSum[group] === sum) return;
        this.lastSum[group] = sum;
        await this.io.write(`${group}.info.Total_Power`, sum);
    }

    isStale(e) { return this.cfg.staleTimeoutSec > 0 && this.now() - e.ts > this.cfg.staleTimeoutSec * 1000; }

    async checkStale() {
        if (this.cfg.staleTimeoutSec <= 0) return;
        for (const g of Object.keys(this.groups)) await this.updateGroupSum(g);
        await this.updateConnection();
    }

    async updateConnection() {
        const conn = [...this.cache.values()].some((e) => !this.isStale(e));
        if (conn === this.lastConn) return;
        this.lastConn = conn;
        await this.io.write('info.connection', conn);
    }

    missingDevices() { return this.cfg.devices.filter((d) => !this.seen.has(d.up)); }

    /** Schreibzugriff (ack=false) auf einen Soll-Datenpunkt -> Quelle. */
    async writeBack(rel, state) {
        const t = this.targets.get(rel);
        if (!t || !state || state.ack) return 'ignored';
        let val = Number(state.val);
        if (state.val === null || state.val === '' || !Number.isFinite(val)) {
            this.log.warn(`Ungültiger Wert für ${rel}: ${state.val}`);
            return 'invalid';
        }
        const max = this.cfg.maxPowerW;
        if (val < 0 || (max > 0 && val > max)) {
            const clamped = Math.min(Math.max(val, 0), max > 0 ? max : val);
            this.log.warn(`${rel}: Wert ${val} W außerhalb von 0…${max || '∞'} W, begrenzt auf ${clamped} W`);
            val = clamped;
        }
        const cands = this.candidates.get(rel);
        if (!cands || !cands.size) {
            this.log.warn(`Kein Quell-Datenpunkt für ${rel} bekannt (noch kein Wert vom Adapter empfangen)`);
            return 'no-source';
        }
        let src = null;
        for (const [id, w] of cands) {
            let writable = w;
            if (writable === null) { writable = await this.io.isWritable(id); cands.set(id, writable); }
            if (writable === true) { src = id; break; }
        }
        if (!src) {
            this.log.warn(`Keine beschreibbare Quelle für ${rel}. Kandidaten: ${[...cands.keys()].join(', ')}`);
            return 'no-writable-source';
        }
        const out = parseFloat((val / this.cfg.powerScale).toFixed(3));
        await this.io.setSource(src, out);
        this.io.invalidate(rel);
        (this.cfg.logWrites ? this.log.info : this.log.debug).call(this.log, `${rel} = ${val} W -> ${src} = ${out}`);
        return 'ok';
    }
}

module.exports = { EcoflowCore };
