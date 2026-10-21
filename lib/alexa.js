'use strict';

/*
 * Devices for Alexa (lib/hue.js): which device types can be lamps for Alexa, and how on/off and
 * 0-100 % map to their data points. Locks, garage doors and alarm systems are left out on purpose:
 * over the Hue emulation anybody near an Echo could open them without a PIN.
 */

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
        const on = () => (d.switchState && x.val(d.switchState) !== undefined ? x.bool(d.switchState) : level() > 0);
        let last = 100;
        return {
            kind: 'dimmable',
            get: () => ({ on: on(), pct: level() }),
            set: c => {
                if (level() > 0) {
                    last = level();
                }
                if (c.pct !== undefined) {
                    x.set(d.state, c.pct);
                    if (d.switchState) {
                        x.set(d.switchState, c.pct > 0);
                    }
                } else if (c.on) {
                    if (d.switchState) {
                        x.set(d.switchState, true);
                    }
                    if (level() === 0) {
                        x.set(d.state, last);
                    }
                } else if (d.switchState) {
                    x.set(d.switchState, false);
                } else {
                    x.set(d.state, 0);
                }
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
        if (!d.alexa || !make || !d.state) {
            continue;
        }
        out.push({ id: ids(d.id), name: d.name, ...make(d, x) });
    }
    return out;
}

module.exports = { ALEXA_TYPES, alexaLights };
