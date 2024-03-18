const net = require('net');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const PIPE_DIR = '/tmp'; // Directory where named pipes will be stored
const TCP_PORT = 50000; // TCP port for the server to listen on
const RESPONSE_SUFFIX = '_response'; // Suffix for response pipes

let serialIdToPicoNumber = {}; // Maps Pico serial IDs to Pico numbers
let nextPicoNumber = 1; // Tracks the next Pico number to assign
let picoDevices = {}; // Combined object for storing device connections and pipe paths
const DEBOUNCE_TIME = 20; // Time in milliseconds to debounce pipe changes

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

// Setup command and response pipes for a given Pico-W
function setupPipeForPico(picoNumber) {
    const commandPipeName = `pico_${picoNumber}.txt`;
    const commandPipePath = path.join(PIPE_DIR, commandPipeName);
    fs.writeFileSync(commandPipePath, '', { flag: 'w' });
    fs.chmodSync(commandPipePath, 0o666);

    const responsePipeName = `pico_${picoNumber}${RESPONSE_SUFFIX}.txt`;
    const responsePipePath = path.join(PIPE_DIR, responsePipeName);
    fs.writeFileSync(responsePipePath, '', { flag: 'w' });
    fs.chmodSync(responsePipePath, 0o666);

    // Initialize or update the picoDevices entry
    if (!picoDevices[picoNumber]) {
        picoDevices[picoNumber] = {};
    }
    picoDevices[picoNumber].commandPipePath = commandPipePath;
    picoDevices[picoNumber].responsePipePath = responsePipePath;

    // Setup file watcher and debounce mechanism
    if (picoDevices[picoNumber].fileWatcher) {
        picoDevices[picoNumber].fileWatcher.close();
    }
    picoDevices[picoNumber].fileWatcher = fs.watch(commandPipePath, (eventType, filename) => {
        if (eventType === 'change') {
            if (picoDevices[picoNumber].debounceTimer) {
                clearTimeout(picoDevices[picoNumber].debounceTimer);
            }
            picoDevices[picoNumber].debounceTimer = setTimeout(() => {
                fs.readFile(commandPipePath, 'utf8', (err, data) => {
                    if (err) {
                        console.error(`Error reading command pipe for Pico ${picoNumber}:`, err);
                        return;
                    }
                    if (data && picoDevices[picoNumber].socket) {
                        picoDevices[picoNumber].socket.write(data);
                        fs.writeFileSync(commandPipePath, '', { flag: 'w' }); // Clear the file after reading
                        logMessage(`[Pico ${picoNumber} - command] ${data.trim()}`);
                    }
                });
            }, DEBOUNCE_TIME);
        }
    });
    console.log(`Pipes for Pico ${picoNumber} setup: Command [${commandPipePath}], Response [${responsePipePath}]`);
}

// Function to handle Pico-W connection and store its socket
function handlePicoConnection(picoNumber, socket) {
    if (picoDevices[picoNumber] && picoDevices[picoNumber].socket) {
        console.log(`Pico-W client ${picoNumber} reconnected.`);
        picoDevices[picoNumber].socket.destroy(); // Prevent memory leaks
    } else {
        console.log(`Pico-W client ${picoNumber} connected.`);
        setupPipeForPico(picoNumber);
    }
    picoDevices[picoNumber].socket = socket;
}

// Write Pico-W response to the response pipe
function writeResponseToPipe(picoNumber, data) {
    const responsePipePath = picoDevices[picoNumber].responsePipePath;
    if (responsePipePath) {
        fs.writeFileSync(responsePipePath, data);
        logMessage(`[Pico ${picoNumber} - response] ${data.toString().trim()}`);
    }
}

// Cleanup function for deleting pipes and clearing resources for a disconnected Pico-W
function clearAndDeletePipes(picoNumber) {
    if (picoDevices[picoNumber]) {
        if (picoDevices[picoNumber].commandPipePath) {
            fs.unlinkSync(picoDevices[picoNumber].commandPipePath);
        }
        if (picoDevices[picoNumber].responsePipePath) {
            fs.unlinkSync(picoDevices[picoNumber].responsePipePath);
        }
        console.log(`Pipes for Pico ${picoNumber} deleted.`);
        delete picoDevices[picoNumber];
    }
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
            writeResponseToPipe(picoNumber.toString(), data);
        }
    });

    socket.on('close', () => {
        if (picoNumber) {
            setTimeout(() => {
                if (!picoDevices[picoNumber] || picoDevices[picoNumber].socket.destroyed) {
                    console.log(`Pico-W client ${picoNumber} disconnected.`);
                    clearAndDeletePipes(picoNumber);
                    delete picoDevices[picoNumber].socket;
                }
            }, 100); // Delay to allow for reconnection checks
        }
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err);
    });
});

server.listen(TCP_PORT, () => {
    console.log(`Server listening on TCP port ${TCP_PORT}`);
});

// Function to clean up resources and exit cleanly on process termination signals
function cleanUp() {
    Object.keys(picoDevices).forEach((picoNumber) => {
        clearAndDeletePipes(picoNumber);
    });
    process.exit(0); // Exit cleanly
}
process.on('SIGINT', cleanUp).on('SIGTERM', cleanUp);