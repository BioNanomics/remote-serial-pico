'use strict';
// install / doctor / status for the Pi side of remote-serial-pico.
//
// Plain Node with no dependencies, on purpose: this runs before the app's
// node_modules exist. Every external effect goes through `ctx.run` (an
// argument array, never a shell string) and `ctx.fsx`, so the tests can point
// the whole thing at a temp directory and a fake command runner.
//
// One install root, and everything is derived from it (layout() below):
//
//   <root>/                 root-owned, 755
//     app/                  this package, copied here; what the service and udev run
//     venv/                 Python venv holding rshell
//     firmware/             MicroPython UF2 cache + the autoflash-enabled kill switch
//     log/                  deployer.log, written by the root-run provisioning scripts
//     config.yaml           generated once from src/pi/config.example.yaml
//     data/                 owned by the service user: serial map, secrets, state, service log
//     ports/                owned by the service user: <name> -> /dev/pts/N
//
// udev runs the provisioning scripts as root, so everything root executes or
// reads is root-owned; the service user can write only data/ and ports/
// (issue #19 review, S2). The npm package is the install: there is no git
// clone, the installer copies the package it is running from into <root>/app.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveBindAddress, detectBindInterface, networkOf, isIPv4, readState } = require('./runtime.js');

// The only place the default install root is written down. --root or
// REMOTE_SERIAL_PICO_ROOT overrides it; after that the systemd unit remembers.
const DEFAULT_ROOT = '/opt/remote-serial-pico';
const ROOT_ENV = 'REMOTE_SERIAL_PICO_ROOT';
const DEFAULT_SERVICE_USER = 'rspico';

function layout(root) {
    return {
        root,
        appDir: path.join(root, 'app'),
        venvDir: path.join(root, 'venv'),
        firmwareDir: path.join(root, 'firmware'),
        logDir: path.join(root, 'log'),
        dataDir: path.join(root, 'data'),
        portsDir: path.join(root, 'ports'),
        configPath: path.join(root, 'config.yaml'),
        firewallRules: path.join(root, 'firewall.nft')
    };
}

// Where the operating system wants things; not ours to choose.
const SYSTEM = Object.freeze({
    unitPath: '/etc/systemd/system/ptyserver.service',
    unitName: 'ptyserver.service',
    firewallUnitPath: '/etc/systemd/system/remote-serial-pico-firewall.service',
    firewallUnitName: 'remote-serial-pico-firewall.service',
    rulesDir: '/etc/udev/rules.d',
    nft: '/usr/sbin/nft',
    aptPackages: ['python3', 'python3-venv', 'python3-pip', 'build-essential', 'udisks2']
});

const CONFIG_KEYS = ['PicoSerialMap', 'PicoSecrets', 'StateFile', 'symlinkDir', 'FirmwareDir', 'DeployerLog',
    'SyslogDir', 'CustomlogDir', 'TCP_PORT', 'BindAddress'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Argument arrays, no shell: a quote in a user name or a path cannot change
// what runs (issue #19 review, S8).
function exec(cmd, args = [], opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return {
        status: r.status === null || r.error ? 1 : r.status,
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || (r.error ? r.error.message : '') || '').trim()
    };
}

function lastLine(text) {
    return String(text || '').trim().split('\n').pop() || 'no output';
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// config.yaml and pico_serial_map.yaml are flat `key: value` files. Parsing
// them here avoids depending on js-yaml before it is installed.
function parseFlatYaml(text) {
    const out = {};
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf(':');
        if (i < 1) continue;
        const key = line.slice(0, i).trim();
        let val = line.slice(i + 1).trim();
        if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
            val = val.slice(1, -1);
        } else if (/^-?\d+$/.test(val)) {
            val = Number(val);
        }
        out[key] = val;
    }
    return out;
}

function writeIfChanged(fsx, file, content, mode) {
    let existing = null;
    try { existing = fsx.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing === content) {
        if (mode !== undefined && (fsx.statSync(file).mode & 0o777) !== mode) { fsx.chmodSync(file, mode); return 'updated'; }
        return 'unchanged';
    }
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(file, content, { mode });
    if (mode !== undefined) fsx.chmodSync(file, mode);
    return existing === null ? 'created' : 'updated';
}

function ensureDir(fsx, dir, mode) {
    if (fsx.existsSync(dir)) {
        if (mode !== undefined && (fsx.statSync(dir).mode & 0o777) !== mode) { fsx.chmodSync(dir, mode); return 'updated'; }
        return 'unchanged';
    }
    fsx.mkdirSync(dir, { recursive: true, mode });
    if (mode !== undefined) fsx.chmodSync(dir, mode);
    return 'created';
}

function isWorldWritable(fsx, p) {
    try { return (fsx.statSync(p).mode & 0o002) !== 0; } catch { return false; }
}

function sha256File(fsx, file) {
    return crypto.createHash('sha256').update(fsx.readFileSync(file)).digest('hex');
}

const SAFE_USER = /^[a-z_][a-z0-9_-]*\$?$/i;
const SAFE_ROOT = /^\/[A-Za-z0-9._\-/]*[A-Za-z0-9._-]$/;   // it is pasted into a udev RUN+= line

// Who ran sudo: the person who gets added to the service group so they (and
// Node-RED running as them) can open the ports.
function resolveUser(env = process.env) {
    if (env.SUDO_USER && env.SUDO_USER !== 'root') return env.SUDO_USER;
    const me = os.userInfo().username;
    return me === 'root' ? null : me;
}

// ---------------------------------------------------------------------------
// command line and context
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { command: '', errors: [] };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (name) => {
            if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
            if (i + 1 < argv.length) return argv[++i];
            out.errors.push(`${name} needs a value`);
            return undefined;
        };
        if (a === '--root' || a.startsWith('--root=')) out.root = value('--root');
        else if (a === '--user' || a.startsWith('--user=')) out.serviceUser = value('--user');
        else if (a === '--firmware-from' || a.startsWith('--firmware-from=')) out.firmwareFrom = value('--firmware-from');
        else if (a === '--firewall') out.firewall = true;
        else if (a === '--no-firewall') out.firewall = false;
        else if (a === '-h' || a === '--help') out.help = true;
        else if (a.startsWith('-')) out.errors.push(`unknown option: ${a}`);
        else rest.push(a);
    }
    out.command = (rest[0] || '').toLowerCase();
    if (rest.length > 1) out.errors.push(`unexpected argument: ${rest[1]}`);
    return out;
}

// What an earlier install chose, read back from the unit it wrote, so `doctor`
// and a re-run need no flags and nothing has to be remembered anywhere else.
function readInstalledUnit(fsx, unitPath) {
    let text;
    try { text = fsx.readFileSync(unitPath, 'utf8'); } catch { return null; }
    const execStart = /^ExecStart=(\S+)\s+\S+\s+--config\s+(\S+)\s*$/m.exec(text);
    const user = /^User=(\S+)\s*$/m.exec(text);
    if (!execStart) return null;
    return { nodePath: execStart[1], configPath: execStart[2], root: path.dirname(execStart[2]), user: user ? user[1] : null };
}

function makeContext(overrides = {}) {
    const env = overrides.env || process.env;
    const fsx = overrides.fsx || fs;
    const opts = overrides.opts || {};
    const system = { ...SYSTEM, ...(overrides.system || {}) };
    const installed = readInstalledUnit(fsx, system.unitPath);
    const root = opts.root || env[ROOT_ENV] || (installed && installed.root) || DEFAULT_ROOT;
    const serviceUser = opts.serviceUser || (installed && installed.user) || DEFAULT_SERVICE_USER;
    const cfg = {
        ...layout(root),
        ...system,
        sourceDir: path.resolve(__dirname, '..', '..'),
        serviceUser,
        ...(overrides.cfg || {})
    };
    const ctx = {
        cfg,
        opts,
        installed,
        run: overrides.run || exec,
        fsx,
        log: overrides.log || ((s) => process.stdout.write(s + '\n')),
        sleep: overrides.sleep || sleepMs,
        user: overrides.user !== undefined ? overrides.user : resolveUser(env),
        nodePath: overrides.nodePath || process.execPath,
        isRoot: overrides.isRoot !== undefined ? overrides.isRoot : (typeof process.getuid === 'function' && process.getuid() === 0),
        rootUid: overrides.rootUid !== undefined ? overrides.rootUid : 0,
        interfaces: overrides.interfaces || (() => os.networkInterfaces()),
        flags: {}
    };
    // uid/gid of a user, or null if there is no such user.
    const idCache = {};
    ctx.ids = overrides.ids || ((user) => {
        if (!(user in idCache)) {
            const u = ctx.run('id', ['-u', user]), g = ctx.run('id', ['-g', user]);
            idCache[user] = (u.status === 0 && g.status === 0 && /^\d+$/.test(u.stdout) && /^\d+$/.test(g.stdout))
                ? { uid: Number(u.stdout), gid: Number(g.stdout) } : null;
        }
        return idCache[user];
    });
    ctx.download = overrides.download || ((url, dest) => downloadTo(ctx, url, dest));
    return ctx;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function fillTemplate(text, values) {
    return text.replace(/@([A-Z_]+)@/g, (whole, key) => (key in values ? values[key] : whole));
}

function renderConfig(ctx, bind) {
    const template = ctx.fsx.readFileSync(path.join(ctx.cfg.sourceDir, 'src', 'pi', 'config.example.yaml'), 'utf8');
    return fillTemplate(template, { ROOT: ctx.cfg.root, BIND: bind });
}

function renderUnit({ user, nodePath, cfg }) {
    return [
        '[Unit]',
        'Description=remote-serial-pico PtyServer',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        `WorkingDirectory=${cfg.appDir}/src/pi`,
        `ExecStart=${nodePath} ${cfg.appDir}/src/pi/PtyServer.js --config ${cfg.configPath}`,
        'Restart=always',
        'RestartSec=3',
        `User=${user}`,
        `Group=${user}`,
        'UMask=0022',
        'Environment=NODE_ENV=production',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=ptyserver',
        '',
        '# The service faces the network and needs to write exactly two',
        '# directories. Everything else on the Pi is read-only to it.',
        'NoNewPrivileges=yes',
        'ProtectSystem=strict',
        `ReadWritePaths=${cfg.dataDir} ${cfg.portsDir}`,
        'ProtectHome=read-only',
        'PrivateTmp=yes',
        'ProtectKernelTunables=yes',
        'ProtectKernelModules=yes',
        'ProtectControlGroups=yes',
        'RestrictSUIDSGID=yes',
        'LockPersonality=yes',
        '# AF_NETLINK: how the server reads the interface address it binds to.',
        'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
    ].join('\n');
}

// Every src/pi/*.rules.in in the package, with the install root filled in.
function renderedRules(ctx, fromDir) {
    const dir = path.join(fromDir || ctx.cfg.appDir, 'src', 'pi');
    let names = [];
    try { names = ctx.fsx.readdirSync(dir).filter(n => n.endsWith('.rules.in')).sort(); } catch { /* not installed yet */ }
    const values = { APP: ctx.cfg.appDir, CONFIG: ctx.cfg.configPath, VENV_PYTHON: path.join(ctx.cfg.venvDir, 'bin', 'python') };
    return names.map(n => {
        const name = n.slice(0, -'.in'.length);
        return { name, dst: path.join(ctx.cfg.rulesDir, name), content: fillTemplate(ctx.fsx.readFileSync(path.join(dir, n), 'utf8'), values) };
    });
}

function renderFirewall(port, subnet) {
    return [
        '#!/usr/sbin/nft -f',
        '# Generated by `remote-serial-pico install --firewall`. Only the Pico subnet',
        `# may reach PtyServer's port. Re-run install if the subnet changes.`,
        'table inet remote_serial_pico',
        'delete table inet remote_serial_pico',
        'table inet remote_serial_pico {',
        '    chain input {',
        '        type filter hook input priority filter; policy accept;',
        `        tcp dport ${port} ip saddr != ${subnet} drop`,
        `        meta nfproto ipv6 tcp dport ${port} drop`,
        '    }',
        '}',
        ''
    ].join('\n');
}

function renderFirewallUnit(cfg) {
    return [
        '[Unit]',
        'Description=remote-serial-pico: limit the Pico TCP port to the Pico subnet',
        `Before=${cfg.unitName}`,
        '',
        '[Service]',
        'Type=oneshot',
        'RemainAfterExit=yes',
        `ExecStart=${cfg.nft} -f ${cfg.firewallRules}`,
        `ExecStop=${cfg.nft} delete table inet remote_serial_pico`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
    ].join('\n');
}

// ---------------------------------------------------------------------------
// the package tree
// ---------------------------------------------------------------------------

const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.github']);
const TREE_SKIP_FILES = new Set(['.DS_Store']);
const TREE_SKIP_PATHS = new Set([path.join('src', 'pi', 'config.yaml'), path.join('src', 'pico', 'config.json')]);

function treeSkips(rel, isDir) {
    const base = path.basename(rel);
    if (isDir) return TREE_SKIP_DIRS.has(base);
    return TREE_SKIP_FILES.has(base) || TREE_SKIP_PATHS.has(rel) || base.endsWith('.log') || base.endsWith('.pyc') || base.endsWith('.tgz');
}

function treeFiles(fsx, dir, rel = '') {
    let out = [];
    for (const entry of fsx.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const r = path.join(rel, entry.name);
        if (entry.isDirectory()) { if (!treeSkips(r, true)) out = out.concat(treeFiles(fsx, dir, r)); }
        else if (entry.isFile() && !treeSkips(r, false)) out.push(r);
    }
    return out;
}

// One hash for "is the installed app the same as this package".
function treeHash(fsx, dir) {
    const h = crypto.createHash('sha256');
    for (const rel of treeFiles(fsx, dir)) {
        h.update(rel).update('\0').update(fsx.readFileSync(path.join(dir, rel))).update('\0');
    }
    return h.digest('hex');
}

function packageVersion(fsx, dir) {
    try { return JSON.parse(fsx.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '?'; } catch { return '?'; }
}

function readStamp(fsx, appDir) {
    try { return JSON.parse(fsx.readFileSync(path.join(appDir, '.installed.json'), 'utf8')); } catch { return null; }
}

function nodePtyLoads(ctx, dir, nodePath) {
    return ctx.run(nodePath || ctx.nodePath, ['-e', "require('node-pty')"], { cwd: dir });
}

// ---------------------------------------------------------------------------
// install: each step idempotent, reporting ok / changed / failed
// ---------------------------------------------------------------------------

// `dpkg -s` exits 0 for a package that was removed but not purged ("config
// files" state), so it is not a presence test. Ask for the status text.
function packageInstalled(ctx, pkg) {
    const r = ctx.run('dpkg-query', ['-W', '-f=${Status}', pkg]);
    return r.status === 0 && /install ok installed/.test(r.stdout);
}

function wantedPackages(ctx) {
    return ctx.opts.firewall === true ? [...ctx.cfg.aptPackages, 'nftables'] : ctx.cfg.aptPackages;
}

function stepAptPackages(ctx) {
    const missing = wantedPackages(ctx).filter(p => !packageInstalled(ctx, p));
    if (missing.length === 0) return { result: 'ok', detail: 'all present' };
    const r = ctx.run('apt-get', ['install', '-y', ...missing], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    if (r.status !== 0) return { result: 'failed', detail: `apt-get failed: ${lastLine(r.stderr)}` };
    return { result: 'changed', detail: `installed ${missing.join(', ')}` };
}

// A dedicated account for the network-facing service, and the person who ran
// the installer in its group so they can open the ports.
function stepServiceUser(ctx) {
    const svc = ctx.cfg.serviceUser;
    const done = [];
    if (ctx.run('id', ['-u', svc]).status !== 0) {
        if (ctx.opts.serviceUser) return { result: 'failed', detail: `--user ${svc}: no such user` };
        const r = ctx.run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', ctx.cfg.dataDir, '--shell', '/usr/sbin/nologin', svc]);
        if (r.status !== 0) return { result: 'failed', detail: `useradd ${svc}: ${lastLine(r.stderr)}` };
        done.push(`created system user ${svc}`);
    }
    if (ctx.user && ctx.user !== svc) {
        const groups = ctx.run('id', ['-nG', ctx.user]).stdout.split(/\s+/);
        const group = ctx.run('id', ['-gn', svc]).stdout || svc;
        if (!groups.includes(group)) {
            const r = ctx.run('usermod', ['-aG', group, ctx.user]);
            if (r.status !== 0) return { result: 'failed', detail: `usermod -aG ${group} ${ctx.user}: ${lastLine(r.stderr)}` };
            done.push(`added ${ctx.user} to group ${group} (log in again for it to apply)`);
        }
    }
    return done.length ? { result: 'changed', detail: done.join('; ') }
                       : { result: 'ok', detail: `${svc}${ctx.user && ctx.user !== svc ? `, ${ctx.user} in its group` : ''}` };
}

function ownedDir(ctx, dir, owner, mode) {
    let changed = ensureDir(ctx.fsx, dir, mode) !== 'unchanged';
    const want = owner === 'root' ? { uid: ctx.rootUid, gid: null } : ctx.ids(owner);
    const st = ctx.fsx.statSync(dir);
    if (want && (st.uid !== want.uid || (want.gid !== null && st.gid !== want.gid))) {
        const r = ctx.run('chown', [`${owner}:${owner === 'root' ? 'root' : ctx.run('id', ['-gn', owner]).stdout || owner}`, dir]);
        if (r.status !== 0) throw new Error(`chown ${owner} ${dir}: ${lastLine(r.stderr)}`);
        changed = true;
    }
    return changed;
}

function stepDirectories(ctx) {
    const c = ctx.cfg, svc = c.serviceUser;
    // 755 and root-owned, never 777: udev runs code as root out of this tree.
    const changed = [
        ownedDir(ctx, c.root, 'root', 0o755),
        ownedDir(ctx, c.firmwareDir, 'root', 0o755),
        ownedDir(ctx, c.logDir, 'root', 0o755),
        ownedDir(ctx, c.dataDir, svc, 0o755),
        ownedDir(ctx, c.portsDir, svc, 0o755)
    ].some(Boolean);
    return { result: changed ? 'changed' : 'ok', detail: `${c.root} (root), data and ports (${svc})` };
}

// Copy the package this installer is running from into <root>/app, as root.
// Built in app.new and swapped in, so a failure leaves the old app running.
function stepApp(ctx) {
    const c = ctx.cfg, fsx = ctx.fsx;
    const version = packageVersion(fsx, c.sourceDir);
    if (path.resolve(c.sourceDir) === path.resolve(c.appDir)) return { result: 'ok', detail: `${version}, running from the installed copy` };

    const hash = treeHash(fsx, c.sourceDir);
    const stamp = readStamp(fsx, c.appDir);
    const hasModules = fsx.existsSync(path.join(c.appDir, 'node_modules', 'node-pty'));
    if (stamp && stamp.hash === hash && stamp.node === ctx.nodePath && hasModules) return { result: 'ok', detail: `${version} up to date` };

    const staging = `${c.appDir}.new`, old = `${c.appDir}.old`;
    fsx.rmSync(staging, { recursive: true, force: true });
    fsx.mkdirSync(staging, { recursive: true, mode: 0o755 });
    for (const rel of treeFiles(fsx, c.sourceDir)) {
        const to = path.join(staging, rel);
        fsx.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
        fsx.copyFileSync(path.join(c.sourceDir, rel), to);
    }

    // node_modules, cheapest source first. All three end with the same test:
    // node-pty must load under the exact node the unit will start (issue #7:
    // an npm belonging to a different node builds a module that cannot load).
    // npm-shrinkwrap.json is the lockfile that ships inside the npm package
    // (package-lock.json never does), so `npm i -g` and this copy both get
    // exactly the dependency versions that were tested.
    const lock = (dir) => {
        for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
            try { return fsx.readFileSync(path.join(dir, name), 'utf8'); } catch { /* try the next */ }
        }
        return null;
    };
    const stagedModules = path.join(staging, 'node_modules');
    let how = null;
    if (hasModules && stamp && stamp.node === ctx.nodePath && lock(c.appDir) !== null && lock(c.appDir) === lock(staging)) {
        fsx.cpSync(path.join(c.appDir, 'node_modules'), stagedModules, { recursive: true });
        how = 'kept node_modules';
    } else if (fsx.existsSync(path.join(c.sourceDir, 'node_modules', 'node-pty')) && nodePtyLoads(ctx, c.sourceDir).status === 0) {
        fsx.cpSync(path.join(c.sourceDir, 'node_modules'), stagedModules, { recursive: true });
        how = 'copied node_modules from the package';
    } else {
        const env = { ...process.env, PATH: `${path.dirname(ctx.nodePath)}${path.delimiter}${process.env.PATH || ''}` };
        const args = [lock(staging) !== null ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
        const r = ctx.run('npm', args, { cwd: staging, env });
        if (r.status !== 0) return { result: 'failed', detail: `npm ${args[0]} in ${staging}: ${lastLine(r.stderr)}` };
        how = `npm ${args[0]}`;
    }
    const loads = nodePtyLoads(ctx, staging);
    if (loads.status !== 0) {
        return { result: 'failed', detail: `node-pty does not load under ${ctx.nodePath}: ${lastLine(loads.stderr)}. Run the installer with the node the service should use.` };
    }

    fsx.writeFileSync(path.join(staging, '.installed.json'), JSON.stringify({ version, hash, node: ctx.nodePath }, null, 2) + '\n', { mode: 0o644 });
    for (const args of [['chown', ['-R', 'root:root', staging]], ['chmod', ['-R', 'u+rwX,go+rX,go-w', staging]]]) {
        const r = ctx.run(args[0], args[1]);
        if (r.status !== 0) return { result: 'failed', detail: `${args[0]} ${staging}: ${lastLine(r.stderr)}` };
    }

    fsx.rmSync(old, { recursive: true, force: true });
    const hadApp = fsx.existsSync(c.appDir);
    if (hadApp) fsx.renameSync(c.appDir, old);
    fsx.renameSync(staging, c.appDir);
    fsx.rmSync(old, { recursive: true, force: true });
    ctx.flags.appChanged = true;
    return { result: 'changed', detail: `${hadApp ? `upgraded ${stamp ? stamp.version : '?'} -> ${version}` : `installed ${version}`} into ${c.appDir} (${how})` };
}

function stepVenv(ctx) {
    const c = ctx.cfg;
    const rshell = path.join(c.venvDir, 'bin', 'rshell');
    if (ctx.fsx.existsSync(rshell)) return { result: 'ok', detail: 'rshell present' };
    // As root, into the root-owned tree: udev runs this interpreter as root.
    let r = ctx.run('python3', ['-m', 'venv', c.venvDir]);
    if (r.status === 0) r = ctx.run(path.join(c.venvDir, 'bin', 'pip'), ['install', '-q', 'rshell']);
    if (r.status !== 0) return { result: 'failed', detail: lastLine(r.stderr) };
    ctx.run('chmod', ['-R', 'go-w', c.venvDir]);
    return { result: 'changed', detail: 'created venv and installed rshell' };
}

function defaultRouteDev(ctx) {
    const m = /\bdev\s+(\S+)/.exec(ctx.run('ip', ['-4', 'route', 'show', 'default']).stdout);
    return m ? m[1] : null;
}

function stepConfig(ctx) {
    const c = ctx.cfg;
    if (ctx.fsx.existsSync(c.configPath)) return { result: 'ok', detail: 'config.yaml present (left alone)' };
    const iface = detectBindInterface(ctx.interfaces(), defaultRouteDev(ctx));
    writeIfChanged(ctx.fsx, c.configPath, renderConfig(ctx, iface || '0.0.0.0'), 0o644);
    ctx.flags.configChanged = true;
    return {
        result: 'changed',
        detail: iface ? `wrote ${c.configPath}, Picos connect via ${iface}`
                      : `wrote ${c.configPath}; no network interface found, so BindAddress is 0.0.0.0: set it and restart`
    };
}

function readConfig(ctx) {
    try { return parseFlatYaml(ctx.fsx.readFileSync(ctx.cfg.configPath, 'utf8')); } catch { return null; }
}

// The two files that cannot be regenerated. Created empty if absent, never
// touched if present. The key store is where Phase D will keep per-device
// secrets: 0600 and owned by the service user from its first byte.
function stepState(ctx) {
    const conf = readConfig(ctx) || {};
    const svc = ctx.cfg.serviceUser;
    const want = ctx.ids(svc);
    const group = ctx.run('id', ['-gn', svc]).stdout || svc;
    const files = [
        [conf.PicoSecrets, 0o600, '# remote-serial-pico device secrets. One line per board: <serial id>: <key>. Never share or log this file.\n'],
        [conf.PicoSerialMap, 0o644, '']
    ];
    const done = [];
    for (const [file, mode, initial] of files) {
        if (!file) return { result: 'failed', detail: 'config.yaml has no PicoSecrets / PicoSerialMap key; add them from src/pi/config.example.yaml' };
        let changed = false;
        if (!ctx.fsx.existsSync(file)) {
            ctx.fsx.mkdirSync(path.dirname(file), { recursive: true });
            ctx.fsx.writeFileSync(file, initial, { mode, flag: 'wx' });
            changed = true;
        }
        const st = ctx.fsx.statSync(file);
        if ((st.mode & 0o777) !== mode) { ctx.fsx.chmodSync(file, mode); changed = true; }
        if (want && (st.uid !== want.uid || st.gid !== want.gid)) {
            const r = ctx.run('chown', [`${svc}:${group}`, file]);
            if (r.status !== 0) return { result: 'failed', detail: `chown ${file}: ${lastLine(r.stderr)}` };
            changed = true;
        }
        if (changed) done.push(path.basename(file));
    }
    return done.length ? { result: 'changed', detail: `initialised ${done.join(', ')}` } : { result: 'ok', detail: 'serial map and key store present (left alone)' };
}

function stepUdevRules(ctx) {
    const rules = renderedRules(ctx);
    if (rules.length === 0) return { result: 'failed', detail: `no *.rules.in files found in ${ctx.cfg.appDir}/src/pi` };
    const changed = rules.filter(r => writeIfChanged(ctx.fsx, r.dst, r.content, 0o644) !== 'unchanged').map(r => r.name);
    if (changed.length === 0) return { result: 'ok', detail: rules.map(r => r.name).join(', ') + ' up to date' };
    let rl = ctx.run('udevadm', ['control', '--reload-rules']);
    if (rl.status === 0) rl = ctx.run('udevadm', ['trigger']);
    if (rl.status !== 0) return { result: 'failed', detail: lastLine(rl.stderr) };
    return { result: 'changed', detail: `installed ${changed.join(', ')}` };
}

// The subnet the Picos are on, from BindAddress in config.yaml.
function picoSubnet(ctx, conf) {
    const interfaces = ctx.interfaces();
    const target = resolveBindAddress(conf.BindAddress, interfaces);
    if (!target || target.all) return null;
    if (target.cidr) return networkOf(target.cidr);
    for (const addrs of Object.values(interfaces)) {
        const hit = (addrs || []).find(a => a.address === target.address && a.cidr);
        if (hit) return networkOf(hit.cidr);
    }
    return null;
}

function stepFirewall(ctx) {
    const c = ctx.cfg, fsx = ctx.fsx;
    const present = fsx.existsSync(c.firewallUnitPath);
    const conf = readConfig(ctx) || {};

    if (ctx.opts.firewall === false) {
        if (!present && !fsx.existsSync(c.firewallRules)) return { result: 'ok', detail: 'off' };
        ctx.run('systemctl', ['disable', '--now', c.firewallUnitName]);
        fsx.rmSync(c.firewallUnitPath, { force: true });
        fsx.rmSync(c.firewallRules, { force: true });
        ctx.run('systemctl', ['daemon-reload']);
        return { result: 'changed', detail: 'removed' };
    }
    if (ctx.opts.firewall !== true && !present) {
        const subnet = picoSubnet(ctx, conf);
        return { result: 'ok', detail: `off. To drop connections to port ${conf.TCP_PORT} from outside ${subnet || 'the Pico subnet'}: install --firewall` };
    }

    const subnet = picoSubnet(ctx, conf);
    if (!subnet) return { result: 'failed', detail: `cannot work out the Pico subnet from BindAddress ${conf.BindAddress}; set it to the interface the Picos use` };
    const w1 = writeIfChanged(fsx, c.firewallRules, renderFirewall(conf.TCP_PORT, subnet), 0o644);
    const w2 = writeIfChanged(fsx, c.firewallUnitPath, renderFirewallUnit(c), 0o644);
    const cmds = [];
    if (w2 !== 'unchanged') cmds.push(['daemon-reload']);
    if (ctx.run('systemctl', ['is-enabled', c.firewallUnitName]).stdout !== 'enabled') cmds.push(['enable', c.firewallUnitName]);
    if (w1 !== 'unchanged' || w2 !== 'unchanged' || ctx.run('systemctl', ['is-active', c.firewallUnitName]).stdout !== 'active') cmds.push(['restart', c.firewallUnitName]);
    for (const args of cmds) {
        const r = ctx.run('systemctl', args);
        if (r.status !== 0) return { result: 'failed', detail: `systemctl ${args.join(' ')}: ${lastLine(r.stderr)}` };
    }
    return { result: cmds.length ? 'changed' : 'ok', detail: `port ${conf.TCP_PORT} reachable only from ${subnet}` };
}

function stepService(ctx) {
    const c = ctx.cfg;
    const unit = renderUnit({ user: c.serviceUser, nodePath: ctx.nodePath, cfg: c });
    const w = writeIfChanged(ctx.fsx, c.unitPath, unit, 0o644);
    const restart = w !== 'unchanged' || ctx.flags.appChanged || ctx.flags.configChanged;
    const cmds = [];
    if (w !== 'unchanged') cmds.push(['daemon-reload']);
    if (ctx.run('systemctl', ['is-enabled', c.unitName]).stdout !== 'enabled') cmds.push(['enable', c.unitName]);
    if (restart) cmds.push(['restart', c.unitName]);
    else if (ctx.run('systemctl', ['is-active', c.unitName]).stdout !== 'active') cmds.push(['start', c.unitName]);
    for (const args of cmds) {
        const r = ctx.run('systemctl', args);
        if (r.status !== 0) return { result: 'failed', detail: `systemctl ${args.join(' ')}: ${lastLine(r.stderr)}` };
    }
    if (cmds.length === 0) return { result: 'ok', detail: 'unit unchanged, enabled, active' };
    return { result: 'changed', detail: `${w} unit; ${cmds.map(a => a.join(' ')).join('; ')}` };
}

// Local addresses with a TCP listener on `port`, as ss prints them.
function listeners(ctx, port) {
    const out = ctx.run('ss', ['-H', '-tln']).stdout;
    const found = [];
    for (const line of out.split('\n')) {
        const local = line.trim().split(/\s+/)[3] || '';
        const i = local.lastIndexOf(':');
        if (i > 0 && local.slice(i + 1) === String(port)) found.push(local.slice(0, i));
    }
    return found;
}

// Where the service should be listening, and whether it is.
function listenState(ctx, conf) {
    const port = conf && conf.TCP_PORT;
    const target = conf ? resolveBindAddress(conf.BindAddress, ctx.interfaces()) : null;
    const found = port ? listeners(ctx, port) : [];
    const everywhere = found.some(a => a === '0.0.0.0' || a === '*' || a === '[::]');
    return {
        port, target, found, everywhere,
        ok: !!target && !target.all && found.includes(target.address) && !everywhere
    };
}

// Do not assume: `systemctl start` returning 0 only means the process was
// forked. Wait until it is active and has the port open on the right address.
function stepVerify(ctx) {
    const c = ctx.cfg;
    const conf = readConfig(ctx);
    let active = '', ls = null;
    for (let i = 0; i < 40; i++) {
        active = ctx.run('systemctl', ['is-active', c.unitName]).stdout;
        ls = listenState(ctx, conf);
        if (active === 'active' && ls.found.length > 0) break;
        if (active === 'failed') break;
        ctx.sleep(500);
    }
    const journal = `sudo journalctl -u ${c.unitName} -n 30`;
    if (active !== 'active') return { result: 'failed', detail: `service is ${active || 'not running'}: ${journal}` };
    if (ls.found.length === 0) {
        if (ls.target === null) return { result: 'ok', detail: `active; waiting for ${conf.BindAddress} to get an address before listening on ${ls.port}` };
        return { result: 'failed', detail: `service is active but nothing listens on port ${ls.port}: ${journal}` };
    }
    return { result: 'ok', detail: `active, listening on ${ls.found.map(a => `${a}:${ls.port}`).join(', ')}` };
}

function readManifest(ctx, fromDir) {
    return JSON.parse(ctx.fsx.readFileSync(path.join(fromDir || ctx.cfg.appDir, 'src', 'pi', 'firmware-manifest.json'), 'utf8'));
}

// A child node does the HTTPS download so the installer can stay synchronous.
const DOWNLOAD_SCRIPT = `
const https = require('https'), fs = require('fs');
const [url, dest] = process.argv.slice(1);
function get(u, hops) {
    https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); return get(new URL(res.headers.location, u).href, hops - 1); }
        if (res.statusCode !== 200) { console.error('HTTP ' + res.statusCode + ' for ' + u); process.exit(1); }
        const out = fs.createWriteStream(dest, { mode: 0o644 });
        res.pipe(out);
        out.on('finish', () => out.close(() => process.exit(0)));
        out.on('error', (e) => { console.error(e.message); process.exit(1); });
    }).on('error', (e) => { console.error(e.message); process.exit(1); });
}
get(url, 5);
`;

function downloadTo(ctx, url, dest) {
    if (!/^https:\/\//.test(url)) return { status: 1, stdout: '', stderr: `refusing non-https firmware url ${url}` };
    return ctx.run(ctx.nodePath, ['-e', DOWNLOAD_SCRIPT, url, dest], { timeout: 180000 });
}

// The one moment an internet connection is reasonable to require. Nothing is
// ever downloaded at flash time. Every image is checked against the sha256
// pinned in firmware-manifest.json, whether downloaded or supplied.
function stepFirmware(ctx) {
    const c = ctx.cfg, fsx = ctx.fsx;
    let manifest;
    try { manifest = readManifest(ctx); } catch (e) { return { result: 'failed', detail: `firmware-manifest.json: ${e.message}` }; }
    const fetched = [], problems = [];
    for (const [name, image] of Object.entries(manifest.images)) {
        const dest = path.join(c.firmwareDir, name);
        if (fsx.existsSync(dest) && sha256File(fsx, dest) === image.sha256) continue;
        const tmp = `${dest}.part`;
        fsx.rmSync(tmp, { force: true });
        let got = null;
        if (ctx.opts.firmwareFrom) {
            const local = [name, path.basename(image.url)].map(n => path.join(ctx.opts.firmwareFrom, n)).find(p => fsx.existsSync(p));
            if (local) { fsx.copyFileSync(local, tmp); got = local; }
            else { problems.push(`${name}: not in ${ctx.opts.firmwareFrom}`); continue; }
        } else {
            const r = ctx.download(image.url, tmp);
            if (r.status !== 0) { fsx.rmSync(tmp, { force: true }); problems.push(`${name}: download failed (${lastLine(r.stderr)})`); continue; }
            got = image.url;
        }
        const sum = sha256File(fsx, tmp);
        if (sum !== image.sha256) {
            fsx.rmSync(tmp, { force: true });
            problems.push(`${name}: sha256 of ${got} is ${sum.slice(0, 12)}..., expected ${image.sha256.slice(0, 12)}...; not cached`);
            continue;
        }
        fsx.chmodSync(tmp, 0o644);
        fsx.renameSync(tmp, dest);
        fetched.push(name);
    }
    const on = fsx.existsSync(path.join(c.firmwareDir, 'autoflash-enabled'));
    const tail = `MicroPython ${manifest.version}; auto-flash ${on ? 'ON' : `off: sudo touch ${path.join(c.firmwareDir, 'autoflash-enabled')} to turn it on`}`;
    if (problems.length) {
        return { result: 'failed', detail: `${problems.join('; ')}. Re-run install when online, or pass --firmware-from <dir holding the .uf2 files>` };
    }
    return { result: fetched.length ? 'changed' : 'ok', detail: `${fetched.length ? `cached ${fetched.join(', ')}; ` : ''}${tail}` };
}

const INSTALL_STEPS = [
    ['apt packages', stepAptPackages],
    ['service user', stepServiceUser],
    ['directories', stepDirectories],
    ['application', stepApp],
    ['rshell venv', stepVenv],
    ['config.yaml', stepConfig],
    ['serial map, key store', stepState],
    ['udev rules', stepUdevRules],
    ['firewall', stepFirewall],
    ['systemd service', stepService],
    ['service running', stepVerify],
    ['firmware cache', stepFirmware]
];

function install(ctx) {
    if (!ctx.isRoot) { ctx.log('install needs root: run it as  sudo remote-serial-pico install'); return 2; }
    if (!ctx.user) { ctx.log('cannot tell who is installing: run it with sudo from your normal login, not as root directly'); return 2; }
    if (!SAFE_USER.test(ctx.user) || !SAFE_USER.test(ctx.cfg.serviceUser)) { ctx.log(`refusing an unusual user name: ${ctx.user} / ${ctx.cfg.serviceUser}`); return 2; }
    if (!SAFE_ROOT.test(ctx.cfg.root)) { ctx.log(`--root must be an absolute path of letters, digits, . _ - and /: got ${ctx.cfg.root}`); return 2; }
    if (ctx.opts.firmwareFrom) ctx.opts.firmwareFrom = path.resolve(ctx.opts.firmwareFrom);
    if (typeof process.umask === 'function') process.umask(0o022);

    ctx.log(`Installing into ${ctx.cfg.root} for ${ctx.user}; service runs as ${ctx.cfg.serviceUser} (node: ${ctx.nodePath})`);
    let changed = 0, failed = 0;
    for (const [name, fn] of INSTALL_STEPS) {
        let res;
        try { res = fn(ctx); } catch (e) { res = { result: 'failed', detail: e.message }; }
        const tag = { ok: '  ok   ', changed: 'CHANGED', failed: 'FAILED ' }[res.result];
        ctx.log(`${tag}  ${name.padEnd(22)} ${res.detail}`);
        if (res.result === 'changed') changed++;
        if (res.result === 'failed') { failed++; break; }
    }
    ctx.log(failed ? `\nStopped at the first failure. Fix it and run install again; finished steps are skipped.`
                   : `\nDone. ${changed} change(s). Run  remote-serial-pico doctor  to verify.`);
    return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor: every component, with a hint when it is wrong
// ---------------------------------------------------------------------------

function doctorChecks(ctx) {
    const c = ctx.cfg, fsx = ctx.fsx, checks = [];
    const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint: ok ? '' : hint });
    const stat = (p) => { try { return fsx.statSync(p); } catch { return null; } };
    const reinstall = 'sudo remote-serial-pico install';

    add('node', true, process.version, '');

    // Commands the scripts call at runtime. A package can be half-removed and
    // still satisfy dpkg, so check the commands themselves.
    const needCmd = { python3: 'python3', udisksctl: 'udisks2', ip: 'iproute2', ss: 'iproute2' };
    const missingCmd = Object.keys(needCmd).filter(cmd => ctx.run('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd]).status !== 0);
    add('required commands', missingCmd.length === 0,
        missingCmd.length ? `missing: ${missingCmd.join(', ')}` : Object.keys(needCmd).join(', '),
        `sudo apt-get install -y ${[...new Set(missingCmd.map(cmd => needCmd[cmd]))].join(' ')}`);

    const rootSt = stat(c.root);
    add('install root', !!rootSt, rootSt ? c.root : `${c.root} missing`, reinstall);

    // udev runs the provisioning scripts as root. Anything root executes or
    // reads must be root-owned and writable by nobody else, or whoever can
    // write it is root (issue #19 review, S2).
    const rules = renderedRules(ctx);
    const rootRun = [c.root, c.appDir, path.join(c.appDir, 'src', 'pi'), path.join(c.appDir, 'src', 'pico'),
        path.join(c.appDir, 'src', 'pi', 'PicoScriptDeployer.py'), path.join(c.appDir, 'src', 'pi', 'PicoFirmwareFlasher.py'),
        path.join(c.appDir, 'src', 'pi', 'rsp_config.py'), c.venvDir, path.join(c.venvDir, 'bin'),
        path.join(c.venvDir, 'bin', 'python'), path.join(c.venvDir, 'bin', 'rshell'),
        c.firmwareDir, c.logDir, c.configPath, ...rules.map(r => r.dst)];
    const unsafe = [];
    for (const p of rootRun) {
        const st = stat(p);
        if (!st) continue;   // absence is reported by the check for that component
        if (st.uid !== ctx.rootUid) unsafe.push(`${p} is not owned by root`);
        else if (st.mode & 0o022) unsafe.push(`${p} is writable by group or others (${(st.mode & 0o777).toString(8)})`);
    }
    add('root-run files', unsafe.length === 0, unsafe.length ? unsafe.join('; ') : 'owned by root, not writable by anyone else',
        `${reinstall}   (or: sudo chown -R root:root ${c.appDir} ${c.venvDir} && sudo chmod -R go-w ${c.root})`);

    const stamp = readStamp(fsx, c.appDir);
    let appOk = !!stamp, appDetail = 'not installed';
    if (stamp) {
        const same = path.resolve(c.sourceDir) === path.resolve(c.appDir) || stamp.hash === treeHash(fsx, c.sourceDir);
        appOk = same;
        appDetail = same ? `${stamp.version} in ${c.appDir}` : `${stamp.version} installed, but this command is ${packageVersion(fsx, c.sourceDir)} with different files`;
    }
    add('application', appOk, appDetail, `${reinstall}   (upgrades in place)`);

    // Not "is the folder there": does node-pty load under the node the unit starts.
    const serviceNode = (ctx.installed && ctx.installed.nodePath) || ctx.nodePath;
    const loads = fsx.existsSync(path.join(c.appDir, 'node_modules', 'node-pty')) ? nodePtyLoads(ctx, c.appDir, serviceNode) : { status: 1, stderr: 'node_modules/node-pty missing' };
    add('node-pty loads', loads.status === 0, loads.status === 0 ? `under ${serviceNode}` : `under ${serviceNode}: ${lastLine(loads.stderr)}`,
        `${reinstall}   (run it with the node the service should use)`);

    add('rshell venv', fsx.existsSync(path.join(c.venvDir, 'bin', 'rshell')), path.join(c.venvDir, 'bin', 'rshell'), reinstall);

    const conf = readConfig(ctx);
    const missingKeys = conf ? CONFIG_KEYS.filter(k => !(k in conf)) : CONFIG_KEYS;
    add('config.yaml', !!conf && missingKeys.length === 0,
        conf ? (missingKeys.length ? `missing ${missingKeys.join(', ')}` : `${c.configPath}: port ${conf.TCP_PORT}, bind ${conf.BindAddress}`) : `${c.configPath} missing`,
        conf ? `add the missing keys to ${c.configPath} from ${path.join(c.appDir, 'src', 'pi', 'config.example.yaml')}` : reinstall);

    const svc = ctx.ids(c.serviceUser);
    add('service user', !!svc, svc ? c.serviceUser : `${c.serviceUser} does not exist`, reinstall);

    if (conf) {
        const svcOwned = (p) => { const st = stat(p); return !!st && !!svc && st.uid === svc.uid; };
        const dirs = [conf.symlinkDir, conf.PicoSerialMap && path.dirname(conf.PicoSerialMap)].filter(Boolean);
        const badDirs = dirs.filter(d => !svcOwned(d) || isWorldWritable(fsx, d));
        add('service directories', dirs.length > 0 && badDirs.length === 0,
            badDirs.length ? badDirs.map(d => `${d} ${stat(d) ? (isWorldWritable(fsx, d) ? 'is world-writable' : `is not owned by ${c.serviceUser}`) : 'missing'}`).join('; ') : dirs.join(', '),
            `${reinstall}   (or: sudo chown ${c.serviceUser} ${badDirs.join(' ')} && sudo chmod 755 ${badDirs.join(' ')})`);

        const sec = conf.PicoSecrets ? stat(conf.PicoSecrets) : null;
        const secOk = !!sec && (sec.mode & 0o777) === 0o600 && !!svc && sec.uid === svc.uid;
        add('key store', secOk,
            sec ? (secOk ? `${conf.PicoSecrets} (0600, ${c.serviceUser})` : `${conf.PicoSecrets} is mode ${(sec.mode & 0o777).toString(8)}, owner uid ${sec.uid}; must be 600 and owned by ${c.serviceUser}`) : `${conf.PicoSecrets || 'PicoSecrets'} missing`,
            sec ? `sudo chown ${c.serviceUser} ${conf.PicoSecrets} && sudo chmod 600 ${conf.PicoSecrets}` : reinstall);

        add('serial map', !!(conf.PicoSerialMap && stat(conf.PicoSerialMap)), conf.PicoSerialMap || 'PicoSerialMap', reinstall);

        add('syslog socket', !!(conf.SyslogDir && fsx.existsSync(conf.SyslogDir)), conf.SyslogDir || 'SyslogDir', 'PtyServer logs to syslog; is rsyslog/journald listening on /dev/log?');
    }

    const unitThere = fsx.existsSync(c.unitPath);
    const enabled = ctx.run('systemctl', ['is-enabled', c.unitName]).stdout;
    const active = ctx.run('systemctl', ['is-active', c.unitName]).stdout;
    add('service installed', unitThere, c.unitPath, reinstall);
    add('service enabled at boot', enabled === 'enabled', enabled || 'not enabled', `sudo systemctl enable ${c.unitName}`);
    add('service running', active === 'active', active || 'inactive', `sudo systemctl start ${c.unitName}; sudo journalctl -u ${c.unitName} -n 30`);

    const ls = listenState(ctx, conf);
    let listenDetail, listenHint;
    if (ls.ok) {
        listenDetail = `${ls.target.address}:${ls.port} (${ls.target.source})`;
    } else if (ls.everywhere || (ls.target && ls.target.all)) {
        listenDetail = `port ${ls.port} is open on every interface`;
        listenHint = `set BindAddress in ${c.configPath} to the interface the Picos use (e.g. wlan0), then sudo systemctl restart ${c.unitName}`;
    } else if (!ls.target) {
        listenDetail = conf ? `BindAddress ${conf.BindAddress} has no IPv4 address` : 'no config.yaml';
        listenHint = `bring that interface up, or set BindAddress in ${c.configPath} to the interface the Picos use`;
    } else {
        listenDetail = ls.found.length ? `expected ${ls.target.address}:${ls.port}, found ${ls.found.map(a => `${a}:${ls.port}`).join(', ')}` : `nothing listening on ${ls.target.address}:${ls.port}`;
        listenHint = `sudo systemctl restart ${c.unitName}; sudo journalctl -u ${c.unitName} -n 30`;
    }
    add('listening address', ls.ok, listenDetail, listenHint);

    for (const r of rules) {
        let same = false, detail = 'not installed';
        try {
            same = fsx.readFileSync(r.dst, 'utf8') === r.content;
            detail = same ? 'installed, matches the app' : 'installed but differs from the app';
        } catch {}
        add(`udev rule ${r.name}`, same, detail, reinstall);
    }
    if (rules.length === 0) add('udev rules', false, `no rule templates in ${c.appDir}`, reinstall);

    // A cache that exists but is empty flashes nothing: check every image.
    let fwOk = false, fwDetail = 'firmware-manifest.json missing';
    try {
        const manifest = readManifest(ctx);
        const bad = [];
        for (const [name, image] of Object.entries(manifest.images)) {
            const file = path.join(c.firmwareDir, name);
            if (!fsx.existsSync(file)) bad.push(`${name} missing`);
            else if (sha256File(fsx, file) !== image.sha256) bad.push(`${name} does not match the pinned sha256`);
        }
        fwOk = bad.length === 0;
        const killSwitch = fsx.existsSync(path.join(c.firmwareDir, 'autoflash-enabled'));
        fwDetail = `${fwOk ? `${Object.keys(manifest.images).join(', ')} (MicroPython ${manifest.version})` : bad.join('; ')}; auto-flash ${killSwitch ? 'ON' : 'off'}`;
    } catch {}
    add('firmware cache', fwOk, fwDetail, `${reinstall}   (online, or with --firmware-from <dir>)`);

    if (fsx.existsSync(c.firewallUnitPath)) {
        const fw = ctx.run('systemctl', ['is-active', c.firewallUnitName]).stdout;
        add('firewall', fw === 'active', fw === 'active' ? `port limited to the Pico subnet (${c.firewallRules})` : (fw || 'inactive'), `sudo systemctl restart ${c.firewallUnitName}`);
    }

    return checks;
}

function doctor(ctx) {
    const checks = doctorChecks(ctx);
    for (const ch of checks) {
        ctx.log(`${ch.ok ? ' OK ' : 'FAIL'}  ${ch.name.padEnd(26)} ${ch.detail}${ch.hint ? `\n      -> ${ch.hint}` : ''}`);
    }
    const bad = checks.filter(ch => !ch.ok).length;
    ctx.log(bad ? `\n${bad} problem(s).` : '\nAll good.');
    return bad ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status: what is it doing right now
// ---------------------------------------------------------------------------

function status(ctx) {
    const c = ctx.cfg;
    const conf = readConfig(ctx);
    const active = ctx.run('systemctl', ['is-active', c.unitName]).stdout || 'unknown';
    const enabled = ctx.run('systemctl', ['is-enabled', c.unitName]).stdout || 'unknown';
    const ls = listenState(ctx, conf);
    const where = ls.found.length ? `listening on ${ls.found.map(a => `${a}:${ls.port}`).join(', ')}` : `NOT listening on ${ls.port || 'any port'}`;
    ctx.log(`service   ${active} (${enabled} at boot), ${where}`);

    if (conf && conf.PicoSerialMap) {
        let map = {};
        try { map = parseFlatYaml(ctx.fsx.readFileSync(conf.PicoSerialMap, 'utf8')); } catch {}
        const state = (conf.StateFile && readState(conf.StateFile, ctx.fsx)) || { picos: {} };
        const entries = Object.entries(map);
        if (entries.length === 0) ctx.log('picos     none registered yet');
        for (const [serial, rawName] of entries) {
            const name = String(rawName);
            const link = path.join(conf.symlinkDir, name);
            let port = 'no port';
            let live = false;
            try {
                const target = ctx.fsx.readlinkSync(link);
                live = ctx.fsx.existsSync(target);
                port = live ? `port ${link} -> ${target}` : `stale port ${link} (server restarted?)`;
            } catch {}
            const seen = state.picos[name];
            const connected = !!seen && seen.connected && live && active === 'active';
            const stale = seen && state.expectedHash && seen.hash !== state.expectedHash ? `, NOT what this Pi deploys (${state.expectedHash}): plug it in to update` : '';
            const fw = seen ? `firmware ${seen.firmware || '?'} (${seen.protocol || '?'}, hash ${seen.hash || '?'}${stale})` : 'firmware unknown (not seen since the server last started)';
            ctx.log(`pico      ${name.padEnd(20)} ${connected ? 'connected    ' : 'not connected'}  ${fw}`);
            ctx.log(`          ${''.padEnd(20)} serial ${serial}, ${port}`);
        }
    }

    let uf2 = [];
    try { uf2 = ctx.fsx.readdirSync(c.firmwareDir).filter(n => n.endsWith('.uf2')); } catch {}
    const killSwitch = ctx.fsx.existsSync(path.join(c.firmwareDir, 'autoflash-enabled'));
    ctx.log(`autoflash ${killSwitch ? 'ON' : 'off'}${uf2.length ? ` (${uf2.join(', ')})` : ' (no firmware cached)'}`);

    if (conf && conf.CustomlogDir) {
        let tail = '';
        try { tail = ctx.fsx.readFileSync(conf.CustomlogDir, 'utf8').trimEnd().split('\n').slice(-5).join('\n'); } catch {}
        if (tail) ctx.log(`log       ${conf.CustomlogDir}\n` + tail.split('\n').map(l => '          ' + l).join('\n'));
    }
    return 0;
}

function usage() {
    return [
        'usage: remote-serial-pico <command> [options]',
        '',
        '  install, i   set up this Pi: packages, service user, the install tree, rshell venv,',
        '               config.yaml, key store, udev rules, service, MicroPython firmware cache.',
        '               Safe to run again: finished steps are skipped, a newer package upgrades',
        '               in place, and config.yaml, the serial map and the key store are never',
        '               overwritten. Needs sudo.',
        '  doctor       check every component and say how to fix what is wrong',
        '  status       is the service up, which Picos are connected and on what firmware',
        '',
        'options:',
        `  --root <dir>           install root (default ${DEFAULT_ROOT}); everything lives under it.`,
        '                         Remembered after the first install.',
        `  --user <name>          run the service as an existing user instead of creating ${DEFAULT_SERVICE_USER}`,
        '  --firewall             also drop connections to the Pico port from outside the Pico subnet',
        '  --no-firewall          remove that rule again',
        '  --firmware-from <dir>  take the MicroPython .uf2 files from a directory instead of downloading',
        ''
    ].join('\n');
}

module.exports = {
    DEFAULT_ROOT, ROOT_ENV, DEFAULT_SERVICE_USER, SYSTEM, CONFIG_KEYS, layout,
    exec, parseFlatYaml, writeIfChanged, ensureDir, isWorldWritable, sha256File,
    resolveUser, parseArgs, readInstalledUnit, makeContext,
    fillTemplate, renderConfig, renderUnit, renderedRules, renderFirewall, renderFirewallUnit,
    treeFiles, treeHash, readStamp,
    packageInstalled, stepAptPackages, stepServiceUser, stepDirectories, stepApp, stepVenv, stepConfig, stepState,
    stepUdevRules, stepFirewall, stepService, stepVerify, stepFirmware, listeners, listenState, picoSubnet,
    INSTALL_STEPS, install, doctorChecks, doctor, status, usage
};
