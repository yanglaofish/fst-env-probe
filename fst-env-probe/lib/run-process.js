// 共享服务调用方未提供宿主 runProcess 时的零依赖回退。
// 动作仍使用宿主接口；回退保留编码、输出上限、取消和进程树回收语义。
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

function processError(code, message, file) {
  return Object.assign(new Error(message), { code, details: { executable: file } });
}

/** Windows 批处理需要 cmd；引号平衡、百分号和延迟展开必须分别处理。 */
function batchCommand(file, args, env) {
  if ([file, ...args].some((value) => /[\r\n\0]/.test(value))) {
    throw new TypeError('Windows 批处理的程序路径和参数不能包含换行或空字符');
  }
  const quote = (value) => {
    const escaped = String(value)
      .replace(/\\+/g, (slashes, offset, source) =>
        source[offset + slashes.length] === '"' || offset + slashes.length === source.length ? slashes.repeat(2) : slashes)
      .replaceAll('"', '""')
      .replaceAll('%', '%%cd:~,%');
    return `"${escaped}"`;
  };
  const escapedFile = path.normalize(file).replace(/[()\][%!^"`<>&|;, *?]/g, '^$&');
  return {
    file: env.ComSpec || env.comspec || 'cmd.exe',
    args: ['/d', '/e:on', '/v:off', '/s', '/c', `"${[escapedFile, ...args.map(quote)].join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {
        child.kill();
        resolve();
      });
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

export function createFallbackRunProcess() {
  return (file, args = [], options = {}) => new Promise((resolve, reject) => {
    const { cwd, env, signal, timeout = 30000, maxBuffer = 4 * 1024 * 1024, encoding = 'utf8' } = options;
    if (signal?.aborted) {
      reject(processError('CANCELLED', '操作已取消', file));
      return;
    }
    if (!Number.isFinite(maxBuffer) || maxBuffer < 0) throw new TypeError('maxBuffer 必须为非负有限数');
    // 与新版宿主一致，编码校验在启动进程前完成。
    const label = /^(utf16le|ucs2|ucs-2)$/i.test(encoding) ? 'utf-16le' : encoding;
    const decoder = new TextDecoder(label);
    const mergedEnv = env ? { ...process.env, ...env } : process.env;
    const command = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
      ? batchCommand(file, args, mergedEnv) : { file, args };
    const child = spawn(command.file, command.args, {
      cwd, env: mergedEnv, windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    let stopped, killing, timer;
    const stop = (code) => {
      if (stopped) return;
      stopped = code;
      killing = killTree(child);
    };
    const abort = () => stop('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeout > 0) timer = setTimeout(() => stop('TIMEOUT'), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        if (stopped) return;
        lengths[name] += chunk.length;
        if (lengths[name] > maxBuffer) { stop('OUTPUT_LIMIT'); return; }
        chunks[name].push(chunk);
      });
    }
    child.once('error', (error) => {
      cleanup();
      reject(processError(error.code ?? 'SPAWN_FAILED', `无法启动程序 ${file}：${error.message}`, file));
    });
    child.once('close', async (exitCode, exitSignal) => {
      cleanup();
      await killing;
      if (stopped) {
        const messages = { CANCELLED: '操作已取消', TIMEOUT: '程序运行超时', OUTPUT_LIMIT: '程序输出超过上限' };
        reject(processError(stopped, messages[stopped], file));
      } else if (exitSignal) {
        reject(processError('SPAWN_FAILED', `程序被信号终止：${exitSignal}`, file));
      } else {
        const decode = (name) => decoder.decode(Buffer.concat(chunks[name]));
        resolve({ exitCode, stdout: decode('stdout'), stderr: decode('stderr') });
      }
    });
  });
}
