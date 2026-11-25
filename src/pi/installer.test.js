// Run with:  node --test src/pi/
// Everything runs against a temp directory and a fake command runner, so these
// never touch /opt, systemd or udev on the machine running them.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('./installer.js');

const REPO = path.resolve(__dirname, '..', '..');
const ME = { uid: process.getuid(), gid: process.getgid() };
const IFACES = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [{ family: 'IPv4', address: '10.3.177.167', internal: false, cidr: '10.3.177.167/16' }],
    wlan0: [{ family: 'IPv4', address: '10.42.0.1', internal: false, cidr: '10.42.0.1/24' }]
};

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-installer-'))); }

// A fake command runner: `answers` maps a substring of "cmd arg arg..." to a
// result (or to a function of the call). Calls are recorded as that string.
function fakeRun(answers = {}) {
    const calls = [];
    const run = (cmd, args = [], opts = {}) => {
        const line = [cmd, ...args].join(' ');
        calls.push(line);
        run.last = { cmd, args, opts };
        for (const [needle, res] of Object.entries(answers)) {
            if (line.includes(needle)) return { status: 0, stdout: '', stderr: '', ...(typeof res === 'function' ? res(cmd, args, opts) : res) };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    run.calls = calls;
    return run;
}

// A healthy machine, as systemctl and ss would describe it.
const HEALTHY = {
    'is-enabled': { stdout: 'enabled' },
    'is-active': { stdout: 'active' },
    'ss -H -tln': { stdout: 'LISTEN 0 511 10.42.0.1:50000 0.0.0.0:*' }
};

function ctxIn(dir, extra = {}) {
    const root = path.join(dir, 'root');
    const system = {
        unitPath: path.join(dir, 'etc', 'ptyserver.service'),
        firewallUnitPath: path.join(dir, 'etc', 'remote-serial-pico-firewall.service'),
        rulesDir: path.join(dir, 'rules.d'),
        ...(extra.system || {})
    };
    return I.makeContext({
        env: {}, run: fakeRun(), log: () => {}, sleep: () => {}, user: 'pi', nodePath: '/usr/bin/node', isRoot: true,
        rootUid: ME.uid, ids: () => ME, interfaces: () => IFACES,
        ...extra,
        opts: { root, ...(extra.opts || {}) },
        system
    });
}

// A small stand-in for the package: just enough tree for stepApp to copy.
function fakePackage(dir, version = '9.9.9') {
    const src = path.join(dir, 'pkg');
    fs.mkdirSync(path.join(src, 'src', 'pi'), { recursive: true });
    fs.mkdirSync(path.join(src, 'src', 'pico'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'remote-serial-pico', version }));
    fs.writeFileSync(path.join(src, 'npm-shrinkwrap.json'), '{"lock":1}');
    fs.writeFileSync(path.join(src, 'src', 'pi', 'PtyServer.js'), '// server\n');
    fs.writeFileSync(path.join(src, 'src', 'pico', 'main.py'), '# firmware\n');
    return src;
}

function installedTree(ctx) {
    const c = ctx.cfg;
    for (const d of [c.root, c.firmwareDir, c.logDir, c.dataDir, c.portsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o755 });
}

// --- one root, everything derived ---------------------------------------------

test('every path is derived from the one install root', () => {
    const l = I.layout('/srv/rsp');
    for (const [k, v] of Object.entries(l)) assert.ok(v === '/srv/rsp' || v.startsWith('/srv/rsp/'), `${k}=${v}`);
    const ctx = I.makeContext({ env: {}, opts: { root: '/srv/rsp' }, system: { unitPath: '/nonexistent/unit' } });
    assert.strictEqual(ctx.cfg.appDir, '/srv/rsp/app');
    assert.strictEqual(ctx.cfg.configPath, '/srv/rsp/config.yaml');
});

test('root comes from --root, then the environment, then the installed unit, then the default', () => {
    const d = tmp();
    const unitPath = path.join(d, 'ptyserver.service');
    const mk = (opts, env) => I.makeContext({ env, opts, system: { unitPath } }).cfg.root;
    assert.strictEqual(mk({}, {}), I.DEFAULT_ROOT);
    fs.writeFileSync(unitPath, I.renderUnit({ user: 'svc', nodePath: '/n/node', cfg: { ...I.layout('/from/unit'), unitName: 'ptyserver.service' } }));
    assert.strictEqual(mk({}, {}), '/from/unit', 'a re-run or doctor needs no --root');
    assert.strictEqual(I.makeContext({ env: {}, opts: {}, system: { unitPath } }).cfg.serviceUser, 'svc');
    assert.strictEqual(mk({}, { [I.ROOT_ENV]: '/from/env' }), '/from/env');
    assert.strictEqual(mk({ root: '/from/flag' }, { [I.ROOT_ENV]: '/from/env' }), '/from/flag');
});

test('no install path is written down outside installer.js', () => {
    const offenders = [];
    for (const rel of I.treeFiles(fs, REPO)) {
        if (!/^(src|bin)\//.test(rel) || /\.test\.js$|test_.*\.py$/.test(rel) || rel === path.join('src', 'pi', 'installer.js')) continue;
        const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
        if (text.includes('/home/project')) offenders.push(`${rel}: /home/project`);
        if (text.includes(I.DEFAULT_ROOT) && !/config\.example\.yaml$|PicoFirmwareFlasher\.py$/.test(rel)) offenders.push(`${rel}: ${I.DEFAULT_ROOT}`);
    }
    assert.deepStrictEqual(offenders, []);
    const installer = fs.readFileSync(path.join(REPO, 'src', 'pi', 'installer.js'), 'utf8');
    assert.strictEqual(installer.split(`'${I.DEFAULT_ROOT}'`).length - 1, 1, 'the default root is a single constant');
    assert.ok(!/50000/.test(installer), 'the port lives in config.example.yaml only');
});

test('parseArgs reads the command and options, and reports what it does not understand', () => {
    assert.deepStrictEqual(I.parseArgs(['install', '--root', '/x', '--firewall', '--firmware-from=/fw', '--user', 'pi']),
        { command: 'install', errors: [], root: '/x', firewall: true, firmwareFrom: '/fw', serviceUser: 'pi' });
    assert.strictEqual(I.parseArgs(['i', '--no-firewall']).firewall, false);
    assert.strictEqual(I.parseArgs(['DOCTOR']).command, 'doctor');
    assert.match(I.parseArgs(['install', '--bogus']).errors[0], /unknown option/);
    assert.match(I.parseArgs(['install', '--root']).errors[0], /needs a value/);
});

// --- rendering ---------------------------------------------------------------

test('config.yaml is generated from the committed example with the root and bind filled in', () => {
    const d = tmp(); const ctx = ctxIn(d);
    const y = I.parseFlatYaml(I.renderConfig(ctx, 'wlan0'));
    assert.deepStrictEqual(Object.keys(y).sort(), [...I.CONFIG_KEYS, 'FirmwareMismatch', 'FirmwareUpdate'].sort());
    assert.strictEqual(y.FirmwareUpdate, 'false', 'over-the-air updates are opt-in');
    assert.strictEqual(y.FirmwareMismatch, 'refuse');
    assert.ok(!('AcceptLegacyPicos' in y), 'there is no legacy mode to configure');
    const root = ctx.cfg.root;
    assert.strictEqual(y.symlinkDir, `${root}/ports`);
    assert.strictEqual(y.PicoSerialMap, `${root}/data/pico_serial_map.yaml`);
    assert.strictEqual(y.PicoSecrets, `${root}/data/pico_secrets.yaml`);
    assert.strictEqual(y.FirmwareDir, ctx.cfg.firmwareDir);
    assert.strictEqual(y.DeployerLog, `${root}/log/deployer.log`);
    assert.strictEqual(y.BindAddress, 'wlan0');
    assert.strictEqual(typeof y.TCP_PORT, 'number');
    assert.ok(!I.renderConfig(ctx, 'wlan0').includes('@'), 'no placeholder left behind');
});

test('renderUnit starts the installed app with the installed config, as the service user, hardened', () => {
    const cfg = { ...I.layout('/opt/x'), unitName: 'ptyserver.service' };
    const u = I.renderUnit({ user: 'rspico', nodePath: '/opt/node/bin/node', cfg });
    assert.match(u, /^User=rspico$/m);
    assert.match(u, /^ExecStart=\/opt\/node\/bin\/node \/opt\/x\/app\/src\/pi\/PtyServer\.js --config \/opt\/x\/config\.yaml$/m);
    assert.match(u, /^WantedBy=multi-user\.target$/m);   // what makes `enable` survive a reboot
    assert.match(u, /^Restart=always$/m);
    assert.match(u, /^NoNewPrivileges=yes$/m);
    assert.match(u, /^ProtectSystem=strict$/m);
    assert.match(u, /^ReadWritePaths=\/opt\/x\/data \/opt\/x\/ports$/m);
    assert.match(u, /^PrivateTmp=yes$/m);
});

test('udev rules are rendered from the templates: no placeholder, no fixed path', () => {
    const d = tmp(); const ctx = ctxIn(d);
    const rules = I.renderedRules(ctx, REPO);
    assert.deepStrictEqual(rules.map(r => r.name), ['98-pico-bootsel.rules', '99-pico.rules']);
    for (const r of rules) {
        const active = r.content.split('\n').filter(l => l && !l.startsWith('#')).join('\n');
        assert.ok(!active.includes('@'), `${r.name} still has a placeholder`);
        assert.ok(active.includes(`--config ${ctx.cfg.configPath}`), `${r.name} must pass the config file`);
        assert.ok(active.includes(`${ctx.cfg.appDir}/src/pi/`));
    }
    assert.ok(rules[1].content.includes(` ${ctx.cfg.venvDir}/bin/python ${ctx.cfg.appDir}/src/pi/PicoScriptDeployer.py `), 'the deployer runs under the venv interpreter');
    for (const r of rules) {
        const run = r.content.split('\n').find(l => l.startsWith('ACTION=='));
        assert.match(run, /RUN\+="\/usr\/bin\/systemd-run --no-block --collect --unit=pico-(flash|deploy)-%k /,
            `${r.name}: udev kills long RUN+= commands, so both rules must hand off to systemd-run`);
    }
});

test('parseFlatYaml handles quotes, numbers and comments', () => {
    const y = I.parseFlatYaml("# c\nA: 'x y'\nB: \"z\"\nC: 42\nD: plain\n\n");
    assert.deepStrictEqual(y, { A: 'x y', B: 'z', C: 42, D: 'plain' });
});

// --- idempotent file helpers --------------------------------------------------

test('writeIfChanged: created, then unchanged, then updated; a wrong mode is repaired', () => {
    const f = path.join(tmp(), 'sub', 'file');
    assert.strictEqual(I.writeIfChanged(fs, f, 'a', 0o644), 'created');
    assert.strictEqual(I.writeIfChanged(fs, f, 'a', 0o644), 'unchanged');
    assert.strictEqual(I.writeIfChanged(fs, f, 'b', 0o644), 'updated');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'b');
    fs.chmodSync(f, 0o666);
    assert.strictEqual(I.writeIfChanged(fs, f, 'b', 0o644), 'updated');
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o644);
});

test('ensureDir creates with the mode and reports unchanged afterwards', () => {
    const d = path.join(tmp(), 'p');
    assert.strictEqual(I.ensureDir(fs, d, 0o755), 'created');
    assert.strictEqual(I.ensureDir(fs, d, 0o755), 'unchanged');
    assert.strictEqual(I.isWorldWritable(fs, d), false);
    fs.chmodSync(d, 0o777);
    assert.strictEqual(I.isWorldWritable(fs, d), true);
    assert.strictEqual(I.ensureDir(fs, d, 0o755), 'updated', 'a 777 directory is put back to 755');
});

// --- install guards ----------------------------------------------------------

test('install refuses without root, without a real user, and with names that could not be quoted', () => {
    const d = tmp();
    assert.strictEqual(I.install(ctxIn(d, { isRoot: false })), 2);
    assert.strictEqual(I.install(ctxIn(d, { user: null })), 2);
    assert.strictEqual(I.install(ctxIn(d, { user: "pi'; rm -rf /" })), 2);
    assert.strictEqual(I.install(ctxIn(d, { opts: { root: '/opt/with space' } })), 2);
    assert.strictEqual(I.install(ctxIn(d, { opts: { root: 'relative/path' } })), 2);
});

test('commands are argument arrays, never a shell string built from input', () => {
    const r = I.exec(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', "a'b; echo pwned $(id)"]);
    assert.strictEqual(r.stdout, "a'b; echo pwned $(id)");
    assert.ok(!/spawnSync\('sh'|shell:\s*true/.test(fs.readFileSync(path.join(__dirname, 'installer.js'), 'utf8')));
});

// --- individual steps, run twice: second run must report ok, not changed -----

test('stepServiceUser creates a system account and puts the installing user in its group, once', () => {
    const d = tmp();
    const run = fakeRun({ 'id -u rspico': { status: 1 }, 'id -nG pi': { stdout: 'pi sudo' }, 'id -gn rspico': { stdout: 'rspico' } });
    const res = I.stepServiceUser(ctxIn(d, { run }));
    assert.strictEqual(res.result, 'changed');
    const useradd = run.calls.find(c => c.startsWith('useradd'));
    assert.ok(useradd.includes('--system') && useradd.includes('/usr/sbin/nologin') && useradd.endsWith(' rspico'));
    assert.ok(run.calls.includes('usermod -aG rspico pi'));

    const run2 = fakeRun({ 'id -nG pi': { stdout: 'pi sudo rspico' }, 'id -gn rspico': { stdout: 'rspico' } });
    assert.strictEqual(I.stepServiceUser(ctxIn(d, { run: run2 })).result, 'ok');
    assert.ok(!run2.calls.some(c => c.startsWith('useradd') || c.startsWith('usermod')));
});

test('--user must name an existing account; it is never created', () => {
    const d = tmp();
    const run = fakeRun({ 'id -u nodered': { status: 1 } });
    const res = I.stepServiceUser(ctxIn(d, { run, opts: { serviceUser: 'nodered' } }));
    assert.strictEqual(res.result, 'failed');
    assert.ok(!run.calls.some(c => c.startsWith('useradd')));
});

test('stepDirectories builds the tree 755, repairs a 777 root, and is quiet the second time', () => {
    const d = tmp(); const ctx = ctxIn(d);
    assert.strictEqual(I.stepDirectories(ctx).result, 'changed');
    for (const dir of [ctx.cfg.root, ctx.cfg.firmwareDir, ctx.cfg.logDir, ctx.cfg.dataDir, ctx.cfg.portsDir]) {
        assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755, dir);
    }
    assert.strictEqual(I.stepDirectories(ctx).result, 'ok');
    fs.chmodSync(ctx.cfg.root, 0o777);
    assert.strictEqual(I.stepDirectories(ctx).result, 'changed');
    assert.strictEqual(fs.statSync(ctx.cfg.root).mode & 0o777, 0o755);
});

test('stepDirectories chowns what has the wrong owner', () => {
    const d = tmp();
    const run = fakeRun({ 'id -gn rspico': { stdout: 'rspico' } });
    const ctx = ctxIn(d, { run, ids: () => ({ uid: ME.uid + 1, gid: ME.gid + 1 }) });
    I.stepDirectories(ctx);
    assert.ok(run.calls.includes(`chown rspico:rspico ${ctx.cfg.dataDir}`));
    assert.ok(run.calls.includes(`chown rspico:rspico ${ctx.cfg.portsDir}`));
    assert.ok(!run.calls.some(c => c.startsWith('chown') && c.endsWith(ctx.cfg.firmwareDir)), 'root-owned dirs are not handed to the service user');
});

test('stepApp copies the package into <root>/app as root, verifies node-pty loads, and is a no-op when nothing changed', () => {
    const d = tmp();
    const src = fakePackage(d);
    fs.mkdirSync(path.join(src, 'node_modules', 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node_modules', 'node-pty', 'index.js'), '');
    fs.mkdirSync(path.join(src, '.git'));
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'x');
    fs.writeFileSync(path.join(src, 'src', 'pi', 'config.yaml'), 'dev-only');
    const ctx = ctxIn(d, { cfg: { sourceDir: src } });
    installedTree(ctx);

    const res = I.stepApp(ctx);
    assert.strictEqual(res.result, 'changed', res.detail);
    const app = ctx.cfg.appDir;
    assert.ok(fs.existsSync(path.join(app, 'src', 'pi', 'PtyServer.js')));
    assert.ok(fs.existsSync(path.join(app, 'node_modules', 'node-pty', 'index.js')));
    assert.ok(!fs.existsSync(path.join(app, '.git')), '.git is not part of the install');
    assert.ok(!fs.existsSync(path.join(app, 'src', 'pi', 'config.yaml')), "a developer's local config is not installed");
    assert.ok(ctx.run.calls.includes(`chown -R root:root ${app}.new`));
    assert.ok(ctx.run.calls.some(c => c.startsWith('chmod -R') && c.includes('go-w')));
    assert.ok(ctx.run.calls.some(c => c.startsWith('/usr/bin/node -e') && c.includes("require('node-pty')")), 'node-pty is loaded under the service node');
    assert.strictEqual(ctx.flags.appChanged, true);
    assert.ok(!fs.existsSync(`${app}.new`) && !fs.existsSync(`${app}.old`));

    const ctx2 = ctxIn(d, { cfg: { sourceDir: src } });
    assert.strictEqual(I.stepApp(ctx2).result, 'ok');
    assert.strictEqual(ctx2.run.calls.length, 0, 'nothing runs when the installed app matches the package');
});

test('stepApp upgrades in place when the package changes, keeping node_modules if the lockfile is the same', () => {
    const d = tmp();
    const src = fakePackage(d, '1.0.0');
    fs.mkdirSync(path.join(src, 'node_modules', 'node-pty'), { recursive: true });
    const ctx = ctxIn(d, { cfg: { sourceDir: src } });
    installedTree(ctx);
    I.stepApp(ctx);
    fs.writeFileSync(path.join(ctx.cfg.appDir, 'node_modules', 'marker'), 'kept');

    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'remote-serial-pico', version: '1.1.0' }));
    fs.writeFileSync(path.join(src, 'src', 'pi', 'PtyServer.js'), '// server v2\n');
    const ctx2 = ctxIn(d, { cfg: { sourceDir: src } });
    const res = I.stepApp(ctx2);
    assert.strictEqual(res.result, 'changed');
    assert.match(res.detail, /upgraded 1\.0\.0 -> 1\.1\.0/);
    assert.strictEqual(fs.readFileSync(path.join(ctx2.cfg.appDir, 'src', 'pi', 'PtyServer.js'), 'utf8'), '// server v2\n');
    assert.strictEqual(fs.readFileSync(path.join(ctx2.cfg.appDir, 'node_modules', 'marker'), 'utf8'), 'kept');
    assert.ok(!ctx2.run.calls.some(c => c.startsWith('npm')));
});

test('stepApp runs npm in the staged app with the service node first on PATH when the package has no modules', () => {
    const d = tmp();
    const src = fakePackage(d);
    const run = fakeRun();
    const ctx = ctxIn(d, { run, cfg: { sourceDir: src }, nodePath: '/opt/node20/bin/node' });
    installedTree(ctx);
    let npmCall = null;
    const realRun = ctx.run;
    ctx.run = (cmd, args, opts) => {
        if (cmd === 'npm') { npmCall = { args, opts }; fs.mkdirSync(path.join(opts.cwd, 'node_modules', 'node-pty'), { recursive: true }); }
        return realRun(cmd, args, opts);
    };
    assert.strictEqual(I.stepApp(ctx).result, 'changed');
    assert.strictEqual(npmCall.args[0], 'ci', 'a lockfile means npm ci');
    assert.ok(npmCall.args.includes('--omit=dev'));
    assert.strictEqual(npmCall.opts.cwd, `${ctx.cfg.appDir}.new`);
    assert.ok(npmCall.opts.env.PATH.startsWith('/opt/node20/bin'), 'npm must build for the node the unit will start (issue #7)');
});

test('stepApp fails, and leaves the running app alone, when node-pty will not load under the service node', () => {
    const d = tmp();
    const src = fakePackage(d, '1.0.0');
    fs.mkdirSync(path.join(src, 'node_modules', 'node-pty'), { recursive: true });
    const ctx = ctxIn(d, { cfg: { sourceDir: src } });
    installedTree(ctx);
    I.stepApp(ctx);

    fs.writeFileSync(path.join(src, 'src', 'pi', 'PtyServer.js'), '// broken build\n');
    const run = fakeRun({ "require('node-pty')": { status: 1, stderr: 'Error: was compiled against a different Node.js version using\nNODE_MODULE_VERSION 115' } });
    const res = I.stepApp(ctxIn(d, { run, cfg: { sourceDir: src } }));
    assert.strictEqual(res.result, 'failed');
    assert.match(res.detail, /NODE_MODULE_VERSION/);
    assert.strictEqual(fs.readFileSync(path.join(ctx.cfg.appDir, 'src', 'pi', 'PtyServer.js'), 'utf8'), '// server\n', 'the old app is still in place');
});

test('stepVenv builds the venv as root inside the root, and skips when rshell is present', () => {
    const d = tmp(); const ctx = ctxIn(d);
    assert.strictEqual(I.stepVenv(ctx).result, 'changed');
    assert.ok(ctx.run.calls.includes(`python3 -m venv ${ctx.cfg.venvDir}`));
    assert.ok(ctx.run.calls.includes(`${ctx.cfg.venvDir}/bin/pip install -q rshell`));
    assert.ok(!ctx.run.calls.some(c => c.includes('sudo -u')), 'root executes this interpreter, so root must own it');
    fs.mkdirSync(path.join(ctx.cfg.venvDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ctx.cfg.venvDir, 'bin', 'rshell'), '');
    const before = ctx.run.calls.length;
    assert.strictEqual(I.stepVenv(ctx).result, 'ok');
    assert.strictEqual(ctx.run.calls.length, before);
});

test('stepConfig writes config.yaml once with the detected interface and never overwrites it', () => {
    const d = tmp(); const ctx = ctxIn(d);
    installedTree(ctx);
    const res = I.stepConfig(ctx);
    assert.strictEqual(res.result, 'changed');
    assert.strictEqual(I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8')).BindAddress, 'wlan0');
    assert.strictEqual(fs.statSync(ctx.cfg.configPath).mode & 0o777, 0o644);
    fs.writeFileSync(ctx.cfg.configPath, 'TCP_PORT: 6000\n');          // an operator edited it
    assert.strictEqual(I.stepConfig(ctx).result, 'ok');
    assert.strictEqual(fs.readFileSync(ctx.cfg.configPath, 'utf8'), 'TCP_PORT: 6000\n');
});

test('stepConfig falls back to the default-route interface, and says so when there is no network at all', () => {
    const d = tmp();
    const wired = { lo: IFACES.lo, end0: [{ family: 'IPv4', address: '192.168.1.9', internal: false, cidr: '192.168.1.9/24' }] };
    const ctx = ctxIn(d, { interfaces: () => wired, run: fakeRun({ 'ip -4 route show default': { stdout: 'default via 192.168.1.1 dev end0 proto dhcp' } }) });
    installedTree(ctx);
    I.stepConfig(ctx);
    assert.strictEqual(I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8')).BindAddress, 'end0');

    const d2 = tmp(); const ctx2 = ctxIn(d2, { interfaces: () => ({ lo: IFACES.lo }) });
    installedTree(ctx2);
    assert.match(I.stepConfig(ctx2).detail, /0\.0\.0\.0/);
});

test('stepState initialises the key store 0600 and the serial map, then never touches their contents', () => {
    const d = tmp(); const ctx = ctxIn(d);
    installedTree(ctx); I.stepConfig(ctx);
    assert.strictEqual(I.stepState(ctx).result, 'changed');
    const conf = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8'));
    assert.strictEqual(fs.statSync(conf.PicoSecrets).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(conf.PicoSerialMap));

    fs.writeFileSync(conf.PicoSecrets, 'e661aaaa: 00ff\n');
    fs.writeFileSync(conf.PicoSerialMap, 'e661aaaa: Blinds_pico\n');
    assert.strictEqual(I.stepState(ctx).result, 'ok');
    assert.strictEqual(fs.readFileSync(conf.PicoSecrets, 'utf8'), 'e661aaaa: 00ff\n');
    assert.strictEqual(fs.readFileSync(conf.PicoSerialMap, 'utf8'), 'e661aaaa: Blinds_pico\n');

    fs.chmodSync(conf.PicoSecrets, 0o644);
    assert.strictEqual(I.stepState(ctx).result, 'changed', 'a readable key store is closed again');
    assert.strictEqual(fs.statSync(conf.PicoSecrets).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(conf.PicoSecrets, 'utf8'), 'e661aaaa: 00ff\n');
});

test('stepUdevRules installs the rendered rules and reloads only when something changed', () => {
    const d = tmp(); const ctx = ctxIn(d, { cfg: { appDir: REPO } });
    assert.strictEqual(I.stepUdevRules(ctx).result, 'changed');
    assert.ok(ctx.run.calls.includes('udevadm control --reload-rules'));
    assert.ok(ctx.run.calls.includes('udevadm trigger'));
    const installed = fs.readFileSync(path.join(ctx.cfg.rulesDir, '99-pico.rules'), 'utf8');
    assert.ok(installed.includes(`--config ${ctx.cfg.configPath}`));
    const before = ctx.run.calls.length;
    assert.strictEqual(I.stepUdevRules(ctx).result, 'ok');
    assert.strictEqual(ctx.run.calls.length, before, 'no udevadm call when nothing changed');
});

test('stepService writes the unit, enables and restarts; then does nothing on a clean re-run', () => {
    const d = tmp();
    const run = fakeRun();                                          // first run: not enabled, not active
    const ctx = ctxIn(d, { run });
    assert.strictEqual(I.stepService(ctx).result, 'changed');
    assert.ok(run.calls.includes('systemctl daemon-reload'));
    assert.ok(run.calls.includes('systemctl enable ptyserver.service'));
    assert.ok(run.calls.includes('systemctl restart ptyserver.service'));
    assert.match(fs.readFileSync(ctx.cfg.unitPath, 'utf8'), /^User=rspico$/m);

    const run2 = fakeRun(HEALTHY);
    const ctx2 = ctxIn(d, { run: run2 });
    assert.strictEqual(I.stepService(ctx2).result, 'ok');
    assert.ok(!run2.calls.some(c => /systemctl (enable|restart|start|daemon-reload)/.test(c)));
});

test('stepService restarts a running service when the app or its config changed underneath it', () => {
    const d = tmp();
    I.stepService(ctxIn(d));
    const run = fakeRun(HEALTHY);
    const ctx = ctxIn(d, { run });
    ctx.flags.appChanged = true;
    assert.strictEqual(I.stepService(ctx).result, 'changed');
    assert.ok(run.calls.includes('systemctl restart ptyserver.service'));
});

test('stepVerify does not take systemctl at its word: active and listening, or it fails', () => {
    const d = tmp();
    const config = (ctx) => { installedTree(ctx); I.stepConfig(ctx); };

    let ctx = ctxIn(d, { run: fakeRun(HEALTHY) }); config(ctx);
    const good = I.stepVerify(ctx);
    assert.strictEqual(good.result, 'ok');
    assert.match(good.detail, /10\.42\.0\.1:50000/);

    ctx = ctxIn(d, { run: fakeRun({ 'is-active': { stdout: 'failed' } }) });
    assert.strictEqual(I.stepVerify(ctx).result, 'failed');

    let slept = 0;
    ctx = ctxIn(d, { run: fakeRun({ 'is-active': { stdout: 'active' }, 'ss -H -tln': { stdout: '' } }), sleep: () => { slept++; } });
    const deaf = I.stepVerify(ctx);
    assert.strictEqual(deaf.result, 'failed');
    assert.match(deaf.detail, /nothing listens on port 50000/);
    assert.ok(slept > 10, 'it waits for the port before giving up');
});

test('stepVerify waits for a service that takes a moment to open its port', () => {
    const d = tmp();
    let polls = 0;
    const run = fakeRun({ 'is-active': { stdout: 'active' }, 'ss -H -tln': () => ({ stdout: ++polls < 4 ? '' : 'LISTEN 0 511 10.42.0.1:50000 0.0.0.0:*' }) });
    const ctx = ctxIn(d, { run }); installedTree(ctx); I.stepConfig(ctx);
    assert.strictEqual(I.stepVerify(ctx).result, 'ok');
});

// --- firewall ----------------------------------------------------------------

test('the firewall is offered, not imposed: off unless --firewall, and the offer names the subnet', () => {
    const d = tmp(); const ctx = ctxIn(d); installedTree(ctx); I.stepConfig(ctx);
    const res = I.stepFirewall(ctx);
    assert.strictEqual(res.result, 'ok');
    assert.match(res.detail, /install --firewall/);
    assert.match(res.detail, /10\.42\.0\.0\/24/);
    assert.ok(!fs.existsSync(ctx.cfg.firewallUnitPath));
});

test('--firewall limits the port to the Pico subnet, survives re-runs, and --no-firewall removes it', () => {
    const d = tmp();
    let ctx = ctxIn(d, { opts: { firewall: true } }); installedTree(ctx); I.stepConfig(ctx);
    assert.ok(I.stepAptPackages(ctxIn(d, { opts: { firewall: true }, run: fakeRun() })).detail.includes('nftables'));
    assert.strictEqual(I.stepFirewall(ctx).result, 'changed');
    const rules = fs.readFileSync(ctx.cfg.firewallRules, 'utf8');
    assert.match(rules, /tcp dport 50000 ip saddr != 10\.42\.0\.0\/24 drop/);
    assert.match(rules, /meta nfproto ipv6 tcp dport 50000 drop/);
    assert.ok(ctx.run.calls.includes('systemctl enable remote-serial-pico-firewall.service'));

    ctx = ctxIn(d, { run: fakeRun(HEALTHY) });                       // no flag: an existing firewall is kept
    assert.strictEqual(I.stepFirewall(ctx).result, 'ok');
    assert.ok(fs.existsSync(ctx.cfg.firewallUnitPath));

    ctx = ctxIn(d, { opts: { firewall: false } });
    assert.strictEqual(I.stepFirewall(ctx).result, 'changed');
    assert.ok(!fs.existsSync(ctx.cfg.firewallUnitPath) && !fs.existsSync(ctx.cfg.firewallRules));
    assert.ok(ctx.run.calls.includes('systemctl disable --now remote-serial-pico-firewall.service'));
});

test('--firewall refuses to guess a subnet when the server listens everywhere', () => {
    const d = tmp(); const ctx = ctxIn(d, { opts: { firewall: true }, interfaces: () => ({ lo: IFACES.lo }) });
    installedTree(ctx); I.stepConfig(ctx);
    assert.strictEqual(I.stepFirewall(ctx).result, 'failed');
});

// --- firmware cache ----------------------------------------------------------

function manifestApp(d, images) {
    const app = path.join(d, 'app-with-manifest');
    fs.mkdirSync(path.join(app, 'src', 'pi'), { recursive: true });
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const m = { version: '1.29.0', images: {} };
    for (const [name, body] of Object.entries(images)) m.images[name] = { url: `https://example.invalid/fw/${name.replace('.uf2', '-v1.29.0.uf2')}`, sha256: sha(body) };
    fs.writeFileSync(path.join(app, 'src', 'pi', 'firmware-manifest.json'), JSON.stringify(m));
    return app;
}

test('stepFirmware downloads each image once, verifies its sha256, and never enables auto-flash by itself', () => {
    const d = tmp();
    const bodies = { 'RPI_PICO_W.uf2': 'pico-w-image', 'RPI_PICO2_W.uf2': 'pico-2-w-image' };
    const fetched = [];
    const download = (url, dest) => { fetched.push(url); fs.writeFileSync(dest, url.includes('PICO2') ? bodies['RPI_PICO2_W.uf2'] : bodies['RPI_PICO_W.uf2']); return { status: 0, stdout: '', stderr: '' }; };
    const ctx = ctxIn(d, { download, cfg: { appDir: manifestApp(d, bodies) } }); installedTree(ctx);

    const res = I.stepFirmware(ctx);
    assert.strictEqual(res.result, 'changed', res.detail);
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fs.readFileSync(path.join(ctx.cfg.firmwareDir, 'RPI_PICO_W.uf2'), 'utf8'), 'pico-w-image');
    assert.match(res.detail, /auto-flash off/);
    assert.ok(!fs.existsSync(path.join(ctx.cfg.firmwareDir, 'autoflash-enabled')));

    assert.strictEqual(I.stepFirmware(ctx).result, 'ok');
    assert.strictEqual(fetched.length, 2, 'nothing is downloaded when the cache already matches');
    fs.writeFileSync(path.join(ctx.cfg.firmwareDir, 'autoflash-enabled'), '');
    assert.match(I.stepFirmware(ctx).detail, /auto-flash ON/);
});

test('stepFirmware rejects an image whose sha256 is wrong and caches nothing in its place', () => {
    const d = tmp();
    const download = (url, dest) => { fs.writeFileSync(dest, 'tampered'); return { status: 0, stdout: '', stderr: '' }; };
    const ctx = ctxIn(d, { download, cfg: { appDir: manifestApp(d, { 'RPI_PICO_W.uf2': 'genuine' }) } }); installedTree(ctx);
    const res = I.stepFirmware(ctx);
    assert.strictEqual(res.result, 'failed');
    assert.match(res.detail, /sha256/);
    assert.deepStrictEqual(fs.readdirSync(ctx.cfg.firmwareDir), []);
});

test('stepFirmware reports a failed download with what to do offline, and --firmware-from needs no network', () => {
    const d = tmp();
    const app = manifestApp(d, { 'RPI_PICO_W.uf2': 'genuine' });
    const offline = (url, dest) => ({ status: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND micropython.org' });
    let ctx = ctxIn(d, { download: offline, cfg: { appDir: app } }); installedTree(ctx);
    const res = I.stepFirmware(ctx);
    assert.strictEqual(res.result, 'failed');
    assert.match(res.detail, /ENOTFOUND/);
    assert.match(res.detail, /--firmware-from/);

    const usb = path.join(d, 'usb-stick'); fs.mkdirSync(usb);
    fs.writeFileSync(path.join(usb, 'RPI_PICO_W-v1.29.0.uf2'), 'genuine');       // named as micropython.org names it
    const never = () => { throw new Error('must not download'); };
    ctx = ctxIn(d, { download: never, opts: { firmwareFrom: usb }, cfg: { appDir: app } });
    assert.strictEqual(I.stepFirmware(ctx).result, 'changed');
    assert.strictEqual(fs.readFileSync(path.join(ctx.cfg.firmwareDir, 'RPI_PICO_W.uf2'), 'utf8'), 'genuine');
});

test('the committed firmware manifest pins an https url and a sha256 for every image the flasher knows', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'firmware-manifest.json'), 'utf8'));
    const flasher = fs.readFileSync(path.join(__dirname, 'PicoFirmwareFlasher.py'), 'utf8');
    for (const [name, image] of Object.entries(m.images)) {
        assert.match(image.url, /^https:\/\/micropython\.org\//);
        assert.match(image.sha256, /^[0-9a-f]{64}$/);
        assert.ok(image.url.includes(`v${m.version}`), `${name} url must be the pinned version`);
        assert.ok(flasher.includes(`'${name}'`), `${name} must be a file the flasher looks for`);
    }
    assert.strictEqual(Object.keys(m.images).length, 2);
});

// --- apt -----------------------------------------------------------------------

test('a removed-but-not-purged package counts as missing and gets reinstalled', () => {
    const d = tmp();
    const run = fakeRun({ 'dpkg-query': { stdout: 'deinstall ok config-files' } });
    const ctx = ctxIn(d, { run });
    const res = I.stepAptPackages(ctx);
    assert.strictEqual(res.result, 'changed');
    assert.ok(run.calls.some(c => c.startsWith('apt-get install -y') && c.includes('udisks2')));
    assert.strictEqual(I.packageInstalled(ctxIn(d, { run: fakeRun({ 'dpkg-query': { stdout: 'install ok installed' } }) }), 'udisks2'), true);
});

// --- the whole install ---------------------------------------------------------

function fullInstall(d, extra = {}) {
    const src = fakePackage(d);
    fs.mkdirSync(path.join(src, 'node_modules', 'node-pty'), { recursive: true });
    for (const f of ['config.example.yaml', '98-pico-bootsel.rules.in', '99-pico.rules.in']) fs.copyFileSync(path.join(__dirname, f), path.join(src, 'src', 'pi', f));
    const sha = crypto.createHash('sha256').update('fw').digest('hex');
    fs.writeFileSync(path.join(src, 'src', 'pi', 'firmware-manifest.json'), JSON.stringify({ version: '1.29.0', images: { 'RPI_PICO_W.uf2': { url: 'https://example.invalid/a.uf2', sha256: sha } } }));
    const lines = [];
    const run = extra.run || fakeRun({ ...HEALTHY, 'dpkg-query': { stdout: 'install ok installed' }, 'id -nG pi': { stdout: 'pi rspico' }, 'id -gn rspico': { stdout: 'rspico' } });
    // venv creation is faked: make rshell appear, as pip would.
    const wrapped = (cmd, args, opts) => {
        if (cmd.endsWith('/bin/pip')) { fs.mkdirSync(path.dirname(cmd), { recursive: true }); fs.writeFileSync(path.join(path.dirname(cmd), 'rshell'), ''); }
        return run(cmd, args, opts);
    };
    wrapped.calls = run.calls;
    const ctx = ctxIn(d, { run: wrapped, log: (s) => lines.push(s), cfg: { sourceDir: src }, download: (u, dest) => { fs.writeFileSync(dest, 'fw'); return { status: 0, stdout: '', stderr: '' }; }, ...extra, run: wrapped });
    return { ctx, lines, code: I.install(ctx) };
}

test('a full install succeeds, a second one changes nothing, and nothing it made is world-writable', () => {
    const d = tmp();
    const first = fullInstall(d);
    assert.strictEqual(first.code, 0, first.lines.join('\n'));
    assert.ok(!first.lines.some(l => l.startsWith('FAILED')));

    const second = fullInstall(d);
    assert.strictEqual(second.code, 0, second.lines.join('\n'));
    assert.ok(second.lines.some(l => l.includes('Done. 0 change(s)')), second.lines.join('\n'));

    const walk = (p) => fs.statSync(p).isDirectory() ? [p, ...fs.readdirSync(p).flatMap(n => walk(path.join(p, n)))] : [p];
    const ww = walk(first.ctx.cfg.root).filter(p => fs.statSync(p).mode & 0o002);
    assert.deepStrictEqual(ww, []);
});

test('a second install never rewrites config.yaml, the serial map or the key store', () => {
    const d = tmp();
    const { ctx } = fullInstall(d);
    const conf = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8'));
    fs.appendFileSync(ctx.cfg.configPath, '# edited by the operator\n');
    fs.writeFileSync(conf.PicoSerialMap, 'e661aaaa: Blinds_pico\n');
    fs.writeFileSync(conf.PicoSecrets, 'e661aaaa: 00ff\n');
    assert.strictEqual(fullInstall(d).code, 0);
    assert.match(fs.readFileSync(ctx.cfg.configPath, 'utf8'), /# edited by the operator/);
    assert.strictEqual(fs.readFileSync(conf.PicoSerialMap, 'utf8'), 'e661aaaa: Blinds_pico\n');
    assert.strictEqual(fs.readFileSync(conf.PicoSecrets, 'utf8'), 'e661aaaa: 00ff\n');
});

test('install stops at a service that does not come up instead of reporting success', () => {
    const d = tmp();
    const run = fakeRun({ 'dpkg-query': { stdout: 'install ok installed' }, 'is-active': { stdout: 'failed' }, 'id -nG pi': { stdout: 'pi rspico' } });
    const { code, lines } = fullInstall(d, { run });
    assert.strictEqual(code, 1);
    assert.ok(lines.some(l => l.startsWith('FAILED') && l.includes('service running')), lines.join('\n'));
});

// --- doctor ------------------------------------------------------------------

function doctorOn(d, answers = {}, extra = {}) {
    const { ctx } = fullInstall(d);
    // The server creates the control socket when it starts; stand in for it.
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
    const ctlSock = path.join(sockDir, 'c.sock');
    require('node:child_process').spawnSync(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => { require('fs').chmodSync(process.argv[1], 0o660); process.exit(0); })", ctlSock]);
    fs.writeFileSync(ctx.cfg.configPath, fs.readFileSync(ctx.cfg.configPath, 'utf8').replace(/^ControlSocket: .*$/m, `ControlSocket: '${ctlSock}'`));
    // /dev/log does not exist on every machine that runs these tests.
    const sock = path.join(d, 'dev-log'); fs.writeFileSync(sock, '');
    fs.writeFileSync(ctx.cfg.configPath, fs.readFileSync(ctx.cfg.configPath, 'utf8').replace("SyslogDir: '/dev/log'", `SyslogDir: '${sock}'`));
    const run = fakeRun({ ...HEALTHY, ...answers });
    const ctx2 = ctxIn(d, { run, cfg: { sourceDir: ctx.cfg.sourceDir }, ...extra });
    return { ctx: ctx2, checks: I.doctorChecks(ctx2) };
}

test('doctor passes on a fully installed machine', () => {
    const d = tmp();
    const { ctx, checks } = doctorOn(d);
    const bad = checks.filter(x => !x.ok);
    assert.deepStrictEqual(bad, [], JSON.stringify(bad, null, 1));
    assert.strictEqual(I.doctor(ctx), 0);
});

test('doctor fails loudly with hints on an empty machine', () => {
    const d = tmp();
    const run = fakeRun({ 'ss -H -tln': { stdout: '' } });
    const ctx = ctxIn(d, { run, ids: () => null });
    const checks = I.doctorChecks(ctx);
    const failed = checks.filter(c => !c.ok).map(c => c.name);
    for (const name of ['install root', 'application', 'node-pty loads', 'config.yaml', 'service user', 'service enabled at boot', 'service running', 'listening address', 'firmware cache']) {
        assert.ok(failed.includes(name), `${name} should fail: ${failed}`);
    }
    assert.ok(checks.filter(c => !c.ok).every(c => c.hint.length > 0), 'every failure carries a hint');
    assert.strictEqual(I.doctor(ctx), 1);
});

test('doctor checks the commands themselves, not just dpkg', () => {
    const d = tmp();
    const run = fakeRun({ 'sh udisksctl': { status: 1 } });
    const ch = I.doctorChecks(ctxIn(d, { run })).find(c => c.name === 'required commands');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /udisksctl/);
    assert.match(ch.hint, /apt-get install -y udisks2/);
});

test('doctor flags a root-run file that someone other than root could change', () => {
    const d = tmp();
    let { ctx, checks } = doctorOn(d);
    fs.chmodSync(ctx.cfg.root, 0o777);
    let ch = I.doctorChecks(ctx).find(c => c.name === 'root-run files');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /writable by group or others \(777\)/);
    fs.chmodSync(ctx.cfg.root, 0o755);

    // Same tree, but "root" is now somebody else: every file is foreign-owned.
    ch = I.doctorChecks(ctxIn(d, { run: fakeRun(HEALTHY), cfg: { sourceDir: ctx.cfg.sourceDir }, rootUid: ME.uid + 1 })).find(c => c.name === 'root-run files');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /PicoScriptDeployer\.py is not owned by root|is not owned by root/);
});

test('doctor flags a key store that is readable, or not the service user\'s', () => {
    const d = tmp();
    const { ctx } = doctorOn(d);
    const conf = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8'));
    fs.chmodSync(conf.PicoSecrets, 0o644);
    const ch = I.doctorChecks(ctx).find(c => c.name === 'key store');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /mode 644/);
    assert.match(ch.hint, /chmod 600/);
});

test('doctor flags an empty or tampered firmware cache', () => {
    const d = tmp();
    const { ctx } = doctorOn(d);
    const uf2 = path.join(ctx.cfg.firmwareDir, 'RPI_PICO_W.uf2');
    fs.writeFileSync(uf2, 'something else');
    assert.match(I.doctorChecks(ctx).find(c => c.name === 'firmware cache').detail, /does not match the pinned sha256/);
    fs.rmSync(uf2);
    const ch = I.doctorChecks(ctx).find(c => c.name === 'firmware cache');
    assert.strictEqual(ch.ok, false, 'a cache directory with no .uf2 in it must not pass');
    assert.match(ch.detail, /RPI_PICO_W\.uf2 missing/);
});

test('doctor flags a server listening on every interface, or on the wrong address', () => {
    const d = tmp();
    let r = doctorOn(d, { 'ss -H -tln': { stdout: 'LISTEN 0 511 0.0.0.0:50000 0.0.0.0:*' } });
    let ch = r.checks.find(c => c.name === 'listening address');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /every interface/);
    assert.match(ch.hint, /BindAddress/);

    ch = I.doctorChecks(ctxIn(d, { run: fakeRun({ ...HEALTHY, 'ss -H -tln': { stdout: 'LISTEN 0 511 10.3.177.167:50000 0.0.0.0:*' } }), cfg: { sourceDir: r.ctx.cfg.sourceDir } })).find(c => c.name === 'listening address');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /expected 10\.42\.0\.1:50000, found 10\.3\.177\.167:50000/);
});

test('doctor loads node-pty under the node named in the unit, not the one running doctor', () => {
    const d = tmp();
    const { ctx } = fullInstall(d, { nodePath: '/opt/node20/bin/node' });
    const run = fakeRun({ ...HEALTHY, "require('node-pty')": (cmd) => (cmd === '/opt/node20/bin/node' ? { status: 1, stderr: 'NODE_MODULE_VERSION 115' } : {}) });
    const ctx2 = ctxIn(d, { run, cfg: { sourceDir: ctx.cfg.sourceDir }, nodePath: '/usr/bin/node' });
    const ch = I.doctorChecks(ctx2).find(c => c.name === 'node-pty loads');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /\/opt\/node20\/bin\/node: NODE_MODULE_VERSION 115/);
});

test('doctor flags a missing control socket, and one that is open to everyone', () => {
    const d = tmp();
    const { ctx } = doctorOn(d);
    const sock = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8')).ControlSocket;
    assert.strictEqual(I.doctorChecks(ctx).find(c => c.name === 'control socket').ok, true);
    fs.chmodSync(sock, 0o666);
    let ch = I.doctorChecks(ctx).find(c => c.name === 'control socket');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.detail, /open to everyone/);
    fs.rmSync(sock);
    ch = I.doctorChecks(ctx).find(c => c.name === 'control socket');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.hint, /systemctl restart/);
});

test('doctor notices a udev rule that was edited or removed, and an app that is older than the package', () => {
    const d = tmp();
    const { ctx } = doctorOn(d);
    fs.rmSync(path.join(ctx.cfg.rulesDir, '99-pico.rules'));
    assert.strictEqual(I.doctorChecks(ctx).find(c => c.name === 'udev rule 99-pico.rules').ok, false);
    fs.writeFileSync(path.join(ctx.cfg.sourceDir, 'src', 'pi', 'PtyServer.js'), '// newer\n');
    const app = I.doctorChecks(ctx).find(c => c.name === 'application');
    assert.strictEqual(app.ok, false);
    assert.match(app.hint, /install/);
});

// --- status ------------------------------------------------------------------

test('status reports each registered Pico: connected or not, port, and firmware version', () => {
    const d = tmp();
    const { ctx } = fullInstall(d);
    const conf = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8'));
    fs.writeFileSync(conf.PicoSerialMap, 'e661aaaa: Blinds_pico\ne661bbbb: Lights_pico\ne661cccc: Spare_pico\n');
    const live = path.join(d, 'pts0'); fs.writeFileSync(live, '');
    fs.symlinkSync(live, path.join(conf.symlinkDir, 'Blinds_pico'));
    fs.symlinkSync(path.join(d, 'gone'), path.join(conf.symlinkDir, 'Lights_pico'));
    fs.writeFileSync(conf.StateFile, JSON.stringify({ picos: {
        Blinds_pico: { serial: 'e661aaaa', firmware: '1.0.0', hash: '0123456789abcdef', protocol: 'v1', connected: true },
        Lights_pico: { serial: 'e661bbbb', firmware: 'v0', hash: 'unknown', protocol: 'v0', connected: false }
    } }));
    const lines = [];
    const sctx = ctxIn(d, { run: fakeRun(HEALTHY), log: (s) => lines.push(s) });
    assert.strictEqual(I.status(sctx), 0);
    const out = lines.join('\n');
    assert.match(out, /service +active \(enabled at boot\), listening on 10\.42\.0\.1:50000/);
    assert.match(out, /Blinds_pico +connected +firmware 1\.0\.0 \(v1, hash 0123456789abcdef\)/);
    assert.match(out, /serial e661aaaa, port .*Blinds_pico -> /);
    assert.match(out, /Lights_pico +not connected +firmware v0/);
    assert.match(out, /stale port/);
    assert.match(out, /Spare_pico +not connected +firmware unknown/);
    assert.ok(!/NOT what this Pi deploys/.test(out));

    // Once the server has said which firmware it deploys, a board on another is called out.
    fs.writeFileSync(conf.StateFile, JSON.stringify({ expectedHash: '0123456789abcdef', picos: {
        Blinds_pico: { serial: 'e661aaaa', firmware: '1.1.0', hash: '0123456789abcdef', protocol: 'v1', connected: true },
        Lights_pico: { serial: 'e661bbbb', firmware: '1.0.0', hash: 'ffffffffffffffff', protocol: 'v1', connected: true }
    } }));
    lines.length = 0;
    I.status(sctx);
    assert.ok(!/Blinds_pico.*NOT what this Pi deploys/.test(lines.join('\n')));
    assert.match(lines.join('\n'), /Lights_pico .*hash ffffffffffffffff, NOT what this Pi deploys \(0123456789abcdef\): plug it in to update/);
    assert.match(out, /^autoflash off \(RPI_PICO_W\.uf2\)/m);
});

test('status does not call a board connected when the service is down', () => {
    const d = tmp();
    const { ctx } = fullInstall(d);
    const conf = I.parseFlatYaml(fs.readFileSync(ctx.cfg.configPath, 'utf8'));
    fs.writeFileSync(conf.PicoSerialMap, 'e661aaaa: Blinds_pico\n');
    const live = path.join(d, 'pts0'); fs.writeFileSync(live, '');
    fs.symlinkSync(live, path.join(conf.symlinkDir, 'Blinds_pico'));
    fs.writeFileSync(conf.StateFile, JSON.stringify({ picos: { Blinds_pico: { firmware: '1.0.0', connected: true } } }));
    const lines = [];
    I.status(ctxIn(d, { run: fakeRun({ 'is-active': { stdout: 'inactive' } }), log: (s) => lines.push(s) }));
    assert.match(lines.join('\n'), /Blinds_pico +not connected/);
});

test('dependencies are locked in the file npm actually ships, and node-pty is pinned exactly', () => {
    // `npm i -g` ignores package-lock.json (it is not even in the tarball). With
    // "^1.0.0" a global install picked node-pty 1.1.0, whose open() terminals
    // throw on the first write, and the service crashed when a board sent data.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.dependencies['node-pty'], '1.0.0');
    assert.ok(fs.existsSync(path.join(REPO, 'npm-shrinkwrap.json')));
    assert.ok(!fs.existsSync(path.join(REPO, 'package-lock.json')), 'two lockfiles would drift apart');
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'npm-shrinkwrap.json'), 'utf8'));
    assert.strictEqual(lock.packages['node_modules/node-pty'].version, '1.0.0');
});

test('usage names the three commands and the options', () => {
    for (const w of ['install', 'doctor', 'status', 'ctl <name>', 'uart set', '--root', '--firewall', '--firmware-from', I.DEFAULT_ROOT]) assert.ok(I.usage().includes(w), w);
});
