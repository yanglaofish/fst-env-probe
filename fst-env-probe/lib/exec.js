// 受管进程调用的薄封装：宿主 runProcess 抛错时不让单点失败中断整次检测。
import { resolveExecutable, isWindows, platformKey } from './which.js';
import { EnvProbeError } from './errors.js';
import { extractVersion } from './version.js';

export { extractVersion };

export async function tryRun(runProcess, file, args, options = {}) {
  const { signal, timeoutMs = 8000, cwd, env, encoding } = options;
  if (signal?.aborted) throw new EnvProbeError('操作已取消', { code: 'CANCELLED' });
  try {
    // 宿主 0.4.0 起支持显式 encoding；只有显式给出时才传，避免覆盖默认解码。
    const result = await runProcess(file, args, {
      signal,
      timeout: timeoutMs,
      cwd,
      env,
      ...(typeof encoding === 'string' && encoding ? { encoding } : {}),
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: false,
      error: null,
    };
  } catch (error) {
    if (signal?.aborted) throw new EnvProbeError('操作已取消', { code: 'CANCELLED', cause: error });
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: error?.code === 'TIMEOUT',
      error: { code: error?.code ?? 'PROCESS_ERROR', message: error?.message ?? String(error) },
    };
  }
}

/** 有界并发；任一项失败（不只是取消）都会立刻收敛其余协程，避免继续 fork 子进程。 */
export async function mapLimit(items, limit, worker, { signal } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  let stopped = false;
  const size = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 6, list.length || 1));
  const run = async () => {
    for (;;) {
      if (stopped || signal?.aborted) throw new EnvProbeError('操作已取消', { code: 'CANCELLED' });
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

/** 取第一个非空行（可选截断），把命令输出压成一行摘要时统一走这里。 */
export function firstNonEmptyLine(text, { max = 0 } = {}) {
  const first =
    String(text ?? '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? '';
  if (!max || first.length <= max) return first;
  return `${first.slice(0, Math.max(0, max - 3))}...`;
}

export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    /* 继续尝试截取 */
  }
  const start = clean.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function firstLine(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
}

export function nonEmpty(text) {
  return typeof text === 'string' && text.trim() !== '';
}

const POWERSHELL_KEYS = ['pwsh', 'powershell'];

/**
 * 拼接 PowerShell 脚本片段：统一用 ';' 分隔并去掉行尾分号。
 * 若片段自身以 ';' 结尾，拼接后会得到空的 ';;' 语句，在哈希字面量里是语法错误。
 */
export function joinPowerShell(lines) {
  return lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => line.replace(/;+$/, ''))
    .join(';');
}

/**
 * PowerShell 把未捕获错误序列化成 CLIXML 写入 stderr 时，
 * 直接取首行只能得到 '#< CLIXML'。这里还原出可读的报错文本。
 */
export function cleanPowerShellError(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  if (!raw.includes('CLIXML') && !raw.includes('<Objs')) return firstLine(raw);
  const lines = raw
    .replace(/<S S="Error">([\s\S]*?)<\/S>/g, '$1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/_x000D_/g, '')
    .replace(/_x000A_/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 3).join(' ') || '#< CLIXML（PowerShell 未给出可读错误）';
}

/** 找到可用的 PowerShell（优先 pwsh 7，其次 Windows PowerShell 5.1）。 */
export async function resolvePowerShell({ platform = process.platform, env = process.env, context } = {}) {
  if (!isWindows(platform)) return null;
  const known = env.SystemRoot ? [`${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`] : [];
  for (const name of [...POWERSHELL_KEYS, ...known]) {
    const hit = await resolveExecutable(name, { platform, env, context });
    if (hit) return hit.path;
  }
  return null;
}

/**
 * 用 PowerShell 取结构化 JSON：强制 UTF-8 输出、-EncodedCommand 免转义。
 * @returns {Promise<{ok:boolean,data:any,error:null|{code:string,message:string}}>}
 */
export async function pwshJson(runProcess, script, options = {}) {
  const { signal, timeoutMs = 20000, executable, context } = options;
  const exe = executable ?? (await resolvePowerShell({ context }));
  if (!exe) {
    return { ok: false, data: null, error: { code: 'NO_POWERSHELL', message: '当前平台没有可用的 PowerShell' } };
  }
  const body = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$ProgressPreference='SilentlyContinue'",
    '$OutputEncoding=[System.Text.Encoding]::UTF8',
    'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
    script,
  ].join(';');
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  const result = await tryRun(
    runProcess,
    exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { signal, timeoutMs },
  );
  const data = parseJsonLoose(result.stdout);
  if (data === null) {
    return {
      ok: false,
      data: null,
      error: {
        code: result.timedOut ? 'POWERSHELL_TIMEOUT' : 'POWERSHELL_JSON',
        message: cleanPowerShellError(result.stderr) || result.error?.message || 'PowerShell 未返回可解析的 JSON',
      },
    };
  }
  return { ok: true, data, error: null };
}

export function platformTarget(platform = process.platform) {
  const key = platformKey(platform);
  return key === 'linux' ? `${platform}-${process.arch}-glibc` : `${platform}-${process.arch}`;
}
