import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

for (const key of ['github', 'feishu-office', 'wecom-office']) {
  const { createAuthWire } = await import(`../../plugins/${key}/.neuxbot/auth/wire.mjs`);
  const params = { protocol: 'neuxbot-auth/1', operationId: 'op-example', pluginId: 'plugin-example', versionId: 'version-example', digest: 'a'.repeat(64), configurationRevision: 2, accountGeneration: 3, sessionId: 'session-example', dataDirectory: path.join(tmpdir(), 'example-private'), scopes: ['read'] };
  test(`${key}: strict initialization binds all context and rejects prior protocol`, () => {
    assert.throws(() => createAuthWire().accept('auth/start', params), /invalid_session/);
    for (const patch of [{ dataDirectory: 42 }, { dataDirectory: 'relative' }, { operationId: 'bad\0id' }, { sessionId: 'bad\0id' }, { accountGeneration: -1 }, { configurationRevision: Number.MAX_SAFE_INTEGER + 1 }, { scopes: Array(129).fill('read') }]) {
      assert.throws(() => createAuthWire().accept('auth/initialize', { ...params, ...patch }), /invalid_session/);
    }
    assert.throws(() => createAuthWire().accept('auth/initialize', { ...params, protocol: 'neuxally-auth/1' }), /invalid_session/);
    const wire = createAuthWire(), initialized = wire.accept('auth/initialize', params);
    assert.deepEqual(initialized, { protocol: 'neuxbot-auth/1', context: { operationId: 'op-example', pluginId: 'plugin-example', versionId: 'version-example', digest: 'a'.repeat(64), configurationRevision: 2, accountGeneration: 3 } });
    assert.equal(wire.accept('auth/status', params), undefined);
    for (const patch of [{ operationId: 'old' }, { pluginId: 'foreign' }, { versionId: 'other' }, { digest: 'b'.repeat(64) }, { configurationRevision: 1 }, { accountGeneration: 2 }, { sessionId: 'other' }, { dataDirectory: path.join(tmpdir(), 'foreign') }, { scopes: ['write'] }]) {
      assert.throws(() => wire.accept('auth/resolve', { ...params, ...patch }), /invalid_session/);
    }
    assert.throws(() => wire.accept('auth/initialize', params), /invalid_session/);
    assert.throws(() => wire.accept('management/read', params), /invalid_session/);
  });
}

// 文件事件确认真实子进程已安装信号处理器，不用睡眠估计启动速度。
function waitFile(filename) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); unwatchFile(filename, inspect); };
    const timer = setTimeout(() => { stop(); reject(new Error('supplier readiness event missing')); }, 30000);
    const inspect = () => readFile(filename).then(() => { stop(); resolve(); }, error => { if (error.code !== 'ENOENT') { stop(); reject(error); } });
    watchFile(filename, { interval: 20 }, inspect); inspect();
  });
}

for (const key of ['feishu-office', 'wecom-office']) {
  const { prepareSkillLauncher } = await import(`../../plugins/${key}/.neuxbot/auth/launcher.mjs`);
  test(`${key}: 私有launcher固定Node和账号，保留带引号参数并等待实际子进程退出`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin launcher's %PATH%! "));
    let child, exited;
    t.after(async () => { if (child) { child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true }); });
    const script = path.join(directory, 'supplier fixture.mjs'), preload = path.join(directory, 'foreign.mjs');
    await writeFile(preload, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path.join(directory, 'injected'))},'unsafe');`);
    await writeFile(script, `import {writeFileSync} from 'node:fs';import path from 'node:path';
if(process.argv[2]==='wait'){
 process.on('SIGTERM',()=>{writeFileSync(path.join(process.env.PRIVATE_CONFIG_DIR,'stopped'),'yes');process.exit(0)});
 setInterval(()=>{},1000);writeFileSync(path.join(process.env.PRIVATE_CONFIG_DIR,'ready'),'yes');
}else console.log(JSON.stringify({args:process.argv.slice(2),profile:process.env.PRIVATE_CONFIG_DIR,foreign:process.env.PRIVATE_TOKEN,nodeOptions:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH}));`);
    const bin = await prepareSkillLauncher({ directory, binary: process.execPath, name: 'private-cli', prefix: 'PRIVATE_', environment: { PRIVATE_CONFIG_DIR: directory } });
    const launcher = path.join(bin, process.platform === 'win32' ? 'private-cli.cmd' : 'private-cli');
    const environment = { ...process.env, PRIVATE_CONFIG_DIR: '/foreign-profile', PRIVATE_TOKEN: 'foreign-token', NODE_OPTIONS: `--import=${preload}`, NODE_PATH: '/foreign-modules' };
    const args = [script, 'space value', "single'quote", 'double"quote', 'amp&value', '%PATH%', '!literal'];
    let command = launcher, arguments_ = args, inherited = environment;
    if (process.platform === 'win32') {
      const batch = await readFile(launcher, 'utf8');
      assert.match(batch, /setlocal DisableDelayedExpansion/); assert.match(batch, /set "NODE_OPTIONS="/); assert.match(batch, /set "NODE_PATH="/);
      command = process.execPath; arguments_ = [path.join(bin, 'private-cli.mjs'), ...args]; inherited = { ...environment, NODE_OPTIONS: '', NODE_PATH: '' };
    }
    const result = spawnSync(command, arguments_, { env: inherited, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: args.slice(1), profile: directory });
    await assert.rejects(readFile(path.join(directory, 'injected')), { code: 'ENOENT' });
    if (process.platform !== 'win32') {
      child = spawn(launcher, [script, 'wait'], { env: environment, stdio: 'ignore' });
      exited = once(child, 'close');
      await waitFile(path.join(directory, 'ready')); child.kill('SIGTERM'); await exited;
      assert.equal(await readFile(path.join(directory, 'stopped'), 'utf8'), 'yes');
    }
    await assert.rejects(prepareSkillLauncher({ directory, binary: process.execPath, name: '../escape', prefix: 'PRIVATE_', environment: {} }), /invalid_launcher/);
    const other = path.join(directory, 'other'); await mkdir(other);
    const alias = path.join(other, 'skill-bin'); await symlink(bin, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareSkillLauncher({ directory: other, binary: process.execPath, name: 'private-cli', prefix: 'PRIVATE_', environment: {} }), /invalid_launcher/);
  });
}
