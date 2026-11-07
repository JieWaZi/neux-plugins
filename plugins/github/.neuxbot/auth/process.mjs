import { spawn } from 'node:child_process';
import path from 'node:path';

const failure = code => Object.assign(new Error(code), { code });

// 不继承用户 CLI 身份、钥匙串选择和可执行搜索路径；官方命令始终使用已校验绝对路径。
export function managedEnvironment(binary, dataDirectory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(GH_|GITHUB_|GIT_|XDG_|LD_|DYLD_|NODE_)/i.test(key) || /KEYCHAIN|KEYRING/i.test(key) || /^(BROWSER|SSH_ASKPASS)$/i.test(key)) delete env[key];
  const home = path.join(dataDirectory, 'home');
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), GH_CONFIG_DIR: path.join(dataDirectory, 'profile'), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb' });
  const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [...new Set([path.dirname(binary), path.dirname(process.execPath), ...system])].join(path.delimiter);
  return env;
}

export function cliRunner(binary, dataDirectory) {
  const children = new Set();
  async function run(args, { signal, timeout = 20000, stderrLine } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env: managedEnvironment(binary, dataDirectory), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      children.add(child);
      let output = '', diagnostic = '', total = 0, reason, killTimer, settled = false;
      const kill = force => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') {
            const utility = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe');
            const termination = spawn(utility, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            termination.on('error', () => child.kill());
          } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch { /* 上游已退出时无需再次终止。 */ }
      };
      const stop = code => { reason ??= code; kill(false); killTimer ??= setTimeout(() => kill(true), 1000); };
      const abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('expired'), timeout);
      if (signal?.aborted) abort();
      child.stdout.on('data', bytes => { total += bytes.length; if (total > 1024 * 1024) stop('output_limit'); else output += bytes; });
      const consume = line => { try { stderrLine(line.trim()); } catch (error) { stop(error.code ?? 'invalid_challenge'); } };
      child.stderr.on('data', bytes => {
        total += bytes.length;
        if (total > 1024 * 1024 || (stderrLine && total > 64 * 1024)) { stop('output_limit'); return; }
        if (!stderrLine) return;
        diagnostic += bytes;
        let end; while ((end = diagnostic.indexOf('\n')) >= 0) { consume(diagnostic.slice(0, end)); diagnostic = diagnostic.slice(end + 1); }
      });
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); children.delete(child); if (error) reject(failure(error)); else resolve(output); };
      child.once('error', () => finish('plugin_not_ready'));
      child.once('close', code => { if (stderrLine && diagnostic) consume(diagnostic); finish(reason ?? (code === 0 ? undefined : 'authorization_failed')); });
    });
  }
  return { run, terminate: () => { for (const child of children) child.kill('SIGKILL'); } };
}
