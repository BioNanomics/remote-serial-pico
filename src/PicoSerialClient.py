import network
import socket
import time
from machine import UART, Pin

# Network credentials
WIFI_SSID = 'your_wifi_ssid'
WIFI_PASSWORD = 'your_wifi_password'

# Server details
IP_ADDRESS = 'your_device_ip_address'
TCP_PORT = 50000

# Pico identification number
PICO_ID = 1  

# Initialize UART and LED
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
wlan.connect(WIFI_SSID, WIFI_PASSWORD)

while not wlan.isconnected():
    blink_led()

led.off()
print("Connected to WiFi")

# Establish a new TCP connection
def create_tcp_connection():
    while True:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.connect((IP_ADDRESS, TCP_PORT))
            led.on()
            return sock
        
        except Exception as e:
            print(f"Failed to connect to TCP server: {e}")
            print("Retrying in 5 seconds...")
            time.sleep(5)

# 'pico_ID' packet to initiate named pipe creation
def send_hello_packet(sock):
    hello_message = f'pico_{PICO_ID}'
    sock.send(hello_message.encode())

# Create initial TCP socket and connect
s = create_tcp_connection()
print("Connected to TCP server")

# Send 'pico_ID' packet
send_hello_packet(s)

try:
    while True:
        # Check for incoming UART data
        if uart1.any():
            rxed = uart1.read().decode('utf-8').rstrip()
            s.send(rxed.encode()) # Send the uart received data to the TCP server
            blink_led()
            #print("Serial: ", rxed)

        # Non-blocking mode to avoid halting the execution if no data is available.
        s.setblocking(False)
        try:
            data = s.recv(64) # Data received from TCP Server

            if data == b'':  # Empty byte string indicates that the other side of the TCP connection has closed
                s.close()  # Closes the socket on Pico-W's side      
                led.off()
                print("TCP connection closed by server. Reconnecting...")
                s = create_tcp_connection()
                send_hello_packet(s)
                print("Reconnected to server.")
                continue

            if data:	# Valid data received from TCP Server
                cmd = data.decode()
                blink_led()
                #print("TCP: ", cmd)

        except Exception as e:
            pass  # No data received, normal for non-blocking call

        # Set blocking mode to block until all the data has been sent to the TCP server 
        s.setblocking(True)
        time.sleep(0.05)  # Short delay to prevent CPU overload

except Exception as e:
    print("An error occurred:", e)
    
finally:
    s.close()
    led.off()
    print("TCP socket closed")