import { mkdir, lstat, realpath, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Skill 通过包内 launcher 使用私有账号，宿主无需理解供应商环境变量。
export async function prepareSkillLauncher({ directory, binary, name, prefix, environment }) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(binary) || !/^[a-z][a-z0-9-]*$/.test(name) || !/^[A-Z][A-Z0-9_]*_$/.test(prefix) ||
      !environment || Object.entries(environment).some(([key, value]) => !key.startsWith(prefix) || typeof value !== 'string' || value.includes('\0'))) throw new Error('invalid_launcher');
  const root = await realpath(directory);
  const bin = path.join(root, 'skill-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  if ((await lstat(bin)).isSymbolicLink() || await realpath(bin) !== bin) throw new Error('invalid_launcher');
  const scriptPath = path.join(bin, `${name}.mjs`);
  const script = `import { spawn } from 'node:child_process';\nconst env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith(${JSON.stringify(prefix)}) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));\nObject.assign(env, ${JSON.stringify(environment)});\nconst child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { env, stdio: 'inherit', windowsHide: true });\nfor (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));\nchild.on('error', () => process.exit(1));\nchild.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGINT' ? 130 : 143)));\n`;
  async function atomic(filename, content) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: 'wx', mode: 0o700 });
    await rename(temporary, filename); await chmod(filename, 0o700);
  }
  await atomic(scriptPath, script);
  if (process.platform === 'win32') {
    const quote = value => '"' + value.replaceAll('%', '%%') + '"';
    await atomic(path.join(bin, `${name}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\n${quote(process.execPath)} ${quote(scriptPath)} %*\r\n`);
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await atomic(path.join(bin, name), `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`);
  }
  return bin;
}
