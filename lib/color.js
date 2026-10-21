'use strict';

/*
 * Color light (RGBW) on separate channel data points - KNX (R, G, B, W 0-100 % or 0-255) and Shelly
 * RGBW2/Bulb (red, green, blue, white 0-255, gain, switch). Apple Home and Alexa speak hue/saturation,
 * color temperature and brightness; this turns them into channel values and back:
 *   - the white part of a color goes to the W channel (pure white = W only)
 *   - with a brightness data point (Shelly gain) the channels stay at full scale, else they are scaled
 *   - several settings in a row (Home sends hue and saturation separately) are written once
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const WRITE_DELAY_MS = 60;
const SWITCH_THEN_COLOR_MS = 400;
const KEEP_TARGET_MS = 10000;

function hsvToRgb(h, s, v) {
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    return [
        [v, t, p],
        [q, v, p],
        [p, v, t],
        [p, q, v],
        [t, p, v],
        [v, p, q],
    ][i];
}

function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) {
            h = ((g - b) / d) % 6;
        } else if (max === g) {
            h = (b - r) / d + 2;
        } else {
            h = (r - g) / d + 4;
        }
        h *= 60;
        if (h < 0) {
            h += 360;
        }
    }
    return [h, max === 0 ? 0 : d / max, max];
}

/** Color of white light at a color temperature (mired), 0..1 with max 1. */
function miredToRgb(mired) {
    const t = 1e6 / clamp(mired, 140, 500) / 100;
    const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const c = [r, g, b].map(v => clamp(v, 0, 255) / 255);
    const m = Math.max(...c);
    return c.map(v => v / m);
}

/** Hue CIE xy (Alexa may send it) -> hue/saturation. */
function xyToHs(x, y) {
    const Y = 1;
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
    const gamma = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    [r, g, b] = [r, g, b].map(v => Math.max(0, gamma(v)));
    const m = Math.max(r, g, b) || 1;
    const [h, s] = rgbToHsv(r / m, g / m, b / m);
    return { h: Math.round(h), s: Math.round(s * 100) };
}

/** hue/saturation -> CIE xy (what Alexa shows for a Hue lamp). */
function hsToXy(h, s) {
    const lin = v => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
    const [r, g, b] = hsvToRgb(h, s / 100, 1).map(lin);
    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z || 1;
    return [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000];
}

/**
 * One color light on its data points.
 * @param {object} d device {red, green, blue, white?, brightness?, switchState?, range: '255'|'100'}
 * @param {object} x data point access (val/num/bool/ts/set) from main.js
 */
function colorLight(d, x) {
    const scale = d.range === '100' ? 100 : 255;
    const channels = [d.red, d.green, d.blue, d.white].filter(Boolean);
    let target = null; // last commanded {on, bri, h, s, ct, mode, at}
    let pending = null;
    let timer = null;
    let last = { bri: 100, h: 0, s: 0, ct: 370, mode: 'ct' };

    /** State from the data points. */
    function read() {
        const ch = id => (id ? clamp(x.num(id, 0) / scale, 0, 1) : 0);
        const w = ch(d.white);
        const [h, s, v] = rgbToHsv(Math.min(1, ch(d.red) + w), Math.min(1, ch(d.green) + w), Math.min(1, ch(d.blue) + w));
        const bri = d.brightness ? clamp(Math.round(x.num(d.brightness, 0)), 0, 100) : Math.round(v * 100);
        let on = bri > 0 && v > 0;
        let shown = bri;
        if (d.switchState && x.val(d.switchState) !== undefined) {
            // the switch decides when it changed after the color (KNX switch objects are often stale)
            const newest = Math.max(0, ...channels.concat(d.brightness || []).map(id => x.ts(id)));
            if (x.ts(d.switchState) >= newest) {
                on = x.bool(d.switchState);
            }
        }
        if (on && !shown) {
            // switched on, but the channel objects have no feedback: show the last known brightness
            shown = last.bri || 100;
        }
        return { on, bri: shown, h: Math.round(h), s: Math.round(s * 100), ct: null, mode: 'hs' };
    }

    function get() {
        if (target && Date.now() - target.at < KEEP_TARGET_MS) {
            return target;
        }
        target = null;
        return read();
    }

    /** Channel values (0..scale) for a state. */
    function values(st) {
        let rgb = st.mode === 'ct' && st.ct ? miredToRgb(st.ct) : hsvToRgb(st.h, st.s / 100, 1);
        let w = 0;
        if (d.white && st.mode === 'ct' && st.ct) {
            // white light: the W channel carries it, R/G/B only add a slight warm or cool tint
            const min = Math.min(...rgb);
            rgb = rgb.map(c => (c - min) * 0.5);
            w = 1;
        } else if (d.white) {
            w = Math.min(...rgb);
            rgb = rgb.map(c => c - w);
        }
        const k = d.brightness ? 1 : st.bri / 100;
        const v = c => Math.round(clamp(c * k, 0, 1) * scale);
        return { red: v(rgb[0]), green: v(rgb[1]), blue: v(rgb[2]), white: v(w) };
    }

    function writeColor(st) {
        const vals = values(st);
        for (const key of ['red', 'green', 'blue', 'white']) {
            if (d[key]) {
                x.set(d[key], vals[key]);
            }
        }
        if (d.brightness) {
            x.set(d.brightness, st.bri);
        }
    }

    function flush() {
        timer = null;
        const cmd = pending;
        pending = null;
        const before = get();
        const st = { ...before };
        if (cmd.h !== undefined || cmd.s !== undefined) {
            st.mode = 'hs';
            st.h = cmd.h !== undefined ? cmd.h : before.mode === 'hs' ? before.h : last.h;
            st.s = cmd.s !== undefined ? cmd.s : before.mode === 'hs' ? before.s : last.s;
        }
        if (cmd.ct !== undefined) {
            st.mode = 'ct';
            st.ct = clamp(Math.round(cmd.ct), 140, 500);
            // Home and Alexa also show white as a point on the color wheel
            const [h, s] = rgbToHsv(...miredToRgb(st.ct));
            st.h = Math.round(h);
            st.s = Math.round(s * 100);
        }
        if (cmd.bri !== undefined) {
            st.bri = cmd.bri;
        }
        st.on = cmd.on !== undefined ? cmd.on : cmd.bri !== undefined ? cmd.bri > 0 : before.on || cmd.h !== undefined || cmd.ct !== undefined;
        if (st.on && !st.bri) {
            st.bri = last.bri || 100;
        }
        target = { ...st, at: Date.now() };
        if (!st.on) {
            if (before.bri > 0) {
                last = { ...last, bri: before.bri };
            }
            if (d.switchState) {
                x.set(d.switchState, false);
            } else if (d.brightness) {
                x.set(d.brightness, 0);
            } else {
                for (const id of channels) {
                    x.set(id, 0);
                }
            }
            return;
        }
        last = { bri: st.bri, h: st.h, s: st.s, ct: st.ct || last.ct, mode: st.mode };
        const colorChanged = cmd.h !== undefined || cmd.s !== undefined || cmd.ct !== undefined || cmd.bri !== undefined;
        if (d.switchState && !before.on) {
            // switch on first (the actuator restores its last color), then the wanted color
            x.set(d.switchState, true);
            if (colorChanged) {
                setTimeout(() => writeColor(st), SWITCH_THEN_COLOR_MS);
            }
        } else if (colorChanged || !before.on) {
            writeColor(st);
        }
    }

    /** {on?, bri? (0-100), h? (0-360), s? (0-100), ct? (mired)} - collected for a moment, then written. */
    function set(cmd) {
        pending = { ...(pending || {}), ...cmd };
        if (!timer) {
            timer = setTimeout(flush, WRITE_DELAY_MS);
        }
    }

    return { get, set, read, values };
}

module.exports = { colorLight, hsvToRgb, rgbToHsv, miredToRgb, xyToHs, hsToXy };
