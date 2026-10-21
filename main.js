'use strict';

const os = require('node:os');
const utils = require('@iobroker/adapter-core');
const { HomekitBridge } = require('./lib/bridge');
const { TYPES, catalog } = require('./lib/devices');
const { cameraTypes } = require('./lib/camera');
const { DeviceStore } = require('./lib/store');
const { SetupServer } = require('./lib/server');

const CAMERA_ID = /^livecam\.\d+\.cameras\.[^.]+$/;

function localAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
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
            meta: id => this.meta.get(id) || {},
            set: (id, val) => this.write(id, val).catch(err => this.log.warn(`HomeKit -> ${id}: ${err.message}`)),
        };
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
                catalog: () => [...catalog(), ...Object.entries(extraTypes).map(([type, t]) => ({ type, label: t.label, group: t.group, fields: t.fields, options: t.options }))],
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
                }),
                resetPairing: () => this.resetPairing(),
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
        await this.setState('info.connection', true, true);
        this.log.info(`HomeKit bridge "${this.bridge.name}" running with ${this.bridge.accessories.size} device(s); setup page http://${host}:${port}/`);
    }

    async saveDevices(list) {
        const devices = this.store.save(list);
        await this.readMeta(devices);
        this.bridge.update(devices);
        await this.resubscribe();
        await this.setState('info.devices', this.bridge.accessories.size, true);
        return devices;
    }

    async resetPairing() {
        await this.bridge.resetPairing(this.store.devices);
        await this.resubscribe();
        await this.setState('info.paired', false, true);
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
                this.values.set(id, { val: st.val, ack: st.ack, ts: st.ts });
            }
            this.bridge.notify(id);
        }
    }

    onStateChange(id, state) {
        if (!this.subscribed.has(id)) {
            return;
        }
        if (state) {
            this.values.set(id, { val: state.val, ack: state.ack, ts: state.ts });
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
        this.values.set(id, { val: v, ack: false, ts: Date.now() });
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
