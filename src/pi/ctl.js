'use strict';
// `remote-serial-pico ctl <name> <command>`: the operator's command line for
// the control channel. It only talks to PtyServer's control socket (see
// control.js); PtyServer talks to the board.

const net = require('net');

const USAGE = [
    'usage: remote-serial-pico ctl <name> <command>',
    '',
    '  status                                what the board reports about itself',
    '  reboot                                restart the board',
    '  identify [seconds]                    blink its LED (default 10 s) so you can find it',
    '  uart set <baud> [bits parity stop]    retune the serial link, e.g. uart set 9600 8 N 1.',
    '           [--save]                     Lasts until the board restarts unless --save is given,',
    '                                        so a wrong setting is undone by a power cycle',
    '  listen                                show the serial traffic, hex, until Ctrl-C',
    '  update                                update this one board to the firmware this Pi deploys,',
    '                                        even when FirmwareUpdate is off: try one board first',
    '',
    '<name> is the port name from `remote-serial-pico status`.',
    ''
].join('\n');

// Turn the words after `ctl` into { pico, cmd, args }, or { error }.
function parseCtl(argv) {
    const words = argv.filter(a => a !== '--save');
    const save = words.length !== argv.length;
    const [pico, cmd, ...rest] = words;
    if (!pico || !cmd || pico.startsWith('-')) return { error: 'a board name and a command are required' };
    const int = (text, what) => {
        if (!/^\d+$/.test(text)) throw new Error(`${what} must be a whole number, got ${text}`);
        return Number(text);
    };
    try {
        switch (cmd) {
            case 'status':
            case 'reboot':
            case 'listen':
            case 'update':
                if (rest.length || save) return { error: `${cmd} takes no arguments` };
                return { pico, cmd, args: {} };
            case 'identify':
                if (rest.length > 1 || save) return { error: 'identify takes at most a number of seconds' };
                return { pico, cmd, args: rest.length ? { seconds: int(rest[0], 'seconds') } : {} };
            case 'uart': {
                if (rest[0] !== 'set' || rest.length < 2 || rest.length > 5) return { error: 'expected: uart set <baud> [bits parity stop] [--save]' };
                const args = { baud: int(rest[1], 'baud'), save };
                if (rest[2] !== undefined) args.bits = int(rest[2], 'bits');
                if (rest[3] !== undefined) args.parity = rest[3].toUpperCase();
                if (rest[4] !== undefined) args.stop = int(rest[4], 'stop');
                return { pico, cmd: 'uart_set', args };
            }
            default:
                return { error: `unknown command: ${cmd}` };
        }
    } catch (err) {
        return { error: err.message };
    }
}

function formatResult(cmd, result) {
    if (cmd === 'update' && result && result.note) return result.note;
    if (cmd !== 'status' || !result || typeof result !== 'object') return JSON.stringify(result);
    const label = {
        fw: 'firmware', hash: 'firmware hash', uptime_s: 'uptime (s)', rssi: 'WiFi signal (dBm)', free_mem: 'free memory (bytes)',
        connections: 'connections since boot', uart: 'serial link', uart_rx_bytes: 'bytes from device',
        uart_tx_bytes: 'bytes to device', uart_errors: 'serial read errors'
    };
    return Object.entries(result).map(([k, v]) => `${(label[k] || k).padEnd(24)} ${v === null ? 'unknown' : v}`).join('\n');
}

// Returns a promise of the exit code.
function run(request, socketPath, out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n')) {
    return new Promise((resolve) => {
        const client = net.createConnection(socketPath);
        let buffered = '';
        let first = true;
        let code = 1;
        client.setEncoding('utf8');
        client.on('connect', () => client.write(JSON.stringify(request) + '\n'));
        client.on('data', (chunk) => {
            buffered += chunk;
            let nl;
            while ((nl = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, nl);
                buffered = buffered.slice(nl + 1);
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (first) {
                    first = false;
                    if (!msg.ok) { err(`${request.pico}: ${msg.error}`); code = 1; continue; }
                    code = 0;
                    if (request.cmd === 'listen') out(`listening to ${request.pico} (hex; < from the device, > to the device). Ctrl-C to stop.`);
                    else out(formatResult(request.cmd, msg.result));
                } else if (msg.hex !== undefined) {
                    out(`${msg.dir === 'from-device' ? '<' : '>'} ${msg.hex}`);
                }
            }
        });
        client.on('error', (e) => {
            if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') err(`cannot reach the server's control socket ${socketPath}: is ptyserver.service running?`);
            else if (e.code === 'EACCES') err(`not allowed to use ${socketPath}: you must be in the service's group (log in again after the first install)`);
            else err(`control socket ${socketPath}: ${e.message}`);
            resolve(1);
        });
        client.on('close', () => resolve(code));
    });
}

module.exports = { USAGE, parseCtl, formatResult, run };
