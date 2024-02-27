# About
Ever need a serial port far away from your Raspberry Pi? Wish you could use WiFi to talk to a serial device without having to run a wire? This project is for you.

## Install for use
<img src="./img/3.GIF" alt="Pico-Pi connection" width="40%" align="right"/>

```
$ npm install -g RemoteSerialPico
$ RemoteSerialPico install
```

Now a server is running on the Pi. If you plug in a Pico to the USB it will install the client code on the pico and make it a remote serial port.

`/tmp/pico_1`

It's that easy to setup a remote serial port.  Each time you plug in a pico, it will be the next pico_N on the list.

### Background
Designed to facilitate communication between a remote device (such as a Raspberry Pi) and a device connected via serial to the Pico. It leverages TCP/IP networking to bridge data exchange between the Pico's serial interface and a networked environment. This project can be extended using either the [`node-red-bridge`](https://github.com/RajkumarGara/node-red-bridge) or [`homebridge-tcp-smarthome`](https://github.com/RajkumarGara/homebridge-tcp-smarthome).

## Installation for Development
* Install nodejs latest version on Raspberry Pi, for more details refer [install-nodejs](https://github.com/nodejs/help/wiki/Installation#how-to-install-nodejs-via-binary-archive-on-linux).
    ```
    sudo apt update && sudo apt upgrade
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install nodejs
    ```

* Install `rshell` on Raspberry Pi.
    ```
    sudo mkdir -m 777 /home/project && cd /home/project
    sudo apt update && sudo apt install python3-venv python3-pip
    python3 -m venv myenv && source myenv/bin/activate
    pip install rshell
    ```

## Running the setup
* Open terminal on your Raspberry Pi and enter below commands to clone this github repo.
    ```
    cd /home/project
    git clone https://github.com/RajkumarGara/RemoteSerialPico
    ```
* Create a udev rule that triggers on USB Pico connection. 
    ```
    cd /home/project/RemoteSerialPico/src
    sudo cp 99-pico.rules /etc/udev/rules.d/
    ```
* Reload udev rules to apply the changes
    ```
    sudo udevadm control --reload-rules
    sudo udevadm trigger
    ```
* Run `PtyServer.js` code
    ```
    node PtyServer.js
    ```
* Connect your Pico-W to the Raspberry Pi. This will automatically install [`PicoSerialClient.py`](./src/PicoSerialClient.py) on the Pico-W within 5sec.

## Pico on-board LED status
* LED blinks repeatedly during the WiFi connection process. Upon successful connection it turns off.
* LED switches on again when connected to the TCP server.
* LED blinks once upon receiving a command either from TCP server or a serially connected device.
* LED turns off when disconnected from the TCP server.

## Project Q&A
* **Curious about PtyServer?**
    * Detects Pico clients using `pico_{N}` format, and assigns separate pipes.
    * Sends data available in command pipe to the respective Pico and clears the pipe.
    * Writes data received from Pico into corresponding response pipe.
    * Deletes corresponding Pico pipes upon disconnection.

* **Wondering how plugging Pico into the Pi installs PicoSerialClient.py?**
    * The udev rule ([99-pico.rules](./src/99-pico.rules)) will monitor the Pi's USB port for connections.
    * If it detects any new connections, it will simply run the [PicoScriptDeployer.py](./src/PicoScriptDeployer.py) on Pi.

* **And what exactly does PicoScriptDeployer do?**
    * Automtically obtains `wifi-ssid, password, IP, Pico-serial-id` and updates [`config.json`](./src/config.json). Sometimes it couldn't get the password; you can always **manually update** it in config.json.
    * Modifies [`PicoSerialClient.py`](./src/PicoSerialClient.py) with the credentials from config.json.
    * Renames PicoSerialClient.py as main.py and then deploys it to ensure Pico runs the code after power-on reset.
    * Deploys [`PicoSerialClient.py`](./src/PicoSerialClient.py) to the most recently connected Pico only, if multiple Picos are attached to Pi.

## Visual Overview
* This diagram provides a general overview of the project. For more infomation checkout [detailed diagram](img/2.jpg).
    ![general diagram](img/1.jpg)

## Credits
Special thanks to [Medical Informatics Engineering](https://www.mieweb.com/) for their support throughout the development of this project, especially to [Doug Horner](https://github.com/horner) for his invaluable guidance.
