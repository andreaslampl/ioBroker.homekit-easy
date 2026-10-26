'use strict';

/*
 * Alexa without cloud: the Echo devices find a "Hue bridge" (API v1) in the home network and control
 * its lights locally - no skill, no account. Alexa only knows lights there, so every device appears as
 * a lamp: on/off and brightness 0-100 % (a blind: on = open, brightness = how far open).
 *
 *   SSDP (UDP 1900)   answers M-SEARCH with the address of /description.xml
 *   HTTP (port 80)    /description.xml, POST /api (user), GET /api/<user>[/lights[/<n>]], config,
 *                     PUT /api/<user>/lights/<n>/state {on, bri}
 * The Echo devices insist on port 80.
 */

const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { xyToHs, hsToXy } = require('./color');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

/** 0-100 % <-> Hue brightness 1-254 */
const toBri = pct => Math.max(1, Math.min(254, Math.round((pct / 100) * 254)));
const toPct = bri => Math.max(0, Math.min(100, Math.round((bri / 254) * 100)));

class HueBridge extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.ip address announced to the Echo devices
     * @param {number} [o.port] HTTP port (Echo devices need 80)
     * @param {string} o.mac bridge MAC (12 hex digits)
     * @param {string} o.name
     * @param {() => Array<{id: string, name: string, kind: 'dimmable'|'onoff', get: () => {on: boolean, pct: number}, set: (s: {on?: boolean, pct?: number}) => void}>} o.lights
     */
    constructor({ ip, port = 80, mac, name = 'ioBroker', lights, log, ssdpPort = SSDP_PORT }) {
        super();
        this.ip = ip;
        this.port = port;
        this.mac = mac.toLowerCase();
        this.name = name;
        this.lights = lights;
        this.log = log;
        this.ssdpPort = ssdpPort;
        this.bridgeId = `${this.mac.slice(0, 6)}fffe${this.mac.slice(6)}`.toUpperCase();
        this.uuid = `2f402f80-da50-11e1-9b23-${this.mac}`;
        this.lastSeen = null; // {at, from} last request of an Echo device
        this.recent = new Map(); // light id -> {on, pct, until}: commanded state until the device reports it
        this.http = http.createServer((req, res) => this._handle(req, res).catch(err => this._json(res, 500, [{ error: { type: 901, address: req.url, description: err.message } }])));
    }

    async start() {
        await new Promise((resolve, reject) => {
            this.http.once('error', reject);
            this.http.listen(this.port, '0.0.0.0', () => {
                this.http.removeListener('error', reject);
                resolve();
            });
        });
        this.port = this.http.address().port;
        await this._startSsdp().catch(err => this.log.warn(`Alexa: SSDP (UDP ${this.ssdpPort}) not available: ${err.message} - the Echo devices may not find the bridge`));
    }

    stop() {
        if (this.ssdp) {
            try {
                this.ssdp.close();
            } catch {
                // closed
            }
        }
        this.http.closeAllConnections();
        return new Promise(resolve => this.http.close(() => resolve()));
    }

    _startSsdp() {
        return new Promise((resolve, reject) => {
            const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            s.once('error', reject);
            s.on('message', (msg, rinfo) => this._ssdp(msg.toString(), rinfo));
            s.bind(this.ssdpPort, () => {
                s.removeListener('error', reject);
                s.on('error', err => this.log.debug(`Alexa SSDP: ${err.message}`));
                try {
                    s.addMembership(SSDP_ADDR);
                } catch (err) {
                    this.log.debug(`Alexa SSDP membership: ${err.message}`);
                }
                this.ssdp = s;
                resolve();
            });
        });
    }

    _ssdp(text, rinfo) {
        if (!/^M-SEARCH/i.test(text)) {
            return;
        }
        const st = (/^ST:\s*(.+)$/im.exec(text) || [])[1];
        const target = st ? st.trim() : '';
        if (!['ssdp:all', 'upnp:rootdevice', 'urn:schemas-upnp-org:device:basic:1', 'urn:schemas-upnp-org:device:Basic:1'].includes(target) && !target.startsWith('uuid:2f402f80')) {
            return;
        }
        const base = [
            'HTTP/1.1 200 OK',
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
            'EXT:',
            'CACHE-CONTROL: max-age=100',
            `LOCATION: http://${this.ip}:${this.port}/description.xml`,
            'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0',
            `hue-bridgeid: ${this.bridgeId}`,
        ];
        const answers = [
            [`ST: upnp:rootdevice`, `USN: uuid:${this.uuid}::upnp:rootdevice`],
            [`ST: uuid:${this.uuid}`, `USN: uuid:${this.uuid}`],
            [`ST: urn:schemas-upnp-org:device:basic:1`, `USN: uuid:${this.uuid}`],
        ];
        answers.forEach((a, i) => {
            const buf = Buffer.from(`${[...base, ...a].join('\r\n')}\r\n\r\n`);
            setTimeout(() => this.ssdp && this.ssdp.send(buf, rinfo.port, rinfo.address, () => {}), 50 + i * 50);
        });
        this.log.debug(`Alexa: discovery from ${rinfo.address} answered`);
    }

    // ---------------- HTTP (Hue API v1) ----------------

    _json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    async _body(req) {
        let text = '';
        for await (const c of req) {
            text += c;
            if (text.length > 10000) {
                throw new Error('too large');
            }
        }
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return {};
        }
    }

    _description() {
        return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${this.ip}:${this.port}/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>${this.name} (${this.ip})</friendlyName>
<manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL>
<modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2012</modelName>
<modelNumber>929000226503</modelNumber>
<modelURL>http://www.meethue.com</modelURL>
<serialNumber>${this.mac}</serialNumber>
<UDN>uuid:${this.uuid}</UDN>
<presentationURL>index.html</presentationURL>
</device>
</root>
`;
    }

    _config() {
        const m = this.mac;
        return {
            name: this.name,
            bridgeid: this.bridgeId,
            mac: `${m.slice(0, 2)}:${m.slice(2, 4)}:${m.slice(4, 6)}:${m.slice(6, 8)}:${m.slice(8, 10)}:${m.slice(10, 12)}`,
            modelid: 'BSB002',
            datastoreversion: '70',
            swversion: '1709131301',
            apiversion: '1.17.0',
            dhcp: true,
            ipaddress: this.ip,
            netmask: '255.255.255.0',
            gateway: this.ip,
            linkbutton: true,
            portalservices: false,
            zigbeechannel: 15,
            factorynew: false,
            replacesbridgeid: null,
            starterkitid: '',
            whitelist: {},
        };
    }

    /** State Alexa sees: what was just commanded (for a few seconds), else what the device reports. */
    _state(l) {
        const r = this.recent.get(l.id);
        if (r && r.until > Date.now()) {
            return r;
        }
        this.recent.delete(l.id);
        return l.get();
    }

    _light(l) {
        const s = this._state(l);
        const unique = crypto.createHash('md5').update(`homekit-easy:${l.id}`).digest('hex');
        const uniqueid = `00:17:88:01:${unique.slice(0, 2)}:${unique.slice(2, 4)}:${unique.slice(4, 6)}:${unique.slice(6, 8)}-0b`;
        const common = { name: l.name, uniqueid, swversion: '1.46.13_r26312', swupdate: { state: 'noupdates', lastinstall: null } };
        if (l.kind === 'color') {
            const hue = Math.round(((s.h || 0) / 360) * 65535);
            const sat = Math.round(((s.s || 0) / 100) * 254);
            return {
                state: {
                    on: Boolean(s.on),
                    bri: toBri(s.pct > 0 ? s.pct : 100),
                    hue,
                    sat,
                    effect: 'none',
                    xy: hsToXy(s.h || 0, s.s || 0),
                    ct: s.ct || 370,
                    alert: 'none',
                    colormode: s.mode === 'ct' ? 'ct' : 'hs',
                    mode: 'homeautomation',
                    reachable: true,
                },
                type: 'Extended color light',
                modelid: 'LCT015',
                manufacturername: 'Philips',
                productname: 'Hue color lamp',
                capabilities: {
                    certified: true,
                    control: { mindimlevel: 1000, maxlumen: 806, colorgamuttype: 'C', ct: { min: 153, max: 500 } },
                    streaming: { renderer: true, proxy: false },
                },
                config: { archetype: 'sultanbulb', function: 'mixed', direction: 'omnidirectional' },
                ...common,
            };
        }
        if (l.kind === 'onoff') {
            return {
                state: { on: Boolean(s.on), alert: 'select', mode: 'homeautomation', reachable: true },
                type: 'On/Off plug-in unit',
                modelid: 'LOM001',
                manufacturername: 'Philips',
                productname: 'Hue Smart plug',
                ...common,
            };
        }
        return {
            state: { on: Boolean(s.on), bri: toBri(s.pct > 0 ? s.pct : 100), alert: 'none', mode: 'homeautomation', reachable: true },
            type: 'Dimmable light',
            modelid: 'LWB010',
            manufacturername: 'Philips',
            productname: 'Hue white lamp',
            capabilities: { certified: true, control: { mindimlevel: 5000, maxlumen: 806 }, streaming: { renderer: false, proxy: false } },
            config: { archetype: 'classicbulb', function: 'functional', direction: 'omnidirectional' },
            ...common,
        };
    }

    _lights() {
        const out = {};
        for (const l of this.lights()) {
            out[l.id] = this._light(l);
        }
        return out;
    }

    async _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.pathname === '/description.xml') {
            this._seen(req);
            res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
            res.end(this._description());
            return;
        }
        if (parts[0] !== 'api') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        this._seen(req);
        // POST /api: create a user (no link button needed)
        if (parts.length === 1 && req.method === 'POST') {
            await this._body(req);
            return this._json(res, 200, [{ success: { username: crypto.createHash('md5').update(this.uuid).digest('hex') } }]);
        }
        if (parts.length === 1 || (parts.length === 2 && parts[1] === 'config')) {
            return this._json(res, 200, this._config());
        }
        const [, , what, id, sub] = parts;
        if (!what) {
            return this._json(res, 200, { lights: this._lights(), groups: {}, config: this._config(), schedules: {}, scenes: {}, rules: {}, sensors: {}, resourcelinks: {} });
        }
        if (what === 'config') {
            return this._json(res, 200, this._config());
        }
        if (what !== 'lights') {
            return this._json(res, 200, {});
        }
        if (!id) {
            return this._json(res, 200, this._lights());
        }
        const l = this.lights().find(x => x.id === id);
        if (!l) {
            return this._json(res, 200, [{ error: { type: 3, address: `/lights/${id}`, description: `resource, /lights/${id}, not available` } }]);
        }
        if (!sub && req.method === 'GET') {
            return this._json(res, 200, this._light(l));
        }
        if (sub === 'state' && req.method === 'PUT') {
            const body = await this._body(req);
            const cmd = {};
            const result = [];
            if (typeof body.on === 'boolean') {
                cmd.on = body.on;
                result.push({ success: { [`/lights/${id}/state/on`]: body.on } });
            }
            if (typeof body.bri === 'number' && l.kind !== 'onoff') {
                cmd.pct = toPct(body.bri);
                result.push({ success: { [`/lights/${id}/state/bri`]: Math.max(1, Math.min(254, Math.round(body.bri))) } });
            }
            if (l.kind === 'color') {
                if (typeof body.hue === 'number') {
                    cmd.h = Math.round((body.hue / 65535) * 360) % 360;
                    result.push({ success: { [`/lights/${id}/state/hue`]: body.hue } });
                }
                if (typeof body.sat === 'number') {
                    cmd.s = Math.round((Math.min(254, body.sat) / 254) * 100);
                    result.push({ success: { [`/lights/${id}/state/sat`]: body.sat } });
                }
                if (Array.isArray(body.xy) && body.xy.length === 2) {
                    Object.assign(cmd, xyToHs(Number(body.xy[0]), Number(body.xy[1])));
                    result.push({ success: { [`/lights/${id}/state/xy`]: body.xy } });
                }
                if (typeof body.ct === 'number') {
                    cmd.ct = body.ct;
                    result.push({ success: { [`/lights/${id}/state/ct`]: body.ct } });
                }
            }
            if (cmd.on !== undefined || cmd.pct !== undefined || cmd.h !== undefined || cmd.ct !== undefined) {
                const now = this._state(l);
                const next = {
                    ...now,
                    on: cmd.on !== undefined ? cmd.on : cmd.pct !== undefined ? cmd.pct > 0 : true,
                    pct: cmd.pct !== undefined ? cmd.pct : now.pct,
                };
                if (cmd.h !== undefined || cmd.s !== undefined) {
                    Object.assign(next, { mode: 'hs', h: cmd.h !== undefined ? cmd.h : now.h, s: cmd.s !== undefined ? cmd.s : now.s });
                }
                if (cmd.ct !== undefined) {
                    Object.assign(next, { mode: 'ct', ct: cmd.ct });
                }
                this.recent.set(l.id, { ...next, until: Date.now() + 8000 });
                const what = [cmd.on !== undefined ? (cmd.on ? 'ein' : 'aus') : '', cmd.pct !== undefined ? `${cmd.pct} %` : '', cmd.h !== undefined ? `Farbe ${cmd.h}°/${cmd.s}%` : '', cmd.ct !== undefined ? `Weiß ${Math.round(1e6 / cmd.ct)} K` : ''];
                this.log.info(`Alexa: ${l.name} -> ${what.filter(Boolean).join(', ')}`);
                if (l.set(cmd) === false) {
                    this.recent.delete(l.id);
                }
            }
            return this._json(res, 200, result);
        }
        return this._json(res, 200, [{ error: { type: 4, address: url.pathname, description: 'method not available' } }]);
    }

    _seen(req) {
        const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!this.lastSeen || Date.now() - this.lastSeen.at > 5000 || this.lastSeen.from !== from) {
            this.log.debug(`Alexa: request from ${from}: ${req.method} ${req.url}`);
        }
        this.lastSeen = { at: Date.now(), from };
    }
}

module.exports = { HueBridge, toBri, toPct };
