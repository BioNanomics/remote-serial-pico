# boot.py -- runs before main.py on every start. Issue #19 Phase F.
#
# This is the recovery path for firmware updates, which is why it is
# deliberately small, imports nothing from the rest of the firmware, and is
# never itself updated over the air: only plugging the board into the Pi
# replaces it. A bad update can break main.py and everything it imports; it
# cannot break this.
#
# update.py swaps new firmware in and leaves update.json behind, listing the
# files it replaced (each old one kept as <name>.bak). The new firmware deletes
# update.json once it has registered with the Pi. Until then every start is
# counted here, and a watchdog is armed before main.py gets control, so new
# firmware that hangs, crashes to the REPL or fails to import still ends in a
# reset. After MAX_BOOTS starts without a registration the old files are put
# back.
#
# Nothing here may raise: a broken boot.py is the one thing an update cannot
# fix.

MARKER = 'update.json'
BACKUP = '.bak'
MAX_BOOTS = 3


def _check():
    import json
    import os
    try:
        with open(MARKER) as fh:
            marker = json.load(fh)
        files = marker.get('files')
        boots = marker.get('boots', 0)
    except Exception:
        return                      # no update in progress (or nothing readable)
    if not isinstance(files, list) or not files or not isinstance(boots, int):
        return                      # a fresh USB deploy leaves an empty marker

    if boots >= MAX_BOOTS:
        print('[BOOT] New firmware did not register in %d starts; restoring the previous firmware' % boots)
        for name in files:
            try:
                os.stat(name + BACKUP)
            except Exception:
                continue            # this file had no predecessor
            try:
                os.remove(name)
            except Exception:
                pass
            try:
                os.rename(name + BACKUP, name)
            except Exception as err:
                print('[BOOT] Could not restore %s: %s' % (name, err))
        try:
            os.remove(MARKER)
        except Exception:
            pass
        print('[BOOT] Previous firmware restored')
        return

    marker['boots'] = boots + 1
    try:
        with open(MARKER + '.tmp', 'w') as fh:
            json.dump(marker, fh)
        os.rename(MARKER + '.tmp', MARKER)
    except Exception as err:
        print('[BOOT] Could not count this start: %s' % (err,))
    print('[BOOT] New firmware on trial, start %d of %d' % (boots + 1, MAX_BOOTS))
    try:
        import machine
        machine.WDT(timeout=8388)   # if main.py never gets going, reset and try again
    except Exception as err:
        print('[BOOT] Could not arm the watchdog: %s' % (err,))


try:
    _check()
except Exception as _err:
    print('[BOOT] %s' % (_err,))
