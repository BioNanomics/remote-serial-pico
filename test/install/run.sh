#!/usr/bin/env bash
# End-to-end install test for "one-command Pi setup" (issue #19, Part 1).
#
# Boots a Debian trixie container under systemd as a stand-in for a fresh
# Raspberry Pi OS Lite image, then follows the README's quick install exactly,
# using this working tree instead of the npm registry and GitHub:
#
#   apt install nodejs npm build-essential python3 python3-venv python3-pip
#   sudo npm i -g <this tree, packed>
#   sudo remote-serial-pico install          (clones this tree, not GitHub)
#
# and checks what the issue's acceptance criteria can check without hardware:
# install succeeds, a re-run changes nothing, doctor is green, the service is
# enabled and listening, nothing is world-writable, a Pico (simulated with the
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
CLONE=/home/project/remote-serial-pico
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
        in_root tail -n 40 /tmp/smartHome.log 2>/dev/null
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
    git init -q -b under-test &&
    git add -A &&
    git -c user.name=ci -c user.email=ci@localhost commit -qm 'tree under test' &&
    git clone -q --bare . "$WORK/rsp.git" &&
    npm pack --silent --pack-destination "$WORK" >/dev/null
) || die "could not build the repo snapshot and npm package"
TGZ=$(ls "$WORK"/*.tgz)
pass "snapshot $(cd "$WORK/src" && git rev-parse --short HEAD), package $(basename "$TGZ")"

step "boot a clean 'Pi OS' container"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || die "docker build failed"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --hostname raspberrypi --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null || die "docker run failed"
wait_for_boot
pass "systemd up ($(in_root systemctl is-system-running))"

# Not /tmp: trixie mounts a tmpfs there at boot, which hides what docker cp writes.
in_root mkdir -p /srv/ci
docker cp "$WORK/rsp.git" "$NAME:/srv/rsp.git" && in_root chown -R pi:pi /srv/rsp.git
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

INSTALL=(sudo REMOTE_SERIAL_PICO_REPO=/srv/rsp.git REMOTE_SERIAL_PICO_BRANCH=under-test remote-serial-pico install)
out=$(as_pi "${INSTALL[@]}" 2>&1); code=$?
echo "$out"
[ $code -eq 0 ] && pass "first install exits 0" || die "first install exited $code"

step "re-run is a no-op"
out=$(as_pi "${INSTALL[@]}" 2>&1); code=$?
echo "$out"
if [ $code -eq 0 ] && grep -q 'Done. 0 change(s)' <<<"$out"; then
    pass "second install changes nothing"
else
    fail "second install was not a no-op (exit $code)"
fi

# ---------------------------------------------------------------------------
check_running() {   # check_running "label"
    expect_ok "$1: service enabled at boot" test "$(in_root systemctl is-enabled ptyserver.service)" = enabled
    expect_ok "$1: service active" test "$(in_root systemctl is-active ptyserver.service)" = active
    local listening=0
    for _ in $(seq 1 20); do
        in_root ss -tln | grep -q ':50000 ' && { listening=1; break; }
        sleep 0.5
    done
    expect_ok "$1: listening on tcp 50000" test $listening = 1
    out=$(as_pi remote-serial-pico doctor 2>&1); code=$?
    echo "$out"
    expect_ok "$1: doctor all green" test $code -eq 0
}

relay() {   # relay "label"
    out=$(as_pi python3 /srv/ci/fake_pico.py --src "$CLONE/src/pico" --id "$PICO_ID" --high-bytes 2>&1); code=$?
    echo "$out"
    expect_ok "$1: simulated Pico registers and relays byte-exact both ways" test $code -eq 0
    if grep -q HIGH_BYTES_FAILED <<<"$out"; then
        known "$1: pty is not byte-transparent for 0x80-0xFF (issue #19 review, 'other issues')"
    fi
}

step "service, doctor, permissions"
check_running "after install"

ww=$(in_root find /home/project /etc/systemd/system/ptyserver.service /etc/udev/rules.d \
        -xdev ! -type l -perm -0002 2>/dev/null)
if [ -z "$ww" ]; then pass "nothing the installer created is world-writable"; else fail "world-writable: $ww"; fi

# udev runs these as root, so they must not be writable by anyone but root.
not_root=$(in_root sh -c "for p in /home/project /home/project/myenv /home/project/myenv/bin \
        $CLONE $CLONE/src/pi $CLONE/src/pi/PicoScriptDeployer.py $CLONE/src/pi/PicoFirmwareFlasher.py \
        /home/project/firmware; do [ -e \"\$p\" ] && [ \"\$(stat -c %U \"\$p\")\" != root ] && echo \"\$p (\$(stat -c %U \"\$p\"))\"; done")
if [ -z "$not_root" ]; then
    pass "everything udev runs as root is root-owned"
else
    known "root executes files owned by the service user (issue #19 review, S2): $(echo $not_root)"
fi

step "simulated Pico through the installed service"
relay "after install"
out=$(as_pi remote-serial-pico status 2>&1)
echo "$out"
expect_ok "status lists the Pico" grep -q "$PICO_ID" <<<"$out"

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

in_root chmod 777 /home/project
doctor_flags "world-writable /home/project" "project directory"
in_root chmod 755 /home/project

in_root rm /etc/udev/rules.d/99-pico.rules
doctor_flags "missing udev rule" "udev rule 99-pico.rules"
out=$(as_pi "${INSTALL[@]}" 2>&1); code=$?
expect_ok "install repairs the missing rule" test $code -eq 0
check_running "after repair"

# ---------------------------------------------------------------------------
echo
echo "=== $fails failure(s), $nknown known issue(s)"
[ "$fails" -eq 0 ]
