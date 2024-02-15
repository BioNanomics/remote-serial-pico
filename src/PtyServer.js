const net = require('net');
const fs = require('fs');
const path = require('path');

const FILE_DIR = '/tmp';
const TCP_PORT = 50000;
const RESPONSE_SUFFIX = '_response'; // Suffix for response files
const DEBOUNCE_TIME = 200; // Time in milliseconds


let picoSockets = {}; // Store sockets for each Pico-W, keyed by pico number
let picoFiles = {}; // Store command file paths for each Pico-W
let picoResponseFiles = {}; // Store response file paths for each Pico-W
let fileWatchers = {}; // Store file watchers for command files
let debounceTimers = {}; // Store debounce timers for each Pico


function sanitizeInput(input) {
    // Remove null bytes and other non-printable characters
    return String(input).replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}

function setupFileForPico(picoNumber) {
  const sanitizedNumber = sanitizeInput(picoNumber);
  const commandFilename = `pico_${sanitizedNumber}.txt`;
  const commandFilePath = path.join(FILE_DIR, commandFilename);
  fs.writeFileSync(commandFilePath, '', { flag: 'w' });
  fs.chmodSync(commandFilePath, 0o666);
  picoFiles[picoNumber] = commandFilePath;

  const responseFilename = `pico_${sanitizedNumber}${RESPONSE_SUFFIX}.txt`;
  const responseFilePath = path.join(FILE_DIR, responseFilename);
  fs.writeFileSync(responseFilePath, '', { flag: 'w' });
  fs.chmodSync(responseFilePath, 0o666);
  picoResponseFiles[picoNumber] = responseFilePath;

  console.log(`Files for Pico ${picoNumber} setup: Command [${commandFilePath}], Response [${responseFilePath}]`);

  // Cancel any previous watcher and setup a new one
  if (fileWatchers[picoNumber]) {
      fileWatchers[picoNumber].close();
  }

  fileWatchers[picoNumber] = fs.watch(commandFilePath, (eventType, filename) => {
      if (eventType === 'change') {
          if (debounceTimers[picoNumber]) {
              clearTimeout(debounceTimers[picoNumber]);
          }
          debounceTimers[picoNumber] = setTimeout(() => {
              fs.readFile(commandFilePath, 'utf8', (err, data) => {
                  if (err) {
                      console.error(`Error reading command file for Pico ${picoNumber}:`, err);
                      return;
                  }
                  if (data && picoSockets[picoNumber]) {
                      picoSockets[picoNumber].write(data);
                      fs.writeFileSync(commandFilePath, '', { flag: 'w' }); // Clear file after sending command
                      console.log(`Command sent to Pico ${picoNumber}: ${data}`);
                  }
              });
          }, DEBOUNCE_TIME);
      }
  });
}

function writeResponseToFile(picoNumber, data) {
    const responseFilePath = picoResponseFiles[picoNumber];
    if (responseFilePath) {
        fs.writeFileSync(responseFilePath, data);
        console.log(`Response from Pico ${picoNumber} written to file: ${responseFilePath}`);
    }
}

function clearAndDeleteFiles(picoNumber) {
    if (fileWatchers[picoNumber]) {
        fileWatchers[picoNumber].close(); // Close the file watcher
        delete fileWatchers[picoNumber];
    }

    if (picoFiles[picoNumber]) {
        fs.unlinkSync(picoFiles[picoNumber]);
        delete picoFiles[picoNumber];
    }

    if (picoResponseFiles[picoNumber]) {
        fs.unlinkSync(picoResponseFiles[picoNumber]);
        delete picoResponseFiles[picoNumber];
    }

    console.log(`Files for Pico ${picoNumber} deleted.`);
}

const server = net.createServer((socket) => {
  let picoNumber = null; // Variable to hold the Pico's identifier

  socket.on('data', (data) => {
      const message = data.toString().trim();
      const sanitizedMessage = sanitizeInput(message);

      // Check if the message is an identifier
      if (sanitizedMessage.startsWith('pico_')) {
          picoNumber = sanitizedMessage.slice(5);
          handlePicoConnection(picoNumber, socket);
      } else if (picoNumber) {
          // If we have a picoNumber, it means this is data from the Pico
          writeResponseToFile(picoNumber, data);
      }
  });

  socket.on('close', () => {
      if (picoNumber) {
          console.log(`Pico-W client ${picoNumber} disconnected.`);
          clearAndDeleteFiles(picoNumber);
          delete picoSockets[picoNumber];
      }
  });

  socket.on('error', (err) => {
      console.error('Socket error:', err);
  });
});

function handlePicoConnection(picoNumber, socket) {
  if (picoSockets[picoNumber]) {
      console.log(`Pico-W client ${picoNumber} reconnected.`);
      // Optionally close the old socket before reassigning it to prevent memory leaks
      picoSockets[picoNumber].destroy();
  } else {
      console.log(`Pico-W client ${picoNumber} connected.`);
      setupFileForPico(picoNumber);
  }
  picoSockets[picoNumber] = socket;
}

server.listen(TCP_PORT, () => {
    console.log(`Server listening on TCP port ${TCP_PORT}`);
});

function cleanUp() {
    Object.keys(picoSockets).forEach((picoNumber) => {
        if (picoSockets[picoNumber]) {
            picoSockets[picoNumber].end();
            delete picoSockets[picoNumber];
        }
        clearAndDeleteFiles(picoNumber); // Ensure cleanup includes file watchers
    });
    process.exit(0); // Exit cleanly
}

process.on('SIGINT', cleanUp).on('SIGTERM', cleanUp);
