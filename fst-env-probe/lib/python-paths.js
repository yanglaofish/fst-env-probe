// 所有 Python 入口共用 Conda 注册表与 Windows 启动器的只读发现结果。
import os from 'node:os';
import path from 'node:path';
import { isWindows, readScanFile, resolveExecutableAll } from './which.js';
import { tryRun } from './exec.js';

export function pythonInEnv(prefix, platform = process.platform) {
  return isWindows(platform) ? path.join(prefix, 'python.exe') : path.join(prefix, 'bin', 'python');
}

export async function registeredCondaPrefixes({ env = process.env, context } = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const prefixes = [env.CONDA_PREFIX].filter(Boolean);
  try {
    const text = await readScanFile(path.join(home, '.conda', 'environments.txt'), { context });
    prefixes.push(...text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && path.isAbsolute(line)));
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    // 缺失注册表是正常情况，远程跳过和超时已由扫描上下文记录。
  }
  return [...new Set(prefixes)];
}

export function parsePyLauncher(text) {
  const found = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*-V:(\d+\.\d+)(\s*\*)?\s+(.+?\.exe)\s*$/i.exec(line);
    if (match) found.push({ path: match[3].trim(), version: match[1], default: Boolean(match[2]) });
  }
  return found;
}

export async function registeredLauncherPythons({ runProcess, signal, platform = process.platform, env = process.env, context, timeoutMs = 8000 } = {}) {
  if (!isWindows(platform) || typeof runProcess !== 'function') return [];
  const [launcher] = await resolveExecutableAll('py', { platform, env, context });
  if (!launcher) return [];
  const result = await tryRun(runProcess, launcher.path, ['-0p'], { signal, timeoutMs: Math.min(timeoutMs, 8000) });
  return parsePyLauncher(result.stdout).sort((a, b) => Number(b.default) - Number(a.default));
}
