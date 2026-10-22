'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAdapter } = require('./helpers');

test('SmartView creates, updates and removes its devices; other devices stay', async t => {
    const { adapter, api } = await startAdapter(t);
    await api('devices', { method: 'PUT', body: JSON.stringify([{ id: 'own', type: 'light', name: 'Eigenes Licht', state: 'knx.0.Licht.Wohnzimmer' }]) });

    let r = await adapter.message('smartview.0', 'sync', {
        devices: [
            { id: 'sv-a', type: 'light', name: 'Küche Licht', state: 'knx.0.Licht.Wohnzimmer' },
            { id: 'sv-b', type: 'blind', name: 'Rollladen', state: 'knx.0.Rollladen.Wohnzimmer', closed100: true },
            // imported in SmartView from here: linked by id, updated but never removed by SmartView
            { id: 'own', type: 'light', name: 'Wohnzimmer', state: 'knx.0.Licht.Wohnzimmer' },
        ],
    });
    assert.deepEqual(r, { ok: true, created: 2, updated: 1, removed: 0, total: 2 });
    let list = (await api('devices')).body;
    assert.deepEqual(list.map(d => [d.id, d.name, d.source || '']), [['own', 'Wohnzimmer', ''], ['sv-a', 'Küche Licht', 'smartview.0'], ['sv-b', 'Rollladen', 'smartview.0']]);
    assert.equal(adapter.bridge.accessories.size, 3);

    // Alexa ticked here stays when SmartView sends the device again
    await api('devices', { method: 'PUT', body: JSON.stringify(list.map(d => (d.id === 'sv-a' ? { ...d, alexa: true } : d))) });
    r = await adapter.message('smartview.0', 'sync', { devices: [{ id: 'sv-a', type: 'light', name: 'Küche Licht', state: 'knx.0.Licht.Wohnzimmer' }] });
    assert.deepEqual(r, { ok: true, created: 0, updated: 0, removed: 1, total: 1 });
    list = (await api('devices')).body;
    assert.deepEqual(list.map(d => d.id), ['own', 'sv-a']);
    assert.equal(list[1].alexa, true);

    // only SmartView may sync; the device list can be read by anyone
    r = await adapter.message('javascript.0', 'sync', { devices: [] });
    assert.match(r.error, /not allowed/);
    r = await adapter.message('smartview.0', 'devices', {});
    assert.equal(r.devices.length, 2);
    assert.equal(r.types.light, 'Licht (Ein/Aus)');
});
