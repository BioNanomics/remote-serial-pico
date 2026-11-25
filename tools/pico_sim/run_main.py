#!/usr/bin/env python3
"""Run the real src/pico/main.py on a desktop against a real TCP server.

Used by src/pi/firmware.sim.test.js. Not used on a board.

Builds what the deployer would put on a Pico -- every file firmware.json
names and a config.json pointing at --host/--port -- in a temporary
directory, swaps in desktop stand-ins for the `machine` and `network`
modules, and executes main.py there. socket, select, time and json are the
real CPython modules, which is the point: the relay loop, the framing and
the reconnect logic run unmodified.

    python3 tools/pico_sim/run_main.py --host 127.0.0.1 --port 50000 --id e6614103e71d2c2f

Talk to the fake UART over stdin/stdout, see machine.py.

A reset normally ends the run (exit code 4, or 3 for a watchdog reset). With
--reboot the board is powered on again with its files intact, boot.py first,
which is what lets a firmware update be followed through its restart and, if
the new firmware is broken, through boot.py restoring the old one.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PICO_SRC = os.path.normpath(os.path.join(HERE, '..', '..', 'src', 'pico'))


def run_board(board):
    """One power-on of the board in `board`: boot.py, then main.py, the order
    MicroPython runs them in. Ends by os._exit from the machine stand-in (a
    reset is 4, a watchdog reset is 3) or by main.py raising."""
    # The stand-ins must shadow any real module of the same name, and main.py
    # must import net_util/frame from the "board", exactly as on hardware.
    sys.path.insert(0, HERE)
    sys.path.insert(0, board)
    os.chdir(board)
    import machine
    try:
        for script in ('boot.py', 'main.py'):
            if not os.path.exists(script):
                continue
            with open(script) as fh:
                code = compile(fh.read(), script, 'exec')
            exec(code, {'__name__': '__main__', '__file__': script})
    except BaseException as err:
        if isinstance(err, SystemExit):
            raise
        import traceback
        traceback.print_exc()
        sys.stderr.flush()
        if machine.wdt_armed:
            # A real board would now sit at the REPL, nobody would feed the
            # watchdog, and it would reset.
            print('WDT-RESET main.py crashed and the armed watchdog reset the board')
            sys.stdout.flush()
            os._exit(3)
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int)
    ap.add_argument('--id', default='e6614103e71d2c2f')
    ap.add_argument('--src', default=PICO_SRC, help='directory holding main.py and friends')
    ap.add_argument('--key', default=None, help='device key, 64 hex characters; omit for an unprovisioned board')
    ap.add_argument('--reboot', action='store_true',
                    help='power the board back on after a reset, keeping its files, like real hardware '
                         '(needed to follow a firmware update through its restart)')
    ap.add_argument('--board', default=None, help=argparse.SUPPRESS)   # internal: one power-on of an existing board
    args = ap.parse_args()

    sys.stdout.reconfigure(line_buffering=True)

    if args.board:
        return run_board(args.board)
    if args.port is None:
        ap.error('--port is required')

    # What the deployer puts on a Pico: the firmware, boot.py, a config.json
    # and an empty update marker.
    board = tempfile.mkdtemp(prefix='pico-sim-')
    with open(os.path.join(args.src, 'firmware.json')) as fh:
        manifest = json.load(fh)
    for name in ['firmware.json'] + manifest['files'] + manifest.get('usb_only', []):
        shutil.copy(os.path.join(args.src, name), board)
    config = {'WIFI_SSID': 'sim', 'WIFI_PASSWORD': 'sim', 'IP_ADDRESS': args.host,
              'PORT': args.port, 'PICO_ID': args.id}
    if args.key:
        config['KEY'] = args.key
    with open(os.path.join(board, 'config.json'), 'w') as fh:
        json.dump(config, fh)
    with open(os.path.join(board, 'update.json'), 'w') as fh:
        json.dump({'files': [], 'boots': 0}, fh)
    print('SIM board=%s server=%s:%d' % (board, args.host, args.port))

    try:
        if not args.reboot:
            return run_board(board)
        import subprocess
        for power_on in range(1, 21):
            code = subprocess.call([sys.executable, '-u', os.path.abspath(__file__), '--board', board])
            if code not in (3, 4):          # anything but a reset: the board is done
                sys.exit(code)
            print('SIM-REBOOT %d' % power_on)
        sys.exit(5)                          # a board that resets twenty times is a boot loop
    finally:
        if not os.environ.get('PICO_SIM_KEEP'):
            shutil.rmtree(board, ignore_errors=True)


if __name__ == '__main__':
    main()
