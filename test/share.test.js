'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpClient } = require('hap-controller');
const { startAdapter, DEVICES } = require('./helpers');

// Apple Home "Personen einladen": the owner's iPhone adds the other user's key to every bridge (AddPairing)
test('shared home: the owner adds a family member, who sees and reads the devices', async t => {
    const { api, adapter, hapPort } = await startAdapter(t);
    await api('devices', { method: 'PUT', body: JSON.stringify(DEVICES) });
    const { pincode } = (await api('pairing')).body;
    const { username } = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'identity.json'), 'utf8'));
    const owner = new HttpClient(username, '127.0.0.1', hapPort);
    await owner.pairSetup(pincode);
    // the family member's long-term key (ed25519; libsodium wants seed + public key as secret key)
    const jwk = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const kp = { publicKey: Buffer.from(jwk.x, 'base64url'), secretKey: Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]) };
    const id = crypto.randomUUID().toUpperCase();
    await owner.addPairing(id, Buffer.from(kp.publicKey), false);
    const member = new HttpClient(username, '127.0.0.1', hapPort, {
        ...owner.getLongTermData(),
        iOSDevicePairingID: Buffer.from(id).toString('hex'),
        iOSDeviceLTSK: Buffer.from(kp.secretKey).toString('hex'),
        iOSDeviceLTPK: Buffer.from(kp.publicKey).toString('hex'),
    });
    t.after(() => [owner, member].forEach(c => c.close && c.close()));
    const { accessories } = await member.getAccessories();
    assert.equal(accessories.length, DEVICES.length + 1, 'bridge + all devices');
});
