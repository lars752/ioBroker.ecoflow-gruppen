'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, buildModel, mergeSerials, serialsFromIds } = require('./lib/model');
const { EcoflowCore } = require('./lib/core');
const configio = require('./lib/configio');

class EcoflowGruppen extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'ecoflow-gruppen' });
        this.cache = new Map();
        this.queue = Promise.resolve();
        this.core = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (ecoflow-gruppen.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    /** Legt Kanäle und Datenpunkte an, passt Schreibrechte an und entfernt Altlasten. */
    async ensureStructure(model, prune) {
        const expected = new Set(['info', 'info.connection']);
        for (const ch of model.channels) {
            expected.add(ch.id);
            await this.extendObjectAsync(ch.id, { type: 'channel', common: { name: ch.name }, native: {} });
        }
        for (const st of model.states) {
            expected.add(st.id);
            await this.extendObjectAsync(st.id, { type: 'state', common: st.common, native: {} });
            const cur = await this.getStateAsync(st.id);
            if (!cur || cur.val === null) await this.setStateAsync(st.id, { val: st.common.def, ack: true });
        }
        if (prune) {
            const all = await this.getAdapterObjectsAsync();
            for (const full of Object.keys(all)) {
                const rel = full.slice(this.namespace.length + 1);
                if (rel && !expected.has(rel) && !rel.startsWith('info.')) {
                    await this.delObjectAsync(rel);
                    this.log.info(`Veralteten Datenpunkt entfernt: ${rel}`);
                }
            }
        }
        for (const [group, list] of Object.entries(model.groups)) await this.setStateChangedAsync(`${group}.info.Count`, { val: list.length, ack: true });
    }

    /** Abonnement-Muster je Gerät und Quell-Instanz: <adapter>.<seriennummer>.* */
    patterns(cfg) {
        const out = [];
        for (const a of cfg.adapters) {
            for (const d of cfg.devices) for (const s of new Set([d.serial, d.up])) out.push(`${a}.${s}.*`);
        }
        return out;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const { cfg, errors } = normalizeConfig(this.config, this.log);
        this.cfg = cfg;
        if (errors.length) {
            for (const e of errors) this.log.error(e);
            this.log.error('Konfiguration fehlerhaft – Adapter bleibt inaktiv. Bitte in der Instanz korrigieren');
            return;
        }
        if (!cfg.devices.length) this.log.warn('Keine gültigen Geräte konfiguriert – bitte die Gerätetabelle in der Instanz ausfüllen');
        const model = buildModel(cfg.devices);
        await this.ensureStructure(model, cfg.pruneOnStart);

        this.core = new EcoflowCore({
            cfg,
            log: this.log,
            io: {
                write: (id, val) => this.write(id, val),
                invalidate: (id) => this.cache.delete(id),
                setSource: (id, val) => this.setForeignStateAsync(id, { val, ack: false }),
                isWritable: async (id) => {
                    const o = await this.getForeignObjectAsync(id);
                    return !!(o && o.common && o.common.write === true);
                },
            },
        });

        for (const rel of this.core.targets.keys()) this.subscribeStates(rel);
        const pats = this.patterns(cfg);
        for (const p of pats) this.subscribeForeignStates(p);

        let count = 0;
        for (const p of pats) {
            const objs = (await this.getForeignObjectsAsync(p, 'state')) || {};
            for (const [id, obj] of Object.entries(objs)) {
                if (!this.core.parseId(id)) continue;
                this.core.addCandidate(id, !!(obj.common && obj.common.write === true));
                await this.core.handle(id, await this.getForeignStateAsync(id));
                count++;
            }
        }
        this.log.info(`Initial-Sync: ${count} Quell-Datenpunkte übernommen`);
        const missing = this.core.missingDevices();
        if (missing.length) this.log.warn(`Keine passenden Quell-Datenpunkte gefunden für: ${missing.map((d) => d.serial).join(', ')}. Seriennummer und Datenpunktnamen (permanentWatts, invOutputWatts) prüfen`);

        if (cfg.staleTimeoutSec > 0) this.staleTimer = setInterval(() => this.core.checkStale().catch((e) => this.log.error(e.message)), 30000);
        this.log.info(`Adapter gestartet (Quelle: ${cfg.adapters.join(', ')}), Datenpunkte unter ${this.namespace}.*`);
    }

    onStateChange(id, state) {
        if (!this.core || !state) return;
        const prefix = `${this.namespace}.`;
        if (id.startsWith(prefix)) {
            const rel = id.slice(prefix.length);
            if (state.ack === false && this.core.targets.has(rel)) {
                this.core.writeBack(rel, state).catch((e) => this.log.error(`Schreiben von ${rel}: ${e.message}`));
            }
            return;
        }
        this.core.handle(id, state).catch((e) => this.log.error(`Fehler bei ${id}: ${e.message}`));
    }

    /** Nachrichten der Admin-Oberfläche: JSON-Export/-Import und Geräte-Suche. */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else if (obj.command === 'discoverDevices') {
                const c = msg.config || {};
                const { cfg } = normalizeConfig(c);
                const ids = [];
                for (const a of cfg.adapters) ids.push(...Object.keys((await this.getForeignObjectsAsync(`${a}.*`, 'state')) || {}));
                const serials = serialsFromIds(ids, cfg.adapters);
                const { rows, added } = mergeSerials(c.devices, serials);
                reply = {
                    native: { devices: rows },
                    result: serials.size
                        ? `${serials.size} Gerät(e) gefunden, ${added.length} neu in die Tabelle übernommen. Bei neuen Zeilen die Gruppe eintragen (Zeilen ohne Gruppe werden ignoriert), danach „Speichern und schließen“ drücken.`
                        : `In ${cfg.adapters.join(', ')} wurden keine Geräte gefunden.`,
                };
            } else return;
        } catch (e) {
            reply = { error: `Fehler: ${e.message}` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    onUnload(callback) {
        try {
            if (this.staleTimer) clearInterval(this.staleTimer);
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) module.exports = (options) => new EcoflowGruppen(options);
else new EcoflowGruppen();
