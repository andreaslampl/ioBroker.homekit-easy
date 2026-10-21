'use strict';

/*
 * Devices for Alexa (lib/hue.js): which device types can be lamps for Alexa, and how on/off and
 * 0-100 % map to their data points. Locks, garage doors and alarm systems are left out on purpose:
 * over the Hue emulation anybody near an Echo could open them without a PIN.
 */

const { colorLight } = require('./color');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ALEXA_TYPES = {
    light(d, x) {
        const on = () => x.bool(d.status || d.state, d.invert);
        return {
            kind: 'dimmable', // Alexa counts only lamps for "Licht aus"; brightness > 0 = on
            get: () => ({ on: on(), pct: on() ? 100 : 0 }),
            set: c => {
                const v = c.pct !== undefined ? c.pct > 0 : c.on;
                x.set(d.state, d.invert ? !v : v);
            },
        };
    },
    dimmer(d, x) {
        const level = () => clamp(Math.round(x.num(d.status || d.state, 0)), 0, 100);
        const on = () => dimmerOn(d, x, level);
        let last = 100;
        return {
            kind: 'dimmable',
            get: () => ({ on: on(), pct: level() }),
            set: c => {
                if (level() > 0) {
                    last = level();
                }
                const wantOn = c.pct !== undefined ? c.pct > 0 : c.on;
                if (!wantOn) {
                    if (d.switchState) {
                        x.set(d.switchState, false);
                    } else {
                        x.set(d.state, 0);
                    }
                    return;
                }
                const pct = c.pct !== undefined ? c.pct : null;
                if (d.switchState && !on()) {
                    // switch on first, the brightness after it: a KNX dimmer jumps to its switch-on
                    // value on "Ein" - sent the other way round that would override the percent
                    x.set(d.switchState, true);
                    if (pct !== null) {
                        setTimeout(() => x.set(d.state, pct), SWITCH_THEN_LEVEL_MS);
                    }
                } else if (pct !== null) {
                    x.set(d.state, pct);
                } else if (!d.switchState && level() === 0) {
                    x.set(d.state, last);
                }
            },
        };
    },
    rgbw(d, x) {
        const L = colorLight(d, x);
        return {
            kind: 'color',
            get: () => {
                const st = L.get();
                return { on: st.on, pct: st.bri, h: st.h, s: st.s, ct: st.ct, mode: st.mode };
            },
            set: c => {
                const cmd = {};
                for (const [from, to] of [['on', 'on'], ['pct', 'bri'], ['h', 'h'], ['s', 's'], ['ct', 'ct']]) {
                    if (c[from] !== undefined) {
                        cmd[to] = c[from];
                    }
                }
                L.set(cmd);
            },
        };
    },
    outlet: onOff,
    switch: onOff,
    fan(d, x) {
        const on = () => x.bool(d.status || d.state);
        return {
            kind: d.speed ? 'dimmable' : 'onoff',
            get: () => ({ on: on(), pct: d.speed ? clamp(x.num(d.speed, 0), 0, 100) : on() ? 100 : 0 }),
            set: c => {
                if (c.pct !== undefined && d.speed) {
                    x.set(d.speed, c.pct);
                    x.set(d.state, c.pct > 0);
                } else {
                    x.set(d.state, c.on !== undefined ? c.on : c.pct > 0);
                }
            },
        };
    },
    blind(d, x) {
        // Alexa: "an" = open, "aus" = closed, "auf 30 Prozent" = 30 % open
        const open = () => clamp(Math.round(d.closed100 ? 100 - x.num(d.status || d.state, 0) : x.num(d.status || d.state, 0)), 0, 100);
        const write = pct => x.set(d.state, d.closed100 ? 100 - pct : pct);
        return {
            kind: 'dimmable',
            get: () => ({ on: open() > 0, pct: open() }),
            set: c => write(c.pct !== undefined ? c.pct : c.on ? 100 : 0),
        };
    },
};

const SWITCH_THEN_LEVEL_MS = 400;

/**
 * Dimmer with brightness and its own on/off data point: whichever changed last tells whether it is on
 * (a KNX switch object often has no feedback and keeps its old value after dimming, and the
 * other way round).
 */
function dimmerOn(d, x, level) {
    const lvlId = d.status || d.state;
    if (!d.switchState || x.val(d.switchState) === undefined) {
        return level() > 0;
    }
    if (x.val(lvlId) === undefined) {
        return x.bool(d.switchState);
    }
    return x.ts(d.switchState) > x.ts(lvlId) ? x.bool(d.switchState) : level() > 0;
}

function onOff(d, x) {
    const on = () => x.bool(d.status || d.state, d.invert);
    return {
        kind: 'onoff',
        get: () => ({ on: on(), pct: on() ? 100 : 0 }),
        set: c => {
            const v = c.on !== undefined ? c.on : c.pct > 0;
            x.set(d.state, d.invert ? !v : v);
        },
    };
}

/** Lights for the Hue emulation from the device list; ids stay the same (map in alexa.json). */
function alexaLights(devices, x, ids) {
    const out = [];
    for (const d of devices) {
        const make = ALEXA_TYPES[d.type];
        if (!d.alexa || !make || !(d.state || d.red)) {
            continue;
        }
        out.push({ id: ids(d.id), name: d.name, ...make(d, x) });
    }
    return out;
}

module.exports = { ALEXA_TYPES, alexaLights, dimmerOn, SWITCH_THEN_LEVEL_MS };
