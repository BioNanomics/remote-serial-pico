# About
Ever need a serial port far away from your Raspberry Pi? Wish you could use WiFi to talk to a serial device without having to run a wire? This project is for you.

## How it works

A Pico W is wired to your serial device and joins your WiFi. It opens a TCP
connection back to the Raspberry Pi and announces itself. The Pi allocates a
pseudo-terminal (pty) for that Pico and symlinks it into `/home/project/`. Any
program on the Pi can then open that symlink as an ordinary serial port — every
byte written to it comes out of the Pico's UART, and every byte the Pico's UART
receives shows up on the pty.

```
[serial device] --UART 19200--> [Pico W] --WiFi/TCP:50000--> [Pi: PtyServer] --> /home/project/<name> -> /dev/pts/N
```

## Requirements

**Raspberry Pi (the server)**
* Raspberry Pi OS (Bookworm or later) with NetworkManager — the default on Bookworm.
* Node.js 18+ (developed on v20.14.0). `node-pty` is compiled at install time, so
  you also need `build-essential` and `python3`.
* Connected to WiFi via NetworkManager, using WPA-PSK. The deployer reads the
  password out of `/etc/NetworkManager/system-connections/*.nmconnection`.
* A stable IP address. The Pico is given the Pi's current IP at flash time and
  does not rediscover it, so use a DHCP reservation or a static address —
  otherwise every Pico stops connecting the day the Pi's IP changes.

**Pico**
* A **Pico W** or Pico 2 W. Plain Picos have no WiFi and will not work.
* MicroPython already flashed on the board — see [Step 1](#step-1-flash-micropython-one-time-per-board) below.

**Both**
* The Pi and the Picos must be on the same WiFi network, and that network must
  allow client-to-client traffic (many guest/isolated SSIDs do not).

## Part 1 — Set up the Raspberry Pi

<a href="https://www.youtube.com/shorts/CbkAj24SPnE" target="_blank">
    <img src="./img/3.jpg" alt="Pico-Pi connection" style="width:40%; height:50%;" align="right"/>
</a>

### The quick way

```bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3 python3-venv python3-pip
sudo npm i -g remote-serial-pico
remote-serial-pico i
```

`remote-serial-pico i` runs [bin/remote-serial-pico.js](./bin/remote-serial-pico.js),
which creates `/home/project`, builds a Python venv there with `rshell` in it,
clones this repo into `/home/project/remote-serial-pico`, installs the udev rule,
copies the systemd unit, and starts the service.

> **It does not finish the job.** `src/pi/config.yaml` and `src/pi/ptyserver.service`
> are host-specific and are not in the repo, so a fresh clone has neither — the
> unit copy fails and the service will not start. Create both by hand as shown
> below, then start the service. Do this once and the installer's other steps are
> already done.

### The manual way (and what the installer leaves out)

**1. Create the working directory and the rshell venv.** `/home/project` is
hard-coded throughout this project; it is not currently configurable.

```bash
sudo mkdir -m 777 /home/project
cd /home/project
sudo apt install -y python3-venv python3-pip build-essential
python3 -m venv myenv
/home/project/myenv/bin/pip install rshell
```

**2. Clone and install dependencies.**

```bash
cd /home/project
git clone https://github.com/RajkumarGara/remote-serial-pico
cd remote-serial-pico
npm install
```

**3. Write `src/pi/config.yaml`.** `PtyServer.js` exits immediately if this file
is missing.

```yaml
PicoSerialMap: '/home/project/pico_serial_map.yaml'
symlinkDir: '/home/project'
SyslogDir: '/dev/log'
CustomlogDir: '/tmp/smartHome.log'
TCP_PORT: 50000
```

| Key | Meaning |
| --- | --- |
| `PicoSerialMap` | Where the serial-ID → friendly-name map is stored |
| `symlinkDir` | Where the port symlinks are created |
| `SyslogDir` | Unix syslog socket, normally `/dev/log` |
| `CustomlogDir` | Plain-text application log |
| `TCP_PORT` | Port the Picos connect to. Must match `PORT` in the Pico's `config.json` |

**4. Install the udev rule** so plugging in a Pico deploys the client code.

```bash
sudo cp src/pi/99-pico.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

**5. Write `src/pi/ptyserver.service`** and install it. Replace `User=` with your
login and `ExecStart=` with the output of `which node` — if you installed Node
through nvm, the absolute path is required because systemd does not read your
shell profile.

```ini
[Unit]
Description=PtyServer Node.js Service
After=network.target

[Service]
WorkingDirectory=/home/project/remote-serial-pico/src/pi
ExecStart=/usr/bin/node PtyServer.js
Restart=always
User=pi
Environment=NODE_ENV=production
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=ptyserver

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp src/pi/ptyserver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ptyserver.service
sudo systemctl status ptyserver.service
```

`enable` is what makes it survive a reboot — the installer script only does
`start`, so remember this step.

**6. Confirm it is listening.**

```bash
ss -tlnp | grep 50000
tail -f /tmp/smartHome.log      # expect: Server listening on TCP port 50000
```

## Part 2 — Load the software onto the Pico

### Step 1: Flash MicroPython (one time per board)

A Pico ships with its flash erased — no MicroPython, no firmware of any kind. Only
the UF2 bootloader in unerasable ROM is present, which is why a Pico is very hard
to brick. The deployer copies files onto a board that is **already running
MicroPython**; it cannot install MicroPython itself. So for a brand-new Pico:

1. Download the MicroPython UF2 for your board from
   <https://micropython.org/download/> (`RPI_PICO_W` or `RPI_PICO2_W`).
2. Plug the Pico into the Pi's USB. It appears as a USB drive called `RPI-RP2`.
   A factory-fresh board does this on its own, because the ROM falls back to USB
   mass-storage mode when it finds nothing in flash. Once a board *has* been
   flashed, hold **BOOTSEL** while plugging it in to get back to this state.
3. Copy the `.uf2` onto that drive. The Pico reboots automatically and the drive
   disappears.

The board now enumerates as a serial device (`2e8a:0005`), which is what the udev
rule watches for.

> Buy the **Pico W** or **Pico 2 W** — a non-wireless Pico has no WiFi and cannot
> work. Headers are only pre-soldered on the "H" variants; this project needs GP4,
> GP5 and GND, so a plain board means soldering.

### Step 2: Plug it into the Pi

With MicroPython on board, just plug the Pico into the Pi's USB port. The udev
rule fires [PicoScriptDeployer.py](./src/pi/PicoScriptDeployer.py), which:

1. Reads the Pi's current SSID (`iwgetid`), the matching WiFi password from
   NetworkManager, and the Pi's current IP address.
2. Writes those plus the Pico's USB serial number into [src/pico/config.json](./src/pico/config.json).
3. Uses `rshell` to copy `config.json` and [main.py](./src/pico/main.py) onto the board.

It takes a few seconds. Watch it happen:

```bash
tail -f /tmp/deployer.log
```

Then unplug the Pico, power it from any USB supply within WiFi range, and wire it
to your serial device: **GP4 = TX, GP5 = RX, plus a common ground**, 19200 8N1.

> `config.json` is tracked by git and is rewritten in place with your real WiFi
> password. Check `git status` before committing anything on a Pi that has flashed
> a board.

### Doing it manually

If udev does not fire, or you want to flash a Pico from a different machine:

```bash
# edit src/pico/config.json first — SSID, password, the Pi's IP, PORT 50000
/home/project/myenv/bin/rshell -p /dev/ttyACM0 cp src/pico/main.py src/pico/config.json /pyboard/
```

`PICO_ID` in that file is only a label; the Pi keys off it to name the port, so
give each board a distinct value if you set it by hand.

## Naming your serial ports

The first time a Pico connects, the Pi records it in `/home/project/pico_serial_map.yaml`
using its serial ID for both key and name, and creates a symlink named after it:

```yaml
e66164084319422c: e66164084319422c
```

Edit the value to whatever you want the port to be called, then restart the
service:

```yaml
e66164084319422c: Lights_pico
e6614103e71d2c2f: Blinds_pico
```

```bash
sudo systemctl restart ptyserver.service
```

You now have `/home/project/Lights_pico` and `/home/project/Blinds_pico`. Point
any serial-aware program at those paths:

```bash
ls -l /home/project/*_pico          # see what is currently wired up
screen /home/project/Blinds_pico 19200
```

The symlink target changes every time the service restarts, because a new pty is
allocated — always open the symlink, never `/dev/pts/N` directly. Programs that
hold the old pty open (Node-RED, for instance) need to be restarted after the
PtyServer service restarts.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Service dies instantly | `src/pi/config.yaml` missing. `journalctl -u ptyserver.service -n 20` |
| `node: not found` from systemd | Use the absolute path from `which node` in `ExecStart=` |
| Nothing in `/tmp/deployer.log` on plug-in | udev rule not installed, or MicroPython not flashed — a board in BOOTSEL/mass-storage mode is not `2e8a:0005` and is ignored |
| Deployer runs but Pico never connects | Wrong SSID/password captured, Pi's IP changed since flashing, or client isolation on the WiFi |
| Pico LED blinks forever | Cannot join WiFi — re-flash `config.json` |
| `cannot open /home/project/<name>` | The Pico is not currently connected, so there is no live pty behind that symlink |
| `Error: port in use` on 50000 | Something else already bound it; check with `ss -tlnp \| grep 50000` |

Logs worth knowing:

```bash
tail -f /tmp/smartHome.log                  # every command and response
sudo journalctl -u ptyserver.service -f     # service lifecycle
tail -f /tmp/deployer.log                   # Pico flashing
```

### Background
Designed to facilitate communication between a remote device (such as a Raspberry Pi) and a device connected via serial to the Pico. It leverages TCP/IP networking to bridge data exchange between the Pico's serial interface and a networked environment. Extend this project using either the [`node-red-bridge`](https://github.com/RajkumarGara/node-red-bridge) or [`homebridge-tcp-smarthome`](https://github.com/RajkumarGara/homebridge-tcp-smarthome).

### Pico on-board LED status
* LED blinks repeatedly during the WiFi connection process. Upon successful connection it turns off.
* LED switches on again when connected to the TCP server.
* LED blinks once upon receiving a command either from TCP server or a serially connected device.
* LED turns off when disconnected from the TCP server.

## Project Details
* **Curious about PtyServer?**
    * Detects a Pico client from its first packet, `pico_<serialId>`, and creates a pseudo terminal (pty) for each Pico.
    * Resolves that serial ID to a friendly name via `pico_serial_map.yaml`, and symlinks the pty into `symlinkDir`.
    * Sends data available in pty to the respective Pico.
    * Writes data received from Pico into corresponding pty.
    * Answers the Pico's `PING` keepalive with `PONG`.
    * Log the commands and responses for each pico; check out the log:
        ```
        tail -f /tmp/smartHome.log
        ```

* **Wondering how plugging Pico into the Pi installs client code in Pico?**
    * The udev rule ([99-pico.rules](./src/pi/99-pico.rules)) watches Pi's USB port for Pico connection.
    * When a Pico is connected, it triggers another script [PicoScriptDeployer.py](./src/pi/PicoScriptDeployer.py) to run on Pi.
    * It matches `2e8a:0005`, the USB serial interface a board presents once MicroPython is running. A board in BOOTSEL/mass-storage mode reports a different product ID and is ignored.

* **And what exactly does PicoScriptDeployer do?**
    * It fetches `wifi-ssid, password, IP, Pico-Serial-ID` and updates the corresponding credentials on [config.json](./src/pico/config.json). You can also manually update it.
    * Deploys [`main.py`](./src/pico/main.py) and [`config.json`](./src/pico/config.json) to the most recently connected pico.
    * You can observe the deployer log:
        ```
        tail -f /tmp/deployer.log
        ``` 

* **Now, what's the role of the main code in Pico?**
    * Retrieves the network credentials and server details from the `config.json`.
    * Upon TCP connection, sends its `Serial-ID` to the Pi in the first packet.
    * Continuously checks for data in TCP and Serial; if it receives data from either, it sends that data to the other.
    * Sends a heartbeat signal (`PING`) to the server every 10 seconds to ensure the connection is alive; expects a `PONG` response from the server.
    * Reconnects automatically if the Pi closes the connection.

## Visual Overview
* Checkout the serial diagram: ![block diagram](img/2.jpg)  
* Checkout the network diagram: [SRC](https://docs.google.com/drawings/d/1oIbP6EGNI4thhi0qzVgtGZw0lyD-F9gRc0-1tAc7O_Q/edit)
    ![drawing alt text](https://docs.google.com/drawings/d/1oIbP6EGNI4thhi0qzVgtGZw0lyD-F9gRc0-1tAc7O_Q/export/png)

    [![Watch the video](img/4.GIF)](https://youtu.be/M36LoMouvPg)

## Credits
Special thanks to [Medical Informatics Engineering](https://www.mieweb.com/) for their support throughout the development of this project, especially to [Doug Horner](https://github.com/horner) for his invaluable guidance.
