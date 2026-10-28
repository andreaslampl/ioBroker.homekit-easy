'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HttpClient } = require('hap-controller');
const { until, startAdapter } = require('./helpers');

// field: after every adapter update/restart Apple Home lost the bridge - stopping deleted the pairing data
test('the pairing survives stopping the adapter (update, restart)', async t => {
    const { adapter, api, hapPort } = await startAdapter(t);
    const pairing = (await api('pairing')).body;
    const ident = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'identity.json'), 'utf8'));
    const client = new HttpClient(ident.username, '127.0.0.1', hapPort);
    await client.pairSetup(pairing.pincode);
    await until(() => adapter.foreign['homekit-easy.0.info.paired'] && adapter.foreign['homekit-easy.0.info.paired'].val === true);
    client.close && client.close();
    await new Promise(resolve => adapter.emit('unload', resolve));
    const file = path.join(adapter.dataDir, 'hap', `AccessoryInfo.${ident.username.replace(/:/g, '')}.json`);
    assert.ok(fs.existsSync(file), 'pairing data still there');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).pairedClients || {}).length, 1);
    assert.ok(fs.existsSync(path.join(adapter.dataDir, 'hap', `IdentifierCache.${ident.username.replace(/:/g, '')}.json`)), 'ids of the accessories kept (rooms in Home)');
});
