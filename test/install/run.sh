#!/usr/bin/env bash
# End-to-end install test for "one-command Pi setup" (issue #19, Part 1).
#
# Boots a Debian trixie container under systemd as a stand-in for a fresh
# Raspberry Pi OS Lite image, then follows the README's quick install exactly,
# using this working tree instead of the npm registry and GitHub:
#
#   apt install nodejs npm build-essential python3 python3-venv python3-pip
#   sudo npm i -g <this tree, packed>
#   sudo remote-serial-pico install          (the package is the install: no clone)
#
# and checks what the issue's acceptance criteria can check without hardware:
# install succeeds, a re-run changes nothing, doctor is green, the service is
# enabled and listening on the LAN address only, nothing is world-writable,
# everything root executes is root-owned, the key store is private, the
# MicroPython images are cached and verified, a Pico (simulated with the
# firmware's own protocol code) gets a working pty both ways, everything comes
# back after a reboot, and doctor notices when things are broken.
#
# It cannot check USB, udev events, BOOTSEL flashing, WiFi or a real board:
# that is the hardware bench test.
#
# Needs Docker. Usage:  bash test/install/run.sh      (KEEP=1 leaves the container)
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=${IMAGE:-rsp-install-test}
NAME=${NAME:-rsp-install-test}
KEEP=${KEEP:-0}
PICO_ID=c1c1c1c1c1c1c1c1
RSP_ROOT=/opt/remote-serial-pico      # the installer's default; asserted below, not assumed
SVC_USER=rspico
WORK=$(mktemp -d)

fails=0
nknown=0
pass()  { echo "PASS   $*"; }
fail()  { echo "FAIL   $*"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"; fails=$((fails + 1)); }
known() { echo "KNOWN  $*"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::$*"; nknown=$((nknown + 1)); }
step()  { echo; echo "=== $*"; }
die()   { fail "$*"; exit 1; }

# docker exec runs with umask 0000 in a systemd container; a Pi login shell
# has 0022. Use the Pi's, or every file `doctor` touches looks world-writable.
in_root() { docker exec "$NAME" sh -c 'umask 022; exec "$@"' sh "$@"; }
as_pi()   { docker exec -u pi -w /home/pi "$NAME" sh -c 'umask 022; exec "$@"' sh "$@"; }

cleanup() {
    local code=$?
    if [ "$fails" -gt 0 ] || [ "$code" -ne 0 ]; then
        step "diagnostics"
        in_root systemctl --no-pager --failed 2>/dev/null
        in_root journalctl --no-pager -u ptyserver.service -n 80 2>/dev/null
        in_root tail -n 40 "$RSP_ROOT/data/ptyserver.log" 2>/dev/null
    fi
    if [ "$KEEP" = 1 ]; then
        echo "container left running: docker exec -it $NAME bash"
    else
        docker rm -f "$NAME" >/dev/null 2>&1
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

wait_for_boot() {
    local state
    for _ in $(seq 1 90); do
        state=$(in_root systemctl is-system-running 2>/dev/null)
        case "$state" in running|degraded) return 0 ;; esac
        sleep 1
    done
    die "systemd did not finish booting (state: ${state:-unknown})"
}

expect_ok() {   # expect_ok "what" cmd...
    local what=$1; shift
    if "$@"; then pass "$what"; else fail "$what"; fi
}

# ---------------------------------------------------------------------------
step "snapshot this working tree (tracked + untracked, minus .gitignore)"
(
    cd "$ROOT" &&
    git ls-files -z -co --exclude-standard | tar --null -T - -cf - | (cd "$WORK" && mkdir src && cd src && tar -xf -)
) || die "could not snapshot the working tree"
(
    cd "$WORK/src" &&
    npm pack --silent --pack-destination "$WORK" >/dev/null
) || die "could not build the npm package"
TGZ=$(ls "$WORK"/*.tgz)
pass "package $(basename "$TGZ")"

step "boot a clean 'Pi OS' container"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || die "docker build failed"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --hostname raspberrypi --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null || die "docker run failed"
wait_for_boot
pass "systemd up ($(in_root systemctl is-system-running))"

# Not /tmp: trixie mounts a tmpfs there at boot, which hides what docker cp writes.
in_root mkdir -p /srv/ci
docker cp "$TGZ" "$NAME:/srv/ci/remote-serial-pico.tgz"
docker cp "$HERE/fake_pico.py" "$NAME:/srv/ci/fake_pico.py"

# ---------------------------------------------------------------------------
step "README quick install"
as_pi sudo apt-get update -q >/dev/null || die "apt-get update failed"
as_pi sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
    nodejs npm build-essential python3 python3-venv python3-pip >/dev/null \
    || die "README apt line failed"
pass "apt: nodejs $(in_root node --version), npm $(in_root npm --version)"

as_pi sudo npm i -g --no-audit --no-fund --loglevel=error /srv/ci/remote-serial-pico.tgz \
    || die "sudo npm i -g failed"
pass "sudo npm i -g"

# FIRMWARE_FROM=<dir with the .uf2 files> skips the download (offline runs).
INSTALL=(sudo remote-serial-pico install)
if [ -n "${FIRMWARE_FROM:-}" ]; then
    docker cp "$FIRMWARE_FROM" "$NAME:/srv/ci/firmware"
    INSTALL+=(--firmware-from /srv/ci/firmware)
fi
out=$(as_pi "${INSTALL[@]}" 2>&1); code=$?
echo "$out"
[ $code -eq 0 ] && pass "first install exits 0" || die "first install exited $code"
expect_ok "installed under the default root" in_root test -f "$RSP_ROOT/config.yaml"

step "re-run is a no-op"
out=$(as_pi sudo remote-serial-pico install 2>&1); code=$?
echo "$out"
if [ $code -eq 0 ] && grep -q 'Done. 0 change(s)' <<<"$out"; then
    pass "second install changes nothing"
else
    fail "second install was not a no-op (exit $code)"
fi

# ---------------------------------------------------------------------------
cfg() { in_root sed -n "s/^$1: *'\{0,1\}\([^']*\)'\{0,1\} *\$/\1/p" "$RSP_ROOT/config.yaml"; }
PORT=$(cfg TCP_PORT)
BIND=$(cfg BindAddress)
BIND_IP=$(in_root sh -c "ip -4 -o addr show dev '$BIND' | awk '{print \$4}' | cut -d/ -f1 | head -1")
echo "config: port $PORT, BindAddress $BIND ($BIND_IP)"

check_running() {   # check_running "label"
    expect_ok "$1: service enabled at boot" test "$(in_root systemctl is-enabled ptyserver.service)" = enabled
    expect_ok "$1: service active" test "$(in_root systemctl is-active ptyserver.service)" = active
    local listening=0
    for _ in $(seq 1 20); do
        in_root ss -H -tln | grep -q " $BIND_IP:$PORT " && { listening=1; break; }
        sleep 0.5
    done
    expect_ok "$1: listening on the LAN address $BIND_IP:$PORT" test $listening = 1
    if in_root ss -H -tln | grep -Eq " (0\.0\.0\.0|\*|\[::\]):$PORT "; then
        fail "$1: port $PORT is open on every interface"
    else
        pass "$1: not listening on every interface"
    fi
    out=$(as_pi remote-serial-pico doctor 2>&1); code=$?
    echo "$out"
    expect_ok "$1: doctor all green" test $code -eq 0
}

fake_pico() {   # fake_pico <args...>: the simulated board, as the login user
    as_pi python3 /srv/ci/fake_pico.py --src "$RSP_ROOT/app/src/pico" --link-dir "$RSP_ROOT/ports" \
        --host "$BIND_IP" --port "$PORT" "$@"
}

# What the deployer does when a board is plugged in: record its key. Appending
# as root keeps the file's owner and mode.
PICO_KEY=$(openssl rand -hex 32)
in_root sh -c "printf \"%s: '%s'\\n\" '$PICO_ID' '$PICO_KEY' >> '$RSP_ROOT/data/pico_secrets.yaml'"

relay() {   # relay "label"
    out=$(fake_pico --id "$PICO_ID" --key "$PICO_KEY" --high-bytes 2>&1); code=$?
    echo "$out"
    expect_ok "$1: simulated Pico registers and relays byte-exact both ways" test $code -eq 0
    if grep -q HIGH_BYTES_FAILED <<<"$out"; then
        known "$1: pty is not byte-transparent for 0x80-0xFF (issue #19 review, 'other issues')"
    fi
}

step "service, doctor, permissions"
expect_ok "BindAddress was detected as an interface, not left at 0.0.0.0" test -n "$BIND_IP"
check_running "after install"

expect_ok "the service runs as its own user ($SVC_USER), not as the login user" \
    test "$(in_root sh -c 'ps -o user= -p "$(systemctl show -p MainPID --value ptyserver.service)"' | tr -d ' ')" = "$SVC_USER"

ww=$(in_root find "$RSP_ROOT" /etc/systemd/system/ptyserver.service /etc/udev/rules.d \
        -xdev ! -type l -perm -0002 2>/dev/null)
if [ -z "$ww" ]; then pass "nothing the installer created is world-writable"; else fail "world-writable: $ww"; fi

# udev runs these as root, so nobody but root may be able to change them
# (issue #19 review, S2). Every file, not a sample.
not_root=$(in_root find "$RSP_ROOT" "$RSP_ROOT/app" "$RSP_ROOT/venv" "$RSP_ROOT/firmware" "$RSP_ROOT/log" "$RSP_ROOT/config.yaml" \
        /etc/udev/rules.d/98-pico-bootsel.rules /etc/udev/rules.d/99-pico.rules \
        -maxdepth 0 \( ! -user root -o -perm /022 \) 2>/dev/null
    in_root find "$RSP_ROOT/app" "$RSP_ROOT/venv" -xdev ! -type l \( ! -user root -o -perm /022 \) 2>/dev/null | head -5)
if [ -z "$not_root" ]; then
    pass "everything udev runs as root is root-owned and writable only by root"
else
    fail "root executes files someone else can change: $(echo $not_root)"
fi

writable=$(in_root sh -c "sudo -u $SVC_USER find '$RSP_ROOT' -xdev -writable ! -type l 2>/dev/null | grep -Ev '^$RSP_ROOT/(data|ports)(/|\$)'")
if [ -z "$writable" ]; then pass "the service user can write only data/ and ports/"; else fail "service user can write: $(echo $writable)"; fi

expect_ok "key store is 0600 and owned by the service user" \
    test "$(in_root stat -c '%a %U' "$RSP_ROOT/data/pico_secrets.yaml")" = "600 $SVC_USER"
expect_ok "the login user cannot read the key store" \
    sh -c "! docker exec -u pi '$NAME' cat '$RSP_ROOT/data/pico_secrets.yaml' >/dev/null 2>&1"

for uf2 in RPI_PICO_W.uf2 RPI_PICO2_W.uf2; do
    expect_ok "firmware cached: $uf2" in_root test -s "$RSP_ROOT/firmware/$uf2"
done
expect_ok "auto-flash stays off until someone turns it on" in_root test ! -e "$RSP_ROOT/firmware/autoflash-enabled"

rules=$(in_root cat /etc/udev/rules.d/98-pico-bootsel.rules /etc/udev/rules.d/99-pico.rules | grep -v '^#')
expect_ok "neither udev rule runs its script inline (both hand off to systemd-run)" \
    sh -c 'test "$(echo "$1" | grep -c "RUN+=\"/usr/bin/systemd-run --no-block --collect --unit=pico-")" -eq 2' sh "$rules"
expect_ok "udev rules point at the install root and pass the config" \
    sh -c 'echo "$1" | grep -q -- "--config $2/config.yaml" && ! echo "$1" | grep -q "@"' sh "$rules" "$RSP_ROOT"

step "simulated Pico through the installed service"
relay "after install"
out=$(as_pi remote-serial-pico status 2>&1)
echo "$out"
expect_ok "status lists the Pico" grep -q "$PICO_ID" <<<"$out"
expect_ok "status shows the Pico's firmware version" grep -Eq "$PICO_ID +(connected|not connected) +firmware ci-fake" <<<"$out"

# ---------------------------------------------------------------------------
step "authentication (Phase D): only a board holding its key gets a port"
refused() {   # refused "label" "reason" fake_pico args...
    local what=$1 reason=$2; shift 2
    out=$(fake_pico --expect-refused "$reason" "$@" 2>&1); code=$?
    echo "$out"
    expect_ok "$what" test $code -eq 0
}
STRANGER=dddddddddddddddd
refused "a serial id this Pi never provisioned is refused" "unknown device" --id "$STRANGER" --key "$(openssl rand -hex 32)"
refused "the right serial id with the wrong key is refused" "authentication failed" --id "$PICO_ID" --key "$(openssl rand -hex 32)"
refused "the right serial id with no key at all is refused" "this board has no device key" --id "$PICO_ID"
refused "an authenticated board on other firmware is refused" "firmware mismatch" --id "$PICO_ID" --key "$PICO_KEY" --fw-hash 0000000000000000
expect_ok "a refused serial id got no port and no line in the serial map" \
    sh -c "! docker exec '$NAME' test -e '$RSP_ROOT/ports/$STRANGER' && ! docker exec '$NAME' grep -q '$STRANGER' '$RSP_ROOT/data/pico_serial_map.yaml'"

# The old v0 registration (unframed "pico_<id>") must get nothing: no port, no reply.
out=$(as_pi python3 -c "
import socket, sys
s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=5)
s.sendall(b'pico_eeeeeeeeeeeeeeee')
s.settimeout(15)
try:
    data = s.recv(100)
except socket.timeout:
    print('STILL-OPEN'); sys.exit(1)
print('reply', data)
sys.exit(0 if data == b'' else 1)
" "$BIND_IP" "$PORT" 2>&1); code=$?
echo "$out"
expect_ok "a v0 (unframed) registration gets no reply and is disconnected: no legacy mode" test $code -eq 0
expect_ok "the v0 serial id got no port" sh -c "! docker exec '$NAME' test -e '$RSP_ROOT/ports/eeeeeeeeeeeeeeee'"
expect_ok "refusals are logged" in_root grep -q "refusing $PICO_ID: it does not hold the device key" "$RSP_ROOT/data/ptyserver.log"
if in_root grep -rqs -- "$PICO_KEY" "$RSP_ROOT/data/ptyserver.log" "$RSP_ROOT/log" /var/log 2>/dev/null \
   || in_root journalctl --no-pager 2>/dev/null | grep -q -- "$PICO_KEY"; then
    fail "a device key appears in a log"
else
    pass "no device key appears in any log"
fi
relay "after the refused attempts"

# ---------------------------------------------------------------------------
step "control channel (Phase E): remote-serial-pico ctl against the real firmware"
# The real src/pico/main.py, run by tools/pico_sim with stand-ins for the
# hardware, connected to the installed service like a board would be.
SIM_ID=5151515151515151
SIM_KEY=$(openssl rand -hex 32)
in_root sh -c "printf \"%s: '%s'\\n\" '$SIM_ID' '$SIM_KEY' >> '$RSP_ROOT/data/pico_secrets.yaml'"
start_sim() {   # the stub exits when its stdin closes, so keep one open
    docker exec -d -u pi "$NAME" sh -c "tail -f /dev/null | python3 -u '$RSP_ROOT/app/tools/pico_sim/run_main.py' \
        --host '$BIND_IP' --port '$PORT' --id '$SIM_ID' --key '$SIM_KEY' >> /tmp/sim.log 2>&1"
}
sim_log() { in_root cat /tmp/sim.log 2>/dev/null; }
wait_sim() {   # wait_sim "regex in the board's own output"
    for _ in $(seq 1 60); do sim_log | grep -Eq "$1" && return 0; sleep 0.25; done; return 1
}
ctl() { as_pi remote-serial-pico ctl "$@"; }

start_sim
expect_ok "the simulated board registers with the installed service" wait_sim "Registered as '$SIM_ID'"

# Anything a control command leaks into the serial port would show up here.
docker exec -d -u pi "$NAME" sh -c "timeout 6 cat '$RSP_ROOT/ports/$SIM_ID' > /tmp/pty-during-ctl.bin 2>/dev/null"

out=$(ctl "$SIM_ID" status 2>&1); code=$?
echo "$out"
expect_ok "ctl status: answers with the board's firmware and serial settings" \
    sh -c 'test "$1" -eq 0 && echo "$2" | grep -q "^firmware " && echo "$2" | grep -q "^serial link  *19200 8N1"' sh "$code" "$out"

out=$(ctl "$SIM_ID" identify 1 2>&1); code=$?
echo "$out"
expect_ok "ctl identify: accepted" test $code -eq 0
expect_ok "ctl identify: the board blinked and stopped by itself" wait_sim "\[CTL\] identify finished"

out=$(ctl "$SIM_ID" uart set 9600 8 e 1 2>&1); code=$?
echo "$out"
expect_ok "ctl uart set: accepted, not saved" sh -c 'test "$1" -eq 0 && echo "$2" | grep -q "\"saved\":false"' sh "$code" "$out"
expect_ok "ctl uart set: the board retuned its serial link" wait_sim "^UART-INIT 9600 8 E 1"
out=$(ctl "$SIM_ID" uart set 5 2>&1); code=$?
echo "$out"
expect_ok "ctl uart set: a nonsense baud rate is refused by the board and exits non-zero" \
    sh -c 'test "$1" -ne 0 && echo "$2" | grep -q "baud must be between"' sh "$code" "$out"

out=$(ctl no-such-board reboot 2>&1); code=$?
echo "$out"
expect_ok "ctl: a board that is not connected is an error" sh -c 'test "$1" -ne 0 && echo "$2" | grep -q "is not connected"' sh "$code" "$out"

sleep 6   # let the pty capture above run out
leaked=$(in_root sh -c 'wc -c < /tmp/pty-during-ctl.bin' 2>/dev/null | tr -d ' ')
expect_ok "no control command or answer appeared in the pty stream" test "${leaked:-1}" = 0

out=$(ctl "$SIM_ID" reboot 2>&1); code=$?
echo "$out"
expect_ok "ctl reboot: accepted" test $code -eq 0
expect_ok "ctl reboot: the board reset" wait_sim "^MACHINE-RESET"
expect_ok "every control command and its result is in the server log" \
    sh -c "docker exec '$NAME' grep -c 'control: ' '$RSP_ROOT/data/ptyserver.log' | awk '{exit !(\$1 >= 6)}'"
expect_ok "the control socket is for the service group only" \
    test "$(in_root stat -c '%a %U %G' "$RSP_ROOT/data/control.sock")" = "660 $SVC_USER $SVC_USER"
# A user outside the service group cannot control a board.
in_root useradd -m outsider 2>/dev/null
out=$(docker exec -u outsider "$NAME" remote-serial-pico ctl "$SIM_ID" status 2>&1); code=$?
echo "$out"
expect_ok "someone outside the service group cannot use ctl" test $code -ne 0

# ---------------------------------------------------------------------------
step "firmware update over the air (Phase F): an older board is brought up to date"
# "Older firmware": this firmware with one line added to main.py, so its hash differs.
in_root sh -c "rm -rf /srv/ci/old-firmware && cp -r '$RSP_ROOT/app/src/pico' /srv/ci/old-firmware \
    && echo '# an older build' >> /srv/ci/old-firmware/main.py && chmod -R a+rX /srv/ci/old-firmware"
OTA_ID=0707070707070707
OTA_KEY=$(openssl rand -hex 32)
in_root sh -c "printf \"%s: '%s'\\n\" '$OTA_ID' '$OTA_KEY' >> '$RSP_ROOT/data/pico_secrets.yaml'"
start_old_board() {   # --reboot: power it back on after a reset, files intact, like hardware
    in_root sh -c ': > /tmp/ota.log; chmod 666 /tmp/ota.log'
    docker exec -d -u pi "$NAME" sh -c "tail -f /dev/null | python3 -u '$RSP_ROOT/app/tools/pico_sim/run_main.py' --reboot \
        --src /srv/ci/old-firmware --host '$BIND_IP' --port '$PORT' --id '$OTA_ID' --key '$OTA_KEY' >> /tmp/ota.log 2>&1"
}
stop_boards() { in_root sh -c "pkill -f pico_sim/run_main.py; pkill -f 'tail -f /dev/null'; true"; }
wait_ota() {   # wait_ota "regex in the board's own output" [seconds]
    for _ in $(seq 1 $(( ${2:-20} * 4 ))); do in_root grep -Eq "$1" /tmp/ota.log 2>/dev/null && return 0; sleep 0.25; done
    in_root tail -n 25 /tmp/ota.log; return 1
}
srv_log() { in_root grep -E "$1" "$RSP_ROOT/data/ptyserver.log"; }

expect_ok "updates are off unless asked for" test "$(cfg FirmwareUpdate)" = false
start_old_board
expect_ok "with updates off, a board on other firmware is refused and nothing is sent to it" \
    wait_ota "registration refused: firmware mismatch"
expect_ok "no update was offered" sh -c "! docker exec '$NAME' grep -q '\[OTA\]' /tmp/ota.log"
stop_boards

in_root sed -i "s/^FirmwareUpdate: .*/FirmwareUpdate: true/" "$RSP_ROOT/config.yaml"
in_root systemctl restart ptyserver.service
for _ in $(seq 1 20); do in_root ss -H -tln | grep -q " $BIND_IP:$PORT " && break; sleep 0.5; done
start_old_board
expect_ok "with updates on, the board receives and verifies the new firmware" wait_ota "\[OTA\] Update verified" 40
expect_ok "it restarts with the new firmware on trial under boot.py" wait_ota "\[BOOT\] New firmware on trial, start 1 of 3" 20
expect_ok "it registers on the new firmware" wait_ota "Registered as '$OTA_ID'" 30
expect_ok "and confirms it, ending the trial" wait_ota "\[OTA\] New firmware confirmed" 10
NEW_HASH=$(in_root "$RSP_ROOT/venv/bin/python" -c "import sys; sys.path.insert(0, '$RSP_ROOT/app/src/pico'); import net_util; print(net_util.firmware_hash('$RSP_ROOT/app/src/pico'))")
OLD_HASH=$(in_root "$RSP_ROOT/venv/bin/python" -c "import sys; sys.path.insert(0, '$RSP_ROOT/app/src/pico'); import net_util; print(net_util.firmware_hash('/srv/ci/old-firmware'))")
echo "old firmware $OLD_HASH, new firmware $NEW_HASH"
srv_log "firmware update" | tail -n 6
expect_ok "the server logged the old and the new version" \
    sh -c "docker exec '$NAME' grep -q 'firmware update complete: $OTA_ID was hash $OLD_HASH, now runs .* (hash $NEW_HASH)' '$RSP_ROOT/data/ptyserver.log'"
out=$(as_pi remote-serial-pico status 2>&1)
expect_ok "status shows the board on the firmware this Pi deploys" \
    sh -c 'echo "$1" | grep -E "$2 +connected" | grep -q "hash $3)"' sh "$out" "$OTA_ID" "$NEW_HASH"
out=$(ctl "$OTA_ID" update 2>&1); code=$?
echo "$out"
expect_ok "ctl update: a board that is already current is left alone" sh -c 'test "$1" -ne 0 && echo "$2" | grep -q "already runs the firmware"' sh "$code" "$out"
stop_boards
in_root sed -i "s/^FirmwareUpdate: .*/FirmwareUpdate: false/" "$RSP_ROOT/config.yaml"
in_root systemctl restart ptyserver.service
for _ in $(seq 1 20); do in_root ss -H -tln | grep -q " $BIND_IP:$PORT " && break; sleep 0.5; done

# ---------------------------------------------------------------------------
step "the provisioning scripts take everything from config.yaml"
# No Pico here, so stand in for rshell and for the WiFi lookup: what matters is
# the port and address the deployer would write to a board, and that the WiFi
# password never lands in the tree.
in_root sed -i "s/^TCP_PORT: .*/TCP_PORT: 50123/" "$RSP_ROOT/config.yaml"
WIFI_PW="pw-$RANDOM-$RANDOM-$RANDOM"      # made up here so the search below cannot find this script
cat > "$WORK/deployer_standin.py" <<'PY'
import json, sys
root, password = sys.argv[1], sys.argv[2]
sys.path.insert(0, f'{root}/app/src/pi')
import PicoScriptDeployer as D
seen = {}
def fake_cp(cmd, **kw):
    seen['rshell'] = cmd[0]
    seen['cmd'] = cmd
    seen['config'] = json.load(open(cmd[-2]))
    return 0
D.subprocess.check_call = fake_cp
D.reset_pico = lambda port: True
D.get_wifi_credentials = lambda run=None, *a, **k: ('PicoNet', password, 'hostapd')
code = D.main(['--config', f'{root}/config.yaml', '/dev/ttyACM0', '2e8a', '0005', 'e661abcd00000000'])
board = seen.get('config') or {}
print('exit', code, 'rshell', seen.get('rshell'), 'password-delivered', board.pop('WIFI_PASSWORD', None) == password, 'board', json.dumps(board))
print('files', ' '.join(p.rsplit('/', 1)[1] for p in seen.get('cmd', [])[4:-1]))
PY
docker cp "$WORK/deployer_standin.py" "$NAME:/srv/ci/deployer_standin.py"
out=$(in_root "$RSP_ROOT/venv/bin/python" /srv/ci/deployer_standin.py "$RSP_ROOT" "$WIFI_PW" 2>&1)
echo "$out"
in_root sed -i "s/^TCP_PORT: .*/TCP_PORT: $PORT/" "$RSP_ROOT/config.yaml"
expect_ok "deployer writes the port from config.yaml into the board's config (issue #10)" grep -q '"PORT": 50123' <<<"$out"
expect_ok "deployer tells the board to connect to the bind address" grep -q "\"IP_ADDRESS\": \"$BIND_IP\"" <<<"$out"
expect_ok "deployer finds rshell next to its own interpreter" grep -q "rshell $RSP_ROOT/venv/bin/rshell" <<<"$out"
expect_ok "deployer puts the WiFi password on the board" grep -q 'password-delivered True' <<<"$out"
leak=$(in_root grep -rl -- "$WIFI_PW" "$RSP_ROOT" /tmp /run /var/tmp 2>/dev/null)
if [ -z "$leak" ]; then pass "the WiFi password is left nowhere on disk"; else fail "WiFi password left in: $leak"; fi
expect_ok "deployer logged to the root-owned log" in_root grep -q 'pico_id=e661abcd00000000' "$RSP_ROOT/log/deployer.log"
WANT_FILES="firmware.json $(in_root python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(' '.join(m['files'] + m.get('usb_only', [])))" "$RSP_ROOT/app/src/pico/firmware.json") update.json config.json"
expect_ok "deployer copies every firmware file the manifest names" grep -qx "files $WANT_FILES" <<<"$out"

# Phase D: the deployer gave that board a key and recorded it for the server.
BOARD_KEY=$(sed -n 's/.*"KEY": "\([0-9a-f]\{64\}\)".*/\1/p' <<<"$out")
expect_ok "deployer generated a 256-bit device key for the board" test ${#BOARD_KEY} -eq 64
expect_ok "the same key is on record in the key store" in_root grep -q "^e661abcd00000000: '$BOARD_KEY'\$" "$RSP_ROOT/data/pico_secrets.yaml"
expect_ok "the key store is still 0600 and the service user's after the deployer wrote it as root" \
    test "$(in_root stat -c '%a %U' "$RSP_ROOT/data/pico_secrets.yaml")" = "600 $SVC_USER"
expect_ok "the key store kept the other board's key" in_root grep -q "^$PICO_ID: '$PICO_KEY'\$" "$RSP_ROOT/data/pico_secrets.yaml"
if in_root grep -q -- "$BOARD_KEY" "$RSP_ROOT/log/deployer.log"; then fail "the device key is in the deployer log"; else pass "the device key is not in the deployer log"; fi
# The whole chain: a board carrying exactly what the deployer wrote can register.
out=$(fake_pico --id e661abcd00000000 --key "$BOARD_KEY" 2>&1); code=$?
echo "$out"
expect_ok "a board provisioned by the deployer authenticates and relays, with no server restart" test $code -eq 0
out=$(in_root "$RSP_ROOT/venv/bin/python" /srv/ci/deployer_standin.py "$RSP_ROOT" "$WIFI_PW" 2>&1)
NEW_KEY=$(sed -n 's/.*"KEY": "\([0-9a-f]\{64\}\)".*/\1/p' <<<"$out")
expect_ok "plugging the board in again rotates its key" test -n "$NEW_KEY" -a "$NEW_KEY" != "$BOARD_KEY"
refused "after rotation the old key no longer works" "authentication failed" --id e661abcd00000000 --key "$BOARD_KEY"

out=$(in_root python3 "$RSP_ROOT/app/src/pi/PicoFirmwareFlasher.py" --config "$RSP_ROOT/config.yaml" /dev/null 0003 2>&1)
echo "$out"
expect_ok "flasher reads FirmwareDir from config.yaml and honours the kill switch" \
    grep -q "Auto-flash disabled.*$RSP_ROOT/firmware/autoflash-enabled" <<<"$out"

# ---------------------------------------------------------------------------
step "reboot"
docker restart "$NAME" >/dev/null || die "docker restart failed"
wait_for_boot
check_running "after reboot"
relay "after reboot"

# ---------------------------------------------------------------------------
step "doctor notices breakage"
doctor_flags() {   # doctor_flags "label" "regex expected in a FAIL line"
    out=$(as_pi remote-serial-pico doctor 2>&1); code=$?
    if [ $code -ne 0 ] && grep -Eq "^FAIL +$2" <<<"$out"; then
        pass "doctor flags: $1"
    else
        echo "$out"
        fail "doctor did not flag: $1"
    fi
}

in_root systemctl stop ptyserver.service
doctor_flags "service stopped" "service running"
in_root systemctl start ptyserver.service

in_root chmod 777 "$RSP_ROOT"
doctor_flags "world-writable install root" "root-run files"
in_root chmod 755 "$RSP_ROOT"

in_root chown pi "$RSP_ROOT/app/src/pi/PicoScriptDeployer.py"
doctor_flags "a root-run script owned by someone else" "root-run files"
in_root chown root "$RSP_ROOT/app/src/pi/PicoScriptDeployer.py"

in_root chmod 644 "$RSP_ROOT/data/pico_secrets.yaml"
doctor_flags "readable key store" "key store"

in_root mv "$RSP_ROOT/firmware/RPI_PICO_W.uf2" /srv/ci/RPI_PICO_W.uf2
doctor_flags "missing firmware image" "firmware cache"

in_root sed -i "s/^BindAddress: .*/BindAddress: '0.0.0.0'/" "$RSP_ROOT/config.yaml"
in_root systemctl restart ptyserver.service
for _ in $(seq 1 20); do in_root ss -H -tln | grep -q ":$PORT " && break; sleep 0.5; done
doctor_flags "listening on every interface" "listening address"
in_root sed -i "s/^BindAddress: .*/BindAddress: '$BIND'/" "$RSP_ROOT/config.yaml"
in_root systemctl restart ptyserver.service

in_root rm /etc/udev/rules.d/99-pico.rules
doctor_flags "missing udev rule" "udev rule 99-pico.rules"

# The firmware comes back from the local copy, so the repair needs no network.
out=$(as_pi sudo remote-serial-pico install --firmware-from /srv/ci 2>&1); code=$?
echo "$out"
expect_ok "install repairs the rule, the key store mode and the firmware cache" test $code -eq 0
expect_ok "repaired key store is 0600 again" test "$(in_root stat -c '%a' "$RSP_ROOT/data/pico_secrets.yaml")" = 600
check_running "after repair"

# ---------------------------------------------------------------------------
step "optional firewall"
out=$(as_pi sudo remote-serial-pico install --firewall 2>&1); code=$?
echo "$out"
if [ $code -eq 0 ] && in_root nft list table inet remote_serial_pico >/dev/null 2>&1; then
    pass "install --firewall loads a rule limiting port $PORT to the Pico subnet"
    in_root nft list table inet remote_serial_pico
    relay "behind the firewall"
    out=$(as_pi sudo remote-serial-pico install --no-firewall 2>&1); code=$?
    expect_ok "install --no-firewall removes it" sh -c "[ $code -eq 0 ] && ! docker exec '$NAME' nft list table inet remote_serial_pico >/dev/null 2>&1"
    check_running "after the firewall round trip"
else
    fail "install --firewall did not load its rule (exit $code)"
fi

# ---------------------------------------------------------------------------
echo
echo "=== $fails failure(s), $nknown known issue(s)"
[ "$fails" -eq 0 ]
