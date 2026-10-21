'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { HttpClient } = require('hap-controller');
const { Service, Characteristic } = require('hap-nodejs');
const { until, short, startAdapter } = require('./helpers');

test('camera: snapshot from livecam reaches Apple Home', async t => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const cam = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(jpg);
    });
    await new Promise(r => cam.listen(0, '127.0.0.1', r));
    t.after(() => cam.close());
    const { adapter, api, hapPort } = await startAdapter(t, {}, `http://127.0.0.1:${cam.address().port}`);
    await api('devices', { method: 'PUT', body: JSON.stringify([{ id: 'tuer', type: 'doorbell', name: 'Haustür', camera: 'livecam.0.cameras.haustuer', ring: 'livecam.0.intercom.ringing' }]) });
    const pairing = (await api('pairing')).body;
    const ident = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'identity.json'), 'utf8'));
    const client = new HttpClient(ident.username, '127.0.0.1', hapPort);
    t.after(() => client.close && client.close());
    await client.pairSetup(pairing.pincode);
    const { accessories } = await client.getAccessories();
    const acc = accessories.find(a => a.services.some(s => short(s.type) === short(Service.Doorbell.UUID)));
    assert.ok(acc, 'doorbell service');
    assert.ok(acc.services.some(s => short(s.type) === short(Service.CameraRTPStreamManagement.UUID)), 'camera stream service');
    const img = await client.getImage(640, 360, acc.aid);
    assert.deepEqual(Buffer.from(img), jpg);

    // ringing: the doorbell event goes out
    const doorbell = acc.services.find(s => short(s.type) === short(Service.Doorbell.UUID));
    const ev = doorbell.characteristics.find(c => short(c.type) === short(Characteristic.ProgrammableSwitchEvent.UUID));
    const key = `${acc.aid}.${ev.iid}`;
    const events = [];
    client.on('event', e => events.push(...e.characteristics));
    const conn = await client.subscribeCharacteristics([key]);
    t.after(() => client.unsubscribeCharacteristics([key], conn).catch(() => {}));
    adapter.change('livecam.0.intercom.ringing', true);
    await until(() => events.some(e => `${e.aid}.${e.iid}` === key && e.value === 0));
});
