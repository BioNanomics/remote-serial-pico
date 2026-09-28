#!/usr/bin/env python3
"""Run the real src/pico/main.py on a desktop against a real TCP server.

Used by src/pi/firmware.sim.test.js. Not used on a board.

Builds what the deployer would put on a Pico -- main.py, net_util.py,
frame.py and a config.json pointing at --host/--port -- in a temporary
directory, swaps in desktop stand-ins for the `machine` and `network`
modules, and executes main.py there. socket, select, time and json are the
real CPython modules, which is the point: the relay loop, the framing and
the reconnect logic run unmodified.

    python3 tools/pico_sim/run_main.py --host 127.0.0.1 --port 50000 --id e6614103e71d2c2f

Talk to the fake UART over stdin/stdout, see machine.py.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PICO_SRC = os.path.normpath(os.path.join(HERE, '..', '..', 'src', 'pico'))
FILES = ('main.py', 'net_util.py', 'frame.py')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--id', default='e6614103e71d2c2f')
    ap.add_argument('--src', default=PICO_SRC, help='directory holding main.py and friends')
    args = ap.parse_args()

    sys.stdout.reconfigure(line_buffering=True)

    board = tempfile.mkdtemp(prefix='pico-sim-')
    for name in FILES:
        shutil.copy(os.path.join(args.src, name), board)
    with open(os.path.join(board, 'config.json'), 'w') as fh:
        json.dump({'WIFI_SSID': 'sim', 'WIFI_PASSWORD': 'sim', 'IP_ADDRESS': args.host,
                   'PORT': args.port, 'PICO_ID': args.id}, fh)

    # The stand-ins must shadow any real module of the same name, and main.py
    # must import net_util/frame from the "board", exactly as on hardware.
    sys.path.insert(0, HERE)
    sys.path.insert(0, board)
    os.chdir(board)
    print('SIM board=%s server=%s:%d' % (board, args.host, args.port))

    try:
        with open('main.py') as fh:
            code = compile(fh.read(), 'main.py', 'exec')
        exec(code, {'__name__': '__main__', '__file__': 'main.py'})
    finally:
        shutil.rmtree(board, ignore_errors=True)


if __name__ == '__main__':
    main()
