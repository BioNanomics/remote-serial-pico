# About
`pico-network-serial-port` is designed to bridge TCP communication with UART controllers using a Raspberry Pi Pico-W. This project facilitates seamless data transmission from TCP networks to UART-compatible devices. Ideal for IoT applications, this repository provides a robust framework for developers looking to connect network protocols with serial communication devices. This project serves as the second part, completing the [homebridge-tcp-smarthome](https://github.com/RajkumarGara/homebridge-tcp-smarthome) and [node-red-bridge](https://github.com/RajkumarGara/node-red-bridge) projects.

## Running the setup
Two ways to run this code:
1. Connect your Pico-W to the Raspberry Pi or laptop and manually run [`main.py`](./main.py) in thonny (follow the steps in [get-started-pico-w](https://projects.raspberrypi.org/en/projects/get-started-pico-w/1)), make sure to initialize the `WIFI_SSID`, `WIFI_PASSWORD`, `IP_ADDRESS` with the exact credentials on lines 7, 8, 11 before running the code.

2. Use [PicoScriptDeployer](https://github.com/RajkumarGara/PicoScriptDeployer) to update the Wi-Fi credentials in [`main.py`](./main.py) and deploy the code.
 
## Visual Overview
Connect either LMDI-100 or Mechonet to the Pico-W as shown below.
![pico](img/1.jpg)