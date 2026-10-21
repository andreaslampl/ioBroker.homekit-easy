'use strict';

/* Color light (RGBW): conversion, KNX and Shelly data points, Apple Home and Alexa. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HttpClient } = require('hap-controller');
const { Service, Characteristic } = require('hap-nodejs');
const { colorLight, xyToHs, hsToXy } = require('../lib/color');
const { freePort, until, short, startAdapter } = require('./helpers');

/** Minimal data point store like main.js offers it. */
function fakeX(init = {}) {
    const values = new Map(Object.entries(init).map(([id, val]) => [id, { val, lc: 1 }]));
    const writes = [];
    let clock = 10;
    return {
        writes,
        values,
        val: id => (values.has(id) ? values.get(id).val : undefined),
        num: (id, def) => (values.has(id) && Number.isFinite(Number(values.get(id).val)) ? Number(values.get(id).val) : def),
        bool: id => Boolean(values.has(id) && values.get(id).val),
        ts: id => (values.has(id) ? values.get(id).lc : 0),
        set: (id, val) => {
            writes.push([id, val]);
            values.set(id, { val, lc: ++clock });
        },
    };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('color: channels for colors and white, KNX percent with W, Shelly with gain, read back', async () => {
    const knx = { red: 'r', green: 'g', blue: 'b', white: 'w', switchState: 'sw', range: '100' };
    const x = fakeX({ r: 0, g: 0, b: 0, w: 0, sw: false });
    const L = colorLight(knx, x);
    assert.equal(L.get().on, false);
    // Home: red at 50 % (hue and saturation arrive one after the other -> written once)
    L.set({ on: true });
    L.set({ h: 0 });
    L.set({ s: 100 });
    L.set({ bri: 50 });
    await wait(600);
    const last = id => x.writes.filter(w => w[0] === id).at(-1)[1];
    assert.deepEqual(x.writes[0], ['sw', true], 'switch first');
    assert.equal(last('r'), 50);
    assert.equal(last('g'), 0);
    assert.equal(last('w'), 0);
    // pastel: the white part goes to W
    L.set({ h: 240, s: 50, bri: 100 });
    await wait(150);
    assert.deepEqual(['r', 'g', 'b', 'w'].map(last), [0, 0, 50, 50]);
    // warm white (2700 K) mostly on W
    L.set({ ct: 370 });
    await wait(150);
    assert.equal(last('w'), 100);
    assert.ok(last('r') > 0 && last('r') < 50 && last('b') === 0, 'warm: W + a little red');
    // off: switch only
    const n = x.writes.length;
    L.set({ on: false });
    await wait(150);
    assert.deepEqual(x.writes.slice(n), [['sw', false]]);

    // read back from the data points (someone set it in the KNX visu)
    const y = fakeX({ r: 0, g: 100, b: 0, w: 0, sw: true });
    const st = colorLight(knx, y).get();
    assert.deepEqual([st.on, st.bri, st.h, st.s], [true, 100, 120, 100]);

    // Shelly: channels 0-255 at full scale, brightness on gain
    const shelly = { red: 'r', green: 'g', blue: 'b', white: 'w', brightness: 'gain', switchState: 'sw', range: '255' };
    const z = fakeX({ r: 0, g: 0, b: 0, w: 0, gain: 0, sw: true });
    const S = colorLight(shelly, z);
    S.set({ h: 30, s: 100, bri: 40 });
    await wait(150);
    const lz = id => z.writes.filter(w => w[0] === id).at(-1)[1];
    assert.deepEqual(['r', 'g', 'b', 'w', 'gain'].map(lz), [255, 128, 0, 0, 40]);

    // Alexa sends colors as CIE xy as well
    const red = xyToHs(...hsToXy(0, 100));
    assert.ok(red.h <= 2 || red.h >= 358, `red stays red (${red.h})`);
    assert.ok(red.s >= 95);
});

test('color: Apple Home color wheel and Alexa colors on KNX and Shelly data points', async t => {
    const alexaPort = await freePort();
    const { adapter, api, hapPort } = await startAdapter(t, { alexaPort }, undefined, a => {
        a.ssdpPort = 0;
    });
    const devices = [
        { id: 'knx', type: 'rgbw', name: 'Wohnzimmer Farbe', red: 'knx.0.RGBW.Wohnzimmer_R', green: 'knx.0.RGBW.Wohnzimmer_G', blue: 'knx.0.RGBW.Wohnzimmer_B', white: 'knx.0.RGBW.Wohnzimmer_W', switchState: 'knx.0.RGBW.Wohnzimmer_Schalten', range: '100', alexa: true },
        { id: 'shelly', type: 'rgbw', name: 'Terrasse', red: 'shelly.0.SHRGBW2#1#1.color.red', green: 'shelly.0.SHRGBW2#1#1.color.green', blue: 'shelly.0.SHRGBW2#1#1.color.blue', white: 'shelly.0.SHRGBW2#1#1.color.white', brightness: 'shelly.0.SHRGBW2#1#1.color.gain', switchState: 'shelly.0.SHRGBW2#1#1.color.Switch', alexa: true },
    ];
    const saved = (await api('devices', { method: 'PUT', body: JSON.stringify(devices) })).body;
    assert.equal(saved[1].range, '255', 'default range');
    assert.equal(saved[0].alexa, true);

    // Apple Home
    const pairing = (await api('pairing')).body;
    const ident = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'identity.json'), 'utf8'));
    const client = new HttpClient(ident.username, '127.0.0.1', hapPort);
    t.after(() => client.close && client.close());
    await client.pairSetup(pairing.pincode);
    const { accessories } = await client.getAccessories();
    const find = (name, ch) => {
        for (const a of accessories) {
            const info = a.services.find(s => short(s.type) === short(Service.AccessoryInformation.UUID));
            const n = info && info.characteristics.find(c => short(c.type) === short(Characteristic.Name.UUID));
            if (n && n.value === name) {
                const s = a.services.find(x => short(x.type) === short(Service.Lightbulb.UUID));
                const c = s.characteristics.find(x => short(x.type) === short(ch.UUID));
                return `${a.aid}.${c.iid}`;
            }
        }
        throw new Error(name);
    };
    assert.ok(find('Wohnzimmer Farbe', Characteristic.ColorTemperature));
    await client.setCharacteristics({ [find('Wohnzimmer Farbe', Characteristic.On)]: true, [find('Wohnzimmer Farbe', Characteristic.Hue)]: 120, [find('Wohnzimmer Farbe', Characteristic.Saturation)]: 100, [find('Wohnzimmer Farbe', Characteristic.Brightness)]: 80 });
    await until(() => adapter.foreign['knx.0.RGBW.Wohnzimmer_G'].val === 80);
    assert.equal(adapter.foreign['knx.0.RGBW.Wohnzimmer_Schalten'].val, true);
    assert.equal(adapter.foreign['knx.0.RGBW.Wohnzimmer_R'].val, 0);
    assert.equal((await client.getCharacteristics([find('Wohnzimmer Farbe', Characteristic.Hue)])).characteristics[0].value, 120);

    // Alexa: "Terrasse blau"
    const base = `http://127.0.0.1:${alexaPort}`;
    const lights = await (await fetch(`${base}/api/u/lights`)).json();
    const [id, l] = Object.entries(lights).find(([, v]) => v.name === 'Terrasse');
    assert.equal(l.type, 'Extended color light');
    await fetch(`${base}/api/u/lights/${id}/state`, { method: 'PUT', body: JSON.stringify({ on: true, hue: Math.round((240 / 360) * 65535), sat: 254 }) });
    await until(() => adapter.foreign['shelly.0.SHRGBW2#1#1.color.blue'].val === 255);
    assert.equal(adapter.foreign['shelly.0.SHRGBW2#1#1.color.red'].val, 0);
    assert.equal(adapter.foreign['shelly.0.SHRGBW2#1#1.color.Switch'].val, true);
    // "Alexa, Terrasse warmweiß"
    await fetch(`${base}/api/u/lights/${id}/state`, { method: 'PUT', body: JSON.stringify({ ct: 370 }) });
    await until(() => adapter.foreign['shelly.0.SHRGBW2#1#1.color.white'].val > 200);
    const back = (await (await fetch(`${base}/api/u/lights/${id}`)).json()).state;
    assert.equal(back.colormode, 'ct');
    assert.equal(back.ct, 370);
});
