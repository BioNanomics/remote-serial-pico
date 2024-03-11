#!/usr/bin/env node

const { execSync } = require('child_process');

const installRshellCommands = [
  'if [ ! -d "/home/project" ]; then sudo mkdir -m 777 /home/project; fi',
  'cd /home/project',
  'sudo apt update && sudo apt install -y python3-venv python3-pip',
  'python3 -m venv myenv',
  '/home/project/myenv/bin/pip install rshell'
].join(' && ');

const npmInstallCommand = 'sudo npm install';

const setupProjectCommands = `
cd /home/project && 
if [ ! -d "remote-serial-pico" ] || [ -z "$(ls -A remote-serial-pico)" ]; then 
  git clone https://github.com/RajkumarGara/remote-serial-pico; 
else 
  echo "Directory remote-serial-pico already exists and is not empty. Skipping clone."; 
fi && 
cd /home/project/remote-serial-pico/src && 
sudo cp 99-pico.rules /etc/udev/rules.d/ && 
sudo udevadm control --reload-rules && 
sudo udevadm trigger
`;

function runCommands(commands) {
  execSync(commands, { stdio: 'inherit', shell: true });
}

console.log("Installing rshell and other dependencies...");
runCommands(installRshellCommands);
console.log("Installing dependencies listed in package.json...");
runCommands(npmInstallCommand);
console.log("Setting up remote-serial-pico project...");
runCommands(setupProjectCommands);
console.log("Starting the project...");
execSync('node PtyServer.js', { stdio: 'inherit', cwd: '/home/project/remote-serial-pico/src', shell: true });
