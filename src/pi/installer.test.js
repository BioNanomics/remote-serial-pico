// Run with:  node --test src/pi/
// Everything runs against a temp directory and a fake shell, so these never
// touch /home/project, systemd or udev on the machine running them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('./installer.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-installer-')); }

// A fake shell: `answers` maps a substring of the command to a result.
function fakeRun(answers = {}) {
    const calls = [];
    const run = (cmd) => {
        calls.push(cmd);
        for (const [needle, res] of Object.entries(answers)) if (cmd.includes(needle)) return { status: 0, stdout: '', stderr: '', ...res };
        return { status: 0, stdout: '', stderr: '' };
    };
    run.calls = calls;
    return run;
}

function ctxIn(dir, extra = {}) {
    const cfg = {
        projectDir: dir,
        cloneDir: path.join(dir, 'remote-serial-pico'),
        venvDir: path.join(dir, 'myenv'),
        firmwareDir: path.join(dir, 'firmware'),
        unitPath: path.join(dir, 'etc', 'ptyserver.service'),
        rulesDir: path.join(dir, 'rules.d'),
        syslogSocket: path.join(dir, 'dev-log'),
        ...(extra.cfg || {})
    };
    return I.makeContext({ cfg, run: extra.run || fakeRun(), log: () => {}, user: 'pi', nodePath: '/usr/bin/node', isRoot: true, ...extra });
}

// --- rendering ---------------------------------------------------------------

test('renderConfig has every key PtyServer reads, pointed at the project dir', () => {
    const y = I.parseFlatYaml(I.renderConfig({ ...I.DEFAULTS, projectDir: '/home/project' }));
    assert.deepStrictEqual(Object.keys(y).sort(), ['CustomlogDir', 'PicoSerialMap', 'SyslogDir', 'TCP_PORT', 'symlinkDir']);
    assert.strictEqual(y.symlinkDir, '/home/project');
    assert.strictEqual(y.TCP_PORT, 50000);
});

test('renderUnit is host-specific in exactly the two places the README says', () => {
    const u = I.renderUnit({ user: 'qquais', nodePath: '/opt/node/bin/node', cloneDir: '/home/project/remote-serial-pico' });
    assert.match(u, /^User=qquais$/m);
    assert.match(u, /^ExecStart=\/opt\/node\/bin\/node PtyServer\.js$/m);
    assert.match(u, /^WorkingDirectory=\/home\/project\/remote-serial-pico\/src\/pi$/m);
    assert.match(u, /^WantedBy=multi-user\.target$/m);   // what makes `enable` survive a reboot
    assert.match(u, /^Restart=always$/m);
});

test('parseFlatYaml handles quotes, numbers and comments', () => {
    const y = I.parseFlatYaml("# c\nA: 'x y'\nB: \"z\"\nC: 42\nD: plain\n\n");
    assert.deepStrictEqual(y, { A: 'x y', B: 'z', C: 42, D: 'plain' });
});

// --- idempotent file helpers --------------------------------------------------

test('writeIfChanged: created, then unchanged, then updated', () => {
    const f = path.join(tmp(), 'sub', 'file');
    assert.strictEqual(I.writeIfChanged(fs, f, 'a', 0o644), 'created');
    assert.strictEqual(I.writeIfChanged(fs, f, 'a', 0o644), 'unchanged');
    assert.strictEqual(I.writeIfChanged(fs, f, 'b', 0o644), 'updated');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'b');
});

test('ensureDir creates with the mode and reports unchanged afterwards', () => {
    const d = path.join(tmp(), 'p');
    assert.strictEqual(I.ensureDir(fs, d, 0o755), 'created');
    assert.strictEqual(I.ensureDir(fs, d, 0o755), 'unchanged');
    assert.strictEqual(I.isWorldWritable(fs, d), false);
    fs.chmodSync(d, 0o777);
    assert.strictEqual(I.isWorldWritable(fs, d), true);
});

// --- install guards ----------------------------------------------------------

test('install refuses without root and without a real user', () => {
    const d = tmp();
    assert.strictEqual(I.install(ctxIn(d, { isRoot: false })), 2);
    assert.strictEqual(I.install(ctxIn(d, { user: null })), 2);
});

// --- individual steps, run twice: second run must report ok, not changed -----

test('stepConfig writes config.yaml once and never overwrites it', () => {
    const d = tmp(); const ctx = ctxIn(d);
    fs.mkdirSync(path.join(ctx.cfg.cloneDir, 'src', 'pi'), { recursive: true });
    assert.strictEqual(I.stepConfig(ctx).result, 'changed');
    const file = path.join(ctx.cfg.cloneDir, 'src', 'pi', 'config.yaml');
    fs.writeFileSync(file, 'TCP_PORT: 6000\n');          // an operator edited it
    assert.strictEqual(I.stepConfig(ctx).result, 'ok');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'TCP_PORT: 6000\n');
});

test('stepFirmwareDir reports the kill switch state truthfully', () => {
    const d = tmp(); const ctx = ctxIn(d);
    assert.strictEqual(I.stepFirmwareDir(ctx).result, 'changed');
    assert.match(I.stepFirmwareDir(ctx).detail, /auto-flash off/);
    fs.writeFileSync(path.join(ctx.cfg.firmwareDir, 'autoflash-enabled'), '');
    assert.match(I.stepFirmwareDir(ctx).detail, /auto-flash ON/);
});

test('stepUdevRules installs every *.rules from the checkout and reloads only when something changed', () => {
    const d = tmp(); const ctx = ctxIn(d);
    const src = path.join(ctx.cfg.cloneDir, 'src', 'pi'); fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, '99-pico.rules'), 'ACTION=="add"\n');
    fs.writeFileSync(path.join(src, '98-pico-bootsel.rules'), 'ACTION=="add", SUBSYSTEM=="block"\n');
    assert.strictEqual(I.stepUdevRules(ctx).result, 'changed');
    assert.ok(ctx.run.calls.some(c => c.includes('udevadm control --reload-rules')));
    assert.strictEqual(fs.readFileSync(path.join(ctx.cfg.rulesDir, '98-pico-bootsel.rules'), 'utf8'), 'ACTION=="add", SUBSYSTEM=="block"\n');
    const before = ctx.run.calls.length;
    assert.strictEqual(I.stepUdevRules(ctx).result, 'ok');
    assert.strictEqual(ctx.run.calls.length, before, 'no udevadm call when nothing changed');
});

test('stepService writes the unit, enables and restarts; then does nothing on a clean re-run', () => {
    const d = tmp();
    const run = fakeRun({ 'is-enabled': { status: 1 } });          // first run: not enabled yet
    const ctx = ctxIn(d, { run });
    assert.strictEqual(I.stepService(ctx).result, 'changed');
    assert.ok(run.calls.some(c => c === 'systemctl daemon-reload'));
    assert.ok(run.calls.some(c => c.includes('systemctl enable ptyserver.service')));
    assert.ok(run.calls.some(c => c.includes('systemctl restart ptyserver.service')));
    assert.match(fs.readFileSync(ctx.cfg.unitPath, 'utf8'), /^User=pi$/m);

    const run2 = fakeRun();                                        // enabled and active now
    const ctx2 = ctxIn(d, { run: run2 });
    assert.strictEqual(I.stepService(ctx2).result, 'ok');
    assert.ok(!run2.calls.some(c => c.startsWith('systemctl enable') || c.startsWith('systemctl restart')));
});

test('stepNpmInstall runs in the clone as the user, and skips when node-pty is present', () => {
    const d = tmp(); const ctx = ctxIn(d);
    fs.mkdirSync(ctx.cfg.cloneDir, { recursive: true });
    assert.strictEqual(I.stepNpmInstall(ctx).result, 'changed');
    const call = ctx.run.calls.find(c => c.includes('npm install'));
    assert.ok(call.startsWith(`cd '${ctx.cfg.cloneDir}'`), 'must cd into the clone first');
    assert.ok(call.includes('sudo -u pi npm install'), 'must run as the user, not root');
    fs.mkdirSync(path.join(ctx.cfg.cloneDir, 'node_modules', 'node-pty'), { recursive: true });
    assert.strictEqual(I.stepNpmInstall(ctx).result, 'ok');
});

test('stepClone clones from the BioNanomics repo and never pulls an existing checkout', () => {
    const d = tmp(); const ctx = ctxIn(d);
    assert.strictEqual(I.stepClone(ctx).result, 'changed');
    assert.ok(ctx.run.calls.some(c => c.includes('git clone') && c.includes('github.com/BioNanomics/remote-serial-pico')));
    fs.mkdirSync(path.join(ctx.cfg.cloneDir, '.git'), { recursive: true });
    const before = ctx.run.calls.length;
    assert.strictEqual(I.stepClone(ctx).result, 'ok');
    assert.strictEqual(ctx.run.calls.length, before, 'no git command on a re-run');
});

// --- doctor ------------------------------------------------------------------

test('doctor fails loudly with hints on an empty machine', () => {
    const d = tmp();
    const run = fakeRun({ 'is-enabled': { status: 1 }, 'is-active': { status: 1 }, 'ss -tln': { status: 1 } });
    const ctx = ctxIn(d, { run });
    const checks = I.doctorChecks(ctx);
    const failed = checks.filter(c => !c.ok).map(c => c.name);
    assert.ok(failed.includes('config.yaml'));
    assert.ok(failed.includes('service enabled at boot'));
    assert.ok(failed.includes('listening on tcp port'));
    assert.ok(checks.filter(c => !c.ok).every(c => c.hint.length > 0), 'every failure carries a hint');
    assert.strictEqual(I.doctor(ctx), 1);
});

test('doctor flags a world-writable project directory', () => {
    const d = tmp(); const ctx = ctxIn(d);
    fs.chmodSync(d, 0o777);
    const ch = I.doctorChecks(ctx).find(c => c.name === 'project directory');
    assert.strictEqual(ch.ok, false);
    assert.match(ch.hint, /chmod 755/);
});

test('doctor passes on a fully installed machine', () => {
    const d = tmp();
    const run = fakeRun({ 'is-enabled': { stdout: 'enabled' }, 'is-active': { stdout: 'active' }, 'git -C': { stdout: 'abc1234 msg' }, 'rev-list': { stdout: '0' } });
    const ctx = ctxIn(d, { run });
    const c = ctx.cfg;
    fs.mkdirSync(path.join(c.venvDir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(c.venvDir, 'bin', 'rshell'), '');
    fs.mkdirSync(path.join(c.cloneDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(c.cloneDir, 'node_modules', 'node-pty'), { recursive: true });
    fs.mkdirSync(path.join(c.cloneDir, 'src', 'pi'), { recursive: true });
    fs.writeFileSync(path.join(c.cloneDir, 'src', 'pi', 'config.yaml'), I.renderConfig(c));
    fs.writeFileSync(path.join(c.cloneDir, 'src', 'pi', '99-pico.rules'), 'r\n');
    fs.mkdirSync(c.rulesDir, { recursive: true }); fs.writeFileSync(path.join(c.rulesDir, '99-pico.rules'), 'r\n');
    fs.writeFileSync(c.syslogSocket, '');
    fs.mkdirSync(path.dirname(c.unitPath), { recursive: true }); fs.writeFileSync(c.unitPath, 'u');
    fs.mkdirSync(c.firmwareDir, { recursive: true });
    const bad = I.doctorChecks(ctx).filter(x => !x.ok);
    assert.deepStrictEqual(bad, [], JSON.stringify(bad));
    assert.strictEqual(I.doctor(ctx), 0);
});

// --- status ------------------------------------------------------------------

test('status reports each registered Pico as connected or stale', () => {
    const d = tmp(); const ctx = ctxIn(d);
    const c = ctx.cfg;
    fs.mkdirSync(path.join(c.cloneDir, 'src', 'pi'), { recursive: true });
    fs.writeFileSync(path.join(c.cloneDir, 'src', 'pi', 'config.yaml'), I.renderConfig(c));
    fs.writeFileSync(path.join(c.projectDir, 'pico_serial_map.yaml'), 'e661aaaa: Blinds_pico\ne661bbbb: Lights_pico\n');
    const live = path.join(d, 'pts0'); fs.writeFileSync(live, '');
    fs.symlinkSync(live, path.join(c.projectDir, 'Blinds_pico'));
    fs.symlinkSync(path.join(d, 'gone'), path.join(c.projectDir, 'Lights_pico'));
    const lines = []; ctx.log = (s) => lines.push(s);
    I.status(ctx);
    assert.ok(lines.some(l => l.includes('Blinds_pico') && l.includes('port ')));
    assert.ok(lines.some(l => l.includes('Lights_pico') && l.includes('stale')));
    assert.ok(lines.some(l => l.startsWith('autoflash off')));
});

test('usage names the three commands', () => {
    for (const w of ['install', 'doctor', 'status']) assert.ok(I.usage().includes(w));
});
