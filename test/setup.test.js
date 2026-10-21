'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAdapter } = require('./helpers');

test('setup page: device list is validated, objects for the picker, pairing can be reset', async t => {
    const { adapter, api } = await startAdapter(t);
    const saved = await api('devices', {
        method: 'PUT',
        body: JSON.stringify([
            { id: 'a', type: 'light', name: 'A', state: 'knx.0.Licht.Wohnzimmer', evil: 1 },
            { id: 'a', type: 'contact', name: 'B', state: 'knx.0.Fenster.Kueche' },
            { id: 'c', type: 'nonsense', name: 'C' },
            { id: 'd', type: 'garage', name: 'D', command: 'x', mode: 'weird' },
        ]),
    });
    assert.deepEqual(saved.body.map(d => d.id), ['a', 'ax', 'd']);
    assert.equal(saved.body[0].evil, undefined);
    assert.equal(saved.body[2].mode, 'impulse');
    const objects = (await api('objects')).body;
    assert.ok(objects.states.some(s => s.id === 'knx.0.Licht.Wohnzimmer'));
    assert.deepEqual((await api('cameras')).body, [{ id: 'livecam.0.cameras.haustuer', name: 'Haustür' }]);
    const first = (await api('pairing')).body;
    await api('pairing/reset', { method: 'POST' });
    const second = (await api('pairing')).body;
    assert.notEqual(second.setupURI, first.setupURI);
    assert.equal(second.paired, false);
    assert.equal(second.devices, 3);
    void adapter;
});
