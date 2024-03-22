const net = require('net');
const moment = require('moment-timezone');
const pty = require('node-pty');
const fs = require('fs');

const TCP_PORT = 50000; // TCP port for the server to listen on
const symlinkDir = '/home/project'; // Directory for symlinks

let serialIdToPicoNumber = {}; // Maps Pico serial IDs to Pico numbers
let nextPicoNumber = 1; // Tracks the next Pico number to assign
let picoDevices = {}; // storing device connections and pty processes

// Log file setup
const LOG_FILE_PATH = '/tmp/smart_home.log';
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB in bytes

// Function to Log a message to the log file.
function logMessage(message) {
    // Ensures the log file exists; creates it if it doesn't.
    if (!fs.existsSync(LOG_FILE_PATH)) {
        fs.writeFileSync(LOG_FILE_PATH, '');
    } else {
        // Check the file size and clear if it exceeds the maximum size
        const fileSizeInBytes = fs.statSync(LOG_FILE_PATH).size;
        if (fileSizeInBytes > MAX_FILE_SIZE_BYTES) {
            fs.writeFileSync(LOG_FILE_PATH, '');
        }
    }
    // Append the new log message
    const CurrentDateTimeInEST = moment().tz('America/New_York').format('YYYY-MM-DD HH:mm:ss:S');
    const formattedMessage = `${CurrentDateTimeInEST} ${message}\n`;
    fs.appendFileSync(LOG_FILE_PATH, formattedMessage);
}

// Function to create symlink for Pico
function createSymlink(picoNumber, ptsName) {
    const symlinkPath = `${symlinkDir}/pico${picoNumber}`;
    if (!fs.existsSync(symlinkPath)) {
        try {
            fs.symlinkSync(ptsName, symlinkPath);
            logMessage(`Created symlink '${fs.realpathSync(symlinkPath)}' -> '${symlinkPath}'`);
        } catch (err) {
            logMessage(`Error creating symlink: ${err.message}`);
        }
    } else {
        logMessage(`Symlink '${fs.realpathSync(symlinkPath)}' -> '${symlinkPath}' already exists.`);
    }
}

// Function to remove symlink for Pico
function removeSymlink(picoNumber) {
    const symlinkPath = `${symlinkDir}/pico${picoNumber}`;
    try {
        fs.unlinkSync(symlinkPath);
        logMessage(`Removed symlink pico${picoNumber}`);
    } catch (err) {
        logMessage(`Error removing symlink: ${err.message}`);
    }
}

// Setup pty for a given Pico-W
function setupPicoPty(picoNumber) {
    const myPty = pty.open();
    createSymlink(picoNumber, myPty.ptsName);
    return myPty;
}

// Function to handle Pico-W connection and store its socket and pty process
function handlePicoConnection(picoNumber, socket) {
    if (picoDevices[picoNumber] && picoDevices[picoNumber].pty) {
        logMessage(`Pico${picoNumber} client reconnected.`);
    } else {
        logMessage(`Pico${picoNumber} client connected.`);
        const myPty = setupPicoPty(picoNumber);
        picoDevices[picoNumber] = {
            socket: socket,
            pty: myPty
        };
        routePtyCmdToSocket(picoNumber);
    }
}

// Function to handle data received from pty and send it to the socket
function routePtyCmdToSocket(picoNumber) {
    const myPty = picoDevices[picoNumber].pty;
    myPty.on('data', (data) => {
        const command = data.toString();
        picoDevices[picoNumber].socket.write(command);
        logMessage(`[Pico ${picoNumber} - command] ${command}`);
    });
}

// Function to write response received from socket to the pty
function writePicoRespToPty(picoNumber, response) {
    const myPty = picoDevices[picoNumber].pty;
    myPty.write(response + '\r');
    logMessage(`[Pico ${picoNumber} - response] ${response}`);
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
        if (picoNumber && picoDevices[picoNumber]) {
            logMessage(`Pico${picoNumber} client disconnected.`);
            picoDevices[picoNumber].pty.destroy();
            removeSymlink(picoNumber);
            delete picoDevices[picoNumber];
        }
    });

    socket.on('error', (err) => {
        logMessage('Socket error:', err);
    });
});

server.listen(TCP_PORT, () => {
    logMessage(`Server listening on TCP port ${TCP_PORT}`);
});

// Function to clean up resources and exit cleanly on process termination signals
function cleanUp() {
    Object.keys(picoDevices).forEach((picoNumber) => {
        if (picoDevices[picoNumber] && picoDevices[picoNumber].pty) {
            picoDevices[picoNumber].pty.destroy();
            removeSymlink(picoNumber);
        }
    });
    process.exit(0);
}
process.on('SIGINT', cleanUp).on('SIGTERM', cleanUp);