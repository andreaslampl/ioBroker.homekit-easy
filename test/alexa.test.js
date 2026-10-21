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

test('Alexa: discovery, lights for the ticked devices, on/off and percent like an Echo, no locks', async t => {
    const alexaPort = await freePort();
    const ssdpPort = await freeUdpPort();
    const { adapter, api } = await startAdapter(t, { alexaPort }, undefined, a => {
        a.ssdpPort = ssdpPort;
    });
    // without ticked devices the Hue emulation does not run
    assert.equal((await api('pairing')).body.alexa.running, false);
    const catalog = (await api('catalog')).body;
    assert.equal(catalog.find(c => c.type === 'dimmer').alexa, true);
    assert.equal(catalog.find(c => c.type === 'lock').alexa, false);

    const devices = DEVICES.map(d => (['licht', 'essen', 'rollo', 'schloss'].includes(d.id) ? { ...d, alexa: true } : d));
    devices.push({ id: 'szene', type: 'switch', name: 'Fernsehen', state: 'knx.0.Licht.Wohnzimmer', alexa: true });
    const saved = (await api('devices', { method: 'PUT', body: JSON.stringify(devices) })).body;
    assert.equal(saved.find(d => d.id === 'schloss').alexa, undefined, 'locks never go to Alexa');
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
    assert.equal(Object.keys(lights).length, 4);
    assert.ok(!byName('Haustür Schloss'));
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

    // ids stay the same after another save (Alexa remembers them)
    await api('devices', { method: 'PUT', body: JSON.stringify(saved.filter(d => d.id !== 'licht')) });
    const again = await (await fetch(`${base}/api/${user}/lights`)).json();
    assert.equal(again[essenId].name, 'Essen');
    assert.equal(Object.keys(again).length, 3);
    const info = (await api('pairing')).body.alexa;
    assert.equal(info.devices, 3);
    assert.ok(info.lastSeen);
});
