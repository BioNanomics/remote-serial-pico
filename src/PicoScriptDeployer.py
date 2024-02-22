import os
import subprocess
import sys
import time
import serial.tools.list_ports
import socket
import shutil
import json

# Check if the script is run with root privileges, necessary for certain operations.
def is_root_user():
    return os.geteuid() == 0

# Fetch the SSID of the currently active WiFi connection using nmcli command.
def get_wifi_ssid():
    try:
        # Execute nmcli to get the active SSID, handling errors if the command fails.
        ssid = subprocess.check_output("nmcli -t -f active,ssid dev wifi | grep yes: | cut -d ':' -f2", shell=True).decode().strip()
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

# Update or create config.json with current network settings and PICO_ID.
def update_config_json():
    ssid, wifi_password = get_wifi_ssid_pswd(get_wifi_ssid())
    ip_address = get_ip_address()
    
    # Path to the configuration file.
    config_path = 'config.json'
    # Default configuration structure.
    config_data = {
        'WIFI_SSID': ssid if ssid else 'your_wifi_ssid',
        'WIFI_PASSWORD': wifi_password if wifi_password else 'your_wifi_password',
        'IP_ADDRESS': ip_address if ip_address else 'your_ip_address',
        'PICO_ID': '1'
    }
    
    # Load existing configuration if available, to preserve other settings.
    if os.path.exists(config_path):
        with open(config_path, 'r') as file:
            try:
                existing_data = json.load(file)
                config_data.update(existing_data)  # Merge the new data with existing.
            except json.JSONDecodeError:
                # If the existing file is not valid JSON, it's ignored.
                pass
    
    # Write the merged or default configuration back to the file.
    with open(config_path, 'w') as file:
        json.dump(config_data, file, indent=4)

# Detect all connected Raspberry Pi Picos by their USB IDs.
def get_connected_picos():
    pico_vid = 0x2E8A  # Vendor ID for Raspberry Pi Pico.
    pico_pid = 0x0005  # Product ID for Raspberry Pi Pico.
    # List connected devices that match the Pico's USB IDs.
    return [port.device for port in serial.tools.list_ports.comports() if port.vid == pico_vid and port.pid == pico_pid]

# Read the configuration from config.json and update the script with these settings.
def read_config_and_update_main():
    config_path = 'config.json'
    # Load the configuration, falling back to defaults if the file doesn't exist.
    if os.path.exists(config_path):
        with open(config_path, 'r') as file:
            config_data = json.load(file)
    else:
        config_data = {}

    # Open the script file and prepare to update it with configuration values.
    with open('PicoSerialClient.py', 'r') as main_file:
        main_lines = main_file.readlines()

    # Update the script lines with configuration values.
    main_lines[6] = f"WIFI_SSID = '{config_data.get('WIFI_SSID', '')}'\n"
    main_lines[7] = f"WIFI_PASSWORD = '{config_data.get('WIFI_PASSWORD', '')}'\n"
    main_lines[10] = f"IP_ADDRESS = '{config_data.get('IP_ADDRESS', '127.0.0.1')}'\n"
    main_lines[14] = f"PICO_ID = {config_data.get('PICO_ID', '1')}\n"

    # Write the updated lines back to the script file.
    with open('PicoSerialClient.py', 'w') as main_file:
        main_file.writelines(main_lines)
    print("PicoSerialClient.py is updated with the WiFi credentials and PICO_ID from config.json")

# Prepare the script for transfer to the Pico by creating a copy named main.py.
def prepare_script_for_transfer():
    if os.path.exists('PicoSerialClient.py'):
        shutil.copy('PicoSerialClient.py', 'main.py')
        print("PicoSerialClient.py has been copied to main.py for transfer.")
    else:
        print("PicoSerialClient.py does not exist, skipping preparation.")

# Transfer the prepared script to the connected Pico.
def transfer_script_to_pico(port):
    prepare_script_for_transfer()
    # Use rshell to copy the script to the Pico.
    os.system(f'rshell -p {port} "cp main.py /pyboard"')
    os.remove('main.py')  # Clean up the temporary file.

# Perform a soft reset on the Pico to restart it with the new script.
def reset_pico(port):
    os.system(f'rshell -p {port} repl "~ import machine ~ machine.reset() ~"')

def main():
    if not is_root_user():
        print("Restarting script with sudo for Wi-Fi credentials.")
        subprocess.check_call(["sudo", sys.executable] + sys.argv)
    else:
        update_config_json()  # Ensure the configuration file is current.
        print("Config.json updated or created with default values if empty.")
        known_picos = set()

        # Continuously check for new Pico connections and update them.
        while True:
            current_connected_picos = set(get_connected_picos())
            new_picos = current_connected_picos - known_picos

            for pico_port in new_picos:
                print(f"Pico detected at {pico_port}.")
                read_config_and_update_main()
                print("Transferring the main.py script.")
                transfer_script_to_pico(pico_port)
                print("Script transferred. Resetting Pico to run the new script.")
                reset_pico(pico_port)

            known_picos = current_connected_picos
            time.sleep(5)  # Wait before checking for new connections again.

if __name__ == "__main__":
    main()
