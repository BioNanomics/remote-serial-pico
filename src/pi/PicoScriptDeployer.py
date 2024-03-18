#!/usr/bin/python3
import datetime
import os
import subprocess
import sys
import socket
import json

PICO_MAIN_PATH = '/home/project/remote-serial-pico/src/pico/main.py'
PICO_CONFIG_PATH = '/home/project/remote-serial-pico/src/pico/config.json'

TCP_PORT = 50000

def log_message(message):
    with open('/tmp/deployer.log', 'a') as log_file:
        log_file.write(f'{message}\n')

# Fetch the SSID of the currently active WiFi connection using nmcli command.
def get_wifi_ssid():
    try:
        # Execute to get the active SSID
        ssid = subprocess.check_output("iwgetid -r", shell=True).decode().strip()
    except subprocess.CalledProcessError:
        ssid = None  # None signifies an error or no active connection.
    return ssid

# Retrieve WiFi credentials for a given SSID from the system's network manager.
def get_wifi_ssid_pswd(ssid):
    cred_path1 = f'/etc/NetworkManager/system-connections/{ssid}.nmconnection' if ssid else None
    cred_path2 = '/etc/NetworkManager/system-connections/preconfigured.nmconnection'
    
    # Function to extract psk from a given credential path
    def extract_psk(cred_path):
        if cred_path and os.path.exists(cred_path):
            with open(cred_path, 'r') as file:
                for line in file:
                    if 'psk=' in line:
                        return line.split('=')[1].strip()
        return None
    
    psk = extract_psk(cred_path1)
    # If PSK not found in the first path, try the second
    if psk is None:
        psk = extract_psk(cred_path2)
    return ssid, psk

# Determine the external IP address of the Raspberry Pi.
def get_ip_address():
    try:
        # Use a socket connection to a public DNS to fetch the external IP address.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        IP = s.getsockname()[0]
    except Exception:
        IP = None  # None signifies an error or inability to determine the IP.
    finally:
        s.close()
    return IP

# load default config if the json file is invalid 
def load_or_initialize_config():
    default_config = {
        'WIFI_SSID': 'your_wifi_ssid',
        'WIFI_PASSWORD': 'your_wifi_password',
        'IP_ADDRESS': 'your_ip_address',
        'PORT': TCP_PORT,
        'PICO_ID': '1'
    }
    if os.path.exists(PICO_CONFIG_PATH):
        try:
            with open(PICO_CONFIG_PATH, 'r') as file:
                return json.load(file)
        except json.JSONDecodeError:
            return default_config
    else:
        return default_config

# Update or create config.json with current network settings and PICO_ID.
def update_config_json(pico_serial_id):
    ssid, wifi_password = get_wifi_ssid_pswd(get_wifi_ssid())
    ip_address = get_ip_address()

    config_data = load_or_initialize_config()

    if ssid:
        config_data['WIFI_SSID'] = ssid

    if wifi_password:
        config_data['WIFI_PASSWORD'] = wifi_password

    if ip_address:
        config_data['IP_ADDRESS'] = ip_address

    config_data['PORT'] = TCP_PORT
    config_data['PICO_ID'] = str(pico_serial_id)

    with open(PICO_CONFIG_PATH, 'w') as file:
        json.dump(config_data, file, indent=4)

# Transfer the prepared script to the connected Pico.
def transfer_script_to_pico(port):
    # Transfer main.py, config.json to the pico using rshell
    try:
        subprocess.check_call(['/home/project/myenv/bin/rshell', '-p', port, 'cp', PICO_MAIN_PATH, PICO_CONFIG_PATH, '/pyboard/'])
    except subprocess.CalledProcessError as e:
        log_message(f'Error during transfer: {str(e)}')
    finally:
        log_message(f'{datetime.datetime.now()} Pico Scripts deployed :)')

def main():
    devname = sys.argv[1]
    # id_vendor_id = sys.argv[2]
    # id_model_id = sys.argv[3]
    pico_serial_id = sys.argv[4]
    
    log_message(f'{datetime.datetime.now()} Pico detected - Port: {devname}, ID: {pico_serial_id}')
    update_config_json(pico_serial_id)
    transfer_script_to_pico(devname)

if __name__ == "__main__":
    main()