const net = require('net');
const pty = require('node-pty');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;
const { Syslog } = require('winston-syslog');

let serialIdToPicoName = {};  // Holds the mapping of serial IDs to Pico names
let picoDevices = {};         // Tracks connected Pico devices and their sockets
let lastPicoMappingFileTime = 0;  // Tracks last modified time of PicoSerialMap file

// Load configuration from config.yaml in the current working directory
const configFilePath = path.join(__dirname, 'config.yaml');
let config = {};

try {
    const fileContents = fs.readFileSync(configFilePath, 'utf8');
    config = yaml.load(fileContents);
} catch (err) {
    console.error(`Failed to load config.yaml: ${err.message}`);
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
    picoDevices[picoName] = { socket };
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

// Function to handle data received from pty and send it to the socket
function routePtyCmdToSocket(picoName) {
    const myPty = picoDevices[picoName].pty;
    myPty.on('data', (data) => {
        const command = data.toString();
        picoDevices[picoName].socket.write(command);
        logger.info(`command to ${picoName}: ${command}`);
    });
}

// Function to write response received from socket to the pty
function writePicoRespToPty(picoName, response) {
    const myPty = picoDevices[picoName].pty;
    if (myPty) {
        myPty.write(response + '\r');
        logger.info(`Response from ${picoName}: ${response}`);
    }
}

// The Pico sends 'pico_<serialId>' and 'PING' without any terminator, so TCP is
// free to coalesce them with the device data that follows. Match the tokens
// exactly instead of assuming a packet holds nothing else.
const REGISTRATION_PATTERN = /^pico_([0-9a-fA-F]{16})/;
const HEARTBEAT = 'PING';

// TCP server to listen for connections from Pico devices
const server = net.createServer((socket) => {
    let picoName = null;

    socket.on('data', (data) => {
        let message = data.toString();

        // Registration: consume only the 'pico_<serialId>' token. Anything after it
        // is device data, not part of the serial id.
        const registration = REGISTRATION_PATTERN.exec(message);
        if (registration) {
            picoName = handlePicoConnection(registration[1], socket);
            message = message.slice(registration[0].length);
        } else if (message.startsWith('pico_')) {
            logger.warn(`Ignoring malformed registration packet: ${JSON.stringify(message)}`);
            return;
        }

        // 💓 Heartbeat: respond to PING with PONG, once per PING in the packet
        const segments = message.split(HEARTBEAT);
        if (segments.length > 1) {
            for (let i = 1; i < segments.length; i++) {
                socket.write('PONG\n');
            }
            logger.info(`Heartbeat received from ${picoName || 'unknown'} -> Responded with PONG`);
            message = segments.join('');
        }

        const response = message.trim();
        if (picoName && response) {
            writePicoRespToPty(picoName, response);
        }
    });

    socket.on('close', () => {
        if (picoName) {
            logger.warn(`${picoName} socket close event triggered; ignored this event`);
        }
    });

    socket.on('error', (err) => {
        logger.error('Socket error:', err);
    });
});

server.listen(config.TCP_PORT, () => {
    logger.info(`Server listening on TCP port ${config.TCP_PORT}`);
});

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
    process.exit(0);
}

process.on('SIGINT', fullCleanUp).on('SIGTERM', fullCleanUp);