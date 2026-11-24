const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./runtime.js');

const IFACES = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '10.3.177.167', internal: false, cidr: '10.3.177.167/16' }],
    wlan0: [{ family: 'IPv4', address: '10.42.0.1', internal: false, cidr: '10.42.0.1/24' }],
    wlan1: [{ family: 'IPv6', address: 'fe80::2', internal: false }]
};

test('config path: --config beats the environment, which beats the file next to PtyServer', () => {
    assert.strictEqual(R.configPathFrom(['--config', '/a/config.yaml'], { [R.CONFIG_ENV]: '/b' }, '/src'), '/a/config.yaml');
    assert.strictEqual(R.configPathFrom(['--config=/c/config.yaml'], {}, '/src'), '/c/config.yaml');
    assert.strictEqual(R.configPathFrom([], { [R.CONFIG_ENV]: '/b/config.yaml' }, '/src'), '/b/config.yaml');
    assert.strictEqual(R.configPathFrom([], {}, '/src'), path.join('/src', 'config.yaml'));
});

test('BindAddress: missing or 0.0.0.0 means every interface, and says so', () => {
    for (const v of [undefined, null, '', '0.0.0.0']) {
        const r = R.resolveBindAddress(v, IFACES);
        assert.strictEqual(r.address, '0.0.0.0');
        assert.strictEqual(r.all, true);
    }
});

test('BindAddress: an IPv4 address is used as written', () => {
    assert.deepStrictEqual(R.resolveBindAddress('10.42.0.1', {}), { address: '10.42.0.1', all: false, source: 'configured address' });
});

test('BindAddress: an interface name resolves to its IPv4 address, or null until it has one', () => {
    const r = R.resolveBindAddress('wlan0', IFACES);
    assert.strictEqual(r.address, '10.42.0.1');
    assert.strictEqual(r.cidr, '10.42.0.1/24');
    assert.strictEqual(R.resolveBindAddress('wlan1', IFACES), null, 'IPv6 only is not an address a Pico can use');
    assert.strictEqual(R.resolveBindAddress('nope0', IFACES), null);
    assert.strictEqual(R.resolveBindAddress('lo', IFACES), null, 'never loopback');
});

test('networkOf gives the subnet a firewall rule should allow', () => {
    assert.strictEqual(R.networkOf('10.42.0.1/24'), '10.42.0.0/24');
    assert.strictEqual(R.networkOf('10.3.177.167/16'), '10.3.0.0/16');
    assert.strictEqual(R.networkOf('192.168.4.130/25'), '192.168.4.128/25');
    assert.strictEqual(R.networkOf('garbage'), null);
});

test('detectBindInterface prefers the WiFi interface, then the default route, then nothing', () => {
    assert.strictEqual(R.detectBindInterface(IFACES, 'eth0'), 'wlan0', 'a Pi hosting the Pico AP must not pick its wired uplink');
    const wired = { eth0: IFACES.eth0, lo: IFACES.lo };
    assert.strictEqual(R.detectBindInterface(wired, 'eth0'), 'eth0');
    assert.strictEqual(R.detectBindInterface(wired, null), null);
    assert.strictEqual(R.detectBindInterface({ lo: IFACES.lo }, 'eth0'), null);
});

test('StateFile records firmware per board, atomically, and survives a reconnect cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-state-'));
    const file = path.join(dir, 'state.json');
    const s = new R.StateFile(file, fs, () => new Date('2026-11-24T10:00:00Z'));
    s.connected('Blinds_pico', { serial: 'e6614103e71d2c2f', fw: '1.0.0', hash: '0123456789abcdef', protocol: 'v1', peer: '10.42.0.17:5000' });
    let read = R.readState(file);
    assert.deepStrictEqual(read.picos.Blinds_pico, {
        serial: 'e6614103e71d2c2f', firmware: '1.0.0', hash: '0123456789abcdef', protocol: 'v1',
        peer: '10.42.0.17:5000', connected: true, since: '2026-11-24T10:00:00.000Z'
    });
    assert.ok(!fs.existsSync(file + '.tmp'), 'the temp file is renamed away');
    s.disconnected('Blinds_pico');
    read = R.readState(file);
    assert.strictEqual(read.picos.Blinds_pico.connected, false);
    assert.strictEqual(read.picos.Blinds_pico.firmware, '1.0.0', 'the last known version stays visible while a board is away');
    s.connected('Blinds_pico', { serial: 'e6614103e71d2c2f', fw: '1.0.1', hash: 'ffff', protocol: 'v1' });
    s.allDisconnected();
    assert.strictEqual(R.readState(file).picos.Blinds_pico.connected, false);
});

test('StateFile strips anything a board could use to forge output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-state-'));
    const file = path.join(dir, 'state.json');
    const s = new R.StateFile(file);
    s.connected('p', { serial: 'x', fw: '1.0\nservice   active\u001b[31m', hash: 'h'.repeat(500), protocol: 'v1' });
    const p = R.readState(file).picos.p;
    assert.ok(!/[\n\u001b]/.test(p.firmware));
    assert.strictEqual(p.hash.length, 64);
});

test('StateFile never throws when the file cannot be written', () => {
    const s = new R.StateFile('/nonexistent-dir/state.json');
    let seen = null; s.onError = (e) => { seen = e; };
    s.connected('p', { serial: 'x', fw: '1', hash: 'h', protocol: 'v1' });
    assert.ok(seen);
    assert.strictEqual(R.readState('/nonexistent-dir/state.json'), null);
});

test('sharePtyWithGroup hands the port to the service group, read-write, nobody else', () => {
    const calls = [];
    R.sharePtyWithGroup('/dev/pts/3', { chownSync: (...a) => calls.push(['chown', ...a]), chmodSync: (...a) => calls.push(['chmod', ...a]) }, { uid: 999, gid: 990 });
    assert.deepStrictEqual(calls, [['chown', '/dev/pts/3', 999, 990], ['chmod', '/dev/pts/3', 0o660]]);
});
