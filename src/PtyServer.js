// Import required modules
const net = require('net');
const fs = require('fs');
const path = require('path');

const PIPE_DIR = '/tmp'; // Directory where named pipes will be stored
const TCP_PORT = 50000; // TCP port for the server to listen on
const RESPONSE_SUFFIX = '_response'; // Suffix for response pipes
const DEBOUNCE_TIME = 200; // Time in milliseconds to debounce pipe changes

let picoSockets = {}; // Store sockets for each Pico-W, keyed by pico number
let picoPipes = {}; // Store command pipe paths for each Pico-W
let picoResponsePipes = {}; // Store response pipe paths for each Pico-W
let fileWatchers = {}; // Store file watchers for command pipes
let debounceTimers = {}; // Store debounce timers for each Pico

function sanitizeInput(input) {
    // Remove null bytes and other non-printable characters
    return String(input).replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}

// Setup command and response pipes for a given Pico-W
function setupPipeForPico(picoNumber) {
  const sanitizedNumber = sanitizeInput(picoNumber);
  const commandPipeName = `pico_${sanitizedNumber}.txt`; // Generate name for command pipe
  const commandPipePath = path.join(PIPE_DIR, commandPipeName); // Construct full pipe path
  fs.writeFileSync(commandPipePath, '', { flag: 'w' }); // Create named pipe
  fs.chmodSync(commandPipePath, 0o666); //Give read/write permission to the command pipe for all users  
  picoPipes[picoNumber] = commandPipePath; // Store pipe path in the dictionary

  const responsePipeName = `pico_${sanitizedNumber}${RESPONSE_SUFFIX}.txt`;
  const responsePipePath = path.join(PIPE_DIR, responsePipeName);
  fs.writeFileSync(responsePipePath, '', { flag: 'w' });
  fs.chmodSync(responsePipePath, 0o666);
  picoResponsePipes[picoNumber] = responsePipePath;

  console.log(`Pipes for Pico ${picoNumber} setup: Command [${commandPipePath}], Response [${responsePipePath}]`);

  // Cancel any previous watcher and setup a new one
  if (fileWatchers[picoNumber]) {
      fileWatchers[picoNumber].close();
  }

  fileWatchers[picoNumber] = fs.watch(commandPipePath, (eventType, filename) => {
      if (eventType === 'change') {
          if (debounceTimers[picoNumber]) {
              clearTimeout(debounceTimers[picoNumber]);
          }
          debounceTimers[picoNumber] = setTimeout(() => {
              fs.readFile(commandPipePath, 'utf8', (err, data) => {
                  if (err) {
                      console.error(`Error reading command pipe for Pico ${picoNumber}:`, err);
                      return;
                  }
                  if (data && picoSockets[picoNumber]) {
                      picoSockets[picoNumber].write(data);
                      fs.writeFileSync(commandPipePath, '', { flag: 'w' }); // Clear pipe after sending command
                      console.log(`Command sent to Pico ${picoNumber}: ${data}`);
                  }
              });
          }, DEBOUNCE_TIME);
      }
  });
}

// Write Pico-W response to a pipe
function writeResponseToPipe(picoNumber, data) {
    const responsePipePath = picoResponsePipes[picoNumber];
    if (responsePipePath) {
        fs.writeFileSync(responsePipePath, data);
        console.log(`Response from Pico ${picoNumber} written to pipe: ${responsePipePath}`);
    }
}

// Cleanup and delete pipes for a disconnected Pico-W
function clearAndDeletePipes(picoNumber) {
    if (fileWatchers[picoNumber]) {
        fileWatchers[picoNumber].close();
        delete fileWatchers[picoNumber];
    }

    if (picoPipes[picoNumber]) {
        fs.unlinkSync(picoPipes[picoNumber]);
        delete picoPipes[picoNumber];
    }

    if (picoResponsePipes[picoNumber]) {
        fs.unlinkSync(picoResponsePipes[picoNumber]);
        delete picoResponsePipes[picoNumber];
    }

    console.log(`Pipes for Pico ${picoNumber} deleted.`);
}

// Create TCP server
const server = net.createServer((socket) => {
  let picoNumber = null;

  socket.on('data', (data) => {
      const message = data.toString().trim();
      const sanitizedMessage = sanitizeInput(message);

      // Check if the message is an identifier
      if (sanitizedMessage.startsWith('pico_')) {
          picoNumber = sanitizedMessage.slice(5); // Extract Pico number from the identifier
          handlePicoConnection(picoNumber, socket);
      } else if (picoNumber) {
          // If we have a picoNumber, it means this is data from the Pico
          writeResponseToPipe(picoNumber, data);
      }
  });

  socket.on('close', () => {
      if (picoNumber) {
          console.log(`Pico-W client ${picoNumber} disconnected.`);
          clearAndDeletePipes(picoNumber);
          delete picoSockets[picoNumber];
      }
  });

  socket.on('error', (err) => {
      console.error('Socket error:', err);
  });
});

// To handle Pico-W connection
function handlePicoConnection(picoNumber, socket) {
  if (picoSockets[picoNumber]) {
      console.log(`Pico-W client ${picoNumber} reconnected.`);
      // Close the old socket before reassigning it to prevent memory leaks
      picoSockets[picoNumber].destroy();
  } else {
      console.log(`Pico-W client ${picoNumber} connected.`);
      setupPipeForPico(picoNumber);
  }
  // Store the socket for the Pico-W
  picoSockets[picoNumber] = socket;
}

// Start listening on the specified TCP port
server.listen(TCP_PORT, () => {
    console.log(`Server listening on TCP port ${TCP_PORT}`);
});

// clean up resources and exit cleanly on process termination signals
function cleanUp() {
    Object.keys(picoSockets).forEach((picoNumber) => {
        if (picoSockets[picoNumber]) {
            picoSockets[picoNumber].end();
            delete picoSockets[picoNumber];
        }
        clearAndDeletePipes(picoNumber); // Ensure cleanup includes file watchers
    });
    process.exit(0); // Exit cleanly
}

// Register cleanup function for SIGINT and SIGTERM signals
process.on('SIGINT', cleanUp).on('SIGTERM', cleanUp);