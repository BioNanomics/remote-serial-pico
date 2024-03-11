# About
Ever need a serial port far away from your Raspberry Pi? Wish you could use WiFi to talk to a serial device without having to run a wire? This project is for you.

## Installation
<img src="./img/3.GIF" alt="Pico-Pi connection" width="40%" align="right"/>

```
sudo npm install -g remote-serial-pico
remote-serial-pico install
```

Now a server is running on the Pi. If you plug in a Pico to the USB it will install the client code on the pico and make it a remote serial port.

`/tmp/pico_1`

It's that easy to setup a remote serial port. Each time you plug in a pico, it will be the next `pico_N` on the list.

If you haven't already installed npm:
```
sudo apt update
sudo apt install nodejs npm
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
    * Detects Pico clients upon receiving first packet with `pico_{N}`, and assigns separate pipes.
    * Sends data available in command pipe to the respective Pico and clears the pipe.
    * Writes data received from Pico into corresponding response pipe.
    * Deletes corresponding Pico pipes upon disconnection.

* **Wondering how plugging Pico into the Pi installs PicoSerialClient.py?**
    * The udev rule ([99-pico.rules](./src/99-pico.rules)) watches for Pico devices connecting to the Raspberry Pi.
    * When a Pico is connected, it triggers another script [PicoScriptDeployer.py](./src/PicoScriptDeployer.py) to run on Pi.

* **And what exactly does PicoScriptDeployer do?**
    * It fetches `wifi-ssid, password, IP, Pico-serial-id` and updates the corresponding credentials on [`config.json`](./src/config.json). You can also manually update it.
    * Modifies [`PicoSerialClient.py`](./src/PicoSerialClient.py) with the credentials from config.json.
    * Renames and deploys PicoSerialClient.py as main.py for auto-execution on Pico restart.
    * Deploys [`PicoSerialClient.py`](./src/PicoSerialClient.py) to the most recently connected Pico only.

* **Wanna check out the commands log?**
    ```
    tail -f /tmp/smart_home.log
    ```

## Visual Overview
* Checkout [detailed diagram](img/2.jpg).
    ![block diagram](img/1.jpg)

    [![Watch the video](img/4.GIF)](https://youtu.be/M36LoMouvPg)

## Credits
Special thanks to [Medical Informatics Engineering](https://www.mieweb.com/) for their support throughout the development of this project, especially to [Doug Horner](https://github.com/horner) for his invaluable guidance.
