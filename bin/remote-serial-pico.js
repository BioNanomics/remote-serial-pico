#!/usr/bin/env node
'use strict';
// Thin command-line wrapper. All the logic (and the tests) live in
// src/pi/installer.js so it can be exercised without touching a real Pi.

const { parseArgs, makeContext, install, doctor, status, usage } = require('../src/pi/installer.js');

// `ctl <name> <command...>` has its own arguments and talks to the running
// server, so it is handled before the installer's option parsing.
if ((process.argv[2] || '').toLowerCase() === 'ctl') {
    const ctl = require('../src/pi/ctl.js');
    const { controlSocketPath } = require('../src/pi/installer.js');
    const words = process.argv.slice(3);
    if (words.length === 0 || words.includes('-h') || words.includes('--help')) {
        process.stdout.write(ctl.USAGE);
        process.exit(words.length === 0 ? 2 : 0);
    }
    const request = ctl.parseCtl(words);
    if (request.error) {
        process.stderr.write(`${request.error}\n\n${ctl.USAGE}`);
        process.exit(2);
    }
    const socketPath = controlSocketPath(makeContext());
    if (!socketPath) {
        process.stderr.write('no ControlSocket in config.yaml: run  sudo remote-serial-pico install,  or add the key from config.example.yaml\n');
        process.exit(1);
    }
    ctl.run(request, socketPath).then((code) => process.exit(code));
    return;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.errors.length) {
    process.stderr.write(`${opts.errors.join('\n')}\n\n${usage()}`);
    process.exit(2);
}

let code;
if (opts.help) {
    process.stdout.write(usage());
    code = 0;
} else {
    switch (opts.command) {
        case 'install':
        case 'i':
            code = install(makeContext({ opts }));
            break;
        case 'doctor':
            code = doctor(makeContext({ opts }));
            break;
        case 'status':
            code = status(makeContext({ opts }));
            break;
        case '':
        case 'help':
            process.stdout.write(usage());
            code = opts.command ? 0 : 2;
            break;
        default:
            process.stderr.write(`unknown command: ${opts.command}\n\n${usage()}`);
            code = 2;
    }
}
process.exit(code);
