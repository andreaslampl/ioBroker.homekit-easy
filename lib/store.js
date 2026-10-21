'use strict';

/* Device list in devices.json (instance data directory), validated against the device types. */

const fs = require('node:fs');
const path = require('node:path');
const { ALEXA_TYPES } = require('./alexa');

const ALEXA = new Set(Object.keys(ALEXA_TYPES));

class DeviceStore {
    /** @param {string} dir @param {object} types device types (with fields/options) */
    constructor(dir, types) {
        this.file = path.join(dir, 'devices.json');
        this.types = types;
        try {
            this.devices = this.clean(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        } catch {
            this.devices = [];
        }
    }

    clean(list) {
        const seen = new Set();
        return (Array.isArray(list) ? list : []).slice(0, 300).flatMap((d, i) => {
            const t = d && this.types[d.type];
            if (!t) {
                return [];
            }
            let id = /^[\w-]{1,40}$/.test(String(d.id || '')) ? String(d.id) : `d${i + 1}`;
            while (seen.has(id)) {
                id += 'x';
            }
            seen.add(id);
            const out = { id, type: d.type, name: String(d.name || '').slice(0, 64).trim() || t.label, enabled: d.enabled !== false };
            if (d.alexa && ALEXA.has(d.type)) {
                out.alexa = true;
            }
            for (const [key] of t.fields) {
                const v = String(d[key] || '').trim().slice(0, 300);
                if (v) {
                    out[key] = v;
                }
            }
            for (const [key, , kind, def] of t.options) {
                const raw = d[key] === undefined ? def : d[key];
                if (raw === undefined || raw === '' || raw === null) {
                    continue;
                }
                if (kind === 'check') {
                    out[key] = Boolean(raw);
                } else if (kind === 'number') {
                    const n = Number(raw);
                    if (Number.isFinite(n)) {
                        out[key] = n;
                    }
                } else if (kind.startsWith('select:')) {
                    const allowed = kind.slice(7).split(';').map(o => o.split('=')[0]);
                    out[key] = allowed.includes(String(raw)) ? String(raw) : allowed[0];
                } else {
                    out[key] = String(raw).slice(0, 300);
                }
            }
            return [out];
        });
    }

    save(list) {
        this.devices = this.clean(list);
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.devices, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
        return this.devices;
    }

    /** Data points the devices may write (the setup page shows; the bridge writes only these). */
    writable() {
        const ids = new Set();
        for (const d of this.devices) {
            for (const [key, , mode] of this.types[d.type].fields) {
                if (mode === 'w' && d[key]) {
                    ids.add(d[key]);
                }
            }
            // security: the command falls back to the status data point
            if (d.type === 'security' && !d.command && d.status) {
                ids.add(d.status);
            }
        }
        return ids;
    }
}

module.exports = { DeviceStore };
