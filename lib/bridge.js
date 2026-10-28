'use strict';

/*
 * The HomeKit bridge: one paired bridge in Apple Home, one bridged accessory per configured device.
 * Identity (username = HomeKit "MAC", PIN, setup ID) lives in identity.json, HAP pairing data in
 * hap/ of the instance data directory. Device changes are applied while published (accessories are
 * added/removed/rebuilt), so Apple Home keeps rooms and names of unchanged devices.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Bridge, Accessory, Service, Characteristic, uuid, HAPStorage, Categories, AccessoryEventTypes } = require('hap-nodejs');
const { TYPES } = require('./devices');

const MAX_DEVICES = 149; // HomeKit limit for bridged accessories
// PINs Apple does not accept
const BAD_PINS = new Set(['000-00-000', '111-11-111', '222-22-222', '333-33-333', '444-44-444', '555-55-555', '666-66-666', '777-77-777', '888-88-888', '999-99-999', '123-45-678', '876-54-321']);

function randomPin() {
    for (;;) {
        const d = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
        const pin = `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
        if (!BAD_PINS.has(pin)) {
            return pin;
        }
    }
}

function randomUsername() {
    const b = crypto.randomBytes(6);
    b[0] = (b[0] & 0xfe) | 0x02; // locally administered, unicast
    return [...b].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function randomSetupId() {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

/** HomeKit accepts names of letters, digits, spaces and a few signs, starting and ending with a letter/digit. */
function homekitName(name, fallback = 'Gerät') {
    const clean = String(name || '')
        .replace(/[^\p{L}\p{N} '’.,-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        .slice(0, 64);
    return clean || fallback;
}

class HomekitBridge extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.dir instance data directory
     * @param {object} o.x data point access for the devices (see lib/devices.js)
     * @param {object} [o.extraTypes] more device types (cameras)
     */
    constructor({ dir, name = 'ioBroker', port = 51828, bind, x, log, extraTypes = {} }) {
        super();
        this.dir = dir;
        this.name = homekitName(name, 'ioBroker');
        this.port = port;
        this.bind = bind;
        this.x = x;
        this.log = log;
        this.types = { ...TYPES, ...extraTypes };
        this.accessories = new Map(); // device id -> {acc, conf, watchers: [[id, fn]], cleanup}
        this.watchers = new Map(); // state id -> Set(fn)
        this.identity = this._identity();
        // one storage per process (each instance runs in its own process: compact mode is off)
        try {
            HAPStorage.setCustomStoragePath(path.join(dir, 'hap'));
        } catch (err) {
            log.warn(`HomeKit storage: ${err.message}`);
        }
    }

    _identity() {
        const file = path.join(this.dir, 'identity.json');
        let id = null;
        try {
            id = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            // first start
        }
        if (!id || !id.username || !id.pincode || !id.setupID) {
            id = { username: randomUsername(), pincode: randomPin(), setupID: randomSetupId() };
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(id, null, 1), { mode: 0o600 });
        }
        return id;
    }

    async start(devices) {
        this.bridge = new Bridge(this.name, uuid.generate(`homekit-easy:bridge:${this.identity.username}`));
        this.bridge
            .getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'ioBroker')
            .setCharacteristic(Characteristic.Model, 'HomeKit Easy')
            .setCharacteristic(Characteristic.SerialNumber, this.identity.username);
        this.bridge.on(AccessoryEventTypes.PAIRED, () => this.emit('paired', true));
        this.bridge.on(AccessoryEventTypes.UNPAIRED, () => this.emit('paired', this.paired));
        this.update(devices);
        await this.bridge.publish({
            username: this.identity.username,
            pincode: this.identity.pincode,
            setupID: this.identity.setupID,
            port: this.port,
            category: Categories.BRIDGE,
            bind: this.bind,
        });
        this.emit('paired', this.paired);
    }

    async stop() {
        if (this.bridge) {
            for (const a of this.accessories.values()) {
                a.cleanup.forEach(fn => fn());
            }
            // only unpublish: Accessory.destroy() would delete the pairing data (hap/AccessoryInfo.*.json), so every
            // adapter restart or update made Apple Home lose the bridge. resetPairing() removes it on purpose.
            await this.bridge.unpublish();
            this.bridge = null;
        }
    }

    get paired() {
        const info = this.bridge && this.bridge._accessoryInfo;
        return Boolean(info && typeof info.paired === 'function' && info.paired());
    }

    get setupURI() {
        return this.bridge ? this.bridge.setupURI() : '';
    }

    /** Apply the device list: add new, rebuild changed, remove deleted accessories. */
    update(devices) {
        const wanted = new Map();
        for (const d of devices) {
            if (d.enabled !== false && this.types[d.type] && wanted.size < MAX_DEVICES) {
                wanted.set(d.id, d);
            }
        }
        if (devices.filter(d => d.enabled !== false).length > MAX_DEVICES) {
            this.log.warn(`HomeKit allows at most ${MAX_DEVICES} devices per bridge - the rest is left out`);
        }
        const remove = [];
        for (const [id, a] of this.accessories) {
            const d = wanted.get(id);
            if (!d || JSON.stringify(d) !== a.conf) {
                remove.push(id);
            }
        }
        for (const id of remove) {
            this._remove(id);
        }
        const add = [];
        for (const [id, d] of wanted) {
            if (!this.accessories.has(id)) {
                const acc = this._build(d);
                if (acc) {
                    add.push(acc);
                }
            }
        }
        if (add.length) {
            this.bridge.addBridgedAccessories(add);
        }
        if (remove.length || add.length) {
            this.log.info(`HomeKit: ${this.accessories.size} device(s)${add.length ? `, ${add.length} added/changed` : ''}${remove.length ? `, ${remove.length} removed/changed` : ''}`);
        }
    }

    _build(d) {
        const type = this.types[d.type];
        const name = homekitName(d.name, type.label);
        const acc = new Accessory(name, uuid.generate(`homekit-easy:${d.id}:${d.type}`));
        acc.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'ioBroker')
            .setCharacteristic(Characteristic.Model, type.label.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().slice(0, 64) || 'Gerät')
            .setCharacteristic(Characteristic.SerialNumber, d.id);
        const entry = { acc, conf: JSON.stringify(d), watchers: [], cleanup: [] };
        const x = {
            ...this.x,
            watch: (ids, fn) => {
                for (const id of ids.filter(Boolean)) {
                    if (!this.watchers.has(id)) {
                        this.watchers.set(id, new Set());
                    }
                    this.watchers.get(id).add(fn);
                    entry.watchers.push([id, fn]);
                }
            },
            onCleanup: fn => entry.cleanup.push(fn),
        };
        try {
            type.build(acc, { ...d, name }, x);
        } catch (err) {
            this.log.warn(`HomeKit: device "${d.name}" (${d.type}) could not be created: ${err.message}`);
            entry.cleanup.forEach(fn => fn());
            for (const [id, fn] of entry.watchers) {
                this.watchers.get(id) && this.watchers.get(id).delete(fn);
            }
            return null;
        }
        this.accessories.set(d.id, entry);
        return acc;
    }

    _remove(id) {
        const a = this.accessories.get(id);
        if (!a) {
            return;
        }
        for (const [sid, fn] of a.watchers) {
            const set = this.watchers.get(sid);
            if (set) {
                set.delete(fn);
                if (!set.size) {
                    this.watchers.delete(sid);
                }
            }
        }
        a.cleanup.forEach(fn => fn());
        this.bridge.removeBridgedAccessory(a.acc, false);
        this.accessories.delete(id);
    }

    /** Data points the devices read. */
    watchedIds() {
        return [...this.watchers.keys()];
    }

    /** A data point changed. */
    notify(id) {
        for (const fn of this.watchers.get(id) || []) {
            try {
                fn();
            } catch (err) {
                this.log.debug(`HomeKit update ${id}: ${err.message}`);
            }
        }
    }

    /** Forget all pairings: new identity, Apple Home must add the bridge again. */
    async resetPairing(devices) {
        const old = this.identity.username;
        await this.stop();
        // pairing data of the old identity (HAP storage path stays the same)
        Accessory.cleanupAccessoryData(old);
        fs.rmSync(path.join(this.dir, 'identity.json'), { force: true });
        this.accessories.clear();
        this.watchers.clear();
        this.identity = this._identity();
        this.log.info('HomeKit: pairing reset - add the bridge again in Apple Home (new code on the setup page)');
        await this.start(devices);
    }
}

module.exports = { HomekitBridge, homekitName, randomPin, MAX_DEVICES };
