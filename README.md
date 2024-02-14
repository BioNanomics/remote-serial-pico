# About
`pico-network-serial-port` is designed to bridge TCP communication with UART controllers using a Raspberry Pi Pico-W. This project facilitates seamless data transmission from TCP networks to UART-compatible devices. Ideal for IoT applications, this repository provides a robust framework for developers looking to connect network protocols with serial communication devices. This project serves as the second part, completing the [homebridge-tcp-smarthome](https://github.com/RajkumarGara/homebridge-tcp-smarthome) and [node-red-bridge](https://github.com/RajkumarGara/node-red-bridge) projects.

## Running the setup
* Run `PicoFileServer.py` on Raspberry Pi
    ```bash
    node PicoFileServer.py
    ```
* Follow any one of the two steps to run `main.py` on Pico-W:
    1. Connect your Pico-W to the Raspberry Pi or laptop and manually run [`main.py`](./main.py) in thonny (follow the steps in [get-started-pico-w](https://projects.raspberrypi.org/en/projects/get-started-pico-w/1)), make sure to initialize the `WIFI_SSID`, `WIFI_PASSWORD`, `IP_ADDRESS` with the exact credentials on lines 7, 8, 11 before running the code.
    2. Use [PicoScriptDeployer](https://github.com/RajkumarGara/PicoScriptDeployer) to update the Wi-Fi credentials in [`main.py`](./main.py) and deploy the code subsequently.
 
## PicoFileServer features
1. **Pico Identification and File Management:** Automatically identifies Pico clients upon connection using a specific identifier format (pico_{number}), creating distinct command and response files for each.
2. **Command Dispatching:** Watches for changes in command files, sending new commands to the respective Pico, and clears the file post-send to ready it for next commands.
3. **Response Logging:** Records data received from Picos into their dedicated response files, facilitating external access to Pico responses.
4. **Debounce Mechanism:** Implements a debounce strategy to prevent duplicate command processing and transmission due to rapid file modifications.
5. **Cleanup on Disconnection:** Cleans up resources by closing connections, stopping file watchers, and deleting Pico-specific files upon disconnection.

## Visual Overview
Connect either LMDI-100 or Mechonet to the Pico-W as shown below.
![pico](img/1.jpg)

## Credits
Special thanks to [Medical Informatics Engineering](https://www.mieweb.com/) for their support throughout the development of this project, especially to [Doug Horner](https://github.com/horner) for his invaluable guidance.