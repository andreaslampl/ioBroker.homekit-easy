'use strict';

/*
 * Cameras and the doorbell for Apple Home. The picture comes from the livecam adapter:
 *   snapshot (tile in Home)  -> livecam /cam/<id>.jpg
 *   live video               -> ffmpeg reads livecam's MJPEG (or an own RTSP source of the camera),
 *                               encodes H.264 and sends it SRTP-encrypted to the iPhone (Apple's format)
 *   doorbell                 -> a data point (e.g. livecam.0.intercom.ringing) rings in Apple Home
 *                               with picture on iPhone, iPad and Apple Watch.
 * Audio is not streamed (talking stays with SmartView / the camera wall).
 */

const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const {
    CameraController,
    DoorbellController,
    SRTPCryptoSuites,
    H264Profile,
    H264Level,
    StreamRequestTypes,
} = require('hap-nodejs');

const RESOLUTIONS = [
    [1920, 1080, 30],
    [1280, 720, 30],
    [1024, 768, 30],
    [640, 480, 30],
    [640, 360, 30],
    [480, 360, 30],
    [480, 270, 30],
    [320, 240, 15],
    [320, 180, 15],
];

function streamingOptions() {
    return {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
            codec: {
                profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
                levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
            resolutions: RESOLUTIONS,
        },
    };
}

function fetchImage(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { rejectUnauthorized: false, timeout }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`))));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

/** ffmpeg arguments: source -> H.264 -> SRTP to the iPhone. */
function ffmpegArgs({ source, width, height, fps, bitrate, payloadType, ssrc, key, address, port, mtu }) {
    const input = /^rtsps?:/i.test(source) ? ['-rtsp_transport', 'tcp', '-i', source] : ['-i', source];
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-fflags',
        'nobuffer',
        ...input,
        '-an',
        '-sn',
        '-dn',
        '-codec:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-color_range',
        'mpeg',
        '-r',
        String(fps),
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-filter:v',
        `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        '-b:v',
        `${bitrate}k`,
        '-bufsize',
        `${bitrate * 2}k`,
        '-maxrate',
        `${bitrate}k`,
        '-payload_type',
        String(payloadType),
        '-ssrc',
        String(ssrc),
        '-f',
        'rtp',
        '-srtp_out_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params',
        key.toString('base64'),
        `srtp://${address}:${port}?rtcpport=${port}&pkt_size=${mtu}`,
    ];
}

class StreamingDelegate {
    /**
     * @param {object} o
     * @param {() => Promise<{jpg: string, mjpeg: string}|null>} o.urls livecam URLs of the camera
     * @param {string} [o.source] own video source (RTSP) instead of livecam's MJPEG
     */
    constructor({ name, urls, source = '', ffmpegPath = 'ffmpeg', log, spawnFn = spawn }) {
        this.name = name;
        this.urls = urls;
        this.source = source;
        this.ffmpegPath = ffmpegPath;
        this.log = log;
        this.spawnFn = spawnFn;
        this.sessions = new Map();
        this.lastSnapshot = null;
    }

    async handleSnapshotRequest(request, callback) {
        try {
            const u = await this.urls();
            if (!u || !u.jpg) {
                throw new Error('camera not found in livecam');
            }
            const img = await fetchImage(u.jpg);
            this.lastSnapshot = img;
            callback(undefined, img);
        } catch (err) {
            this.log.debug(`${this.name}: snapshot failed: ${err.message}`);
            // an older picture is better than none
            callback(this.lastSnapshot ? undefined : err, this.lastSnapshot || undefined);
        }
    }

    async prepareStream(request, callback) {
        try {
            // local port: Apple sends RTCP there; no RTCP for a while = viewer gone
            const socket = dgram.createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
            await new Promise((resolve, reject) => {
                socket.once('error', reject);
                socket.bind(0, () => resolve());
            });
            const ssrc = CameraController.generateSynchronisationSource();
            const session = {
                socket,
                address: request.targetAddress,
                port: request.video.port,
                key: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
                ssrc,
                lastRtcp: Date.now(),
            };
            socket.on('message', () => {
                session.lastRtcp = Date.now();
            });
            socket.on('error', () => {});
            this.sessions.set(request.sessionID, session);
            callback(undefined, {
                video: { port: socket.address().port, ssrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
            });
        } catch (err) {
            callback(err);
        }
    }

    handleStreamRequest(request, callback) {
        if (request.type === StreamRequestTypes.START) {
            this._start(request).then(
                () => callback(),
                err => callback(err),
            );
        } else if (request.type === StreamRequestTypes.RECONFIGURE) {
            callback();
        } else {
            this._stop(request.sessionID);
            callback();
        }
    }

    async _start(request) {
        const s = this.sessions.get(request.sessionID);
        if (!s) {
            throw new Error('unknown session');
        }
        let source = this.source;
        if (!source) {
            const u = await this.urls();
            if (!u || !u.mjpeg) {
                throw new Error('camera not found in livecam');
            }
            source = u.mjpeg;
        }
        const v = request.video;
        const args = ffmpegArgs({
            source,
            width: v.width,
            height: v.height,
            fps: Math.min(v.fps, 30),
            bitrate: v.max_bit_rate,
            payloadType: v.pt,
            ssrc: s.ssrc,
            key: s.key,
            address: s.address,
            port: s.port,
            mtu: v.mtu || 1378,
        });
        this.log.debug(`${this.name}: live video ${v.width}x${v.height}@${v.fps} ${v.max_bit_rate} kbit/s`);
        const proc = this.spawnFn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        s.proc = proc;
        let err = '';
        proc.stderr && proc.stderr.on('data', d => (err = (err + d).slice(-1000)));
        proc.on('error', e => this.log.warn(`${this.name}: ${e.code === 'ENOENT' ? 'ffmpeg not found - install it: sudo apt install ffmpeg' : e.message}`));
        proc.on('exit', code => {
            if (s.proc === proc && code) {
                this.log.warn(`${this.name}: ffmpeg ended (${code}) ${err.trim().split('\n').pop() || ''}`);
            }
        });
        // viewer gone without STOP (phone locked, network lost): end after 30 s without RTCP
        s.watchdog = setInterval(() => {
            if (Date.now() - s.lastRtcp > 30000) {
                this.log.debug(`${this.name}: no RTCP for 30 s, stopping the stream`);
                this._stop(request.sessionID);
            }
        }, 5000);
    }

    _stop(sessionID) {
        const s = this.sessions.get(sessionID);
        if (!s) {
            return;
        }
        this.sessions.delete(sessionID);
        clearInterval(s.watchdog);
        if (s.proc) {
            const p = s.proc;
            s.proc = null;
            p.kill('SIGKILL');
        }
        try {
            s.socket.close();
        } catch {
            // already closed
        }
    }

    stopAll() {
        for (const id of [...this.sessions.keys()]) {
            this._stop(id);
        }
    }
}

/** Device types "camera" and "doorbell" (need access to livecam URLs and ffmpeg). */
function cameraTypes({ cameraUrls, ffmpegPath = 'ffmpeg', log, spawnFn }) {
    const build = doorbell => (acc, d, x) => {
        const delegate = new StreamingDelegate({ name: d.name, urls: () => cameraUrls(d.camera), source: d.source || '', ffmpegPath, log, spawnFn });
        const Controller = doorbell ? DoorbellController : CameraController;
        const controller = new Controller({ cameraStreamCount: 2, delegate, streamingOptions: streamingOptions() });
        acc.configureController(controller);
        x.onCleanup(() => delegate.stopAll());
        if (doorbell && d.ring) {
            let prev = x.bool(d.ring);
            x.watch([d.ring], () => {
                const now = x.bool(d.ring);
                if (now && !prev) {
                    controller.ringDoorbell();
                }
                prev = now;
            });
        }
        acc.delegate = delegate; // for tests
    };
    const fields = [['camera', 'Kamera (aus dem livecam-Adapter)', 'camera', true]];
    const options = [['source', 'Eigene Videoquelle für bessere Qualität (optional, z. B. rtsp://…)', 'text']];
    return {
        camera: { label: 'Kamera', group: 'Kameras', fields, options, build: build(false) },
        doorbell: {
            label: 'Türklingel mit Kamera',
            group: 'Kameras',
            fields: [...fields, ['ring', 'Läutet (z. B. livecam.0.intercom.ringing)', 'r', true]],
            options,
            build: build(true),
        },
    };
}

module.exports = { cameraTypes, StreamingDelegate, ffmpegArgs, streamingOptions };
