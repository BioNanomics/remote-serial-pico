const net = require('net');
const pty = require('node-pty');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const { PicoSession } = require('./session.js');
const { ControlServer } = require('./control.js');
const { configPathFrom, resolveBindAddress, StateFile, readState, sharePtyWithGroup, firmwareHash, SecretStore } = require('./runtime.js');

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;
const { Syslog } = require('winston-syslog');

let serialIdToPicoName = {};  // Holds the mapping of serial IDs to Pico names
let picoDevices = {};         // Tracks connected Pico devices and their sockets
let lastPicoMappingFileTime = 0;  // Tracks last modified time of PicoSerialMap file

// The systemd unit passes --config <install root>/config.yaml, the same file
// the installer wrote and the provisioning scripts read. Run from a checkout
// with no argument, it falls back to config.yaml next to this file.
const configFilePath = configPathFrom(process.argv.slice(2));
let config = {};

try {
    const fileContents = fs.readFileSync(configFilePath, 'utf8');
    config = yaml.load(fileContents);
} catch (err) {
    console.error(`Failed to load ${configFilePath}: ${err.message}`);
    process.exit(1);
}

// Combined custom format for timestamp and log message
const customFormat = combine(
    timestamp({
        format: () => {
            const now = new Date();
            const month = now.toLocaleString('default', { month: 'short' });
            const day = now.getDate();
            const time = now.toLocaleTimeString([], { hour12: false });
            return `${month} ${day} ${time}`;
        }
    }),
    printf(({ timestamp, message }) => {
        return `${timestamp} ${message}`;
    })
);

const syslogTransport = new Syslog({
    protocol: 'unix',
    path: config.SyslogDir,
    format: printf(({ message }) => message) // Log only the message
});

const consoleTransport = new transports.Console({
    format: customFormat
});

const fileTransport = new transports.File({ 
    filename: config.CustomlogDir,
    format: customFormat
});

// Create a logger instance
const logger = createLogger({
    transports: [
        syslogTransport,  // Log to syslog (systemd journal)
        consoleTransport, // Log to console
        fileTransport     // Log to a file
    ]
});

// What `remote-serial-pico status` reads: each board's firmware version and
// whether it is connected. Without StateFile in config.yaml nothing is written.
const state = new StateFile(config.StateFile || null);
state.onError = (err) => logger.error(`Could not write ${config.StateFile}: ${err.message}`);
// Per-device keys, written by the deployer when a board is provisioned over
// USB. A board is given nothing until it proves it holds its key.
const secrets = new SecretStore(config.PicoSecrets || '');
secrets.onError = (err) => logger.error(`Could not read the key store ${config.PicoSecrets}: ${err.message}`);

// What a board running exactly the firmware this Pi deploys reports as its
// hash. FirmwareMismatch in config.yaml: 'refuse' (the default) turns away a
// board running anything else until it is plugged in again; 'warn' serves it
// and logs.
const canonicalFirmware = firmwareHash(path.join(__dirname, '..', 'pico'));
const firmwareMismatch = config.FirmwareMismatch === 'warn' ? 'warn' : 'refuse';
state.expectedHash = canonicalFirmware;
logger.info(`Firmware this Pi deploys has hash ${canonicalFirmware}; a board reporting another is ${firmwareMismatch === 'warn' ? 'served with a warning' : 'refused'}`);

// Keep each board's last known firmware across a restart, but nothing is
// connected to a server that has only just started.
const priorState = config.StateFile ? readState(config.StateFile) : null;
if (priorState) {
    state.picos = priorState.picos;
    state.allDisconnected();
}

// Function to handle Pico connection
function handlePicoConnection(serialId, socket) {
    // Load the latest PicoSerialMap file on each connection
    loadPicoMappingFromFile();
    const picoName = serialIdToPicoName[serialId] || serialId;

    // If the serialId is not found, add it to the mapping
    if (!serialIdToPicoName[serialId]) {
        serialIdToPicoName[serialId] = picoName;
        savePicoMappingToFile();
    }

    if (picoDevices[picoName] && picoDevices[picoName].socket) {
        logger.warn(`${picoName} tcp client reconnected`);
        picoDevices[picoName].socket.destroy();  // Prevent memory leaks
    } else {
        logger.info(`${picoName} tcp client connected`);
        setupPicoPty(picoName);
    }
    // Keep the record: replacing it with a fresh object here dropped the pty
    // that setupPicoPty() had just stored, so device responses never reached
    // the pty (present on main since the heartbeat commit, 9e04e1c).
    picoDevices[picoName].socket = socket;
    return picoName;
}

// Function to load the serialIdToPicoName mapping from the PicoSerialMap file
function loadPicoMappingFromFile() {
    const picoMappingFilePath = config.PicoSerialMap;
    try {
        const stats = fs.statSync(picoMappingFilePath); // Get file stats
        const fileModifiedTime = stats.mtimeMs; // Get the last modified time in milliseconds

        // Check if the file has been modified since the last load
        if (fileModifiedTime > lastPicoMappingFileTime) {
            const fileContents = fs.readFileSync(picoMappingFilePath, 'utf8');
            const loadedMapping = yaml.load(fileContents);
            Object.assign(serialIdToPicoName, loadedMapping); // Merge with the existing mapping

            lastPicoMappingFileTime = fileModifiedTime;
            logger.info(`Pico serial id -> name mapping loaded`);
        }
    } catch (err) {
        logger.error(`Error loading Pico mapping: ${err.message}`);
    }
}

// Function to save updated serialIdToPicoName map to the PicoSerialMap file
function savePicoMappingToFile() {
    const picoMappingFilePath = config.PicoSerialMap;

    try {
        const yamlData = yaml.dump(serialIdToPicoName);
        fs.writeFileSync(picoMappingFilePath, yamlData, 'utf8');
        logger.info(`Pico mapping saved to ${picoMappingFilePath}`);
    } catch (err) {
        logger.error(`Error saving Pico mapping: ${err.message}`);
    }
}

// Setup pty for a given Pico
function setupPicoPty(picoName) {
    const myPty = pty.open();
    try {
        sharePtyWithGroup(myPty.ptsName);
    } catch (err) {
        logger.warn(`Could not open ${myPty.ptsName} to the service group (${err.message}); only the service user can use this port`);
    }
    createSymlink(picoName, myPty.ptsName);
    
    if (!picoDevices[picoName]) {
        picoDevices[picoName] = {};
    }
    picoDevices[picoName].pty = myPty;
    routePtyCmdToSocket(picoName);
}

// Function to set up PTY for the Pico
function createSymlink(picoName, ptsName) {
    const symlinkPath = `${config.symlinkDir}/${picoName}`;
    try {
        // readlinkSync inspects the link itself. fs.existsSync() follows it and
        // reports false for a dangling link (the pty it points at is gone after a
        // reboot), which would send us down the "create" path and throw EEXIST.
        let currentTarget = null;
        try {
            currentTarget = fs.readlinkSync(symlinkPath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }

        if (currentTarget === null) {
            fs.symlinkSync(ptsName, symlinkPath);  // Nothing there, create the symlink
            logger.info(`Created symlink ${symlinkPath} -> ${ptsName}`);
        } else if (currentTarget !== ptsName) {
            fs.unlinkSync(symlinkPath);  // Stale or wrong target (incl. dangling links)
            fs.symlinkSync(ptsName, symlinkPath);
            logger.info(`Updated symlink ${symlinkPath} -> ${ptsName}`);
        } else {
            logger.info(`Symlink ${symlinkPath} -> ${ptsName} already exists`);
        }
    } catch (err) {
        logger.error(`Error creating symlink: ${err.message}`);
    }
}

// Function to remove symlink for Pico
function removeSymlink(picoName) {
    const symlinkPath = `${config.symlinkDir}/${picoName}`;
    try {
        fs.unlinkSync(symlinkPath);
        logger.info(`${picoName} symlink removed`);
    } catch (err) {
        logger.error(`Error removing symlink: ${err.message}`);
    }
}

// Bytes written to the pty go to the board inside DATA frames, exactly as
// written: the pty is byte-transparent, so no trimming and no added
// terminator. node-pty hands us strings; convert back to the raw bytes.
function routePtyCmdToSocket(picoName) {
    const myPty = picoDevices[picoName].pty;
    myPty.on('data', (data) => {
        const device = picoDevices[picoName];
        if (!device || !device.session) {
            return;
        }
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
        device.session.sendData(bytes);
        if (control) control.tap(picoName, 'to-device', bytes);
        logger.info(`command to ${picoName}: ${JSON.stringify(bytes.toString('latin1'))}`);
    });
}

// A DATA payload from the board goes to the pty exactly as the device sent it.
function writePicoRespToPty(picoName, payload) {
    const myPty = picoDevices[picoName] && picoDevices[picoName].pty;
    if (myPty) {
        myPty.write(payload.toString('latin1'));
        if (control) control.tap(picoName, 'from-device', payload);
        logger.info(`Response from ${picoName}: ${JSON.stringify(payload.toString('latin1'))}`);
    }
}

// The control channel's operator side: `remote-serial-pico ctl <name> ...`
// connects to this socket (control.js). Control commands travel to the board
// as their own opcodes and never through the pty.
let control = null;
if (config.ControlSocket) {
    control = new ControlServer({
        socketPath: config.ControlSocket,
        sessionFor: (name) => (picoDevices[name] && picoDevices[name].session) || null,
        names: () => Object.keys(picoDevices).filter((name) => picoDevices[name].session && picoDevices[name].session.registered),
        log: (level, msg) => logger[level](msg),
    });
    control.start();
} else {
    logger.warn('No ControlSocket in config.yaml: `remote-serial-pico ctl` is unavailable');
}

// A Pico connection speaks wire protocol v1 (docs/protocol.md) and must
// authenticate with its device key before anything else happens. There is no
// unauthenticated or legacy mode. The session does the parsing and the
// protocol replies; this handler only wires it to the socket, the device
// table and the pty.
const HANDSHAKE_TIMEOUT_MS = 10000;   // connect to registered, or the socket is closed

function onPicoSocket(socket) {
    let picoName = null;
    let session = null;
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;

    const hooks = {
        send: (buf) => { if (!socket.destroyed) socket.write(buf); },
        close: () => socket.end(),
        log: (level, msg) => logger[level](msg),
        secretFor: (serialId) => secrets.get(serialId),
        // Only called once the board has authenticated, so an unknown or
        // impersonated serial id never gets a pty or a line in the serial map.
        register: (serialId, info) => {
            picoName = handlePicoConnection(serialId, socket);
            picoDevices[picoName].session = session;
            picoDevices[picoName].firmware = info;   // { fw, hash } for status/logs
            state.connected(picoName, { serial: serialId, fw: info && info.fw, hash: info && info.hash, protocol: session.protocol, peer });
            return picoName;
        },
        onData: (payload) => writePicoRespToPty(picoName, payload),
    };

    session = new PicoSession(hooks, { firmwareHash: canonicalFirmware, firmwareMismatch });

    // A connection that does not finish the handshake is not left open.
    const handshakeTimer = setTimeout(() => {
        if (!session.registered && !socket.destroyed) {
            logger.warn(`${peer} did not authenticate within ${HANDSHAKE_TIMEOUT_MS / 1000} s; closing`);
            socket.destroy();
        }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('data', (data) => session.receive(data));

    socket.on('close', () => {
        clearTimeout(handshakeTimer);
        session.connectionLost();
        if (picoName) {
            logger.warn(`${picoName} socket close event triggered; ignored this event`);
            if (picoDevices[picoName] && picoDevices[picoName].session === session) {
                picoDevices[picoName].session = null;
                state.disconnected(picoName);
            }
        }
    });

    socket.on('error', (err) => {
        logger.error(`Socket error${picoName ? ` (${picoName})` : ''}: ${err.message}`);
    });
}

// Listen on BindAddress from config.yaml rather than on every interface:
// registration is not authenticated, so the port should only be reachable from
// the network the Picos are on. An interface name is resolved here, at start,
// and re-checked while running, so a DHCP change moves the listener instead of
// leaving it bound to an address the Pi no longer has.
const BIND_RECHECK_MS = 15000;
let server = null;
let boundAddress = null;
let warnedNoAddress = false;

function listenOnBindAddress() {
    const target = resolveBindAddress(config.BindAddress);
    if (!target) {
        if (!warnedNoAddress) {
            logger.warn(`BindAddress ${config.BindAddress} has no IPv4 address yet; waiting for it`);
            warnedNoAddress = true;
        }
        return;
    }
    warnedNoAddress = false;
    if (server && target.address === boundAddress) return;

    if (server) {
        // close() only stops accepting; boards already connected keep their
        // sockets, which is why the new address gets a server of its own.
        logger.warn(`BindAddress moved from ${boundAddress} to ${target.address}; listening there instead`);
        server.close();
    }
    const next = net.createServer(onPicoSocket);
    next.on('error', (err) => {
        logger.error(`Cannot listen on ${target.address}:${config.TCP_PORT}: ${err.message}`);
        if (server === next) { server = null; boundAddress = null; }   // retried on the next check
    });
    next.listen(config.TCP_PORT, target.address, () => {
        logger.info(`Server listening on ${target.address}:${config.TCP_PORT} (${target.source})`);
        if (target.all) logger.warn('Listening on every interface; set BindAddress in config.yaml to the interface the Picos use');
    });
    server = next;
    boundAddress = target.address;
}

listenOnBindAddress();
setInterval(listenOnBindAddress, BIND_RECHECK_MS);

// Cleanup function for destroying pty and socket for a given pico
function cleanPicoResources(picoName) {
    const picoDevice = picoDevices[picoName];
    if (picoDevice) {
        removeSymlink(picoName);
        if (picoDevice.pty) {
            picoDevice.pty.destroy();
        }
        if (picoDevice.socket && !picoDevice.socket.destroyed) {
            picoDevice.socket.destroy();
        }
        delete picoDevices[picoName];
        logger.info(`${picoName} pty and socket destroyed`);
    } else {
        logger.info(`${picoName} device not found (pty and socket not destroyed)`);
    }
}

// Clean up all resources and exit gracefully on process termination signals
function fullCleanUp() {
    Object.keys(picoDevices).forEach((picoName) => {
        cleanPicoResources(picoName);
    });
    state.allDisconnected();
    if (control) control.stop();
    process.exit(0);
}

process.on('SIGINT', fullCleanUp).on('SIGTERM', fullCleanUp);