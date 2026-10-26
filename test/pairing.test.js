'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HttpClient } = require('hap-controller');
const { Service, Characteristic } = require('hap-nodejs');
const { until, short, startAdapter, DEVICES } = require('./helpers');

test('Apple Home pairs with the PIN, reads and switches the devices, gets live updates', async t => {
    const { adapter, api, hapPort } = await startAdapter(t);
    const saved = await api('devices', { method: 'PUT', body: JSON.stringify(DEVICES) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.length, DEVICES.length);
    assert.equal(adapter.foreign['homekit-easy.0.info.devices'].val, DEVICES.length);
    const catalog = (await api('catalog')).body;
    assert.ok(catalog.some(c => c.type === 'doorbell') && catalog.some(c => c.type === 'blind'));

    const pairing = (await api('pairing')).body;
    assert.match(pairing.pincode, /^\d{3}-\d{2}-\d{3}$/);
    assert.match(pairing.setupURI, /^X-HM:\/\/[0-9A-Z]{9}[0-9A-Z]{4}$/);
    assert.match(pairing.qr, /^<svg/);
    assert.equal(pairing.paired, false);

    const ident = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'identity.json'), 'utf8'));
    const client = new HttpClient(ident.username, '127.0.0.1', hapPort);
    t.after(() => client.close && client.close());
    await client.pairSetup(pairing.pincode);
    await until(() => adapter.foreign['homekit-easy.0.info.paired'] && adapter.foreign['homekit-easy.0.info.paired'].val === true);

    const { accessories } = await client.getAccessories();
    const find = (name, service, ch) => {
        for (const a of accessories) {
            const info = a.services.find(s => short(s.type) === short(Service.AccessoryInformation.UUID));
            const n = info && info.characteristics.find(c => short(c.type) === short(Characteristic.Name.UUID));
            if (n && n.value === name) {
                const s = a.services.find(x => short(x.type) === short(service.UUID));
                const c = s && s.characteristics.find(x => short(x.type) === short(ch.UUID));
                if (c) {
                    return { key: `${a.aid}.${c.iid}`, value: c.value, c };
                }
            }
        }
        throw new Error(`${name}: not found`);
    };
    const read = async f => (await client.getCharacteristics([f.key])).characteristics[0].value;
    const set = (f, value) => client.setCharacteristics({ [f.key]: value });

    // names: invalid characters for HomeKit are replaced
    assert.equal(Number(find('Bewegung Flur', Service.MotionSensor, Characteristic.MotionDetected).value), 0);

    // light
    const light = find('Licht Wohnzimmer', Service.Lightbulb, Characteristic.On);
    assert.equal(Number(await read(light)), 0);
    await set(light, true);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Licht.Wohnzimmer', true, false]);
    await until(async () => Number(await read(light)) === 1);

    // dimmer: brightness and on/off
    const bright = find('Essen', Service.Lightbulb, Characteristic.Brightness);
    assert.equal(await read(bright), 40);
    await set(bright, 75);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Licht.Essen', 75, false]);
    await set(find('Essen', Service.Lightbulb, Characteristic.On), false);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Licht.Essen', 0, false]);

    // blind with KNX 100 % = closed: data point 100 -> HomeKit 0 (closed); open to 30 % -> 70
    const pos = find('Rollladen', Service.WindowCovering, Characteristic.CurrentPosition);
    assert.equal(await read(pos), 0);
    await set(find('Rollladen', Service.WindowCovering, Characteristic.TargetPosition), 30);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Rollladen.Wohnzimmer', 70, false]);
    // position + up/down object (1 = down, 0 = up): fully closed/open drive with up/down, in between the position
    const jTarget = find('Jalousie Küche', Service.WindowCovering, Characteristic.TargetPosition);
    await set(jTarget, 0);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Jalousie.AufAb', true, false]);
    await set(jTarget, 40);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Jalousie.Position', 40, false]);
    await set(jTarget, 100);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Jalousie.AufAb', false, false]);
    // only up/down: up (false) = open; any lower target drives down
    assert.equal(await read(find('Markise', Service.WindowCovering, Characteristic.CurrentPosition)), 100);
    await set(find('Markise', Service.WindowCovering, Characteristic.TargetPosition), 20);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Markise.AufAb', true, false]);
    await until(async () => (await read(find('Markise', Service.WindowCovering, Characteristic.CurrentPosition))) === 0);

    // garage: impulse only when the state really has to change; contact = current state
    const door = find('Garage', Service.GarageDoorOpener, Characteristic.TargetDoorState);
    const before = adapter.writes.length;
    await set(door, Characteristic.TargetDoorState.CLOSED); // already closed
    assert.equal(adapter.writes.length, before);
    await set(door, Characteristic.TargetDoorState.OPEN);
    assert.deepEqual(adapter.writes.at(-1), ['shelly.0.Garage.Taster', true, false]);
    adapter.change('knx.0.Garage.Kontakt', true);
    await until(async () => (await read(find('Garage', Service.GarageDoorOpener, Characteristic.CurrentDoorState))) === Characteristic.CurrentDoorState.OPEN);

    // lock
    assert.equal(await read(find('Haustür Schloss', Service.LockMechanism, Characteristic.LockCurrentState)), Characteristic.LockCurrentState.SECURED);
    await set(find('Haustür Schloss', Service.LockMechanism, Characteristic.LockTargetState), Characteristic.LockTargetState.UNSECURED);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Schloss', false, false]);

    // thermostat: range from the object (15..28)
    const target = find('Heizung', Service.Thermostat, Characteristic.TargetTemperature);
    assert.equal(target.c.minValue, 15);
    assert.equal(target.c.maxValue, 28);
    assert.equal(await read(find('Heizung', Service.Thermostat, Characteristic.CurrentTemperature)), 20.8);
    await set(target, 22.5);
    assert.deepEqual(adapter.writes.at(-1), ['knx.0.Heizung.Soll', 22.5, false]);

    // security system: values mapped both ways
    const alarm = find('Alarm', Service.SecuritySystem, Characteristic.SecuritySystemCurrentState);
    assert.equal(await read(alarm), Characteristic.SecuritySystemCurrentState.DISARMED);
    await set(find('Alarm', Service.SecuritySystem, Characteristic.SecuritySystemTargetState), Characteristic.SecuritySystemTargetState.AWAY_ARM);
    assert.deepEqual(adapter.writes.at(-1), ['spc-edp.0.areas.1.state', 3, false]);

    // live events: window opens -> Apple Home is told without asking
    const contact = find('Fenster Küche', Service.ContactSensor, Characteristic.ContactSensorState);
    const events = [];
    client.on('event', ev => events.push(...ev.characteristics));
    const conn = await client.subscribeCharacteristics([contact.key]);
    t.after(() => client.unsubscribeCharacteristics([contact.key], conn).catch(() => {}));
    adapter.change('knx.0.Fenster.Kueche', true);
    await until(() => events.some(e => `${e.aid}.${e.iid}` === contact.key && e.value === 1));

    // sensors are read only: HomeKit answers with an error status (-70404), nothing is written
    const n = adapter.writes.length;
    const res = await set(contact, 0).catch(err => err);
    const status = res && res.characteristics ? res.characteristics[0].status : -1;
    assert.notEqual(status, 0);
    assert.equal(adapter.writes.length, n);
});
