'use strict';

/* Alexa: the adapter acts as a Hue bridge (API v1); this test plays the Echo device. */

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { freePort, until, startAdapter, DEVICES } = require('./helpers');

function freeUdpPort() {
    return new Promise(resolve => {
        const s = dgram.createSocket('udp4');
        s.bind(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

test('Alexa: discovery, lights for the ticked devices, on/off and percent like an Echo, locks only lock', async t => {
    const alexaPort = await freePort();
    const ssdpPort = await freeUdpPort();
    const { adapter, api } = await startAdapter(t, { alexaPort }, undefined, a => {
        a.ssdpPort = ssdpPort;
        a.logs = [];
        a.log = { debug() {}, info() {}, warn: m => a.logs.push(m), error: m => a.logs.push(m) };
    });
    // without ticked devices the Hue emulation does not run
    assert.equal((await api('pairing')).body.alexa.running, false);
    const catalog = (await api('catalog')).body;
    assert.equal(catalog.find(c => c.type === 'dimmer').alexa, true);
    assert.match(catalog.find(c => c.type === 'lock').alexa, /zusperren/);
    assert.equal(catalog.find(c => c.type === 'contact').alexa, false);

    const devices = DEVICES.map(d => (['licht', 'essen', 'rollo', 'schloss'].includes(d.id) ? { ...d, alexa: true } : d));
    devices.push({ id: 'szene', type: 'switch', name: 'Fernsehen', state: 'knx.0.Licht.Wohnzimmer', alexa: true });
    const saved = (await api('devices', { method: 'PUT', body: JSON.stringify(devices) })).body;
    assert.equal(saved.find(d => d.id === 'schloss').alexa, true);
    await until(async () => (await api('pairing')).body.alexa.running);

    // SSDP: the Echo searches, the bridge answers with its description
    const echo = dgram.createSocket('udp4');
    const answers = [];
    echo.on('message', m => answers.push(m.toString()));
    await new Promise(r => echo.bind(0, '127.0.0.1', r));
    echo.send(Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'), ssdpPort, '127.0.0.1');
    await until(() => answers.length >= 3);
    echo.close();
    const location = /LOCATION: (\S+)/.exec(answers[0])[1];
    assert.match(answers.join(''), /hue-bridgeid: [0-9A-F]{6}FFFE[0-9A-F]{6}/);
    const base = location.replace('/description.xml', '');
    assert.match(await (await fetch(location)).text(), /Philips hue bridge 2012/);

    const user = (await (await fetch(`${base}/api`, { method: 'POST', body: '{"devicetype":"Echo"}' })).json())[0].success.username;
    const lights = await (await fetch(`${base}/api/${user}/lights`)).json();
    const byName = n => Object.entries(lights).find(([, l]) => l.name === n);
    assert.equal(Object.keys(lights).length, 5);
    assert.equal(byName('Haustür Schloss')[1].type, 'On/Off plug-in unit');
    const [essenId, essen] = byName('Essen');
    assert.equal(essen.type, 'Dimmable light');
    assert.equal(essen.state.bri, Math.round(0.4 * 254));
    assert.equal(byName('Fernsehen')[1].type, 'On/Off plug-in unit');

    const put = async (id, body) => (await fetch(`${base}/api/${user}/lights/${id}/state`, { method: 'PUT', body: JSON.stringify(body) })).json();
    // "Alexa, Essen auf 30 Prozent"
    const r = await put(essenId, { on: true, bri: Math.round(0.3 * 254) });
    assert.deepEqual(Object.keys(r[0].success), [`/lights/${essenId}/state/on`]);
    await until(() => adapter.foreign['knx.0.Licht.Essen'].val === 30);
    // Alexa reads back what it asked for
    assert.equal((await (await fetch(`${base}/api/${user}/lights/${essenId}`)).json()).state.bri, Math.round(0.3 * 254));

    // "Alexa, Licht Wohnzimmer ein"
    await put(byName('Licht Wohnzimmer')[0], { on: true });
    await until(() => adapter.foreign['knx.0.Licht.Wohnzimmer'].val === true);

    // blind (100 % = closed in KNX): "Rollladen aus" = closed, "auf 30 Prozent" = 30 % open
    const [rolloId, rollo] = byName('Rollladen');
    assert.equal(rollo.state.on, false, 'value 100 with closed100 = closed');
    await put(rolloId, { bri: Math.round(0.3 * 254) });
    await until(() => adapter.foreign['knx.0.Rollladen.Wohnzimmer'].val === 70);
    await put(rolloId, { on: true });
    await until(() => adapter.foreign['knx.0.Rollladen.Wohnzimmer'].val === 0);

    // lock: "ein" locks; "aus" (unlock) is refused without the device option, allowed with it
    const [lockId] = byName('Haustür Schloss');
    await put(lockId, { on: true });
    await until(() => adapter.foreign['knx.0.Schloss'].val === true);
    const nWrites = adapter.writes.length;
    await put(lockId, { on: false });
    await until(() => adapter.logs.some(l => /Alexa wollte „Haustür Schloss“ aufsperren – nicht erlaubt/.test(l)));
    assert.equal(adapter.writes.length, nWrites);
    assert.equal((await (await fetch(`${base}/api/${user}/lights/${lockId}`)).json()).state.on, true, 'Alexa sees it still locked');
    await api('devices', { method: 'PUT', body: JSON.stringify(saved.map(d => (d.id === 'schloss' ? { ...d, alexaUnsafe: true } : d))) });
    await put(lockId, { on: false });
    await until(() => adapter.foreign['knx.0.Schloss'].val === false);
    await api('devices', { method: 'PUT', body: JSON.stringify(saved) });

    // dimmer with its own on/off data point (KNX): switch first, then the percent; state = newest
    adapter.add('knx.0.Licht.Bad', { name: 'Bad Helligkeit', type: 'number', role: 'level.dimmer', write: true }, 0);
    adapter.add('knx.0.Licht.Bad_Schalten', { name: 'Bad Ein/Aus', type: 'boolean', role: 'switch', write: true }, false);
    const withBad = [...saved, { id: 'bad', type: 'dimmer', name: 'Bad', state: 'knx.0.Licht.Bad', switchState: 'knx.0.Licht.Bad_Schalten', alexa: true }];
    await api('devices', { method: 'PUT', body: JSON.stringify(withBad) });
    const bad = Object.entries(await (await fetch(`${base}/api/${user}/lights`)).json()).find(([, l]) => l.name === 'Bad')[0];
    adapter.writes.length = 0;
    await put(bad, { on: true, bri: Math.round(0.3 * 254) });
    await until(() => adapter.foreign['knx.0.Licht.Bad'].val === 30);
    const order = adapter.writes.filter(w => w[0].startsWith('knx.0.Licht.Bad')).map(w => `${w[0].split('.').pop()}=${w[1]}`);
    assert.deepEqual(order, ['Bad_Schalten=true', 'Bad=30'], 'switch before brightness');
    await new Promise(r => setTimeout(r, 9000)); // past the time Alexa's own command is echoed
    let l = (await (await fetch(`${base}/api/${user}/lights/${bad}`)).json()).state;
    assert.equal(l.on, true);
    assert.equal(l.bri, Math.round(0.3 * 254));
    // "Alexa, Bad aus": switch only; the old brightness value must not make it look on
    await put(bad, { on: false });
    await until(() => adapter.foreign['knx.0.Licht.Bad_Schalten'].val === false);
    await new Promise(r => setTimeout(r, 9000));
    l = (await (await fetch(`${base}/api/${user}/lights/${bad}`)).json()).state;
    assert.equal(l.on, false);
    // already on: "auf 60 Prozent" only sends the brightness
    await put(bad, { on: true });
    await until(() => adapter.foreign['knx.0.Licht.Bad_Schalten'].val === true);
    adapter.writes.length = 0;
    await put(bad, { on: true, bri: Math.round(0.6 * 254) });
    await until(() => adapter.foreign['knx.0.Licht.Bad'].val === 60);
    assert.ok(!adapter.writes.some(w => w[0] === 'knx.0.Licht.Bad_Schalten'));
    await api('devices', { method: 'PUT', body: JSON.stringify(saved) });

    // ids stay the same after another save (Alexa remembers them)
    await api('devices', { method: 'PUT', body: JSON.stringify(saved.filter(d => d.id !== 'licht')) });
    const again = await (await fetch(`${base}/api/${user}/lights`)).json();
    assert.equal(again[essenId].name, 'Essen');
    assert.equal(Object.keys(again).length, 4);
    const info = (await api('pairing')).body.alexa;
    assert.equal(info.devices, 4);
    assert.ok(info.lastSeen);
});
