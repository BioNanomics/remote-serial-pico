"""Read the installed config.yaml from the provisioning scripts.

PicoScriptDeployer.py and PicoFirmwareFlasher.py are run by udev as root. They
used to carry their own copies of the project path, the venv path and the TCP
port, which is how the port in config.yaml and the port written to a Pico came
to disagree (issue #10). Now the udev rule passes `--config <file>` and every
path and the port come from that one file.

Standard library only: the flasher runs under the system python3, where PyYAML
may not exist. config.yaml is flat `key: value`, which is all this parses (the
installer's parseFlatYaml in installer.js reads the same subset).
"""
import os

CONFIG_ENV = 'REMOTE_SERIAL_PICO_CONFIG'


def parse_flat_yaml(text):
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition(':')
        if not sep or not key.strip():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        elif value.lstrip('-').isdigit():
            value = int(value)
        elif value in ('true', 'false'):
            value = value == 'true'
        out[key.strip()] = value
    return out


def split_config_arg(argv):
    """Pull `--config <path>` (or --config=<path>) out of an argument list.

    Returns (config_path_or_None, remaining_args). The remaining arguments keep
    their order, so the positional ones udev passes are unaffected.
    """
    path = None
    rest = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--config' and i + 1 < len(argv):
            path = argv[i + 1]
            i += 2
            continue
        if arg.startswith('--config='):
            path = arg[len('--config='):]
            i += 1
            continue
        rest.append(arg)
        i += 1
    return path, rest


def load(path=None, environ=os.environ):
    """The parsed config, or {} when there is none (the caller decides whether
    that is fatal). `path` wins over the REMOTE_SERIAL_PICO_CONFIG variable."""
    path = path or environ.get(CONFIG_ENV)
    if not path:
        return {}
    try:
        with open(path) as fh:
            return parse_flat_yaml(fh.read())
    except OSError:
        return {}
