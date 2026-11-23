# A stand-in for a fresh Raspberry Pi OS Lite image (Debian trixie), booted
# with systemd so the installer's systemctl/udevadm steps run for real.
#
# Only what a clean Pi OS Lite already has goes in here. Everything the README
# tells you to install (nodejs, npm, build-essential, python3, ...) is left
# out on purpose: run.sh installs it inside the container, the README way.
FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        systemd systemd-sysv udev dbus sudo iproute2 procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pi OS: the first user has passwordless sudo (/etc/sudoers.d/010_pi-nopasswd).
RUN useradd -m -s /bin/bash pi \
 && echo 'pi ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/010_pi-nopasswd \
 && chmod 0440 /etc/sudoers.d/010_pi-nopasswd

# Nothing to log in to in a container.
RUN systemctl mask getty@tty1.service serial-getty@ttyS0.service console-getty.service 2>/dev/null || true

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
