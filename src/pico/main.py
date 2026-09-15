import network
import socket
import time
import json
from machine import UART, Pin, WDT
from net_util import safe_decode, Backoff, HeartbeatMonitor, is_heartbeat_reply

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

# Hardware watchdog: if the main loop ever stops calling wdt.feed() -- a true
# hang that no try/except can catch, e.g. blocked forever inside a driver call
# -- the RP2040 resets itself instead of staying dark until someone notices.
# 8388 ms is the RP2040 watchdog's own maximum; there is no larger timeout to
# ask for. wdt.feed() is called once per iteration of the inner loop below,
# which sleeps at most 0.05s per pass, so a live board feeds it constantly.
WATCHDOG_TIMEOUT_MS = 8388
wdt = WDT(timeout=WATCHDOG_TIMEOUT_MS)

def blink_led():
    led.off()
    time.sleep(0.1)
    led.on()
    time.sleep(0.1)

# Connect to Wi-Fi. wdt.feed() here too: on a very slow join, the loop below
# would otherwise not run for long enough to feed the watchdog in time.
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
print(f"[WiFi] Connecting to SSID: {WIFI_SSID}")
wlan.connect(WIFI_SSID, WIFI_PASSWORD)
wifi_attempts = 0
while not wlan.isconnected():
    wdt.feed()
    blink_led()
    wifi_attempts += 1
    print(f"[WiFi] Waiting for connection... attempt {wifi_attempts}")
print(f"[WiFi] Connected! IP: {wlan.ifconfig()[0]}")
led.off()

# Establish TCP connection to server. Backoff (1s, 2s, 4s ... capped at 30s)
# instead of a fixed 5s retry, so a Pi that is down for a while does not get
# hammered by every Pico in the building at once.
tcp_backoff = Backoff(base=1, cap=30)

def create_tcp_connection():
    attempt = 1
    while True:
        wdt.feed()
        try:
            print(f"[TCP] Connecting to {IP_ADDRESS}:{TCP_PORT} (attempt {attempt})")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect((IP_ADDRESS, TCP_PORT))
            sock.settimeout(None)
            led.on()
            print("[TCP] Connected successfully")
            tcp_backoff.reset()
            return sock
        except Exception as e:
            print(f"[TCP] Connection failed: {e}")
            try: sock.close()
            except: pass
            delay = tcp_backoff.next()
            print(f"[TCP] Retrying in {delay} second(s)...")
            time.sleep(delay)
            attempt += 1

# Send hello identification message
def send_hello_packet(sock):
    msg = f'pico_{PICO_ID}'
    print(f"[TCP] Sending hello: {msg}")
    sock.send(msg.encode())

HEARTBEAT_INTERVAL = 10   # seconds between PINGs
HEARTBEAT_TIMEOUT = 5     # seconds to wait for one PONG (was 2, too tight for this wifi)
HEARTBEAT_MAX_MISSES = 3  # consecutive misses before we call the connection dead
last_heartbeat = 0

while True:
    s = create_tcp_connection()
    send_hello_packet(s)
    last_heartbeat = time.time()
    heartbeat = HeartbeatMonitor(HEARTBEAT_MAX_MISSES)

    try:
        while True:
            now = time.time()

            wdt.feed()

            # Read from UART. safe_decode never raises on a malformed byte --
            # it swaps it for U+FFFD and keeps the rest of the line -- so one
            # noisy byte from the serial device can no longer end the loop
            # (issue #19: "invalid UTF-8 doesn't disconnect").
            if uart1.any():
                try:
                    rxed = safe_decode(uart1.read()).rstrip()
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
                    cmd = safe_decode(data)
                    if is_heartbeat_reply(cmd):
                        # A PONG that arrived after its PING timed out. It is
                        # protocol traffic, not something the serial device
                        # said, so it must not be written to the UART.
                        print("[TCP] Late PONG, ignoring")
                        heartbeat.pong()
                    else:
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

            # Send heartbeat ping. A lost PONG is not a lost connection: this
            # wifi drops packets, and dropping the socket on the first miss
            # made the board reconnect every ~40s all day.
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                last_heartbeat = now
                pong = None
                err = None
                try:
                    s.send(b'PING')
                    print("[TCP] Sent heartbeat: PING")
                    s.settimeout(HEARTBEAT_TIMEOUT)
                    wdt.feed()   # the recv below can block for HEARTBEAT_TIMEOUT
                    pong = s.recv(64)
                except Exception as e:
                    err = e
                finally:
                    s.settimeout(None)

                if pong == b'':
                    # Not a lost packet: the server really did hang up.
                    print("[TCP] Server closed the connection during heartbeat")
                    raise OSError('server closed the connection')

                reply = safe_decode(pong).strip() if pong else ''
                if err is None and is_heartbeat_reply(reply):
                    heartbeat.pong()
                    print(f"[TCP] Heartbeat response: '{reply}'")
                else:
                    reason = err if err is not None else f"unexpected reply '{reply}'"
                    if heartbeat.missed():
                        print(f"[TCP] Heartbeat missed {heartbeat.misses} times in a row, reconnecting: {reason}")
                        raise OSError('heartbeat lost')
                    print(f"[TCP] Heartbeat missed {heartbeat.misses}/{HEARTBEAT_MAX_MISSES}, keeping the connection: {reason}")

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
