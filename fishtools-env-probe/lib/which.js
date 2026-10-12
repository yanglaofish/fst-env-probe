// 跨平台可执行文件解析：只依赖 node 内置模块。
//
// 三条设计约束：
// 1) 默认不碰远程/网络挂载点——那里的文件系统调用可能让宿主进程进入内核级不可中断睡眠
//    （典型是 Linux NFS hard mount，连 SIGKILL 都无效）。被跳过的目录会记进
//    context.skipped，并在报告里告警，绝不静默漏检。
// 2) 所有目录访问都异步 + 超时（Promise.race）：即使某个目录挂住，也不会拖死整条流程。
// 3) 目录列表带 TTL 与容量上限缓存，一次检测不会重复读同一个目录。
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_PREFERRED_EXTS = ['.exe', '.cmd', '.bat', '.com'];
const WINDOWS_UNUSABLE_EXTS = new Set(['.ps1', '.vbs', '.js', '.wsf', '.msc', '.jse', '.lnk']);
const DIRECTORY_TTL_MS = 30000;
const DIRECTORY_CACHE_MAX = 512;
const DEFAULT_DIRECTORY_TIMEOUT_MS = 3000;

export function platformKey(platform = process.platform) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

export function isWindows(platform = process.platform) {
  return platformKey(platform) === 'win32';
}

export function pathSeparator(platform = process.platform) {
  return isWindows(platform) ? ';' : ':';
}

export function executableExts(platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return [''];
  const raw = typeof env.PATHEXT === 'string' ? env.PATHEXT : '';
  const fromEnv = raw
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^\.[a-z0-9]+$/.test(item) && !WINDOWS_UNUSABLE_EXTS.has(item));
  return [...new Set([...WINDOWS_PREFERRED_EXTS, ...fromEnv])];
}

export function splitSearchPath(platform = process.platform, env = process.env) {
  const key = isWindows(platform) ? env.PATH ?? env.Path ?? env.path : env.PATH;
  if (typeof key !== 'string' || !key) return [];
  const separator = pathSeparator(platform);
  const seen = new Set();
  const dirs = [];
  for (const entry of key.split(separator)) {
    const dir = entry.replace(/^"|"$/g, '').trim();
    if (!dir) continue;
    const normalized = isWindows(platform) ? dir.toLowerCase() : dir;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(dir);
  }
  return dirs;
}

/** 展开 %VAR% 与开头的 ~；PATH 类配置与快照路径共用同一规则。 */
export function expandPathValue(target, env = process.env) {
  if (typeof target !== 'string') return '';
  return target
    .trim()
    .replace(/%([^%]+)%/g, (raw, name) => env[name] ?? env[name.toUpperCase()] ?? raw)
    .replace(/^~(?=[\\/]|$)/, env.HOME ?? env.USERPROFILE ?? '~');
}

/** 按平台分隔符拆分环境变量列表（PATH、KUBECONFIG 等），去引号与空项，保留顺序与重复项。 */
export function splitEnvList(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return [];
  return value
    .split(pathSeparator(platform))
    .map((entry) => entry.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
}

function windowsKnownDirs(env) {
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return [
    env.SystemRoot ? `${env.SystemRoot}\\System32` : null,
    env.SystemRoot ? `${env.SystemRoot}\\System32\\OpenSSH` : null,
    env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : null,
    env.SystemRoot,
    `${pf}\\PowerShell\\7`,
    `${pf}\\nodejs`,
    `${pf86}\\nodejs`,
    env.APPDATA ? `${env.APPDATA}\\npm` : null,
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Python\\Launcher` : null,
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Microsoft\\WindowsApps` : null,
    `${pf}\\Git\\cmd`,
    `${pf}\\Git\\bin`,
    `${pf}\\Git\\usr\\bin`,
    `${pf}\\Docker\\Docker\\resources\\bin`,
    `${pf}\\dotnet`,
    `${pf}\\Go\\bin`,
    `${pf}\\CMake\\bin`,
    `${pf}\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
    env.ProgramData ? `${env.ProgramData}\\chocolatey\\bin` : null,
    env.ProgramData ? `${env.ProgramData}\\miniconda3` : null,
    env.ProgramData ? `${env.ProgramData}\\miniconda3\\Scripts` : null,
    env.ProgramData ? `${env.ProgramData}\\miniconda3\\Library\\bin` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\miniconda3` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\miniconda3\\Scripts` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\miniconda3\\Library\\bin` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\anaconda3` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\anaconda3\\Scripts` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\anaconda3\\Library\\bin` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\scoop\\shims` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\.cargo\\bin` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\.dotnet\\tools` : null,
    env.USERPROFILE ? `${env.USERPROFILE}\\AppData\\Local\\Microsoft\\WinGet\\Links` : null,
  ].filter(Boolean);
}

function posixKnownDirs(platform, env) {
  const home = env.HOME ?? '';
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/local/sbin',
    '/usr/sbin',
    '/sbin',
    '/snap/bin',
    '/opt/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/opt/local/bin',
    '/usr/local/go/bin',
    '/usr/local/cuda/bin',
    '/usr/local/nvidia/bin',
    '/usr/local/Ascend/driver/tools',
    '/usr/local/Ascend/ascend-toolkit/latest/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    home ? `${home}/.local/bin` : null,
    home ? `${home}/bin` : null,
    home ? `${home}/miniconda3/bin` : null,
    home ? `${home}/anaconda3/bin` : null,
    home ? `${home}/.cargo/bin` : null,
    home ? `${home}/.dotnet/tools` : null,
    home ? `${home}/.local/share/pnpm` : null,
    platform === 'linux' ? '/opt/conda/bin' : null,
  ].filter(Boolean);
}

export function knownDirs(platform = process.platform, env = process.env) {
  const plat = platformKey(platform);
  return (plat === 'win32' ? windowsKnownDirs(env) : posixKnownDirs(plat, env)).map((dir) => expandPathValue(dir, env));
}

export function isStoreShim(executablePath) {
  if (!executablePath) return false;
  const lower = executablePath.toLowerCase();
  return lower.includes('\\microsoft\\windowsapps\\') || lower.includes('/microsoft/windowsapps/');
}

/**
 * 判断目录是否落在某个远程挂载点下。
 * 纯函数：挂载点列表由 lib/mounts.js 探测后传入，避免模块间循环依赖。
 * @returns {{mount:string,fstype:string}|null}
 */
export function findRemoteMountFor(dir, remote = [], platform = process.platform) {
  if (typeof dir !== 'string' || !dir || !remote.length) return null;
  if (isWindows(platform)) {
    for (const entry of remote) {
      const mount = String(entry.mount ?? '');
      if (mount === '\\\\') {
        if (dir.startsWith('\\\\')) return entry;
        continue;
      }
      const letter = mount.slice(0, 2).toUpperCase();
      if (/^[A-Z]:$/.test(letter) && dir.toUpperCase().startsWith(letter)) return entry;
    }
    return null;
  }
  const target = dir.endsWith('/') ? dir : `${dir}/`;
  for (const entry of remote) {
    const mount = String(entry.mount ?? '');
    if (!mount) continue;
    const prefix = mount === '/' ? '/' : mount.endsWith('/') ? mount : `${mount}/`;
    if (target === prefix || target.startsWith(prefix)) return entry;
  }
  return null;
}

// 目录列表缓存：一次检测要查上百个工具名，不能每个名字都读一遍目录。
const DIRECTORY_CACHE = new Map();

export function clearDirectoryCache() {
  DIRECTORY_CACHE.clear();
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(file, platform) {
  if (!(await isFile(file))) return false;
  if (isWindows(platform)) return true;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 解析符号链接（Python 启动器常常是软链）；失败时返回空串。 */
export async function realPathOf(file) {
  try {
    return await realpath(file);
  } catch {
    return '';
  }
}

async function readDirectory(dir, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      readdir(dir),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`目录读取超时：${dir}`), { code: 'SCAN_TIMEOUT' })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function directoryEntries(dir, platform, context) {
  const key = `${platform}|${dir}`;
  const now = Date.now();
  const cached = DIRECTORY_CACHE.get(key);
  if (cached) {
    if (now - cached.at < DIRECTORY_TTL_MS) {
      if (context) context.cacheHits += 1;
      return cached.entries;
    }
    DIRECTORY_CACHE.delete(key);
  }
  let entries;
  let cacheable = true;
  try {
    const names = await readDirectory(dir, context?.directoryTimeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS);
    entries = isWindows(platform) ? new Set(names.map((name) => name.toLowerCase())) : new Set(names);
  } catch (error) {
    entries = new Set();
    if (error?.code === 'SCAN_TIMEOUT') {
      // 超时不缓存：下次仍要尝试，但记录在案，避免被当成"目录里没有"。
      cacheable = false;
      context?.timedOut.push(dir);
    } else {
      // 只缓存"目录确实不存在"；权限/网络/IO 错误不缓存，
      // 否则一次瞬时故障会让工具在 TTL 内被误判为"未找到"。
      cacheable = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
    }
  }
  if (context) context.directories += 1;
  if (cacheable) {
    if (DIRECTORY_CACHE.size >= DIRECTORY_CACHE_MAX) {
      const oldest = DIRECTORY_CACHE.keys().next().value;
      if (oldest !== undefined) DIRECTORY_CACHE.delete(oldest);
    }
    DIRECTORY_CACHE.set(key, { at: now, entries });
  }
  return entries;
}

/**
 * 创建一次扫描的上下文：收集跳过项、超时与统计，供报告层使用。
 */
export function createScanContext({
  platform = process.platform,
  env = process.env,
  remoteMounts = [],
  allowRemoteMounts = false,
  directoryTimeoutMs = DEFAULT_DIRECTORY_TIMEOUT_MS,
  signal,
} = {}) {
  return {
    platform,
    env,
    remoteMounts,
    allowRemoteMounts,
    directoryTimeoutMs,
    signal,
    skipped: [],
    timedOut: [],
    unreachableMounts: new Set(),
    directories: 0,
    cacheHits: 0,
  };
}

const MAX_PATTERN_MATCHES = 64;

/**
 * 展开"多版本安装目录"模式，用来发现 PATH 之外的安装（nvm 的 node、sdkman 的 java、
 * pyenv 的 python、rustup 的 toolchain …）。
 *
 * 段落里支持一个 `*`：整段为 `*` 表示任意一层子目录，`Python*` / `jdk*` 表示前缀匹配，
 * 既有前缀又有后缀时按两者共同过滤。不引入完整 glob，避免复杂度与越界风险。
 */
export async function expandInstallPatterns(patterns = [], options = {}) {
  const { platform = process.platform, env = process.env, context, limit = MAX_PATTERN_MATCHES } = options;
  const results = [];
  const seen = new Set();
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const expanded = expandPathValue(raw, env);
    // 先剥掉根（盘符或 /），否则 path.join('C:\\', 'C:') 会拼出 C:\C: 这种错路径。
    const root = path.isAbsolute(expanded) ? path.parse(expanded).root : '';
    const relative = path.isAbsolute(expanded) ? expanded.slice(root.length) : expanded;
    const segments = relative.split(/[\\/]+/).filter(Boolean);
    let candidates = [root];
    for (const segment of segments) {
      const next = [];
      if (!segment.includes('*')) {
        for (const base of candidates) next.push(path.join(base, segment));
      } else {
        const star = segment.indexOf('*');
        const prefix = segment.slice(0, star);
        const suffix = segment.slice(star + 1);
        for (const base of candidates) {
          const mount = findRemoteMountFor(base, context?.remoteMounts ?? [], platform);
          if (mount && !context?.allowRemoteMounts) {
            context?.skipped.push({ dir: base, mount: mount.mount, fstype: mount.fstype, reason: 'remote-mount' });
            continue;
          }
          if (context?.signal?.aborted) throw Object.assign(new Error('操作已取消'), { code: 'CANCELLED' });
          let names = [];
          try {
            names = await readDirectory(base, context?.directoryTimeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS);
            if (context) context.directories += 1;
          } catch (error) {
            if (error?.code === 'SCAN_TIMEOUT') context?.timedOut.push(base);
            names = [];
          }
          for (const name of names) {
            if (name.startsWith('.')) continue;
            if (prefix && !name.startsWith(prefix)) continue;
            if (suffix && !name.endsWith(suffix)) continue;
            next.push(path.join(base, name));
          }
          if (next.length >= limit) break;
        }
      }
      candidates = next.slice(0, limit);
      if (!candidates.length) break;
    }
    for (const candidate of candidates) {
      if (!(await isExecutableFile(candidate, platform))) continue;
      const key = isWindows(platform) ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        path: candidate,
        dir: path.dirname(candidate),
        name: path.basename(candidate),
        source: 'installation',
      });
    }
  }
  return results;
}

/**
 * 解析一个文件名的全部命中（保持 PATH 顺序，去重）。
 * @param {{platform?:string,env?:object,extraDirs?:string[],cwd?:string,context?:object}} options
 */
export async function resolveExecutableAll(name, options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    extraDirs = [],
    cwd = process.cwd(),
    context,
  } = options;
  if (typeof name !== 'string' || !name.trim()) return [];
  const query = name.trim();
  const results = [];
  const seen = new Set();
  const push = (file, source) => {
    const key = isWindows(platform) ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ path: file, dir: path.dirname(file), name: path.basename(file), source });
  };

  if (path.isAbsolute(query) || /[\\/]/.test(query)) {
    if (await isExecutableFile(path.resolve(cwd, query), platform)) {
      push(path.resolve(cwd, query), 'explicit');
    }
    return results;
  }

  const remoteMounts = context?.remoteMounts ?? [];
  const fromPath = splitSearchPath(platform, env);
  const fromKnown = knownDirs(platform, env).filter(
    (dir) => !fromPath.some((item) => (isWindows(platform) ? item.toLowerCase() === dir.toLowerCase() : item === dir)),
  );
  const groups = [
    { dirs: fromPath, source: 'PATH' },
    { dirs: [...extraDirs, ...(options.shimDirs ?? [])], source: 'configured' },
    { dirs: fromKnown, source: 'known' },
  ];
  const exts = executableExts(platform, env);

  for (const group of groups) {
    for (const dir of group.dirs) {
      const mount = findRemoteMountFor(dir, remoteMounts, platform);
      if (mount) {
        if (!context?.allowRemoteMounts) {
          // 默认跳过：远程挂载上的调用可能永不返回。记录以便报告层告警。
          context?.skipped.push({ dir, mount: mount.mount, fstype: mount.fstype, reason: 'remote-mount' });
          continue;
        }
        if (context.unreachableMounts.has(mount.mount)) {
          context.skipped.push({ dir, mount: mount.mount, fstype: mount.fstype, reason: 'mount-unreachable' });
          continue;
        }
      }
      if (context?.signal?.aborted) throw Object.assign(new Error('操作已取消'), { code: 'CANCELLED' });
      const before = context?.timedOut.length ?? 0;
      const entries = await directoryEntries(dir, platform, context);
      if (mount && (context?.timedOut.length ?? 0) > before) {
        // 这个挂载点已经超时过一次，后续同挂载点目录不再等待。
        context.unreachableMounts.add(mount.mount);
      }
      if (!entries.size) continue;
      for (const ext of exts) {
        const fileName = `${query}${ext}`;
        if (!entries.has(isWindows(platform) ? fileName.toLowerCase() : fileName)) continue;
        const file = path.join(dir, fileName);
        if (!(await isExecutableFile(file, platform))) continue;
        push(file, group.source);
      }
    }
  }
  return results;
}

/** 解析单个可执行文件；返回第一个命中或 null。 */
export async function resolveExecutable(name, options = {}) {
  const list = await resolveExecutableAll(name, options);
  return list[0] ?? null;
}

/** 由锚点可执行文件推断同族目录（如 Git 安装根下的 bin / usr/bin / mingw64/bin）。 */
export async function siblingDirs(anchorPath, relatives = []) {
  const dir = path.dirname(anchorPath);
  const parent = path.dirname(dir);
  const found = [];
  for (const root of new Set([parent, dir])) {
    for (const relative of relatives) {
      const candidate = path.join(root, ...relative.split('/'));
      try {
        if ((await stat(candidate)).isDirectory()) found.push(candidate);
      } catch {
        /* 目录不存在，忽略 */
      }
    }
  }
  return found;
}
