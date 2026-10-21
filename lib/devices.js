'use strict';

/*
 * Device types: what the user picks in the setup page, and how it becomes HomeKit services.
 * Each type lists its data point fields ([key, label, 'r'|'w', required?]) and options; build()
 * adds the services to an accessory and wires them to the data points through `x`:
 *   x.val(id)            current value (raw ioBroker value, undefined while unknown)
 *   x.bool(id, invert)   value as boolean
 *   x.num(id, def)       value as number
 *   x.set(id, value)     write (as command, ack = false)
 *   x.watch(ids, fn)     call fn when one of the data points changes
 *   x.meta(id)           {min, max, unit} of the data point object
 */

const { Service, Characteristic: C } = require('hap-nodejs');
const { dimmerOn, SWITCH_THEN_LEVEL_MS } = require('./alexa');
const { colorLight } = require('./color');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function same(val, want) {
    if (want === undefined || want === null || want === '') {
        return false;
    }
    if (String(val) === String(want)) {
        return true;
    }
    const n = Number(want);
    return want !== '' && Number.isFinite(n) && (val === n || (typeof val === 'boolean' && Number(val) === n));
}

/** Value text from the setup page as the data point would like it (number if it looks like one). */
function typed(text) {
    if (text === 'true') {
        return true;
    }
    if (text === 'false') {
        return false;
    }
    const n = Number(text);
    return text !== '' && Number.isFinite(n) ? n : text;
}

const TYPES = {
    // ---------------- light & power ----------------
    light: {
        label: 'Licht (Ein/Aus)',
        group: 'Licht & Strom',
        fields: [['state', 'Schalten', 'w', true], ['status', 'Rückmeldung (optional)', 'r']],
        options: [['invert', 'Umgekehrt (true = aus)', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.Lightbulb, d.name);
            const on = () => x.bool(d.status || d.state, d.invert);
            s.getCharacteristic(C.On).onGet(on).onSet(v => x.set(d.state, d.invert ? !v : Boolean(v)));
            x.watch([d.status || d.state], () => s.updateCharacteristic(C.On, on()));
        },
    },
    dimmer: {
        label: 'Dimmer',
        group: 'Licht & Strom',
        fields: [
            ['state', 'Helligkeit 0–100 %', 'w', true],
            ['switchState', 'Ein/Aus (optional)', 'w'],
            ['status', 'Rückmeldung Helligkeit (optional)', 'r'],
        ],
        options: [],
        build(acc, d, x) {
            const s = acc.addService(Service.Lightbulb, d.name);
            const level = () => clamp(Math.round(x.num(d.status || d.state, 0)), 0, 100);
            const on = () => dimmerOn(d, x, level);
            let last = 100;
            let pending = null;
            s.getCharacteristic(C.On)
                .onGet(on)
                .onSet(v => {
                    if (d.switchState) {
                        x.set(d.switchState, Boolean(v));
                    }
                    clearTimeout(pending);
                    if (v) {
                        // Home sends On and Brightness together: only restore a level when no brightness follows
                        pending = setTimeout(() => level() === 0 && x.set(d.state, last), 300);
                    } else if (!d.switchState) {
                        if (level() > 0) {
                            last = level();
                        }
                        x.set(d.state, 0);
                    }
                });
            s.getCharacteristic(C.Brightness)
                .onGet(level)
                .onSet(v => {
                    clearTimeout(pending);
                    if (v > 0) {
                        last = v;
                    }
                    if (d.switchState && v > 0 && !on()) {
                        // switch first: on "Ein" a KNX dimmer jumps to its switch-on value
                        x.set(d.switchState, true);
                        pending = setTimeout(() => x.set(d.state, v), SWITCH_THEN_LEVEL_MS);
                    } else {
                        x.set(d.state, v);
                    }
                });
            x.watch([d.status || d.state, d.switchState], () => {
                s.updateCharacteristic(C.On, on());
                s.updateCharacteristic(C.Brightness, level());
            });
        },
    },
    rgbw: {
        label: 'Farblicht (RGBW)',
        group: 'Licht & Strom',
        fields: [
            ['red', 'Rot', 'w', true],
            ['green', 'Grün', 'w', true],
            ['blue', 'Blau', 'w', true],
            ['white', 'Weiß (optional)', 'w'],
            ['brightness', 'Helligkeit 0–100 % (optional, z. B. Shelly gain)', 'w'],
            ['switchState', 'Ein/Aus (optional)', 'w'],
        ],
        options: [['range', 'Wertebereich der Farbkanäle', 'select:255=0–255 (Shelly, KNX 1-Byte-Wert);100=0–100 % (KNX Prozent)', '255']],
        build(acc, d, x) {
            const L = colorLight(d, x);
            const s = acc.addService(Service.Lightbulb, d.name);
            s.getCharacteristic(C.On).onGet(() => L.get().on).onSet(v => L.set({ on: Boolean(v) }));
            s.getCharacteristic(C.Brightness).onGet(() => L.get().bri).onSet(v => L.set({ bri: v }));
            s.getCharacteristic(C.Hue).onGet(() => L.get().h).onSet(v => L.set({ h: v }));
            s.getCharacteristic(C.Saturation).onGet(() => L.get().s).onSet(v => L.set({ s: v }));
            if (d.white) {
                s.getCharacteristic(C.ColorTemperature)
                    .setProps({ minValue: 140, maxValue: 500 })
                    .onGet(() => L.get().ct || 370)
                    .onSet(v => L.set({ ct: v }));
            }
            x.watch([d.red, d.green, d.blue, d.white, d.brightness, d.switchState], () => {
                const st = L.get();
                s.updateCharacteristic(C.On, st.on);
                s.updateCharacteristic(C.Brightness, st.bri);
                s.updateCharacteristic(C.Hue, st.h);
                s.updateCharacteristic(C.Saturation, st.s);
            });
        },
    },
    outlet: {
        label: 'Steckdose',
        group: 'Licht & Strom',
        fields: [['state', 'Schalten', 'w', true], ['status', 'Rückmeldung (optional)', 'r']],
        options: [['invert', 'Umgekehrt (true = aus)', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.Outlet, d.name);
            const on = () => x.bool(d.status || d.state, d.invert);
            s.getCharacteristic(C.On).onGet(on).onSet(v => x.set(d.state, d.invert ? !v : Boolean(v)));
            s.getCharacteristic(C.OutletInUse).onGet(on);
            x.watch([d.status || d.state], () => {
                s.updateCharacteristic(C.On, on());
                s.updateCharacteristic(C.OutletInUse, on());
            });
        },
    },
    switch: {
        label: 'Schalter (z. B. Szene, Gerät)',
        group: 'Licht & Strom',
        fields: [['state', 'Schalten', 'w', true], ['status', 'Rückmeldung (optional)', 'r']],
        options: [['invert', 'Umgekehrt (true = aus)', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.Switch, d.name);
            const on = () => x.bool(d.status || d.state, d.invert);
            s.getCharacteristic(C.On).onGet(on).onSet(v => x.set(d.state, d.invert ? !v : Boolean(v)));
            x.watch([d.status || d.state], () => s.updateCharacteristic(C.On, on()));
        },
    },
    fan: {
        label: 'Ventilator / Lüftung',
        group: 'Licht & Strom',
        fields: [['state', 'Ein/Aus', 'w', true], ['speed', 'Stufe 0–100 % (optional)', 'w'], ['status', 'Rückmeldung Ein/Aus (optional)', 'r']],
        options: [],
        build(acc, d, x) {
            const s = acc.addService(Service.Fanv2, d.name);
            const on = () => (x.bool(d.status || d.state) ? 1 : 0);
            s.getCharacteristic(C.Active).onGet(on).onSet(v => x.set(d.state, v === 1));
            if (d.speed) {
                s.getCharacteristic(C.RotationSpeed)
                    .onGet(() => clamp(x.num(d.speed, 0), 0, 100))
                    .onSet(v => x.set(d.speed, v));
            }
            x.watch([d.status || d.state, d.speed], () => {
                s.updateCharacteristic(C.Active, on());
                if (d.speed) {
                    s.updateCharacteristic(C.RotationSpeed, clamp(x.num(d.speed, 0), 0, 100));
                }
            });
        },
    },

    // ---------------- windows & doors ----------------
    blind: {
        label: 'Rollladen / Jalousie / Markise',
        group: 'Fenster & Türen',
        fields: [['state', 'Position (Datenpunkt)', 'w', true], ['stop', 'Stopp (optional)', 'w'], ['status', 'Rückmeldung Position (optional)', 'r']],
        options: [['closed100', '100 % = geschlossen (KNX, je nach Gerät)', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.WindowCovering, d.name);
            // HomeKit: 0 = closed, 100 = open
            const toHk = v => clamp(Math.round(d.closed100 ? 100 - v : v), 0, 100);
            const current = () => toHk(x.num(d.status || d.state, 0));
            let target = null;
            s.getCharacteristic(C.CurrentPosition).onGet(current);
            s.getCharacteristic(C.TargetPosition)
                .onGet(() => (target === null ? current() : target))
                .onSet(v => {
                    target = v;
                    x.set(d.state, d.closed100 ? 100 - v : v);
                });
            s.getCharacteristic(C.PositionState).onGet(() => C.PositionState.STOPPED);
            if (d.stop) {
                s.getCharacteristic(C.HoldPosition).onSet(v => v && x.set(d.stop, true));
            }
            x.watch([d.status || d.state], () => {
                s.updateCharacteristic(C.CurrentPosition, current());
                // reached (or moved by a button on the wall): the target follows the real position
                if (target === null || Math.abs(target - current()) <= 2 || !d.status) {
                    target = current();
                }
                s.updateCharacteristic(C.TargetPosition, target);
            });
        },
    },
    garage: {
        label: 'Garagentor / Tor',
        group: 'Fenster & Türen',
        fields: [['command', 'Befehl (Taster oder Auf/Zu)', 'w', true], ['status', 'Endlage / Kontakt (optional)', 'r']],
        options: [
            ['mode', 'Befehl', 'select:impulse=Impuls (schreibt true, z. B. Taster);openclose=Auf/Zu (true = auf, false = zu)'],
            ['statusInvert', 'Kontakt umgekehrt (true = zu)', 'check'],
        ],
        build(acc, d, x) {
            const s = acc.addService(Service.GarageDoorOpener, d.name);
            const O = C.CurrentDoorState;
            let target = C.TargetDoorState.CLOSED;
            const isOpen = () => (d.status ? x.bool(d.status, d.statusInvert) : target === C.TargetDoorState.OPEN);
            const current = () => (isOpen() ? O.OPEN : O.CLOSED);
            target = isOpen() ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED;
            s.getCharacteristic(C.CurrentDoorState).onGet(current);
            s.getCharacteristic(C.TargetDoorState)
                .onGet(() => target)
                .onSet(v => {
                    target = v;
                    const wantOpen = v === C.TargetDoorState.OPEN;
                    if (d.mode === 'openclose') {
                        x.set(d.command, wantOpen);
                    } else if (!d.status || wantOpen !== isOpen()) {
                        x.set(d.command, true);
                    }
                    if (!d.status) {
                        s.updateCharacteristic(C.CurrentDoorState, current());
                    }
                });
            s.getCharacteristic(C.ObstructionDetected).onGet(() => false);
            x.watch([d.status], () => {
                target = isOpen() ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED;
                s.updateCharacteristic(C.TargetDoorState, target);
                s.updateCharacteristic(C.CurrentDoorState, current());
            });
        },
    },
    lock: {
        label: 'Türschloss',
        group: 'Fenster & Türen',
        fields: [['state', 'Verriegeln (Datenpunkt)', 'w', true], ['status', 'Rückmeldung (optional)', 'r']],
        options: [['invert', 'Umgekehrt (true = offen)', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.LockMechanism, d.name);
            const locked = () => x.bool(d.status || d.state, d.invert);
            const current = () => (x.val(d.status || d.state) === undefined ? C.LockCurrentState.UNKNOWN : locked() ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
            s.getCharacteristic(C.LockCurrentState).onGet(current);
            s.getCharacteristic(C.LockTargetState)
                .onGet(() => (locked() ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED))
                .onSet(v => {
                    const lock = v === C.LockTargetState.SECURED;
                    x.set(d.state, d.invert ? !lock : lock);
                });
            x.watch([d.status || d.state], () => {
                s.updateCharacteristic(C.LockCurrentState, current());
                s.updateCharacteristic(C.LockTargetState, locked() ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED);
            });
        },
    },

    // ---------------- climate ----------------
    thermostat: {
        label: 'Heizung / Thermostat',
        group: 'Klima',
        fields: [['state', 'Sollwert', 'w', true], ['actual', 'Istwert', 'r', true], ['heating', 'Heizt gerade (optional, z. B. Stellantrieb)', 'r']],
        options: [['min', 'Sollwert minimal (°C)', 'number'], ['max', 'Sollwert maximal (°C)', 'number'], ['step', 'Schritt (°C)', 'number']],
        build(acc, d, x) {
            const s = acc.addService(Service.Thermostat, d.name);
            const m = x.meta(d.state);
            const min = Number.isFinite(d.min) ? d.min : Number.isFinite(m.min) ? m.min : 5;
            const max = Number.isFinite(d.max) ? d.max : Number.isFinite(m.max) ? m.max : 30;
            const step = d.step || 0.5;
            const tgt = () => clamp(x.num(d.state, 20), min, max);
            s.getCharacteristic(C.TargetTemperature)
                .setProps({ minValue: min, maxValue: max, minStep: step })
                .onGet(tgt)
                .onSet(v => x.set(d.state, v));
            s.getCharacteristic(C.CurrentTemperature)
                .setProps({ minValue: -50, maxValue: 100 })
                .onGet(() => x.num(d.actual, 0));
            const heating = () => (d.heating ? (x.bool(d.heating) || x.num(d.heating, 0) > 0 ? 1 : 0) : 1);
            s.getCharacteristic(C.CurrentHeatingCoolingState).onGet(heating);
            s.getCharacteristic(C.TargetHeatingCoolingState)
                .setProps({ validValues: [C.TargetHeatingCoolingState.HEAT] })
                .onGet(() => C.TargetHeatingCoolingState.HEAT);
            s.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);
            x.watch([d.state, d.actual, d.heating], () => {
                s.updateCharacteristic(C.TargetTemperature, tgt());
                s.updateCharacteristic(C.CurrentTemperature, x.num(d.actual, 0));
                s.updateCharacteristic(C.CurrentHeatingCoolingState, heating());
            });
        },
    },
    temperature: sensor('Temperatur', 'Klima', Service.TemperatureSensor, C.CurrentTemperature, (x, d) => x.num(d.state, 0), { minValue: -50, maxValue: 150 }),
    humidity: sensor('Luftfeuchte', 'Klima', Service.HumiditySensor, C.CurrentRelativeHumidity, (x, d) => clamp(x.num(d.state, 0), 0, 100)),
    co2: {
        label: 'CO₂',
        group: 'Klima',
        fields: [['state', 'CO₂ in ppm', 'r', true]],
        options: [['limit', 'Warnung ab ppm (Standard 1200)', 'number']],
        build(acc, d, x) {
            const s = acc.addService(Service.CarbonDioxideSensor, d.name);
            const ppm = () => clamp(x.num(d.state, 0), 0, 100000);
            const alarm = () => (ppm() >= (d.limit || 1200) ? 1 : 0);
            s.getCharacteristic(C.CarbonDioxideLevel).onGet(ppm);
            s.getCharacteristic(C.CarbonDioxideDetected).onGet(alarm);
            x.watch([d.state], () => {
                s.updateCharacteristic(C.CarbonDioxideLevel, ppm());
                s.updateCharacteristic(C.CarbonDioxideDetected, alarm());
            });
        },
    },

    // ---------------- sensors ----------------
    contact: sensor('Kontakt (Fenster/Tür)', 'Sensoren', Service.ContactSensor, C.ContactSensorState, (x, d) => (x.bool(d.state, d.invert) ? 1 : 0), null, [['invert', 'Umgekehrt (true = zu)', 'check']], 'Datenpunkt (true = offen)'),
    motion: sensor('Bewegung', 'Sensoren', Service.MotionSensor, C.MotionDetected, (x, d) => x.bool(d.state, d.invert), null, [['invert', 'Umgekehrt', 'check']]),
    occupancy: sensor('Anwesenheit / Präsenz', 'Sensoren', Service.OccupancySensor, C.OccupancyDetected, (x, d) => (x.bool(d.state, d.invert) ? 1 : 0), null, [['invert', 'Umgekehrt', 'check']]),
    smoke: sensor('Rauch / Brand', 'Sensoren', Service.SmokeSensor, C.SmokeDetected, (x, d) => (x.bool(d.state, d.invert) ? 1 : 0), null, [['invert', 'Umgekehrt', 'check']], 'Datenpunkt (true = Alarm)'),
    leak: sensor('Wasser / Leck', 'Sensoren', Service.LeakSensor, C.LeakDetected, (x, d) => (x.bool(d.state, d.invert) ? 1 : 0), null, [['invert', 'Umgekehrt', 'check']], 'Datenpunkt (true = Wasser)'),
    lux: sensor('Helligkeit (Lux)', 'Sensoren', Service.LightSensor, C.CurrentAmbientLightLevel, (x, d) => clamp(x.num(d.state, 0.0001), 0.0001, 100000)),

    // ---------------- security ----------------
    security: {
        label: 'Alarmanlage',
        group: 'Sicherheit',
        fields: [['status', 'Zustand', 'r', true], ['command', 'Befehl (leer = gleicher Datenpunkt wie Zustand)', 'w'], ['triggered', 'Alarm ausgelöst (optional)', 'r']],
        options: [
            ['valueOff', 'Wert für „Aus“ (unscharf)', 'text', '0'],
            ['valueAway', 'Wert für „Abwesend“ (scharf)', 'text', '1'],
            ['valueHome', 'Wert für „Zuhause“ (intern scharf, optional)', 'text'],
            ['valueNight', 'Wert für „Nacht“ (optional)', 'text'],
        ],
        build(acc, d, x) {
            const s = acc.addService(Service.SecuritySystem, d.name);
            const T = C.SecuritySystemTargetState;
            const modes = [
                [T.DISARM, d.valueOff],
                [T.AWAY_ARM, d.valueAway],
                [T.STAY_ARM, d.valueHome],
                [T.NIGHT_ARM, d.valueNight],
            ].filter(([, v]) => v !== undefined && v !== '');
            const mode = () => {
                const v = x.val(d.status);
                const hit = modes.find(([, want]) => same(v, want));
                return hit ? hit[0] : T.DISARM;
            };
            const current = () => (d.triggered && x.bool(d.triggered) ? C.SecuritySystemCurrentState.ALARM_TRIGGERED : mode());
            let target = mode();
            s.getCharacteristic(C.SecuritySystemCurrentState).onGet(current);
            s.getCharacteristic(C.SecuritySystemTargetState)
                .setProps({ validValues: modes.map(([m]) => m).sort() })
                .onGet(() => target)
                .onSet(v => {
                    target = v;
                    const hit = modes.find(([m]) => m === v);
                    if (hit) {
                        x.set(d.command || d.status, typed(hit[1]));
                    }
                });
            x.watch([d.status, d.triggered], () => {
                target = mode();
                s.updateCharacteristic(C.SecuritySystemTargetState, target);
                s.updateCharacteristic(C.SecuritySystemCurrentState, current());
            });
        },
    },
    button: {
        label: 'Taster (für Automationen in Home)',
        group: 'Sonstiges',
        fields: [['state', 'Datenpunkt (löst aus, wenn er true wird)', 'r', true]],
        options: [['anyChange', 'Bei jeder Änderung auslösen', 'check']],
        build(acc, d, x) {
            const s = acc.addService(Service.StatelessProgrammableSwitch, d.name);
            const ev = s.getCharacteristic(C.ProgrammableSwitchEvent);
            ev.setProps({ validValues: [C.ProgrammableSwitchEvent.SINGLE_PRESS] });
            let prev = x.val(d.state);
            x.watch([d.state], () => {
                const v = x.val(d.state);
                const fire = d.anyChange ? v !== prev : x.bool(d.state) && !(prev === true || prev === 1 || prev === 'true');
                prev = v;
                if (fire) {
                    ev.sendEventNotification(C.ProgrammableSwitchEvent.SINGLE_PRESS);
                }
            });
        },
    },
};

/** A read-only sensor with one characteristic. */
function sensor(label, group, service, characteristic, read, props, options = [], fieldLabel = 'Datenpunkt') {
    return {
        label,
        group,
        fields: [['state', fieldLabel, 'r', true]],
        options,
        build(acc, d, x) {
            const s = acc.addService(service, d.name);
            const ch = s.getCharacteristic(characteristic);
            if (props) {
                ch.setProps(props);
            }
            ch.onGet(() => read(x, d));
            x.watch([d.state], () => s.updateCharacteristic(characteristic, read(x, d)));
        },
    };
}

/** Catalog for the setup page (without build functions). */
function catalog() {
    return Object.entries(TYPES).map(([type, t]) => ({ type, label: t.label, group: t.group, fields: t.fields, options: t.options }));
}

module.exports = { TYPES, catalog, same, typed };
