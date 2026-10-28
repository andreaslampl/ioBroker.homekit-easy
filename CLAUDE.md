# ioBroker.homekit-easy

ioBroker adapter: simple HomeKit bridge. Owner found yahka far too complicated; here a device is
just a type + data points picked in an object browser. Setup page on its own port (8100), HAP on
51828. Cameras and doorbell come from ioBroker.livecam.

## Layout

- `lib/devices.js` – `TYPES`: group/label, `fields` `[key, label, r|w, ...]`, `options`,
  `build(acc, d, x)` creates the HAP services. `x` = val/bool/num/set/watch/meta/onCleanup.
  Dimmer: pending On for 300 ms, remembers last level. Blind: option closed100. Garage: impulse or
  open/close. Security: valueOff/Away/Home/Night mapped with `same()`/`typed()`.
- `lib/camera.js` – camera + doorbell types; `StreamingDelegate` (snapshot from livecam jpg, last
  picture as fallback; ffmpeg libx264 -> SRTP, RTCP socket, 30 s RTCP watchdog stops orphans).
  Source: livecam mjpegUrl, or an own RTSP URL (option `source`).
- `lib/bridge.js` – `HomekitBridge` on hap-nodejs 0.14.3 (pinned exactly): `identity.json`
  (username, PIN without trivial ones - HomeKit rejects 123-45-678 etc., setupID), `update()` diffs by
  config, UUID `homekit-easy:<id>:<type>`, max 149 devices, `resetPairing()`.
  `HAPStorage.setCustomStoragePath` works only once per process (hence compact false, try/catch).
- `lib/store.js` – devices.json, `clean()` validates against the types, `writable()` = 'w' fields.
  Apple Home may only write those (checked in `main.write`). The PIN is never logged.
- `lib/server.js` – setup page + API (catalog, devices, objects/values for the picker, cameras,
  pairing with QR SVG, reset); optional access key (`?key=` once -> cookie `hke_key`).
- `lib/color.js` – `colorLight(d, x)` (0.3.0): RGBW on separate channel data points (KNX 0-100 or
  0-255, Shelly 0-255 + gain + Switch). hue/sat/ct/bri <-> channels (white part of a color -> W;
  white temperature = W full + half-strength tint), brightness data point keeps channels full scale,
  writes debounced 60 ms (Home sends hue and saturation separately), switch first then color 400 ms
  later, commanded state shown for 10 s; on/off by the newest data point (`x.ts` = lc).
  Used by the HomeKit type `rgbw` and Alexa (Hue "Extended color light": hue/sat/xy/ct).
- `lib/hue.js` – Alexa without cloud (0.2.0): emulated Hue bridge API v1 (SSDP on UDP 1900 + HTTP on
  port 80 - Echo devices insist on 80; description.xml "Philips hue bridge 2012", POST /api user,
  lights/state PUT {on, bri}); commanded state is reported back for 8 s so Alexa does not say the
  device does not respond. `lib/alexa.js` maps device types to lamps (light/dimmer/switch/outlet/fan/
  blind; since 0.5.0 also lock/garage/security/thermostat, see below). Light numbers stable in alexa.json (+ bridge MAC).
  Starts only when a device has `alexa: true`. Not yet tested with the owner's Echo devices.
- Messages (0.4.0, `common.messagebox`): `devices` -> {devices, types} for anyone; `sync` {devices} only from
  `smartview.N` -> `DeviceStore.mergeFrom(source, list)`: devices get `source`, same id = update (alexa/enabled
  kept), devices of that source not listed = removed, others untouched. Setup page tags them "SmartView".
  0.4.1: button "Aus SmartView …" (`/api/smartview`, `/api/smartview/link` -> sendTo smartview 'tiles' / 'link';
  SmartView ticks the tiles, saves and syncs back, so SmartView stays the owner of those devices).
- `www/` – vanilla JS setup page; `picker.js` = same object browser as ioBroker.logik/smartview.
- `test/` – `node --test`; hap-controller 0.10.2 (devDependency) is a real HomeKit client: pairing,
  read/write, events, snapshot, doorbell event, SRTP stream (needs ffmpeg). Separate files because
  of the storage path limit. UI checked with Playwright in the scratchpad (desktop + phone).

## Status

- 0.1.0: not yet tested with the owner's iPhone / Apple Home / mDNS on the real network.
- 0.2.0: owner wants Alexa voice commands simpler than the iot adapter (cloud + Pro subscription) ->
  "Weg A": local Hue emulation in this adapter, same device list, tick "auch für Alexa". Owner's
  Alexa routines live in Amazon's cloud and can use these lamps as actions; triggering routines /
  TTS from ioBroker would be the alexa2 adapter (suggested for later).
- 0.2.0 field: Alexa works with the owner's Echo devices. Dimmer with brightness only: perfect; with an
  extra on/off data point Alexa got confused -> 0.2.1: brightness was written before "Ein" (a KNX dimmer
  then jumps to its switch-on value) and the stale switch object decided on/off. Now switch first,
  brightness 400 ms later, and on/off = whichever of the two data points changed last (`dimmerOn`,
  `x.ts`); same for the HomeKit dimmer. `x.ts` returns lc (last change), so devices that repeat their
  values (Shelly polling) do not count as a change.
- 0.3.0: owner asked for RGBW (KNX and Shelly) -> type "Farblicht (RGBW)" (lib/color.js). Not yet
  tested with the owner's actuators.

- 0.4.0: owner asked to avoid entering devices twice in SmartView and homekit-easy -> SmartView tile tick
  "auch in Apple Home" syncs here, SmartView can import devices from here (linked by `hkId`).
- 0.4.2: owner: blind only had a position, needs the up/down object (1 = down, 0 = up) -> fields `state` (position,
  now optional) + `move` (+ option `moveInvert`), type `anyOf: ['state', 'move']` (setup page `missing()`);
  `blindIO()` in alexa.js used by HomeKit and Alexa: 0/100 % via move when present, in between via position, move
  only -> nearer end; a boolean `state` (SmartView tile with up/down) counts as move (meta type). Position without
  feedback: last commanded, else from the move value.
- 0.5.0: owner: "Türschloss auch in Alexa, eigentlich sollten alle gehen". Hue lamps only, no voice PIN possible ->
  lock (ein = lock), garage (aus = close, ein = open), security (ein = valueAway, aus = valueOff), thermostat
  (percent = °C setpoint, aus = min). The unsafe direction (unlock/open/disarm) only with device option
  `alexaUnsafe`, else `refused()` logs a warning and returns false (hue.js then drops the echoed state). Sensors,
  cameras, buttons stay out (Alexa cannot read values from lamps). Catalog `alexa` = help text (ALEXA_HELP) or true.
- 0.5.1: owner: blind direction right in Apple Home but reversed in Alexa (and the other way round with closed100) ->
  option `alexaInvert` (alexa.js blind: pct and commands mirrored, HomeKit untouched). `mergeFrom()` now also keeps
  `alexaUnsafe` / `alexaInvert` when SmartView syncs (they are set here, like alexa/enabled).
- Field: owner could not share the home with the family. The bridge accepts added users (AddPairing,
  `test/share.test.js`); cause was on Apple's side (home hub needed for sharing / company iPhone restrictions),
  confirmed by the owner. Nothing to change in the adapter.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.homekit-easy`.
- Run `npm test` before committing (also passes with Node 20.20.2).
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
