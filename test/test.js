'use strict';
const assert = require('assert');
const { normalizeConfig, buildModel, mergeSerials, serialsFromIds, DEFAULTS } = require('../lib/model');
const { EcoflowCore } = require('../lib/core');
const { exportConfig, importConfig } = require('../lib/configio');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const logs = { warn: [], info: [], debug: [] };
const log = { debug: (m) => logs.debug.push(m), info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {} };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const S1 = 'HW51ZOH4SF765908';
const S2 = 'HW51ZOH4SF6T7860';
const S3 = 'HW51ZEH4SF5X9140';
const ROWS = [{ group: 'pv_garten', serial: S1 }, { group: 'pv_garten', serial: S2 }, { group: 'pv_oben', serial: S3 }];
const SRC = (serial, metric, adapter = 'ecoflow-mqtt.5') => `${adapter}.${serial}.quotas.${metric}`;

function mk(over = {}) {
    const t = { now: 5_000_000 };
    const w = {};
    const sets = [];
    const inval = [];
    const writable = {};
    const { cfg, errors } = normalizeConfig({ sourceAdapters: 'ecoflow-mqtt.5,ecoflow-mqtt.6', devices: ROWS, ...over }, silent);
    assert.deepStrictEqual(errors, []);
    const core = new EcoflowCore({
        cfg, log, now: () => t.now,
        io: {
            write: async (id, v) => { w[id] = v; },
            invalidate: (id) => inval.push(id),
            setSource: async (id, v) => { sets.push([id, v]); },
            isWritable: async (id) => writable[id] === true,
        },
    });
    return { t, w, sets, inval, writable, core, cfg };
}

(async () => {
    await test('Konfiguration: Standardwerte gültig, Namen automatisch WR1, WR2 …', () => {
        const r = normalizeConfig({}, silent);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.cfg.maxPowerW, 800);
        const d = normalizeConfig({ devices: [...ROWS, { group: 'pv_garten', serial: 'ABCDEF123456', name: 'egal' }] }, silent).cfg.devices;
        assert.deepStrictEqual(d.map((x) => `${x.group}.${x.name}`), ['pv_garten.WR1', 'pv_garten.WR2', 'pv_oben.WR1', 'pv_garten.WR3']);
    });
    await test('Konfiguration: Fehler in globalen Werten', () => {
        const r = normalizeConfig({ sourceAdapters: 'ecoflow', staleTimeoutSec: -1, powerScale: 0, outputScale: 'x', maxPowerW: 1e9 }, silent);
        assert.strictEqual(r.errors.length, 5);
    });
    await test('Konfiguration: ungültige Zeilen werden übersprungen', () => {
        logs.warn.length = 0;
        const r = normalizeConfig({ devices: [
            { group: 'a', serial: S1 },
            { group: 'a', serial: S1.toLowerCase() },  // doppelt (ohne Groß-/Kleinschreibung)
            { group: 'a b', serial: S2 },              // Leerzeichen
            { group: 'info', serial: S3 },             // reserviert
            { group: 'a', serial: 'xy' },              // zu kurz
            { group: '', serial: '' },                 // leer, still ignoriert
            { group: '', serial: S3 },                 // Gruppe fehlt
            null,
        ] }, log);
        assert.strictEqual(r.cfg.devices.length, 1);
        assert.strictEqual(logs.warn.length, 5);
    });
    await test('Modell: Kanäle, Datenpunkte, Schreibrecht nur beim Sollwert', () => {
        const m = buildModel(normalizeConfig({ devices: ROWS }, silent).cfg.devices);
        assert.strictEqual(m.states.length, 3 * 2 + 2 * 2);
        const p = m.states.find((s) => s.id === 'pv_garten.WR2.Power');
        const o = m.states.find((s) => s.id === 'pv_garten.WR2.InvOutputWatts');
        assert.strictEqual(p.common.write, true);
        assert.strictEqual(o.common.write, false);
        assert.strictEqual(m.states.find((s) => s.id === 'pv_garten.info.Count').common.def, 2);
    });
    await test('Seriennummern suchen und in die Tabelle übernehmen', () => {
        const ids = [`ecoflow-mqtt.5.${S1}.quotas.a`, `ecoflow-mqtt.5.info.connection`, `ecoflow-mqtt.9.${S2}.x.y`, `ecoflow-mqtt.6.${S3}.x.y`, `ecoflow-mqtt.5.${S3}.x`];
        const s = serialsFromIds(ids, ['ecoflow-mqtt.5', 'ecoflow-mqtt.6']);
        assert.deepStrictEqual([...s].sort(), [S3, S1].sort());
        const r = mergeSerials([{ group: 'g', serial: S1.toLowerCase() }], s);
        assert.deepStrictEqual(r.added, [S3]);
        assert.deepStrictEqual(r.rows[1], { group: '', serial: S3 });
    });
    await test('parseId: Instanz, Seriennummer (groß/klein), Metrik', () => {
        const { core } = mk();
        assert.strictEqual(core.parseId(SRC(S1, 'permanentWatts')).metric.key, 'Power');
        assert.strictEqual(core.parseId(SRC(S1.toLowerCase(), 'invOutputWatts', 'ecoflow-mqtt.6')).device.group, 'pv_garten');
        assert.strictEqual(core.parseId(SRC(S1, 'invOutputWatts', 'ecoflow-mqtt.7')), null);
        assert.strictEqual(core.parseId(SRC(S1, 'soc')), null);
        assert.strictEqual(core.parseId(SRC('HW51XXXXXXXXXXXX', 'invOutputWatts')), null);
        assert.strictEqual(core.parseId('x.y'), null);
    });
    await test('Spiegeln, Rundung, Skalierung und Gruppensumme', async () => {
        const { w, core } = mk({ outputScale: 0.1, powerScale: 0.1 });
        await core.handle(SRC(S1, 'invOutputWatts'), { val: 3005 });
        await core.handle(SRC(S2, 'invOutputWatts'), { val: '1234' });
        await core.handle(SRC(S3, 'permanentWatts'), { val: 4000 });
        assert.strictEqual(w['pv_garten.WR1.InvOutputWatts'], 300.5);
        assert.strictEqual(w['pv_garten.WR2.InvOutputWatts'], 123.4);
        assert.strictEqual(w['pv_garten.info.Total_Power'], 423.9);
        assert.strictEqual(w['pv_oben.WR1.Power'], 400);
        assert.strictEqual(w['pv_oben.info.Total_Power'], undefined); // Sollwert zählt nicht zur Summe
    });
    await test('Ungültige Quellwerte werden ignoriert', async () => {
        const { w, core } = mk();
        assert.strictEqual(await core.handle(SRC(S1, 'invOutputWatts'), { val: 'abc' }), 'invalid');
        assert.strictEqual(await core.handle(SRC(S1, 'invOutputWatts'), { val: null }), 'skip');
        assert.strictEqual(await core.handle(SRC(S1, 'invOutputWatts'), null), 'skip');
        assert.strictEqual(await core.handle(SRC(S1, 'foo'), { val: 1 }), 'ignored');
        assert.strictEqual(w['pv_garten.WR1.InvOutputWatts'], undefined);
    });
    await test('Stale-Timeout und Verbindungsstatus', async () => {
        const { w, t, core } = mk({ staleTimeoutSec: 60 });
        await core.handle(SRC(S1, 'invOutputWatts'), { val: 300 });
        assert.strictEqual(w['info.connection'], true);
        t.now += 61_000;
        await core.checkStale();
        assert.strictEqual(w['pv_garten.info.Total_Power'], 0);
        assert.strictEqual(w['info.connection'], false);
        await core.handle(SRC(S1, 'invOutputWatts'), { val: 50 });
        assert.strictEqual(w['pv_garten.info.Total_Power'], 50);
        assert.strictEqual(w['info.connection'], true);
    });
    await test('Ohne Stale-Timeout bleibt der letzte Wert', async () => {
        const { w, t, core } = mk();
        await core.handle(SRC(S1, 'invOutputWatts'), { val: 300 });
        t.now += 3_600_000; await core.checkStale();
        assert.strictEqual(w['pv_garten.info.Total_Power'], 300);
    });
    await test('Fehlende Geräte werden gemeldet', async () => {
        const { core } = mk();
        await core.handle(SRC(S1, 'invOutputWatts'), { val: 1 });
        assert.deepStrictEqual(core.missingDevices().map((d) => d.serial), [S2, S3]);
    });
    await test('Rückweg: Sollwert wird an die beschreibbare Quelle weitergereicht', async () => {
        const { core, sets, inval, writable } = mk();
        const ro = SRC(S1, 'permanentWatts');
        const rw = `ecoflow-mqtt.5.${S1}.set.permanentWatts`;
        writable[rw] = true;
        await core.handle(ro, { val: 100 });
        core.addCandidate(rw, null);
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: 420, ack: false }), 'ok');
        assert.deepStrictEqual(sets, [[rw, 420]]);
        assert.deepStrictEqual(inval, ['pv_garten.WR1.Power']);
    });
    await test('Rückweg: Skalierung, Begrenzung und Prüfungen', async () => {
        const { core, sets } = mk({ powerScale: 0.1, maxPowerW: 800 });
        core.addCandidate(SRC(S1, 'permanentWatts'), true);
        await core.writeBack('pv_garten.WR1.Power', { val: 300, ack: false });
        await core.writeBack('pv_garten.WR1.Power', { val: 5000, ack: false });
        await core.writeBack('pv_garten.WR1.Power', { val: -20, ack: false });
        assert.deepStrictEqual(sets.map((s) => s[1]), [3000, 8000, 0]);
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: 'x', ack: false }), 'invalid');
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: '', ack: false }), 'invalid');
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: 100, ack: true }), 'ignored');
        assert.strictEqual(await core.writeBack('pv_garten.WR1.InvOutputWatts', { val: 100, ack: false }), 'ignored');
        assert.strictEqual(sets.length, 3);
    });
    await test('Rückweg: maxPowerW = 0 schaltet die Obergrenze ab', async () => {
        const { core, sets } = mk({ maxPowerW: 0 });
        core.addCandidate(SRC(S1, 'permanentWatts'), true);
        await core.writeBack('pv_garten.WR1.Power', { val: 5000, ack: false });
        assert.strictEqual(sets[0][1], 5000);
    });
    await test('Rückweg: keine bekannte oder beschreibbare Quelle', async () => {
        logs.warn.length = 0;
        const { core } = mk();
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: 100, ack: false }), 'no-source');
        core.addCandidate(SRC(S1, 'permanentWatts'), false);
        assert.strictEqual(await core.writeBack('pv_garten.WR1.Power', { val: 100, ack: false }), 'no-writable-source');
        assert.strictEqual(logs.warn.length, 2);
    });
    await test('Rückweg: Protokollierung nur auf Wunsch als info', async () => {
        logs.info.length = 0; logs.debug.length = 0;
        const a = mk(); a.core.addCandidate(SRC(S1, 'permanentWatts'), true);
        await a.core.writeBack('pv_garten.WR1.Power', { val: 10, ack: false });
        assert.strictEqual(logs.info.length, 0); assert.strictEqual(logs.debug.length, 1);
        const b = mk({ logWrites: true }); b.core.addCandidate(SRC(S1, 'permanentWatts'), true);
        await b.core.writeBack('pv_garten.WR1.Power', { val: 10, ack: false });
        assert.strictEqual(logs.info.length, 1);
    });

    await test('Export/Import: Rundlauf', () => {
        const native = { ...DEFAULTS, sourceAdapters: 'ecoflow-mqtt.5, ecoflow-mqtt.6', staleTimeoutSec: 90, powerScale: 0.1, maxPowerW: 1200, logWrites: true, devices: ROWS, configJson: 'alt' };
        const ex = exportConfig(native);
        const parsed = JSON.parse(ex.native.configJson);
        assert.strictEqual(parsed.adapter, 'ecoflow-gruppen');
        assert.strictEqual(JSON.stringify(parsed).includes('alt'), false);
        assert.strictEqual(parsed.config.devices.length, 3);
        const im = importConfig(ex.native.configJson);
        assert.strictEqual(im.error, undefined);
        assert.strictEqual(im.native.sourceAdapters, 'ecoflow-mqtt.5,ecoflow-mqtt.6');
        assert.strictEqual(im.native.powerScale, 0.1);
        assert.strictEqual(im.native.logWrites, true);
        assert.deepStrictEqual(im.native.devices, parsed.config.devices);
        assert.strictEqual(im.native.configJson, '');
    });
    await test('Import: reines config-Objekt, ungültige Zeilen, Namen ignoriert', () => {
        const im = importConfig(JSON.stringify({ devices: [{ group: 'a', serial: S1, name: 'x' }, { group: 'b c', serial: S2 }] }));
        assert.deepStrictEqual(im.native.devices, [{ group: 'a', serial: S1 }]);
        assert.strictEqual(im.native.sourceAdapters, 'ecoflow-mqtt.0');
        assert.ok(im.result.includes('Übersprungen'));
    });
    await test('Import: Fehlerfälle', () => {
        assert.ok(importConfig('').error);
        assert.ok(importConfig('{kaputt').error);
        assert.ok(importConfig('[1]').error);
        assert.ok(importConfig('{"adapter":"netzlimit","config":{}}').error);
        assert.ok(importConfig('{"version":3,"config":{}}').error);
        assert.ok(importConfig('{"config":{"devices":"x"}}').error);
        assert.ok(importConfig('{"config":{"sourceAdapters":"ecoflow"}}').error);
        assert.ok(importConfig('{"config":{"powerScale":0}}').error);
        assert.ok(importConfig('x'.repeat(200001)).error);
    });
    await test('io-package.json: Standardwerte passen zum Modell', () => {
        const io = require('../io-package.json');
        assert.deepStrictEqual({ ...io.native, configJson: undefined }, { ...DEFAULTS, configJson: undefined });
        assert.strictEqual(io.native.configJson, '');
        assert.strictEqual(require('../package.json').version, io.common.version);
        assert.deepStrictEqual(normalizeConfig(io.native, silent).errors, []);
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
