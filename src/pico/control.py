"""Control commands (issue #19 Phase E). The contract is docs/protocol.md,
"Control channel".

A CONTROL_REQUEST only ever arrives inside an authenticated session, so every
command here comes from the Pi that holds this board's key. Nothing in this
file touches hardware: main.py passes in a `board` object that does, which is
what lets the commands be tested on a desktop.

Must stay importable on a Pico W: stdlib only, no type hints, no f-strings.
"""

UART_DEFAULTS = {'baud': 19200, 'bits': 8, 'parity': None, 'stop': 1}

BAUD_MIN = 300
BAUD_MAX = 921600
IDENTIFY_DEFAULT = 10     # seconds
IDENTIFY_MAX = 300

_PARITY = {None: None, 'N': None, 'n': None, 'none': None,
           0: 0, 'E': 0, 'e': 0, 'even': 0,
           1: 1, 'O': 1, 'o': 1, 'odd': 1}


def uart_settings(args, base=None):
    """Merge `args` over `base` and check every value. Returns a new dict with
    baud, bits, parity (None, 0 = even, 1 = odd) and stop. Raises ValueError
    with a message fit to send back to the operator."""
    out = dict(UART_DEFAULTS)
    if base:
        for key in UART_DEFAULTS:
            if key in base:
                out[key] = base[key]
    args = args or {}
    for key in ('baud', 'bits', 'stop'):
        if key in args and args[key] is not None:
            if isinstance(args[key], bool) or not isinstance(args[key], int):
                raise ValueError('%s must be a whole number' % key)
            out[key] = args[key]
    if 'parity' in args:
        p = args['parity']
        if isinstance(p, bool) or p not in _PARITY:
            raise ValueError('parity must be N, E or O')
        out['parity'] = _PARITY[p]
    elif out['parity'] not in (None, 0, 1):
        out['parity'] = _PARITY.get(out['parity'])
    if not BAUD_MIN <= out['baud'] <= BAUD_MAX:
        raise ValueError('baud must be between %d and %d' % (BAUD_MIN, BAUD_MAX))
    if out['bits'] not in (7, 8):
        raise ValueError('bits must be 7 or 8')
    if out['stop'] not in (1, 2):
        raise ValueError('stop must be 1 or 2')
    return out


def describe_uart(settings):
    """'19200 8N1' for logs and status."""
    parity = {None: 'N', 0: 'E', 1: 'O'}.get(settings.get('parity'), '?')
    return '%d %d%s%d' % (settings['baud'], settings['bits'], parity, settings['stop'])


class ControlHandler:
    """Runs one control command against a `board`, which provides:

        status() -> dict                 whatever the board can report
        apply_uart(settings)             retune the serial link now
        save_uart(settings)              write the settings where they survive a reset
        identify(seconds)                start blinking the LED
        reset_soon()                     reset once the reply has been sent

    handle() never raises: a failure comes back as (False, message).
    """

    def __init__(self, board, uart=None):
        self.board = board
        self.uart = uart_settings(None, uart)

    def handle(self, cmd, args):
        try:
            # Letters and underscores only, so a command name can never reach
            # anything but a cmd_* method.
            named = isinstance(cmd, str) and cmd.replace('_', '').isalpha()
            method = getattr(self, 'cmd_' + cmd, None) if named else None
            if method is None:
                return False, 'unknown command: %s' % (cmd,)
            if args is None:
                args = {}
            if not isinstance(args, dict):
                return False, 'args must be an object'
            return True, method(args)
        except ValueError as err:
            return False, str(err)
        except Exception as err:
            return False, 'command failed: %s' % (err,)

    def cmd_status(self, args):
        out = self.board.status()
        out['uart'] = describe_uart(self.uart)
        return out

    def cmd_reboot(self, args):
        self.board.reset_soon()
        return {'rebooting': True}

    def cmd_identify(self, args):
        seconds = args.get('seconds', IDENTIFY_DEFAULT)
        if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= IDENTIFY_MAX:
            raise ValueError('seconds must be between 1 and %d' % IDENTIFY_MAX)
        self.board.identify(seconds)
        return {'blinking_for': seconds}

    def cmd_uart_set(self, args):
        """Session-only unless save is true: a wrong baud rate is then undone
        by a power cycle, not by a visit with a USB cable."""
        new = uart_settings(args, self.uart)
        save = args.get('save', False)
        if not isinstance(save, bool):
            raise ValueError('save must be true or false')
        self.board.apply_uart(new)
        self.uart = new
        if save:
            self.board.save_uart(new)
        return {'uart': describe_uart(new), 'saved': save}
