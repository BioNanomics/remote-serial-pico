const { execSync } = require('child_process');

const installRshellCommands = `
sudo mkdir -m 777 /home/project && cd /home/project
sudo apt update && sudo apt install -y python3-venv python3-pip
python3 -m venv myenv && source myenv/bin/activate
pip install rshell
`;

const setupProjectCommands = `
cd /home/project
git clone https://github.com/RajkumarGara/remote-serial-pico
cd /home/project/remote-serial-pico/src
sudo cp 99-pico.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
`;

function runCommands(commands) {
  commands.split('\n').forEach((command) => {
    if (command.trim()) {
      console.log(`Executing: ${command}`);
      execSync(command, { stdio: 'inherit', shell: true });
    }
  });
}

console.log("Installing rshell and other dependencies...");
runCommands(installRshellCommands);
console.log("Setting up remote-serial-pico project...");
runCommands(setupProjectCommands);
console.log("Starting the project...");
execSync('node PtyServer.js', { stdio: 'inherit', cwd: '/home/project/remote-serial-pico/src', shell: true });
