'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { StreamRequestTypes } = require('hap-nodejs');
const { StreamingDelegate } = require('../lib/camera');
const { until } = require('./helpers');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('live video: livecam MJPEG -> ffmpeg H.264 -> SRTP packets to the iPhone, stopped on STOP', { skip: !hasFfmpeg && 'no ffmpeg' }, async t => {
    // a JPEG from ffmpeg's test pattern, served as MJPEG like livecam does
    const frame = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']).stdout;
    assert.ok(frame.length > 1000);
    const cam = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=f' });
        const timer = setInterval(() => res.write(Buffer.concat([Buffer.from(`--f\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from('\r\n')])), 100);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise(r => cam.listen(0, '127.0.0.1', r));
    t.after(() => {
        cam.closeAllConnections();
        cam.close();
    });

    // the "iPhone": receives SRTP on a UDP port
    const phone = dgram.createSocket('udp4');
    await new Promise(r => phone.bind(0, '127.0.0.1', r));
    t.after(() => phone.close());
    const packets = [];
    phone.on('message', m => packets.push(m));

    const log = { debug() {}, info() {}, warn: m => console.log('WARN', m), error() {} };
    const delegate = new StreamingDelegate({ name: 'Haustür', urls: async () => ({ jpg: '', mjpeg: `http://127.0.0.1:${cam.address().port}/cam/haustuer.mjpeg` }), log });
    const sessionID = crypto.randomUUID();
    const prepared = await new Promise((resolve, reject) =>
        delegate.prepareStream(
            { sessionID, targetAddress: '127.0.0.1', addressVersion: 'ipv4', video: { port: phone.address().port, srtp_key: crypto.randomBytes(16), srtp_salt: crypto.randomBytes(14), srtpCryptoSuite: 0 } },
            (err, res) => (err ? reject(err) : resolve(res)),
        ),
    );
    assert.ok(prepared.video.port > 0);
    await new Promise((resolve, reject) =>
        delegate.handleStreamRequest(
            { sessionID, type: StreamRequestTypes.START, video: { width: 640, height: 360, fps: 15, max_bit_rate: 300, pt: 99, mtu: 1378 } },
            err => (err ? reject(err) : resolve()),
        ),
    );
    await until(() => packets.length > 20, 20000);
    // RTP version 2 with the negotiated payload type and SSRC
    const p = packets[packets.length - 1];
    assert.equal(p[0] >> 6, 2);
    assert.equal(p[1] & 0x7f, 99);
    assert.equal(p.readUInt32BE(8), prepared.video.ssrc >>> 0);

    const proc = delegate.sessions.get(sessionID).proc;
    await new Promise(resolve => delegate.handleStreamRequest({ sessionID, type: StreamRequestTypes.STOP }, () => resolve()));
    await until(() => proc.exitCode !== null || proc.signalCode !== null, 5000);
    assert.equal(delegate.sessions.size, 0);
});
