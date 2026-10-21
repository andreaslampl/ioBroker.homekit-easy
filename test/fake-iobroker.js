'use strict';

/* Minimal ioBroker for tests: objects and foreign states in memory, adapter-core stub. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config || {};
        this.objects = {};
        this.foreign = {};
        this.writes = [];
        this.subs = new Set();
        this.log = options.log || { debug() {}, info() {}, warn() {}, error() {} };
        this.dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
        // devices confirm commands (ack) after this many ms; null = never
        this.ackDelay = 50;
        FakeAdapter.last = this;
    }
    async setState(id, val, ack) {
        this.foreign[`${this.namespace}.${id}`] = { val, ack, ts: Date.now() };
    }
    async getStateAsync(id) {
        return this.foreign[`${this.namespace}.${id}`] || null;
    }
    subscribeStates(pattern) {
        this.subs.add(`${this.namespace}.${pattern}`);
    }
    async getForeignObjectAsync(id) {
        return this.objects[id] ? { _id: id, ...this.objects[id] } : null;
    }
    async getForeignObjectsAsync(pattern, type) {
        const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
        const out = {};
        for (const [id, o] of Object.entries(this.objects)) {
            if (re.test(id) && (o.type || 'state') === type) {
                out[id] = { _id: id, type: 'state', ...o };
            }
        }
        return out;
    }
    async getForeignStatesAsync(pattern) {
        // like ioBroker: * matches anything, dots included
        const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
        return Object.fromEntries(Object.entries(this.foreign).filter(([id]) => re.test(id)));
    }
    async getForeignStateAsync(id) {
        return this.foreign[id] || null;
    }
    async subscribeForeignStatesAsync(id) {
        this.subs.add(id);
    }
    async unsubscribeForeignStatesAsync(id) {
        this.subs.delete(id);
    }
    async setForeignStateAsync(id, val, ack) {
        this.writes.push([id, val, ack]);
        this.change(id, val, ack);
        if (!ack && this.ackDelay !== null) {
            setTimeout(() => this.change(id, val, true), this.ackDelay);
        }
    }
    /** a device or another adapter changes a data point */
    change(id, val, ack = true) {
        this.foreign[id] = { val, ack, ts: Date.now(), lc: Date.now() };
        if (this.subs.has(id)) {
            setImmediate(() => this.emit('stateChange', id, this.foreign[id]));
        }
    }
    /** add a state object (and optionally a value) */
    add(id, common, val) {
        this.objects[id] = { type: 'state', common };
        if (val !== undefined) {
            this.foreign[id] = { val, ack: true, ts: Date.now() - 60000, lc: Date.now() - 60000 };
        }
    }
}

let installed = false;
function install() {
    if (installed) {
        return;
    }
    installed = true;
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')) };
        }
        return orig.call(this, request, ...rest);
    };
}

/** Data points of a small house: KNX, Shelly, sensors, alarm, livecam. */
function demoHouse(a, camBase = 'http://127.0.0.1:1') {
    a.add('knx.0.Licht.Wohnzimmer', { name: 'Licht Wohnzimmer', type: 'boolean', role: 'switch', write: true }, false);
    for (const c of ['R', 'G', 'B', 'W']) {
        a.add(`knx.0.RGBW.Wohnzimmer_${c}`, { name: `RGBW ${c}`, type: 'number', role: 'level.color', unit: '%', min: 0, max: 100, write: true }, 0);
    }
    a.add('knx.0.RGBW.Wohnzimmer_Schalten', { name: 'RGBW Ein/Aus', type: 'boolean', role: 'switch', write: true }, false);
    for (const c of ['red', 'green', 'blue', 'white']) {
        a.add(`shelly.0.SHRGBW2#1#1.color.${c}`, { name: c, type: 'number', role: 'level.color', min: 0, max: 255, write: true }, 0);
    }
    a.add('shelly.0.SHRGBW2#1#1.color.gain', { name: 'gain', type: 'number', role: 'level.brightness', min: 0, max: 100, write: true }, 0);
    a.add('shelly.0.SHRGBW2#1#1.color.Switch', { name: 'Switch', type: 'boolean', role: 'switch', write: true }, false);
    a.add('knx.0.Licht.Essen', { name: 'Dimmer Essen', type: 'number', role: 'level.dimmer', unit: '%', min: 0, max: 100, write: true }, 40);
    a.add('knx.0.Rollladen.Wohnzimmer', { name: 'Rollladen', type: 'number', role: 'level.blind', unit: '%', write: true }, 100);
    a.add('knx.0.Rollladen.Stop', { name: 'Stopp', type: 'boolean', role: 'button', write: true }, false);
    a.add('shelly.0.Garage.Taster', { name: 'Garagentor Taster', type: 'boolean', role: 'button', write: true }, false);
    a.add('knx.0.Garage.Kontakt', { name: 'Garagentor offen', type: 'boolean', role: 'sensor.door', write: false }, false);
    a.add('knx.0.Schloss', { name: 'Schloss', type: 'boolean', role: 'switch.lock', write: true }, true);
    a.add('knx.0.Heizung.Soll', { name: 'Sollwert', type: 'number', role: 'level.temperature', unit: '°C', min: 15, max: 28, write: true }, 21.5);
    a.add('knx.0.Heizung.Ist', { name: 'Istwert', type: 'number', role: 'value.temperature', unit: '°C', write: false }, 20.8);
    a.add('knx.0.Fenster.Kueche', { name: 'Fenster Küche', type: 'boolean', role: 'sensor.window', write: false }, false);
    a.add('knx.0.Bewegung.Flur', { name: 'Bewegung Flur', type: 'boolean', role: 'sensor.motion', write: false }, false);
    a.add('spc-edp.0.areas.1.state', { name: 'Bereich 1', type: 'number', role: 'value', write: true }, 0);
    a.add('0_userdata.0.Taster', { name: 'Taster', type: 'boolean', role: 'button', write: true }, false);
    a.add('livecam.0.intercom.ringing', { name: 'Läutet', type: 'boolean', role: 'indicator', write: false }, false);
    a.objects['livecam.0.cameras.haustuer'] = { type: 'channel', common: { name: 'Haustür' } };
    a.add('livecam.0.cameras.haustuer.snapshotUrl', { name: 'Snapshot', type: 'string', role: 'url' }, `${camBase}/cam/haustuer.jpg`);
    a.add('livecam.0.cameras.haustuer.mjpegUrl', { name: 'MJPEG', type: 'string', role: 'url' }, `${camBase}/cam/haustuer.mjpeg`);
}

module.exports = { FakeAdapter, install, demoHouse };
