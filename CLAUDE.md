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
- `www/` – vanilla JS setup page; `picker.js` = same object browser as ioBroker.logik/smartview.
- `test/` – `node --test`; hap-controller 0.10.2 (devDependency) is a real HomeKit client: pairing,
  read/write, events, snapshot, doorbell event, SRTP stream (needs ffmpeg). Separate files because
  of the storage path limit. UI checked with Playwright in the scratchpad (desktop + phone).

## Status

- 0.1.0: not yet tested with the owner's iPhone / Apple Home / mDNS on the real network.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.homekit-easy`.
- Run `npm test` before committing (also passes with Node 20.20.2).
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
