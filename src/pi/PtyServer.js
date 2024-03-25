const net = require('net');
const pty = require('node-pty');
const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;
const { Syslog } = require('winston-syslog');

const TCP_PORT = 50000; // TCP port for the server to listen on
const symlinkDir = '/home/project'; // Directory for symlinks

let serialIdToPicoNumber = {}; // Maps Pico serial IDs to Pico numbers
let nextPicoNumber = 1; // Tracks the next Pico number to assign
let picoDevices = {}; // storing device connections and pty processes

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
    path: '/dev/log',
    format: printf(({ message }) => message) // Log only the message
});

const consoleTransport = new transports.Console({
    format: customFormat
});

const fileTransport = new transports.File({ 
    filename: '/tmp/smartHome.log',
    format: customFormat
});

// Create a logger instance
const logger = createLogger({
    transports: [
        // syslogTransport,  // Log to syslog (systemd journal)
        // consoleTransport, // Log to console
        fileTransport     // Log to a file
    ]
});

// Function to create symlink for Pico
function createSymlink(picoNumber, ptsName) {
    const symlinkPath = `${symlinkDir}/pico${picoNumber}`;
    if (!fs.existsSync(symlinkPath)) {
        try {
            fs.symlinkSync(ptsName, symlinkPath);
            logger.info(`Created symlink '${fs.realpathSync(symlinkPath)}' -> '${symlinkPath}'`);
        } catch (err) {
            logger.error(`Error creating symlink: ${err.message}`);
        }
    } else {
        logger.info(`Symlink '${fs.realpathSync(symlinkPath)}' -> '${symlinkPath}' already exists`);
    }
}

// Function to remove symlink for Pico
function removeSymlink(picoNumber) {
    const symlinkPath = `${symlinkDir}/pico${picoNumber}`;
    try {
        fs.unlinkSync(symlinkPath);
        logger.info(`Pico${picoNumber} symlink removed`);
    } catch (err) {
        logger.error(`Error removing symlink: ${err.message}`);
    }
}

// Function to handle Pico connection and store its socket and pty process
function handlePicoConnection(picoNumber, socket) {
    if (picoDevices[picoNumber] && picoDevices[picoNumber].socket) {
        logger.warn(`Pico${picoNumber} client reconnected`);
        picoDevices[picoNumber].socket.destroy(); // Prevent memory leaks
    } else {
        logger.info(`Pico${picoNumber} client connected`);
        setupPicoPty(picoNumber);
    }
    picoDevices[picoNumber].socket = socket;
}

// Setup pty for a given Pico
function setupPicoPty(picoNumber) {
    if (!picoDevices[picoNumber]) {
        picoDevices[picoNumber] = {}; // Initialize as an object if it doesn't exist
    }
    const myPty = pty.open();
    createSymlink(picoNumber, myPty.ptsName);
    picoDevices[picoNumber].pty = myPty;
    routePtyCmdToSocket(picoNumber);
}

// Function to handle data received from pty and send it to the socket
function routePtyCmdToSocket(picoNumber) {
    const myPty = picoDevices[picoNumber].pty;
    myPty.on('data', (data) => {
        const command = data.toString();
        picoDevices[picoNumber].socket.write(command);
        logger.info(`Pico${picoNumber} command  ${command}`);
    });
}

// Function to write response received from socket to the pty
function writePicoRespToPty(picoNumber, response) {
    const myPty = picoDevices[picoNumber].pty;
    myPty.write(response + '\r');
    logger.info(`Pico${picoNumber} response ${response}`);
}

// Create the TCP server and setup event listeners for socket connections
const server = net.createServer((socket) => {
    let picoNumber = null;

    socket.on('data', (data) => {
        const message = data.toString().trim();
        const sanitizedMessage = message;

        if (sanitizedMessage.startsWith('pico_')) {
            const serialId = sanitizedMessage.slice(5);
            if (!serialIdToPicoNumber[serialId]) {
                serialIdToPicoNumber[serialId] = nextPicoNumber++;
            }
            picoNumber = serialIdToPicoNumber[serialId];
            handlePicoConnection(picoNumber.toString(), socket);
        } else if (picoNumber) {
            writePicoRespToPty(picoNumber, sanitizedMessage);
        }
    });

    socket.on('close', () => {
        if (picoNumber) {
            logger.warn(`Pico${picoNumber} client disconnected`);
        }
    });

    socket.on('error', (err) => {
        logger.error('Socket error:', err);
    });
});

server.listen(TCP_PORT, () => {
    logger.info(`Server listening on TCP port ${TCP_PORT}`);
});

// Cleanup function for destroying pty, socket for a given pico
function cleanPicoResources(picoNumber) {
    const picoDevice = picoDevices[picoNumber];
    if (picoDevice) {
        if (picoDevice.pty) {
            picoDevice.pty.destroy();
            removeSymlink(picoNumber);
        }
        if (picoDevice.socket && !picoDevice.socket.destroyed) {
            picoDevice.socket.destroy();
        }
        delete picoDevices[picoNumber];
        logger.info(`Pico${picoNumber} pty and socket destroyed`);
    } else {
        logger.info(`Pico${picoNumber} device not found`);
    }
}

// clean up all resources and exit gracefully on process termination signals
function fullCleanUp() {
    Object.keys(picoDevices).forEach((picoNumber) => {
        cleanPicoResources(picoNumber);
    });
    process.exit(0);
}
process.on('SIGINT', fullCleanUp).on('SIGTERM', fullCleanUp);