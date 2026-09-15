#!/usr/bin/env node
'use strict';
// Thin command-line wrapper. All the logic (and the tests) live in
// src/pi/installer.js so it can be exercised without touching a real Pi.

const { makeContext, install, doctor, status, usage } = require('../src/pi/installer.js');

const command = (process.argv[2] || '').toLowerCase();
const ctx = makeContext();

let code;
switch (command) {
    case 'install':
    case 'i':
        code = install(ctx);
        break;
    case 'doctor':
        code = doctor(ctx);
        break;
    case 'status':
        code = status(ctx);
        break;
    case '':
    case 'help':
    case '-h':
    case '--help':
        process.stdout.write(usage());
        code = command ? 0 : 2;
        break;
    default:
        process.stderr.write(`unknown command: ${command}\n\n${usage()}`);
        code = 2;
}
process.exit(code);
