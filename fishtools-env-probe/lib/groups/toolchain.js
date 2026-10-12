// 工具链采集：按注册表解析可执行文件、识别版本，并产出扁平的 paths / flags。
import { resolveExecutableAll, isStoreShim, isWindows, expandInstallPatterns } from '../which.js';
import { commandNamesFor, patternsFor } from '../catalog.js';
import { tryRun, mapLimit, extractVersion, firstNonEmptyLine } from '../exec.js';

/**
 * 解析一个工具的全部命中：PATH / 已知目录 / 配置目录，再加上 PATH 之外的多版本安装
 * （nvm 的 node、sdkman 的 java、pyenv 的 python、rustup 的 toolchain…）。
 * 通用检查、完整探测与 Python 专题都走这里，避免各写一套。
 */
export async function resolveToolHits({
  spec = null,
  query = '',
  platform = process.platform,
  env = process.env,
  extraDirs = [],
  context,
  withInstallations = true,
} = {}) {
  const names = spec ? commandNamesFor(spec, platform) : [query].filter(Boolean);
  let hits = [];
  for (const name of names) {
    const found = await resolveExecutableAll(name, {
      platform,
      env,
      extraDirs: [...(spec?.searchDirs ?? []), ...extraDirs],
      context,
    });
    if (found.length) {
      hits = found;
      break;
    }
  }
  if (spec && withInstallations) {
    const patterns = patternsFor(spec, platform);
    if (patterns.length) {
      const installed = await expandInstallPatterns(patterns, { platform, env, context });
      const seen = new Set(hits.map((hit) => (isWindows(platform) ? hit.path.toLowerCase() : hit.path)));
      for (const item of installed) {
        const key = isWindows(platform) ? item.path.toLowerCase() : item.path;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(item);
      }
    }
  }
  return hits;
}

/** 商店别名排到最后：它们存在但通常不可用。 */
export function orderHits(hits) {
  return [...hits.filter((hit) => !isStoreShim(hit.path)), ...hits.filter((hit) => isStoreShim(hit.path))];
}

function trimRaw(text) {
  return firstNonEmptyLine(text, { max: 220 });
}

export async function probeVersion(tool, executablePath, { runProcess, signal, timeoutMs }) {
  let lastRaw = '';
  let lastError = '';
  for (const args of tool.versionArgs) {
    const result = await tryRun(runProcess, executablePath, args, { signal, timeoutMs });
    const text = `${result.stdout}\n${result.stderr}`;
    const version = extractVersion(text, tool.parse ?? {});
    if (version) return { version, versionRaw: trimRaw(text), error: '' };
    if (!lastRaw) lastRaw = text;
    if (!result.ok) lastError = result.timedOut ? '版本命令超时' : result.error?.message ?? '版本命令返回非零退出码';
  }
  return { version: null, versionRaw: trimRaw(lastRaw), error: lastError || '未能从输出中识别版本号' };
}

export async function collectTools({
  runProcess,
  signal,
  env = process.env,
  tools = [],
  platform = process.platform,
  timeoutMs = 8000,
  concurrency = 6,
  extraDirs = [],
  deep = false,
  context,
} = {}) {
  const entries = await mapLimit(    tools,
    concurrency,
    async (tool) => {
      const hits = await resolveToolHits({
        spec: tool,
        platform,
        env,
        extraDirs,
        context,
      });
      const real = hits.filter((hit) => !isStoreShim(hit.path));
      const primary = real[0] ?? hits[0] ?? null;
      const entry = {
        id: tool.id,
        title: tool.title,
        group: tool.group,
        found: !!primary,
        path: primary?.path ?? '',
        source: primary?.source ?? '',
        shim: !!primary && isStoreShim(primary.path),
        version: null,
        versionRaw: '',
        error: '',
        note: tool.note ?? '',
        candidates: (deep ? hits : hits.slice(0, 1)).map((hit) => hit.path),
        custom: tool.source === 'custom',
      };
      if (!primary) return entry;
      if (!tool.versionArgs.length) return entry;
      const probed = await probeVersion(tool, primary.path, {
        runProcess,
        signal,
        // deep 模式放宽超时，但不越过输入 schema 声明的上限。
        timeoutMs: deep ? Math.min(timeoutMs * 2, 60000) : timeoutMs,
      });
      entry.version = probed.version;
      entry.versionRaw = probed.versionRaw;
      entry.error = probed.error;
      return entry;
    },
    { signal },
  );

  // 统计按最终结果统一计算，避免在并发 worker 里多处手工 +1 而失同步。
  const stats = {
    total: tools.length,
    found: entries.filter((entry) => entry.found).length,
    versioned: entries.filter((entry) => entry.version).length,
    shims: entries.filter((entry) => entry.shim).length,
    failed: entries.filter((entry) => entry.found && !entry.version).length,
  };

  const byId = Object.create(null);
  const paths = Object.create(null);
  const flags = Object.create(null);
  for (const entry of entries) {
    byId[entry.id] = entry;
    flags[entry.id] = entry.found;
    if (entry.found && entry.path) paths[entry.id] = entry.path;
  }
  return { entries, byId, paths, flags, stats };
}

/** Shell 环境：默认 shell、可用 shell、Git Bash、WSL 发行版。 */
export async function collectShells({
  runProcess,
  signal,
  env = process.env,
  toolById = {},
  timeoutMs = 8000,
  deep = false,
  context,
}) {
  const result = { default: '', available: [], gitBash: null, wsl: null, warnings: [] };
  result.default = isWindows() ? env.ComSpec ?? '' : env.SHELL ?? '';

  for (const id of ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh']) {
    const tool = toolById[id];
    if (!tool?.found) continue;
    result.available.push({
      id,
      title: tool.title,
      path: tool.path,
      version: tool.version ?? null,
      default: tool.path === result.default,
    });
  }

  if (isWindows()) {
    const git = toolById.git;
    if (git?.found) {
      const root = git.path.replace(/[\\/](cmd|bin|mingw64[\\/]bin)[\\/]git\.exe$/i, '');
      const candidates = [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`, `${root}\\mingw64\\bin\\bash.exe`];
      let bash = null;
      for (const candidate of candidates) {
        const [hit] = await resolveExecutableAll(candidate, { platform: process.platform, env, context });
        if (hit) {
          bash = hit;
          break;
        }
      }
      if (bash) {
        const probed = await tryRun(runProcess, bash.path, ['--version'], { signal, timeoutMs });
        result.gitBash = {
          path: bash.path,
          version: extractVersion(`${probed.stdout}\n${probed.stderr}`),
          root,
        };
      }
    }
    const wslTool = toolById.wsl;
    if (wslTool?.found) {
      result.wsl = await collectWsl({ runProcess, signal, env, executable: wslTool.path, timeoutMs, deep });
    }
  }
  return result;
}

// WSL 默认按 UTF-16LE 输出；部分版本或显式设置 WSL_UTF8 后为 UTF-8。
// 0.4.0 起 runProcess 支持 encoding，这里两种解码各试一次，取文本质量更高的结果。
const WSL_DECODINGS = [
  { encoding: 'utf16le', decorate: (base) => base },
  { encoding: 'utf8', decorate: (base) => ({ ...base, WSL_UTF8: '1' }) },
];

function wslTextScore(text) {
  const value = String(text ?? '');
  if (!value.trim()) return 0;
  let score = 1;
  // 错误解码通常留下替换字符或 NUL 字节。
  if (!value.includes('\uFFFD') && !value.includes('\u0000')) score += 1;
  if (/(NAME\s+(STATE|VERSION)|WSL|发行版|適用|DISTRIBUTION)/i.test(value)) score += 2;
  return score;
}

async function runWslCommand({ runProcess, signal, env, executable, timeoutMs, args }) {
  let best = null;
  let bestScore = -1;
  for (const candidate of WSL_DECODINGS) {
    const result = await tryRun(runProcess, executable, args, {
      signal,
      timeoutMs,
      encoding: candidate.encoding,
      env: candidate.decorate(env),
    });
    const score = wslTextScore(result.stdout);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
    if (score >= 3) break;
  }
  return best;
}

async function collectWsl({ runProcess, signal, env, executable, timeoutMs, deep = false }) {
  const info = { path: executable, version: '', defaultDistro: '', kernel: '', distributions: [], error: '' };

  const verbose = await runWslCommand({ runProcess, signal, env, executable, timeoutMs, args: ['-l', '-v'] });
  if (verbose?.ok) {
    const lines = verbose.stdout
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines.slice(1)) {
      const match = /^(\*)?\s*(\S+)\s+(\S+)\s+(\d+)$/.exec(line);
      if (!match) continue;
      info.distributions.push({ name: match[2], state: match[3], version: Number(match[4]), default: match[1] === '*' });
    }
    info.defaultDistro = info.distributions.find((item) => item.default)?.name ?? '';
  } else {
    info.error = verbose?.error?.message ?? 'wsl -l -v 执行失败';
  }

  const versionRun = await runWslCommand({ runProcess, signal, env, executable, timeoutMs, args: ['--version'] });
  if (versionRun?.ok) info.version = extractVersion(`${versionRun.stdout}\n${versionRun.stderr}`) ?? '';

  // `wsl -e <命令>` 会真正启动发行版（占资源、可能触发初始化），只在深度检测时执行。
  if (deep) {
    const kernel = await runWslCommand({ runProcess, signal, env, executable, timeoutMs, args: ['-e', 'uname', '-r'] });
    if (kernel?.ok && kernel.stdout.trim()) info.kernel = kernel.stdout.trim();
  }
  return info;
}

/** 汇总布尔标志，供工作流条件判断使用（缺失的工具也要有稳定的 false）。 */
export function aggregateFlags(flags) {
  const merged = { ...flags };
  const anyOf = (...ids) => ids.some((id) => merged[id] === true);
  merged.python = anyOf('python', 'python3');
  merged.node = anyOf('node');
  merged.git = anyOf('git');
  merged.shell = anyOf('powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh');
  merged.packageManager = anyOf(
    'yum',
    'dnf',
    'apt',
    'apt-get',
    'apk',
    'zypper',
    'pacman',
    'brew',
    'choco',
    'winget',
    'scoop',
  );
  merged.containerRuntime = anyOf('docker', 'podman', 'nerdctl');
  merged.kubernetes = anyOf('kubectl', 'helm');
  merged.accelerator = anyOf('nvidia-smi', 'npu-smi', 'rocm-smi', 'xpu-smi');
  return merged;
}
