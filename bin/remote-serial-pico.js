#!/usr/bin/env node
'use strict';
// Thin command-line wrapper. All the logic (and the tests) live in
// src/pi/installer.js so it can be exercised without touching a real Pi.

const { parseArgs, makeContext, install, doctor, status, usage } = require('../src/pi/installer.js');

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
