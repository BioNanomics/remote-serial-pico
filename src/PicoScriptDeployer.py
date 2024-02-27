#!/usr/bin/python3
import datetime
import os
import subprocess
import sys
import socket
import json

# Define the base directory for the project
BASE_DIR = '/home/project/RemoteSerialPico/src/'

def log_message(message):
    with open('/tmp/udev_test.log', 'a') as log_file:
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
    config_path = f'/etc/NetworkManager/system-connections/{ssid}.nmconnection' if ssid else None
    psk = None  # Initialize psk to None.
    if config_path and os.path.exists(config_path):
        with open(config_path, 'r') as file:
            # Search for the psk line within the connection file.
            for line in file:
                if 'psk=' in line:
                    psk = line.split('=')[1].strip()
                    break  # Break after finding the psk to avoid unnecessary processing.
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
def load_or_initialize_config(config_path):
    default_config = {
        'WIFI_SSID': 'your_wifi_ssid',
        'WIFI_PASSWORD': 'your_wifi_password',
        'IP_ADDRESS': 'your_ip_address',
        'PICO_ID': '1'
    }
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as file:
                return json.load(file)
        except json.JSONDecodeError:
            return default_config
    else:
        return default_config

# Update or create config.json with current network settings and PICO_ID.
def update_config_json(pico_serial_id):
    ssid, wifi_password = get_wifi_ssid_pswd(get_wifi_ssid())
    ip_address = get_ip_address()

    # Path to the configuration file.
    config_path = os.path.join(BASE_DIR, 'config.json')
    config_data = load_or_initialize_config(config_path)

    password_flg = False

    if ssid:
        config_data['WIFI_SSID'] = ssid

    if wifi_password:
        config_data['WIFI_PASSWORD'] = wifi_password
        password_flg = True

    if ip_address:
        config_data['IP_ADDRESS'] = ip_address

    config_data['PICO_ID'] = str(pico_serial_id)

    if not password_flg:
        log_message(f'Unable to obtain Wi-Fi password. Manually update it on config.json')

    with open(config_path, 'w') as file:
        json.dump(config_data, file, indent=4)

# Read the configuration from config.json and update the script with these settings.
def read_config_and_update_main():
    config_path = os.path.join(BASE_DIR, 'config.json')
    # Load the configuration, falling back to defaults if the file doesn't exist.
    if os.path.exists(config_path):
        with open(config_path, 'r') as file:
            config_data = json.load(file)
    else:
        config_data = {}

    # Open the script file and prepare to update it with configuration values.
    main_file_path = os.path.join(BASE_DIR, 'PicoSerialClient.py')
    with open(main_file_path, 'r') as main_file:
        main_lines = main_file.readlines()

    # Update the script lines with configuration values.
    main_lines[6] = f"WIFI_SSID = '{config_data.get('WIFI_SSID', '')}'\n"
    main_lines[7] = f"WIFI_PASSWORD = '{config_data.get('WIFI_PASSWORD', '')}'\n"
    main_lines[10] = f"IP_ADDRESS = '{config_data.get('IP_ADDRESS', '127.0.0.1')}'\n"
    main_lines[14] = f"PICO_ID = '{config_data.get('PICO_ID', '1')}'\n"

    # Write the updated lines back to the script file.
    with open(main_file_path, 'w') as main_file:
        main_file.writelines(main_lines)

# Transfer the prepared script to the connected Pico.
def transfer_script_to_pico(port):
    source_path = os.path.join(BASE_DIR, 'PicoSerialClient.py')
    destination_path = os.path.join(BASE_DIR, 'main.py')
    os.rename(source_path, destination_path)

    # Attempt to transfer using rshell with the explicit path to the virtualenv's rshell
    try:
        subprocess.check_call(['/home/project/myenv/bin/rshell', '-p', port, f'cp {destination_path} /pyboard'])
    except subprocess.CalledProcessError as e:
        log_message(f'Error during transfer: {str(e)}')
    finally:
        os.rename(destination_path, source_path)
        log_message(f'Script deployed :) Time: {datetime.datetime.now()}')

def main():
    devname = sys.argv[1]
    # id_vendor_id = sys.argv[2]
    # id_model_id = sys.argv[3]
    pico_serial_id = sys.argv[4]
    
    log_message(f'Pico detected; Port: {devname}, Serial_ID: {pico_serial_id}, Time: {datetime.datetime.now()}')
    update_config_json(pico_serial_id)
    read_config_and_update_main()
    transfer_script_to_pico(devname)

if __name__ == "__main__":
    main()