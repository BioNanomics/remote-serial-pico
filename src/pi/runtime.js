'use strict';
// The parts of PtyServer that can be tested without node-pty, a socket or a
// Pi: where the config file is, which address to listen on, and the small
// state file `remote-serial-pico status` reads. Node built-ins only, so the
// installer can use the same address logic before `npm install` has run.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_ENV = 'REMOTE_SERIAL_PICO_CONFIG';

// --config <file> on the command line (what the systemd unit passes), else the
// environment variable, else config.yaml next to PtyServer.js for running from
// a checkout during development.
function configPathFrom(argv, env = process.env, fallbackDir = __dirname) {
    const i = argv.indexOf('--config');
    if (i !== -1 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find(a => a.startsWith('--config='));
    if (eq) return eq.slice('--config='.length);
    if (env[CONFIG_ENV]) return env[CONFIG_ENV];
    return path.join(fallbackDir, 'config.yaml');
}

function isIPv4(text) {
    const parts = String(text).split('.');
    return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function ipv4Of(iface, interfaces) {
    const entry = (interfaces[iface] || []).find(a => (a.family === 'IPv4' || a.family === 4) && !a.internal);
    return entry ? { address: entry.address, cidr: entry.cidr || null } : null;
}

// BindAddress from config.yaml -> what to pass to server.listen().
//   missing or 0.0.0.0   every interface (doctor reports this as a problem)
//   an IPv4 address      that address
//   an interface name    that interface's IPv4 address now, or null if it has
//                        none yet (the caller waits and tries again)
function resolveBindAddress(bind, interfaces = os.networkInterfaces()) {
    const value = String(bind === undefined || bind === null ? '' : bind).trim();
    if (!value || value === '0.0.0.0') return { address: '0.0.0.0', all: true, source: 'all interfaces' };
    if (isIPv4(value)) return { address: value, all: false, source: 'configured address' };
    const found = ipv4Of(value, interfaces);
    if (!found) return null;
    return { address: found.address, cidr: found.cidr, all: false, source: `interface ${value}` };
}

// "10.42.0.1/24" -> "10.42.0.0/24": the subnet a firewall rule should allow.
function networkOf(cidr) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(cidr || ''));
    if (!m || !isIPv4(m[1]) || Number(m[2]) > 32) return null;
    const bits = Number(m[2]);
    const ip = m[1].split('.').reduce((n, p) => (n * 256) + Number(p), 0);
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    const net = (ip & mask) >>> 0;
    return `${[net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.')}/${bits}`;
}

// The interface the Picos reach this Pi on, for a fresh config.yaml. Same
// preference as the deployer: the WiFi interface if it has an address (a Pi
// hosting the Picos' access point has no default route there), otherwise
// whichever interface carries the default route.
function detectBindInterface(interfaces = os.networkInterfaces(), defaultRouteDev = null, wifi = 'wlan0') {
    if (ipv4Of(wifi, interfaces)) return wifi;
    if (defaultRouteDev && ipv4Of(defaultRouteDev, interfaces)) return defaultRouteDev;
    return null;
}

// What PtyServer knows about each board, for `remote-serial-pico status`.
// Board-supplied strings are cut down to printable ASCII before they are
// stored, so nothing a board sends can forge a line of status output.
function clean(text, max = 64) {
    return String(text === undefined || text === null ? '' : text).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

class StateFile {
    constructor(file, fsx = fs, now = () => new Date()) {
        this.file = file;
        this.fsx = fsx;
        this.now = now;
        this.picos = {};
        this.expectedHash = null;   // hash of the firmware this Pi deploys
        this.onError = () => {};
    }

    connected(name, { serial, fw, hash, protocol, peer }) {
        this.picos[name] = {
            serial: clean(serial), firmware: clean(fw), hash: clean(hash), protocol: clean(protocol, 8),
            peer: clean(peer), connected: true, since: this.now().toISOString()
        };
        this.save();
    }

    disconnected(name) {
        if (!this.picos[name] || !this.picos[name].connected) return;
        this.picos[name].connected = false;
        this.picos[name].since = this.now().toISOString();
        this.save();
    }

    allDisconnected() {
        for (const name of Object.keys(this.picos)) this.picos[name].connected = false;
        this.save();
    }

    // Write-then-rename, so a reader never sees half a file.
    save() {
        if (!this.file) return;
        const body = JSON.stringify({ updatedAt: this.now().toISOString(), pid: process.pid, expectedHash: this.expectedHash, picos: this.picos }, null, 2) + '\n';
        const tmp = `${this.file}.tmp`;
        try {
            this.fsx.writeFileSync(tmp, body, { mode: 0o644 });
            this.fsx.renameSync(tmp, this.file);
        } catch (err) {
            this.onError(err);
        }
    }
}

function readState(file, fsx = fs) {
    try {
        const parsed = JSON.parse(fsx.readFileSync(file, 'utf8'));
        return parsed && typeof parsed.picos === 'object' && parsed.picos ? parsed : null;
    } catch {
        return null;
    }
}

// The hash a board running exactly the firmware in `picoDir` reports in
// REGISTER: firmware.json, then every file it lists, each as name, 0x00,
// contents, 0x00. Must match firmware_hash() in src/pico/net_util.py.
function firmwareHash(picoDir, fsx = fs, length = 16) {
    try {
        const manifest = 'firmware.json';
        const names = [manifest, ...JSON.parse(fsx.readFileSync(path.join(picoDir, manifest), 'utf8')).files];
        const h = crypto.createHash('sha256');
        for (const name of names) {
            h.update(name).update(Buffer.from([0])).update(fsx.readFileSync(path.join(picoDir, name))).update(Buffer.from([0]));
        }
        return h.digest('hex').slice(0, length);
    } catch {
        return null;
    }
}

function firmwareFiles(picoDir, fsx = fs) {
    return ['firmware.json', ...JSON.parse(fsx.readFileSync(path.join(picoDir, 'firmware.json'), 'utf8')).files];
}

// The key store: one `<16 hex serial id>: <64 hex key>` per line, written by
// the deployer. Parsed by hand, not as YAML: an all-digit serial id would
// come back from a YAML parser as a number. Lines that are not exactly a
// serial id and a 256-bit key are ignored.
function parseSecrets(text) {
    const out = new Map();
    for (const raw of String(text).split('\n')) {
        const m = /^\s*['"]?([0-9a-fA-F]{16})['"]?\s*:\s*['"]?([0-9a-fA-F]{64})['"]?\s*$/.exec(raw);
        if (m) out.set(m[1].toLowerCase(), Buffer.from(m[2], 'hex'));
    }
    return out;
}

// Reads the key store again only when it has changed, so a board that was
// just provisioned (or re-keyed) is recognised without restarting the server.
class SecretStore {
    constructor(file, fsx = fs) {
        this.file = file;
        this.fsx = fsx;
        this.mtime = -1;
        this.keys = new Map();
        this.onError = () => {};
    }

    get(serialId) {
        try {
            const st = this.fsx.statSync(this.file);
            if (st.mtimeMs !== this.mtime) {
                this.keys = parseSecrets(this.fsx.readFileSync(this.file, 'utf8'));
                this.mtime = st.mtimeMs;
            }
        } catch (err) {
            this.keys = new Map();
            this.mtime = -1;
            this.onError(err);
        }
        return this.keys.get(String(serialId).toLowerCase()) || null;
    }
}

// A pty slave is created 0620 owner:tty, so only the service user could open
// the port. Give it to the service's own group, read-write, so members of
// that group (the person who ran the installer, Node-RED running as them) can
// open it and nobody else can.
function sharePtyWithGroup(ptsName, fsx = fs, ids = { uid: process.getuid(), gid: process.getgid() }) {
    fsx.chownSync(ptsName, ids.uid, ids.gid);
    fsx.chmodSync(ptsName, 0o660);
}

module.exports = {
    CONFIG_ENV, configPathFrom, isIPv4, ipv4Of, resolveBindAddress, networkOf, detectBindInterface,
    StateFile, readState, clean, sharePtyWithGroup, firmwareHash, firmwareFiles, parseSecrets, SecretStore
};
