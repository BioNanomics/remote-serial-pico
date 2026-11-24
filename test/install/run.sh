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

relay() {   # relay "label"
    out=$(as_pi python3 /srv/ci/fake_pico.py --src "$RSP_ROOT/app/src/pico" --link-dir "$RSP_ROOT/ports" \
            --host "$BIND_IP" --port "$PORT" --id "$PICO_ID" --high-bytes 2>&1); code=$?
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
expect_ok "udev rules point at the install root and pass the config" \
    sh -c 'echo "$1" | grep -q -- "--config $2/config.yaml" && ! echo "$1" | grep -q "@"' sh "$rules" "$RSP_ROOT"

step "simulated Pico through the installed service"
relay "after install"
out=$(as_pi remote-serial-pico status 2>&1)
echo "$out"
expect_ok "status lists the Pico" grep -q "$PICO_ID" <<<"$out"
expect_ok "status shows the Pico's firmware version" grep -Eq "$PICO_ID +(connected|not connected) +firmware ci-fake" <<<"$out"

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
    seen['config'] = json.load(open(cmd[-2]))
    return 0
D.subprocess.check_call = fake_cp
D.reset_pico = lambda port: True
D.get_wifi_credentials = lambda run=None, *a, **k: ('PicoNet', password, 'hostapd')
code = D.main(['--config', f'{root}/config.yaml', '/dev/ttyACM0', '2e8a', '0005', 'e661abcd00000000'])
board = seen.get('config') or {}
print('exit', code, 'rshell', seen.get('rshell'), 'password-delivered', board.pop('WIFI_PASSWORD', None) == password, 'board', json.dumps(board))
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
