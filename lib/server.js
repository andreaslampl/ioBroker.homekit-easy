'use strict';

/*
 * Setup page of HomeKit Easy (own port, linked from the instance):
 *   /                      page (www/)
 *   /api/catalog           device types with their fields
 *   /api/devices           GET / PUT the device list
 *   /api/objects, /api/values  object browser
 *   /api/cameras           cameras of the livecam adapter
 *   /api/pairing           PIN, QR code (SVG), paired state; POST /api/pairing/reset
 *   /api/smartview         GET tiles of SmartView that can be in Apple Home; POST /api/smartview/link
 * Optional access key (?key= once, then a cookie) - the page shows the HomeKit code.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const QRCode = require('qrcode');

const WWW = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

class SetupServer {
    /**
     * @param {object} a adapter side: catalog(), devices(), saveDevices(list), objectList(fresh), stateValues(ids),
     *   cameras(), pairing(), resetPairing()
     */
    constructor({ adapter, accessKey = '', log }) {
        this.a = adapter;
        this.accessKey = accessKey;
        this.log = log;
        this.server = http.createServer((req, res) => {
            this._handle(req, res).catch(err => {
                if (!res.headersSent) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                }
                res.end(JSON.stringify({ error: err.message }));
            });
        });
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve(this.server.address());
            });
        });
    }

    close() {
        this.server.closeAllConnections();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    _allowed(req, url) {
        if (!this.accessKey) {
            return true;
        }
        const m = /(?:^|;\s*)hke_key=([^;]+)/.exec(req.headers.cookie || '');
        return url.searchParams.get('key') === this.accessKey || (m && decodeURIComponent(m[1]) === this.accessKey);
    }

    _json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    }

    async _body(req) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
            size += c.length;
            if (size > 2e6) {
                throw new Error('Zu groß');
            }
            chunks.push(c);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        return text ? JSON.parse(text) : {};
    }

    async _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        if (this.accessKey && url.searchParams.get('key') === this.accessKey) {
            res.setHeader('Set-Cookie', `hke_key=${encodeURIComponent(this.accessKey)}; Path=/; Max-Age=315360000; SameSite=Lax; HttpOnly`);
        }
        if (p.startsWith('/api/')) {
            if (!this._allowed(req, url)) {
                return this._json(res, 403, { error: 'Zugriff verweigert: Schlüssel fehlt (?key=...)' });
            }
            return this._api(req, res, url, p);
        }
        const file = p === '/' ? 'index.html' : p.slice(1);
        if (/^[\w.-]+$/.test(file) && MIME[path.extname(file)]) {
            const full = path.join(WWW, file);
            if (fs.existsSync(full)) {
                res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
                fs.createReadStream(full).pipe(res);
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Nicht gefunden');
    }

    async _api(req, res, url, p) {
        if (p === '/api/catalog') {
            return this._json(res, 200, this.a.catalog());
        }
        if (p === '/api/devices' && req.method === 'GET') {
            return this._json(res, 200, this.a.devices());
        }
        if (p === '/api/devices' && req.method === 'PUT') {
            return this._json(res, 200, await this.a.saveDevices(await this._body(req)));
        }
        if (p === '/api/objects') {
            const { list, folders } = await this.a.objectList(url.searchParams.get('fresh') === '1');
            const body = Buffer.from(JSON.stringify({ states: list, folders }));
            const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
            if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
                res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
                res.end(zlib.gzipSync(body));
            } else {
                res.writeHead(200, headers);
                res.end(body);
            }
            return;
        }
        if (p === '/api/values' && req.method === 'POST') {
            const ids = await this._body(req);
            return this._json(res, 200, await this.a.stateValues(Array.isArray(ids) ? ids.map(String) : []));
        }
        if (p === '/api/cameras') {
            return this._json(res, 200, await this.a.cameras());
        }
        if (p === '/api/pairing' && req.method === 'GET') {
            const info = this.a.pairing();
            const qr = info.setupURI ? await QRCode.toString(info.setupURI, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : '';
            return this._json(res, 200, { ...info, qr });
        }
        if (p === '/api/smartview' && req.method === 'GET') {
            return this._json(res, 200, await this.a.smartviewTiles());
        }
        if (p === '/api/smartview/link' && req.method === 'POST') {
            const body = await this._body(req);
            return this._json(res, 200, await this.a.smartviewLink(Array.isArray(body) ? body : []));
        }
        if (p === '/api/pairing/reset' && req.method === 'POST') {
            await this.a.resetPairing();
            return this._json(res, 200, { ok: true });
        }
        return this._json(res, 404, { error: 'Nicht gefunden' });
    }
}

module.exports = { SetupServer };
