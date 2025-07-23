import network
import socket
import time
import json
from machine import UART, Pin

# Load network configuration
def read_config():
    with open('config.json', 'r') as f:
        return json.load(f)

config = read_config()
WIFI_SSID     = config['WIFI_SSID']
WIFI_PASSWORD = config['WIFI_PASSWORD']
IP_ADDRESS    = config['IP_ADDRESS']
TCP_PORT      = config['PORT']
PICO_ID       = config['PICO_ID']

# Initialize UART and onboard LED
uart1 = UART(1, 19200)
uart1.init(19200, bits=8, parity=None, stop=1, tx=4, rx=5)
led = Pin("LED", Pin.OUT)

def blink_led():
    led.off()
    time.sleep(0.1)
    led.on()
    time.sleep(0.1)

# Connect to Wi-Fi
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
print(f"[WiFi] Connecting to SSID: {WIFI_SSID}")
wlan.connect(WIFI_SSID, WIFI_PASSWORD)
wifi_attempts = 0
while not wlan.isconnected():
    blink_led()
    wifi_attempts += 1
    print(f"[WiFi] Waiting for connection... attempt {wifi_attempts}")
print(f"[WiFi] Connected! IP: {wlan.ifconfig()[0]}")
led.off()

# Establish TCP connection to server
def create_tcp_connection():
    attempt = 1
    while True:
        try:
            print(f"[TCP] Connecting to {IP_ADDRESS}:{TCP_PORT} (attempt {attempt})")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect((IP_ADDRESS, TCP_PORT))
            sock.settimeout(None)
            led.on()
            print("[TCP] Connected successfully")
            return sock
        except Exception as e:
            print(f"[TCP] Connection failed: {e}")
            try: sock.close()
            except: pass
            print("[TCP] Retrying in 5 seconds...")
            time.sleep(5)
            attempt += 1

# Send hello identification message
def send_hello_packet(sock):
    msg = f'pico_{PICO_ID}'
    print(f"[TCP] Sending hello: {msg}")
    sock.send(msg.encode())

HEARTBEAT_INTERVAL = 10  # seconds
last_heartbeat = 0

while True:
    s = create_tcp_connection()
    send_hello_packet(s)
    last_heartbeat = time.time()

    try:
        while True:
            now = time.time()

            # Read from UART
            if uart1.any():
                try:
                    rxed = uart1.read().decode('utf-8').rstrip()
                    if rxed:
                        print(f"[UART] Received: '{rxed}'")
                        s.send(rxed.encode())
                        print(f"[TCP] Sent to server: '{rxed}'")
                        blink_led()
                except Exception as e:
                    print(f"[UART] Read error: {e}")

            # Check for incoming TCP data
            s.setblocking(False)
            try:
                data = s.recv(64)
                if data == b'':
                    print("[TCP] Server closed connection.")
                    raise Exception("Server closed connection")
                if data:
                    cmd = data.decode()
                    print(f"[TCP] Command received: '{cmd}'")
                    uart1.write(cmd)
                    print(f"[UART] Sent to UART: '{cmd}'")
                    blink_led()
            except OSError as e:
                if getattr(e, 'errno', None) not in (11, 35):  # not EAGAIN/EWOULDBLOCK
                    print(f"[TCP] Recv error: {e}")
                    raise
            except Exception as e:
                print(f"[TCP] Recv exception: {e}")
                raise
            finally:
                s.setblocking(True)

            # Send heartbeat ping
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                try:
                    s.send(b'PING')
                    print("[TCP] Sent heartbeat: PING")
                    s.settimeout(2)
                    pong = s.recv(64)
                    if pong:
                        pong_msg = pong.decode().strip()
                        print(f"[TCP] Heartbeat response: '{pong_msg}'")
                        if pong_msg.upper() != "PONG":
                            raise Exception("Unexpected heartbeat response")
                    else:
                        raise Exception("No heartbeat response")
                except Exception as e:
                    print(f"[TCP] Heartbeat failed: {e}")
                    raise
                finally:
                    s.settimeout(None)
                    last_heartbeat = now

            time.sleep(0.05)

    except Exception as e:
        print(f"[MAIN] Lost connection: {e}")
        print("[MAIN] Reconnecting...")
    finally:
        try: s.close()
        except: pass
        led.off()
        print("[TCP] Socket closed.")
        print("[MAIN] Restarting connection loop in 1 second...")
        time.sleep(1)
