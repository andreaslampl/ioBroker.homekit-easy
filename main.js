'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { HomekitBridge } = require('./lib/bridge');
const { TYPES, catalog } = require('./lib/devices');
const { cameraTypes } = require('./lib/camera');
const { DeviceStore } = require('./lib/store');
const { SetupServer } = require('./lib/server');
const { HueBridge } = require('./lib/hue');
const { ALEXA_TYPES, alexaLights } = require('./lib/alexa');

const CAMERA_ID = /^livecam\.\d+\.cameras\.[^.]+$/;

function localAddress() {
    return localInterface().address;
}

function localInterface() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a;
            }
        }
    }
    return { address: '127.0.0.1', mac: '' };
}

function truthy(v) {
    if (typeof v === 'string') {
        return v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
    }
    return Boolean(v);
}

class HomekitEasy extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'homekit-easy' });
        this.values = new Map(); // state id -> {val, ack, ts}
        this.meta = new Map(); // state id -> {type, min, max, unit}
        this.subscribed = new Set();
        this.stateCache = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const dir = this.dataDir || utils.getAbsoluteInstanceDataDir(this);
        const extraTypes = cameraTypes({ cameraUrls: id => this.cameraUrls(id), ffmpegPath: String(this.config.ffmpegPath || '').trim() || 'ffmpeg', log: this.log, spawnFn: this.spawnFn });
        this.types = { ...TYPES, ...extraTypes };
        this.store = new DeviceStore(dir, this.types);

        const x = {
            val: id => {
                const st = id && this.values.get(id);
                return st ? st.val : undefined;
            },
            bool: (id, invert) => {
                const st = id && this.values.get(id);
                const v = st ? truthy(st.val) : false;
                return invert ? !v : v;
            },
            num: (id, def) => {
                const st = id && this.values.get(id);
                const v = st ? (typeof st.val === 'boolean' ? Number(st.val) : Number(st.val)) : NaN;
                return Number.isFinite(v) && st.val !== null && st.val !== '' ? v : def;
            },
            // when the value last changed (a device that repeats its values does not count)
            ts: id => {
                const st = id && this.values.get(id);
                return st ? st.lc || st.ts || 0 : 0;
            },
            meta: id => this.meta.get(id) || {},
            set: (id, val) => this.write(id, val).catch(err => this.log.warn(`HomeKit -> ${id}: ${err.message}`)),
        };
        this.x = x;
        this.dir = dir;
        this.bridge = new HomekitBridge({
            dir,
            name: this.config.bridgeName || 'ioBroker',
            port: Number(this.config.hapPort) || 51828,
            bind: this.bindAddresses,
            x,
            log: this.log,
            extraTypes,
        });
        this.bridge.on('paired', paired => this.setState('info.paired', paired, true));
        await this.readMeta(this.store.devices);
        try {
            await this.bridge.start(this.store.devices);
        } catch (err) {
            this.log.error(`HomeKit bridge cannot start on port ${Number(this.config.hapPort) || 51828}: ${err.message}`);
            return;
        }
        await this.resubscribe();

        const port = Number(this.config.port) || 8100;
        const key = String(this.config.accessKey || '').trim();
        this.server = new SetupServer({
            accessKey: key,
            log: this.log,
            adapter: {
                catalog: () =>
                    [...catalog(), ...Object.entries(extraTypes).map(([type, t]) => ({ type, label: t.label, group: t.group, fields: t.fields, options: t.options }))].map(c => ({
                        ...c,
                        alexa: Boolean(ALEXA_TYPES[c.type]),
                    })),
                devices: () => this.store.devices,
                saveDevices: list => this.saveDevices(list),
                objectList: fresh => this.objectList(fresh),
                stateValues: ids => this.stateValues(ids),
                cameras: () => this.cameras(),
                pairing: () => ({
                    name: this.bridge.name,
                    paired: this.bridge.paired,
                    pincode: this.bridge.identity.pincode,
                    setupURI: this.bridge.setupURI,
                    devices: this.bridge.accessories.size,
                    alexa: this.alexaInfo(),
                }),
                resetPairing: () => this.resetPairing(),
                smartviewTiles: () => this.askSmartview('tiles', {}),
                smartviewLink: tiles => this.askSmartview('link', { tiles }),
            },
        });
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port} for the setup page: ${err.message}`);
        }
        const host = String(this.config.publicHost || '').trim() || localAddress();
        await this.setState('info.setupUrl', `http://${host}:${port}/${key ? `?key=${encodeURIComponent(key)}` : ''}`, true);
        await this.setState('info.devices', this.bridge.accessories.size, true);
        await this.startAlexa();
        await this.setState('info.connection', true, true);
        this.log.info(`HomeKit bridge "${this.bridge.name}" running with ${this.bridge.accessories.size} device(s); setup page http://${host}:${port}/`);
    }

    async saveDevices(list) {
        const devices = this.store.save(list);
        await this.readMeta(devices);
        this.bridge.update(devices);
        await this.resubscribe();
        await this.startAlexa();
        await this.setState('info.devices', this.bridge.accessories.size, true);
        return devices;
    }

    /**
     * Messages from other adapters:
     *   devices -> {devices, types}  (SmartView: "aus homekit-easy übernehmen")
     *   sync {devices}               (SmartView: tiles with "auch in HomeKit")
     */
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        const reply = res => obj.callback && this.sendTo(obj.from, obj.command, res, obj.callback);
        const from = String(obj.from || '').replace(/^system\.adapter\./, '');
        if (!this.store || !this.bridge) {
            return reply({ error: 'homekit-easy startet noch' });
        }
        try {
            if (obj.command === 'devices') {
                return reply({ devices: this.store.devices, types: Object.fromEntries(Object.entries(this.types).map(([k, t]) => [k, t.label])) });
            }
            if (obj.command === 'sync') {
                if (!/^smartview\.\d+$/.test(from)) {
                    return reply({ error: `sync from ${from} not allowed` });
                }
                const m = this.store.mergeFrom(from, obj.message && obj.message.devices);
                if (m.created || m.updated || m.removed) {
                    await this.saveDevices(m.list);
                    this.log.info(`${from}: ${m.created} device(s) created, ${m.updated} updated, ${m.removed} removed`);
                }
                return reply({ ok: true, created: m.created, updated: m.updated, removed: m.removed, total: this.store.devices.filter(d => d.source === from).length });
            }
            reply({ error: `unknown command ${obj.command}` });
        } catch (err) {
            this.log.warn(`Message ${obj.command} from ${from}: ${err.message}`);
            reply({ error: err.message });
        }
    }

    /** sendTo the first SmartView instance; resolves with its answer or {error}. */
    async askSmartview(command, message) {
        const objs = await this.getForeignObjectsAsync('system.adapter.smartview.*', 'instance').catch(() => ({}));
        const instance = Object.keys(objs || {})
            .map(id => id.replace('system.adapter.', ''))
            .filter(id => /^smartview\.\d+$/.test(id))
            .sort()[0];
        if (!instance) {
            return { error: 'SmartView ist nicht installiert', missing: true };
        }
        const alive = await this.getForeignStateAsync(`system.adapter.${instance}.alive`).catch(() => null);
        if (!alive || !alive.val) {
            return { error: `${instance} läuft nicht` };
        }
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve({ error: `${instance} antwortet nicht` }), 20000);
            this.sendTo(instance, command, message, res => {
                clearTimeout(timer);
                resolve(res && typeof res === 'object' ? { instance, ...res } : { error: 'keine Antwort' });
            });
        });
    }

    async resetPairing() {
        await this.bridge.resetPairing(this.store.devices);
        await this.resubscribe();
        await this.setState('info.paired', false, true);
    }

    // ---------------- Alexa (Hue emulation, lib/hue.js) ----------------

    /** alexa.json: bridge MAC and the light number of every device (Alexa remembers the numbers). */
    alexaData() {
        if (!this.alexaStore) {
            const file = path.join(this.dir, 'alexa.json');
            let data = {};
            try {
                data = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                // new
            }
            const mac = String(localInterface().mac || '').replace(/:/g, '');
            data.mac = /^[0-9a-f]{12}$/i.test(String(data.mac || '')) ? data.mac : /^[0-9a-f]{12}$/i.test(mac) && mac !== '000000000000' ? mac : crypto.randomBytes(6).toString('hex');
            data.ids = data.ids && typeof data.ids === 'object' ? data.ids : {};
            this.alexaStore = { file, data };
            this.saveAlexaData();
        }
        return this.alexaStore.data;
    }

    saveAlexaData() {
        fs.writeFileSync(this.alexaStore.file, JSON.stringify(this.alexaStore.data, null, 1));
    }

    alexaId(deviceId) {
        const data = this.alexaData();
        if (!data.ids[deviceId]) {
            data.ids[deviceId] = String(Math.max(0, ...Object.values(data.ids).map(Number)) + 1);
            this.saveAlexaData();
        }
        return data.ids[deviceId];
    }

    alexaLights() {
        return alexaLights(this.store.devices, this.x, id => this.alexaId(id));
    }

    /** Start the Hue emulation as soon as one device is meant for Alexa. */
    async startAlexa() {
        if (this.hue || this.alexaError || !this.store.devices.some(d => d.alexa && ALEXA_TYPES[d.type])) {
            return;
        }
        const port = Number(this.config.alexaPort) || 80;
        const host = String(this.config.publicHost || '').trim();
        const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : localAddress();
        const hue = new HueBridge({ ip, port, mac: this.alexaData().mac, name: this.config.bridgeName || 'ioBroker', lights: () => this.alexaLights(), log: this.log, ssdpPort: this.ssdpPort });
        try {
            await hue.start();
            this.hue = hue;
            this.log.info(`Alexa: ready on http://${ip}:${hue.port}/ - say "Alexa, suche Geräte"`);
        } catch (err) {
            this.alexaError = err.code === 'EADDRINUSE' ? `Port ${port} ist schon belegt` : err.code === 'EACCES' ? `Port ${port} darf nicht geöffnet werden (Rechte)` : err.message;
            this.log.error(`Alexa: cannot open port ${port}: ${err.message}`);
        }
    }

    alexaInfo() {
        const devices = this.store.devices.filter(d => d.alexa && ALEXA_TYPES[d.type]).length;
        return {
            devices,
            running: Boolean(this.hue),
            error: this.alexaError || '',
            port: this.hue ? this.hue.port : Number(this.config.alexaPort) || 80,
            lastSeen: this.hue && this.hue.lastSeen ? this.hue.lastSeen.at : null,
            lastFrom: this.hue && this.hue.lastSeen ? this.hue.lastSeen.from : '',
        };
    }

    /** Object type/min/max of all data points of the devices (before building them). */
    async readMeta(devices) {
        for (const d of devices) {
            for (const [key] of (this.types[d.type] || { fields: [] }).fields) {
                const id = d[key];
                if (id && !CAMERA_ID.test(id) && !this.meta.has(id)) {
                    const obj = await this.getForeignObjectAsync(id).catch(() => null);
                    if (!obj) {
                        this.log.warn(`Data point ${id} (${d.name}) does not exist`);
                    }
                    const c = (obj && obj.common) || {};
                    this.meta.set(id, { type: c.type || '', min: c.min, max: c.max, unit: c.unit || '' });
                }
            }
        }
    }

    /** Subscribe what the devices show, read the current values and push them to HomeKit. */
    async resubscribe() {
        const ids = new Set(this.bridge.watchedIds());
        for (const id of this.subscribed) {
            if (!ids.has(id)) {
                await this.unsubscribeForeignStatesAsync(id);
                this.subscribed.delete(id);
            }
        }
        for (const id of ids) {
            if (!this.subscribed.has(id)) {
                await this.subscribeForeignStatesAsync(id);
                this.subscribed.add(id);
            }
            const st = await this.getForeignStateAsync(id).catch(() => null);
            if (st) {
                this.values.set(id, { val: st.val, ack: st.ack, ts: st.ts, lc: st.lc || st.ts });
            }
            this.bridge.notify(id);
        }
    }

    onStateChange(id, state) {
        if (!this.subscribed.has(id)) {
            return;
        }
        if (state) {
            this.values.set(id, { val: state.val, ack: state.ack, ts: state.ts, lc: state.lc || state.ts });
        } else {
            this.values.delete(id);
        }
        this.bridge.notify(id);
    }

    /** Command from Apple Home: only to data points configured for writing, with the object's type. */
    async write(id, val) {
        if (!this.store.writable().has(id)) {
            throw new Error('not configured for writing');
        }
        const { type } = this.meta.get(id) || {};
        let v = val;
        if (type === 'boolean') {
            v = val === true || val === 1 || val === 'true';
        } else if (type === 'number') {
            v = typeof val === 'boolean' ? (val ? 1 : 0) : Number(val);
        } else if (type === 'string') {
            v = String(val);
        }
        this.log.debug(`HomeKit -> ${id} = ${v}`);
        // show it at once; the device's confirmation replaces it
        const prev = this.values.get(id);
        this.values.set(id, { val: v, ack: false, ts: Date.now(), lc: prev && prev.val === v ? prev.lc : Date.now() });
        await this.setForeignStateAsync(id, v, false);
    }

    async cameraUrls(id) {
        if (!CAMERA_ID.test(String(id || ''))) {
            return null;
        }
        const get = async s => {
            const st = await this.getForeignStateAsync(`${id}.${s}`).catch(() => null);
            return st && typeof st.val === 'string' && /^https?:\/\//.test(st.val) ? st.val : '';
        };
        return { jpg: await get('snapshotUrl'), mjpeg: await get('mjpegUrl') };
    }

    async cameras() {
        const objs = await this.getForeignObjectsAsync('livecam.*', 'channel').catch(() => ({}));
        const name = n => (typeof n === 'object' && n ? n.de || n.en || Object.values(n)[0] || '' : String(n || ''));
        return Object.values(objs || {})
            .filter(o => o && CAMERA_ID.test(o._id))
            .map(o => ({ id: o._id, name: name(o.common && o.common.name) || o._id.split('.').pop() }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async objectList(fresh) {
        if (fresh || !this.stateCache || Date.now() - this.stateCache.at > 300000) {
            const name = n => (typeof n === 'object' && n ? n.de || n.en || Object.values(n)[0] || '' : String(n || ''));
            const states = await this.getForeignObjectsAsync('*', 'state');
            const folders = {};
            for (const type of ['device', 'channel', 'folder', 'instance', 'adapter']) {
                const objs = await this.getForeignObjectsAsync('*', type).catch(() => ({}));
                for (const o of Object.values(objs || {})) {
                    if (o && o.type === type && o.common && o.common.name) {
                        folders[o._id] = name(o.common.name);
                    }
                }
            }
            this.stateCache = {
                at: Date.now(),
                folders,
                list: Object.values(states).map(o => {
                    const c = o.common || {};
                    return { id: o._id, name: name(c.name), type: c.type || '', role: c.role || '', unit: c.unit || '', write: c.write !== false };
                }),
            };
        }
        return this.stateCache;
    }

    async stateValues(ids) {
        const out = {};
        await Promise.all(
            ids.slice(0, 300).map(async id => {
                const st = await this.getForeignStateAsync(id).catch(() => null);
                out[id] = st ? st.val : null;
            }),
        );
        return out;
    }

    async onUnload(callback) {
        try {
            if (this.server) {
                await this.server.close();
            }
            if (this.hue) {
                await this.hue.stop();
            }
            if (this.bridge) {
                await this.bridge.stop();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new HomekitEasy(options);
} else {
    new HomekitEasy();
}
