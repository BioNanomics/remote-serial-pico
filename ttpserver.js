const net = require('net');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const PIPE_DIR = '/tmp';
const TCP_PORT = 50000;

let picoSocket = null; // This will be the socket for the Pico-W
let homebridgeSocket = null; // This will be the socket for the Homebridge client
let pipeReadStream = null;
let pipePath = '';

function setupNamedPipe(filename) {
    // Sanitize filename to ensure it does not contain invalid characters or paths
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_\-]+/g, '');

    pipePath = path.join(PIPE_DIR, sanitizedFilename);

    if (fs.existsSync(pipePath)) {
        fs.unlinkSync(pipePath);
    }

    child_process.execSync(`mkfifo ${pipePath}`);
    console.log(`Named pipe created at: ${pipePath}`);

    const pipeFd = fs.openSync(pipePath, 'r+');
    pipeReadStream = fs.createReadStream(null, { fd: pipeFd });

    pipeReadStream.on('data', (data) => {
        if (picoSocket && picoSocket.writable) {
            picoSocket.write(data);
        }
    });

    pipeReadStream.on('end', () => {
        pipeReadStream.close();
        if (fs.existsSync(pipePath)) {
            fs.unlinkSync(pipePath);
        }
        console.log('Named pipe end reached, stream closed.');
    });
}

function closeSocket(socket) {
    if (socket) {
        socket.end();
        socket.destroy();
    }
}

const server = net.createServer((socket) => {
    socket.on('data', (data) => {
        const message = data.toString().trim();

        if (message.startsWith('pico_')) {
            if (picoSocket) {
                closeSocket(picoSocket); // Close the previous Pico-W socket if it exists
            }
            picoSocket = socket; // Assign the new Pico-W socket
            console.log('Pico-W client connected.');

            // Listen for the close event on the new Pico-W socket
            picoSocket.on('close', () => {
                console.log('Pico-W client disconnected.');
                picoSocket = null; // Clear the reference to allow a new connection
            });

            setupNamedPipe(message);
        } else {
            // If it's not a Pico-W, assume it's Homebridge
            homebridgeSocket = socket; // Assign the Homebridge socket
            console.log('Homebridge client connected.');
            homebridgeSocket.on('close', () => {
                console.log('Homebridge client disconnected.');
                homebridgeSocket = null;
            });
            // Forward data to Pico-W if available and writable
            if (picoSocket && picoSocket.writable) {
                picoSocket.write(data);
            } else {
                console.log('Cannot forward data to Pico-W, socket not writable or not connected.');
            }
        }
    });

    socket.on('end', () => {
        closeSocket(socket);
    });

    socket.on('close', () => {
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err);
        closeSocket(socket);
    });
});

server.listen(TCP_PORT, () => {
    console.log(`Server listening on TCP port ${TCP_PORT}`);
});

function cleanUp() {    
    if (pipeReadStream) {
        pipeReadStream.close();
        pipeReadStream = null;
        if (fs.existsSync(pipePath)) {
            fs.unlinkSync(pipePath);
        }
    }

    closeSocket(picoSocket); // Close the Pico-W socket
    closeSocket(homebridgeSocket); // Close the Homebridge socket
    process.exit(0); // Exit
}

process.on('SIGINT', cleanUp).on('SIGTERM', cleanUp);