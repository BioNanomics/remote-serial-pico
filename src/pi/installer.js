'use strict';
// install / doctor / status for the Pi side of remote-serial-pico.
//
// Plain Node with no dependencies, on purpose: this runs before `npm install`
// has happened in the clone, so nothing from package.json can be assumed.
// Every path is in DEFAULTS and every external effect goes through `run` and
// `fsx`, so the tests can point the whole thing at a temp directory and a fake
// shell.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULTS = Object.freeze({
    projectDir: '/home/project',
    repoUrl: 'https://github.com/BioNanomics/remote-serial-pico',
    cloneDir: '/home/project/remote-serial-pico',
    venvDir: '/home/project/myenv',
    firmwareDir: '/home/project/firmware',
    unitPath: '/etc/systemd/system/ptyserver.service',
    unitName: 'ptyserver.service',
    rulesDir: '/etc/udev/rules.d',
    tcpPort: 50000,
    syslogSocket: '/dev/log',
    aptPackages: ['git', 'python3', 'python3-venv', 'python3-pip', 'build-essential', 'udisks2']
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sh(cmd, opts = {}) {
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
    return { status: r.status === null ? 1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function renderConfig(cfg = DEFAULTS) {
    return [
        `PicoSerialMap: '${cfg.projectDir}/pico_serial_map.yaml'`,
        `symlinkDir: '${cfg.projectDir}'`,
        `SyslogDir: '${cfg.syslogSocket}'`,
        `CustomlogDir: '/tmp/smartHome.log'`,
        `TCP_PORT: ${cfg.tcpPort}`,
        ''
    ].join('\n');
}

function renderUnit({ user, nodePath, cloneDir }) {
    return [
        '[Unit]',
        'Description=PtyServer Node.js Service',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        `WorkingDirectory=${cloneDir}/src/pi`,
        `ExecStart=${nodePath} PtyServer.js`,
        'Restart=always',
        'RestartSec=3',
        `User=${user}`,
        'Environment=NODE_ENV=production',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=ptyserver',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
    ].join('\n');
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
    if (existing === content) return 'unchanged';
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(file, content, { mode });
    if (mode !== undefined) fsx.chmodSync(file, mode);
    return existing === null ? 'created' : 'updated';
}

function ensureDir(fsx, dir, mode) {
    if (fsx.existsSync(dir)) {
        if (mode !== undefined) fsx.chmodSync(dir, mode);
        return 'unchanged';
    }
    fsx.mkdirSync(dir, { recursive: true, mode });
    if (mode !== undefined) fsx.chmodSync(dir, mode);
    return 'created';
}

function isWorldWritable(fsx, p) {
    try { return (fsx.statSync(p).mode & 0o002) !== 0; } catch { return false; }
}

// Who should own the files and run the service: the person who typed sudo.
function resolveUser(env = process.env) {
    if (env.SUDO_USER && env.SUDO_USER !== 'root') return env.SUDO_USER;
    const me = os.userInfo().username;
    return me === 'root' ? null : me;
}

function makeContext(overrides = {}) {
    const cfg = { ...DEFAULTS, ...(overrides.cfg || {}) };
    return {
        cfg,
        run: overrides.run || sh,
        fsx: overrides.fsx || fs,
        log: overrides.log || ((s) => process.stdout.write(s + '\n')),
        user: overrides.user !== undefined ? overrides.user : resolveUser(),
        nodePath: overrides.nodePath || process.execPath,
        isRoot: overrides.isRoot !== undefined ? overrides.isRoot : (typeof process.getuid === 'function' && process.getuid() === 0)
    };
}

// ---------------------------------------------------------------------------
// install: one step per README "manual way" item, each idempotent
// ---------------------------------------------------------------------------

function stepAptPackages(ctx) {
    const missing = ctx.cfg.aptPackages.filter(p => ctx.run(`dpkg -s ${p} >/dev/null 2>&1`).status !== 0);
    if (missing.length === 0) return { result: 'ok', detail: 'all present' };
    const r = ctx.run(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${missing.join(' ')}`);
    if (r.status !== 0) return { result: 'failed', detail: `apt-get failed: ${r.stderr.split('\n').pop()}` };
    return { result: 'changed', detail: `installed ${missing.join(', ')}` };
}

function stepProjectDir(ctx) {
    // 755 owned by the user, not 777: issue #19 lists the world-writable
    // directory as a local privilege-escalation hole.
    const r = ensureDir(ctx.fsx, ctx.cfg.projectDir, 0o755);
    const chown = ctx.run(`chown ${ctx.user}:${ctx.user} '${ctx.cfg.projectDir}'`);
    if (chown.status !== 0) return { result: 'failed', detail: chown.stderr };
    return { result: r === 'created' ? 'changed' : 'ok', detail: `${ctx.cfg.projectDir} 755 ${ctx.user}` };
}

function stepVenv(ctx) {
    const rshell = path.join(ctx.cfg.venvDir, 'bin', 'rshell');
    if (ctx.fsx.existsSync(rshell)) return { result: 'ok', detail: 'rshell present' };
    const r = ctx.run(`sudo -u ${ctx.user} python3 -m venv '${ctx.cfg.venvDir}' && sudo -u ${ctx.user} '${ctx.cfg.venvDir}/bin/pip' install -q rshell`);
    if (r.status !== 0) return { result: 'failed', detail: r.stderr.split('\n').pop() };
    return { result: 'changed', detail: 'created venv and installed rshell' };
}

function stepClone(ctx) {
    if (ctx.fsx.existsSync(path.join(ctx.cfg.cloneDir, '.git'))) {
        // Never pull automatically: a re-run must not change what a running
        // box executes. `doctor` reports if the checkout is behind.
        return { result: 'ok', detail: 'checkout present (not pulled)' };
    }
    const r = ctx.run(`sudo -u ${ctx.user} git clone -q '${ctx.cfg.repoUrl}' '${ctx.cfg.cloneDir}'`);
    if (r.status !== 0) return { result: 'failed', detail: r.stderr.split('\n').pop() };
    return { result: 'changed', detail: `cloned ${ctx.cfg.repoUrl}` };
}

function stepNpmInstall(ctx) {
    // In the clone, as the user, after the clone exists: the three things the
    // old installer got wrong.
    if (ctx.fsx.existsSync(path.join(ctx.cfg.cloneDir, 'node_modules', 'node-pty'))) return { result: 'ok', detail: 'node-pty present' };
    const r = ctx.run(`cd '${ctx.cfg.cloneDir}' && sudo -u ${ctx.user} npm install --no-audit --no-fund --loglevel=error`);
    if (r.status !== 0) return { result: 'failed', detail: r.stderr.split('\n').pop() };
    return { result: 'changed', detail: 'npm install' };
}

function stepConfig(ctx) {
    const file = path.join(ctx.cfg.cloneDir, 'src', 'pi', 'config.yaml');
    if (ctx.fsx.existsSync(file)) return { result: 'ok', detail: 'config.yaml present (left alone)' };
    writeIfChanged(ctx.fsx, file, renderConfig(ctx.cfg), 0o644);
    ctx.run(`chown ${ctx.user}:${ctx.user} '${file}'`);
    return { result: 'changed', detail: `wrote ${file}` };
}

function stepFirmwareDir(ctx) {
    const r = ensureDir(ctx.fsx, ctx.cfg.firmwareDir, 0o755);
    const on = ctx.fsx.existsSync(path.join(ctx.cfg.firmwareDir, 'autoflash-enabled'));
    return { result: r === 'created' ? 'changed' : 'ok', detail: `${ctx.cfg.firmwareDir} (auto-flash ${on ? 'ON' : 'off: create autoflash-enabled there to turn it on'})` };
}

function repoRules(ctx) {
    const dir = path.join(ctx.cfg.cloneDir, 'src', 'pi');
    let names = [];
    try { names = ctx.fsx.readdirSync(dir).filter(n => n.endsWith('.rules')); } catch { /* no clone */ }
    return names.map(n => ({ name: n, src: path.join(dir, n), dst: path.join(ctx.cfg.rulesDir, n) }));
}

function stepUdevRules(ctx) {
    const rules = repoRules(ctx);
    if (rules.length === 0) return { result: 'failed', detail: 'no *.rules files found in the checkout' };
    const changed = [];
    for (const r of rules) {
        const content = ctx.fsx.readFileSync(r.src, 'utf8');
        if (writeIfChanged(ctx.fsx, r.dst, content, 0o644) !== 'unchanged') changed.push(r.name);
    }
    if (changed.length === 0) return { result: 'ok', detail: rules.map(r => r.name).join(', ') + ' up to date' };
    const rl = ctx.run('udevadm control --reload-rules && udevadm trigger');
    if (rl.status !== 0) return { result: 'failed', detail: rl.stderr };
    return { result: 'changed', detail: `installed ${changed.join(', ')}` };
}

function stepService(ctx) {
    const unit = renderUnit({ user: ctx.user, nodePath: ctx.nodePath, cloneDir: ctx.cfg.cloneDir });
    const w = writeIfChanged(ctx.fsx, ctx.cfg.unitPath, unit, 0o644);
    const cmds = [];
    if (w !== 'unchanged') cmds.push('systemctl daemon-reload');
    if (ctx.run(`systemctl is-enabled ${ctx.cfg.unitName} >/dev/null 2>&1`).status !== 0) cmds.push(`systemctl enable ${ctx.cfg.unitName}`);
    if (w !== 'unchanged') cmds.push(`systemctl restart ${ctx.cfg.unitName}`);
    else if (ctx.run(`systemctl is-active ${ctx.cfg.unitName} >/dev/null 2>&1`).status !== 0) cmds.push(`systemctl start ${ctx.cfg.unitName}`);
    for (const c of cmds) {
        const r = ctx.run(c);
        if (r.status !== 0) return { result: 'failed', detail: `${c}: ${r.stderr}` };
    }
    if (cmds.length === 0) return { result: 'ok', detail: 'unit unchanged, enabled, active' };
    return { result: 'changed', detail: `${w} unit; ${cmds.join('; ')}` };
}

const INSTALL_STEPS = [
    ['apt packages', stepAptPackages],
    ['project directory', stepProjectDir],
    ['rshell venv', stepVenv],
    ['repository checkout', stepClone],
    ['npm install', stepNpmInstall],
    ['config.yaml', stepConfig],
    ['firmware cache', stepFirmwareDir],
    ['udev rules', stepUdevRules],
    ['systemd service', stepService]
];

function install(ctx) {
    if (!ctx.isRoot) { ctx.log('install needs root: run it as  sudo remote-serial-pico install'); return 2; }
    if (!ctx.user) { ctx.log('cannot tell which user should own the install: run it with sudo from your normal login, not as root directly'); return 2; }
    ctx.log(`Installing for user ${ctx.user} (node: ${ctx.nodePath})`);
    let changed = 0, failed = 0;
    for (const [name, fn] of INSTALL_STEPS) {
        let res;
        try { res = fn(ctx); } catch (e) { res = { result: 'failed', detail: e.message }; }
        const tag = { ok: '  ok   ', changed: 'CHANGED', failed: 'FAILED ' }[res.result];
        ctx.log(`${tag}  ${name.padEnd(20)} ${res.detail}`);
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

function readConfig(ctx) {
    const file = path.join(ctx.cfg.cloneDir, 'src', 'pi', 'config.yaml');
    try { return parseFlatYaml(ctx.fsx.readFileSync(file, 'utf8')); } catch { return null; }
}

function doctorChecks(ctx) {
    const c = ctx.cfg, checks = [];
    const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint: ok ? '' : hint });

    add('node', true, process.version, '');

    add('project directory', ctx.fsx.existsSync(c.projectDir) && !isWorldWritable(ctx.fsx, c.projectDir),
        ctx.fsx.existsSync(c.projectDir) ? (isWorldWritable(ctx.fsx, c.projectDir) ? 'world-writable (777)' : 'present, not world-writable') : 'missing',
        `sudo chmod 755 ${c.projectDir}`);

    add('rshell venv', ctx.fsx.existsSync(path.join(c.venvDir, 'bin', 'rshell')), path.join(c.venvDir, 'bin', 'rshell'), 'run install');

    const git = ctx.fsx.existsSync(path.join(c.cloneDir, '.git'));
    let gitDetail = 'missing';
    if (git) {
        const head = ctx.run(`git -C '${c.cloneDir}' log --oneline -1`).stdout;
        const behind = ctx.run(`git -C '${c.cloneDir}' fetch -q 2>/dev/null; git -C '${c.cloneDir}' rev-list --count HEAD..@{u} 2>/dev/null`).stdout;
        gitDetail = head + (behind && behind !== '0' ? `  (${behind} commit(s) behind origin)` : '');
    }
    add('repository checkout', git, gitDetail, 'run install');

    add('node modules', ctx.fsx.existsSync(path.join(c.cloneDir, 'node_modules', 'node-pty')), 'node-pty', `cd ${c.cloneDir} && npm install`);

    const conf = readConfig(ctx);
    const need = ['PicoSerialMap', 'symlinkDir', 'SyslogDir', 'CustomlogDir', 'TCP_PORT'];
    const missingKeys = conf ? need.filter(k => !(k in conf)) : need;
    add('config.yaml', !!conf && missingKeys.length === 0, conf ? (missingKeys.length ? `missing ${missingKeys.join(', ')}` : `port ${conf.TCP_PORT}, ports in ${conf.symlinkDir}`) : 'missing', 'run install, or see README "Write src/pi/config.yaml"');

    if (conf && conf.symlinkDir) {
        let writable = false;
        try { ctx.fsx.accessSync(conf.symlinkDir, fs.constants.W_OK); writable = true; } catch {}
        add('symlink directory', writable, conf.symlinkDir, `the service user must be able to write ${conf.symlinkDir}`);
    }

    add('syslog socket', ctx.fsx.existsSync(c.syslogSocket), c.syslogSocket, 'PtyServer logs to syslog; is rsyslog/journald listening on /dev/log?');

    const unitThere = ctx.fsx.existsSync(c.unitPath);
    const enabled = ctx.run(`systemctl is-enabled ${c.unitName} 2>/dev/null`).stdout;
    const active = ctx.run(`systemctl is-active ${c.unitName} 2>/dev/null`).stdout;
    add('service installed', unitThere, c.unitPath, 'run install');
    add('service enabled at boot', enabled === 'enabled', enabled || 'not enabled', `sudo systemctl enable ${c.unitName}`);
    add('service running', active === 'active', active || 'inactive', `sudo systemctl start ${c.unitName}; sudo journalctl -u ${c.unitName} -n 30`);

    const port = (conf && conf.TCP_PORT) || c.tcpPort;
    const listening = ctx.run(`ss -tln 2>/dev/null | grep -q ':${port} '`).status === 0;
    add('listening on tcp port', listening, String(port), 'service up but not listening: check journalctl for a config.yaml error');

    for (const r of repoRules(ctx)) {
        let same = false, detail = 'not installed';
        try {
            same = ctx.fsx.readFileSync(r.src, 'utf8') === ctx.fsx.readFileSync(r.dst, 'utf8');
            detail = same ? 'installed, matches repo' : 'installed but differs from repo';
        } catch {}
        add(`udev rule ${r.name}`, same, detail, `sudo cp ${r.src} ${c.rulesDir}/ && sudo udevadm control --reload-rules`);
    }

    let uf2 = [];
    try { uf2 = ctx.fsx.readdirSync(c.firmwareDir).filter(n => n.endsWith('.uf2')); } catch {}
    const killSwitch = ctx.fsx.existsSync(path.join(c.firmwareDir, 'autoflash-enabled'));
    add('firmware cache', ctx.fsx.existsSync(c.firmwareDir), (uf2.length ? uf2.join(', ') : 'no .uf2 files') + `; auto-flash ${killSwitch ? 'ON' : 'off'}`, 'run install');

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
    const active = ctx.run(`systemctl is-active ${c.unitName} 2>/dev/null`).stdout || 'unknown';
    const enabled = ctx.run(`systemctl is-enabled ${c.unitName} 2>/dev/null`).stdout || 'unknown';
    const port = (conf && conf.TCP_PORT) || c.tcpPort;
    const listening = ctx.run(`ss -tln 2>/dev/null | grep -q ':${port} '`).status === 0;
    ctx.log(`service   ${active} (${enabled} at boot), ${listening ? 'listening' : 'NOT listening'} on ${port}`);

    if (conf && conf.PicoSerialMap) {
        let map = {};
        try { map = parseFlatYaml(ctx.fsx.readFileSync(conf.PicoSerialMap, 'utf8')); } catch {}
        const names = Object.values(map);
        if (names.length === 0) ctx.log('picos     none registered yet');
        for (const name of names) {
            const link = path.join(conf.symlinkDir, String(name));
            let state = 'no port';
            try { const target = ctx.fsx.readlinkSync(link); state = ctx.fsx.existsSync(target) ? `port ${link} -> ${target}` : `stale port ${link} (server restarted?)`; } catch {}
            ctx.log(`pico      ${String(name).padEnd(20)} ${state}`);
        }
    }

    let uf2 = [];
    try { uf2 = ctx.fsx.readdirSync(c.firmwareDir).filter(n => n.endsWith('.uf2')); } catch {}
    const killSwitch = ctx.fsx.existsSync(path.join(c.firmwareDir, 'autoflash-enabled'));
    ctx.log(`autoflash ${killSwitch ? 'ON' : 'off'}${uf2.length ? ` (${uf2.join(', ')})` : ' (no firmware cached)'}`);

    if (conf && conf.CustomlogDir) {
        const tail = ctx.run(`tail -n 5 '${conf.CustomlogDir}' 2>/dev/null`).stdout;
        if (tail) ctx.log(`log       ${conf.CustomlogDir}\n` + tail.split('\n').map(l => '          ' + l).join('\n'));
    }
    return 0;
}

function usage() {
    return [
        'usage: remote-serial-pico <command>',
        '',
        '  install, i   set up this Pi: packages, /home/project, rshell venv, checkout,',
        '               npm install, config.yaml, firmware cache, udev rules, service.',
        '               Safe to run again; finished steps are skipped. Needs sudo.',
        '  doctor       check every component and say how to fix what is wrong',
        '  status       is the service up, which Picos are connected, is auto-flash on',
        ''
    ].join('\n');
}

module.exports = {
    DEFAULTS, sh, renderConfig, renderUnit, parseFlatYaml, writeIfChanged, ensureDir, isWorldWritable,
    resolveUser, makeContext,
    stepAptPackages, stepProjectDir, stepVenv, stepClone, stepNpmInstall, stepConfig, stepFirmwareDir, stepUdevRules, stepService,
    INSTALL_STEPS, install, doctorChecks, doctor, status, usage
};
