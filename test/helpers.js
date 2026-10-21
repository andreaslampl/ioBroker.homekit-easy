'use strict';

/* Shared helpers: fake ioBroker, free ports, adapter start (one adapter per test file: HAP storage is per process). */

const net = require('node:net');
const { install, demoHouse } = require('./fake-iobroker');

install();

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function until(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

/** HAP UUIDs are written without the base suffix by some clients: compare the short form. */
const short = u => String(u).split('-')[0].replace(/^0+/, '').toUpperCase();

async function startAdapter(t, config = {}, camBase) {
    const port = await freePort();
    const hapPort = await freePort();
    const adapter = require('../main.js')({ config: { port, hapPort, bridgeName: 'Test Haus', publicHost: '127.0.0.1', ...config } });
    adapter.bindAddresses = ['127.0.0.1'];
    demoHouse(adapter, camBase);
    adapter.emit('ready');
    await until(() => adapter.foreign['homekit-easy.0.info.connection'] && adapter.foreign['homekit-easy.0.info.connection'].val === true, 30000);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    const base = `http://127.0.0.1:${port}/`;
    const api = async (p, opts = {}) => {
        const res = await fetch(base + 'api/' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
        return { status: res.status, body: await res.json() };
    };
    return { adapter, api, base, hapPort };
}

const DEVICES = [
    { id: 'licht', type: 'light', name: 'Licht Wohnzimmer', state: 'knx.0.Licht.Wohnzimmer' },
    { id: 'essen', type: 'dimmer', name: 'Essen', state: 'knx.0.Licht.Essen' },
    { id: 'rollo', type: 'blind', name: 'Rollladen', state: 'knx.0.Rollladen.Wohnzimmer', stop: 'knx.0.Rollladen.Stop', closed100: true },
    { id: 'garage', type: 'garage', name: 'Garage', command: 'shelly.0.Garage.Taster', status: 'knx.0.Garage.Kontakt', mode: 'impulse' },
    { id: 'schloss', type: 'lock', name: 'Haustür Schloss', state: 'knx.0.Schloss' },
    { id: 'heizung', type: 'thermostat', name: 'Heizung', state: 'knx.0.Heizung.Soll', actual: 'knx.0.Heizung.Ist' },
    { id: 'fenster', type: 'contact', name: 'Fenster Küche', state: 'knx.0.Fenster.Kueche' },
    { id: 'flur', type: 'motion', name: 'Bewegung / Flur!', state: 'knx.0.Bewegung.Flur' },
    { id: 'alarm', type: 'security', name: 'Alarm', status: 'spc-edp.0.areas.1.state', valueOff: '0', valueAway: '3', valueHome: '1' },
    { id: 'taster', type: 'button', name: 'Taster', state: '0_userdata.0.Taster' },
];


module.exports = { freePort, until, short, startAdapter, DEVICES };
