// 容器 / K8s、语言清单（conda 环境与 Python 解释器）、加速设备采集。
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tryRun, parseJsonLoose, toArray, extractVersion, firstLine } from '../exec.js';
import { isWindows, resolveExecutableAll, splitEnvList, realPathOf, findRemoteMountFor, expandInstallPatterns } from '../which.js';
import { patternsFor } from '../catalog.js';
import { compareVersions } from '../version.js';

const DOCKER_INFO_KEYS = [
  'ServerVersion',
  'OperatingSystem',
  'OSType',
  'Architecture',
  'NCPU',
  'MemTotal',
  'Driver',
  'KernelVersion',
  'CgroupVersion',
  'DockerRootDir',
  'Name',
  'Containers',
  'ContainersRunning',
  'Images',
];

function pickFields(data, keys) {
  if (!data || typeof data !== 'object') return null;
  const picked = {};
  for (const key of keys) {
    const value = data[key] ?? data[key.toLowerCase()];
    if (value !== undefined && value !== null && typeof value !== 'object') picked[key] = value;
  }
  return Object.keys(picked).length ? picked : null;
}

async function probeEngine(id, tool, { runProcess, signal, timeoutMs }) {
  const engine = {
    name: id,
    path: tool.path,
    clientVersion: tool.version ?? null,
    serverVersion: '',
    daemonReachable: null,
    context: '',
    composeVersion: '',
    info: null,
    error: '',
  };
  if (id === 'docker') {
    const context = await tryRun(runProcess, tool.path, ['context', 'show'], { signal, timeoutMs: Math.min(timeoutMs, 5000) });
    if (context.ok) engine.context = context.stdout.trim();
    const compose = await tryRun(runProcess, tool.path, ['compose', 'version', '--short'], {
      signal,
      timeoutMs: Math.min(timeoutMs, 8000),
    });
    if (compose.ok) engine.composeVersion = firstLine(compose.stdout);
  }
  const args = id === 'podman' ? ['info', '--format', 'json'] : ['info', '--format', '{{json .}}'];
  const info = await tryRun(runProcess, tool.path, args, { signal, timeoutMs: Math.min(timeoutMs, 8000) });
  if (info.ok) {
    let data = null;
    try {
      data = JSON.parse(info.stdout);
    } catch {
      data = parseJsonLoose(info.stdout);
    }
    engine.daemonReachable = true;
    if (id === 'podman') {
      engine.serverVersion = data?.version?.Version ?? '';
      engine.info = pickFields(
        { ...(data?.host ?? {}), ...(data?.version ?? {}) },
        ['Version', 'Os', 'Arch', 'Kernel', 'CgroupVersion', 'Rootless', 'Runtime', 'Conmon'],
      );
    } else {
      engine.serverVersion = data?.ServerVersion ?? '';
      engine.info = pickFields(data, DOCKER_INFO_KEYS);
    }
  } else {
    engine.daemonReachable = false;
    engine.error = info.timedOut ? '引擎信息查询超时（守护进程可能未运行）' : firstLine(info.stderr) || info.error?.message || '引擎信息查询失败';
  }
  return engine;
}

async function collectK8s({ runProcess, signal, env, toolById, timeoutMs }) {
  const kubectl = toolById.kubectl;
  const k8s = {
    kubectlPath: kubectl?.found ? kubectl.path : '',
    clientVersion: kubectl?.version ?? null,
    kubeconfigPath: '',
    kubeconfigExists: false,
    currentContext: '',
    contexts: [],
    contextCount: 0,
    clusterReachable: null,
    serverVersion: '',
    error: '',
  };
  const configured = splitEnvList(env.KUBECONFIG ?? '', process.platform);
  k8s.kubeconfigPath = configured[0] ?? path.join(os.homedir(), '.kube', 'config');
  // 存在性检查也要走异步：kubeconfig 可能被放在网络挂载上。
  const candidates = configured.length ? configured : [k8s.kubeconfigPath];
  k8s.kubeconfigExists = (await Promise.all(candidates.map((item) => fileExists(item)))).some(Boolean);
  if (!kubectl?.found) {
    k8s.error = '未找到 kubectl';
    return k8s;
  }
  const current = await tryRun(runProcess, kubectl.path, ['config', 'current-context'], {
    signal,
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  if (current.ok) k8s.currentContext = current.stdout.trim();
  const contexts = await tryRun(runProcess, kubectl.path, ['config', 'get-contexts', '-o', 'name'], {
    signal,
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  if (contexts.ok) {
    k8s.contexts = contexts.stdout
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    k8s.contextCount = k8s.contexts.length;
  } else if (!k8s.error) {
    k8s.error = firstLine(contexts.stderr) || '读取 kubeconfig 上下文失败';
  }
  // `kubectl version -o json` 只发一个只读的版本查询，不做任何集群写入，
  // 因此默认执行；请求超时压到 3 秒，连不上也不会拖慢整体检测。
  const version = await tryRun(runProcess, kubectl.path, ['version', '-o', 'json', '--request-timeout=3s'], {
    signal,
    timeoutMs: Math.min(timeoutMs, 8000),
  });
  const data = version.ok ? parseJsonLoose(version.stdout) : null;
  if (data) {
    k8s.clusterReachable = true;
    k8s.serverVersion = data.serverVersion?.gitVersion ?? '';
    k8s.clientVersion = data.clientVersion?.gitVersion ?? k8s.clientVersion;
  } else {
    k8s.clusterReachable = false;
    k8s.error = firstLine(version.stderr) || '集群不可达';
  }
  return k8s;
}

export async function collectContainers({ runProcess, signal, env = process.env, toolById = {}, timeoutMs = 8000 }) {
  const engines = [];
  const warnings = [];
  for (const id of ['docker', 'podman', 'nerdctl']) {
    const tool = toolById[id];
    if (!tool?.found) continue;
    try {
      engines.push(await probeEngine(id, tool, { runProcess, signal, timeoutMs }));
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`${id} 引擎信息读取失败：${error?.message ?? error}`);
    }
  }
  const k8s = await collectK8s({ runProcess, signal, env, toolById, timeoutMs });
  return { engines, engineCount: engines.length, k8s, warnings };
}

// ---------------------------------------------------------------------------
// 语言清单：conda 环境与 Python 解释器
// ---------------------------------------------------------------------------

function pythonInEnv(envDir) {
  return isWindows() ? path.join(envDir, 'python.exe') : path.join(envDir, 'bin', 'python');
}

async function listCondaEnvs({ runProcess, signal, env, condaPath, timeoutMs }) {
  if (condaPath) {
    const json = await tryRun(runProcess, condaPath, ['env', 'list', '--json'], {
      signal,
      timeoutMs: Math.min(timeoutMs, 15000),
    });
    if (json.ok) {
      const data = parseJsonLoose(json.stdout);
      if (data && Array.isArray(data.envs)) return { envs: data.envs, source: 'conda env list --json' };
    }
  }
  const registry = path.join(os.homedir(), '.conda', 'environments.txt');
  try {
    const text = await readFile(registry, 'utf8');
    const envs = text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (envs.length) return { envs, source: '~/.conda/environments.txt' };
  } catch {
    /* 没有该文件 */
  }
  return { envs: [], source: '' };
}

export function parsePyLauncher(text) {
  const found = [];
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    // py -0p 的实际输出形如：` -V:3.12 *        C:\...\python.exe`
    // 星号前有空格，必须一起容错，否则 '*' 会被吃进路径。
    const match = /^\s*-V:(\d+\.\d+)(\s*\*)?\s+(.+?\.exe)\s*$/i.exec(rawLine);
    if (!match) continue;
    found.push({ path: match[3].trim(), version: match[1], default: Boolean(match[2]) });
  }
  return found;
}

async function pythonVersion(runProcess, executable, { signal, timeoutMs }) {
  const result = await tryRun(runProcess, executable, ['--version'], { signal, timeoutMs: Math.min(timeoutMs, 8000) });
  return extractVersion(`${result.stdout}\n${result.stderr}`);
}

async function fileExists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 远程挂载下的路径一律不碰；记录跳过项，让报告层能说明"哪些位置没查"。 */
function isSkippedPath(target, context) {
  if (!target) return false;
  const mount = findRemoteMountFor(target, context?.remoteMounts ?? [], process.platform);
  if (!mount || context?.allowRemoteMounts) return false;
  context?.skipped.push({ dir: target, mount: mount.mount, fstype: mount.fstype, reason: 'remote-mount' });
  return true;
}

/**
 * 枚举本机所有 Python：PATH 上的解释器、Windows py 启动器及其登记的版本、conda 环境。
 * @returns {{pythons:Array,conda:object,warnings:string[]}}
 */
export async function collectPythons({
  runProcess,
  signal,
  env = process.env,
  toolById = {},
  context,
  timeoutMs = 8000,
  includeVersions = true,
  includeCondaEnvs = true,
} = {}) {
  const warnings = [];
  const byPath = new Map();
  const pythons = [];

  const add = async (candidate) => {
    if (!candidate?.path) return;
    const key = isWindows() ? candidate.path.toLowerCase() : candidate.path;
    const existing = byPath.get(key);
    if (existing) {
      // 同一个解释器可能被多个来源发现（conda 环境 / PATH / 首选）：合并信息，而不是丢弃后到的。
      if (candidate.source === 'primary') existing.source = 'primary';
      if (candidate.default) existing.default = true;
      if (!existing.version && candidate.version) existing.version = candidate.version;
      if (!existing.label && candidate.label) existing.label = candidate.label;
      return;
    }
    if (isSkippedPath(candidate.path, context)) return;
    const available = await fileExists(candidate.path);
    const entry = {
      path: candidate.path,
      // Python 启动器常常是符号链接，解析出来才能看出到底指向哪个版本。
      realPath: await realPathOf(candidate.path),
      version: candidate.version ?? null,
      source: candidate.source ?? '',
      kind: candidate.kind ?? 'interpreter',
      label: candidate.label ?? '',
      available,
      default: !!candidate.default,
    };
    byPath.set(key, entry);
    pythons.push(entry);
  };

  const conda = {
    path: '',
    version: null,
    activeEnv: env.CONDA_DEFAULT_ENV ?? '',
    prefix: env.CONDA_PREFIX ?? '',
    envs: [],
    source: '',
    error: '',
  };
  if (includeCondaEnvs) {
    const condaTool = toolById.conda;
    conda.path = condaTool?.found ? condaTool.path : '';
    conda.version = condaTool?.version ?? null;
    const listed = await listCondaEnvs({ runProcess, signal, env, condaPath: conda.path, timeoutMs });
    conda.source = listed.source;
    for (const dir of listed.envs) {
      const interpreter = pythonInEnv(dir);
      const active = dir === conda.prefix;
      const exists = await fileExists(interpreter);
      conda.envs.push({ path: dir, python: exists ? interpreter : '', active });
      if (exists) await add({ path: interpreter, source: active ? 'conda(active)' : 'conda', kind: 'conda-env', default: active, label: path.basename(dir) });
    }
    if (conda.path && !conda.envs.length) conda.error = '未能列出 conda 环境';
    // 只有在"既没找到 conda、也没能列出任何环境"时才说未枚举，避免与实际列出的环境自相矛盾。
    if (!conda.path && !conda.envs.length) warnings.push('未找到 conda，也无法从 ~/.conda/environments.txt 枚举环境');
  }

  for (const name of ['python3', 'python', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python2']) {
    for (const hit of await resolveExecutableAll(name, { platform: process.platform, env, context })) {
      await add({ path: hit.path, source: hit.source, kind: 'interpreter', label: name });
    }
  }

  // PATH 之外的多版本安装（pyenv / uv / mise / 额外 conda 环境…）
  const pythonTool = toolById.python;
  if (pythonTool) {
    const patterns = patternsFor(pythonTool, process.platform);
    if (patterns.length) {
      for (const item of await expandInstallPatterns(patterns, { platform: process.platform, env, context })) {
        await add({ path: item.path, source: 'installation', kind: 'interpreter', label: '多版本安装' });
      }
    }
  }

  if (isWindows()) {
    const launcher = (await resolveExecutableAll('py', { platform: process.platform, env, context }))[0];
    if (launcher) {
      // py.exe 本身是启动器而不是解释器，但它能列出所有已登记的版本。
      await add({ path: launcher.path, source: launcher.source, kind: 'launcher', label: 'py 启动器' });
      const listed = await tryRun(runProcess, launcher.path, ['-0p'], { signal, timeoutMs: Math.min(timeoutMs, 8000) });
      if (listed.ok || listed.stdout) {
        for (const item of parsePyLauncher(listed.stdout)) {
          // 启动器给的是粗粒度版本（3.12），只放进 label；
          // 精确版本统一由后面的 --version 探测得到，避免粗值抢占精确值。
          await add({
            path: item.path,
            source: 'py 启动器',
            kind: 'interpreter',
            default: item.default,
            label: `py -V:${item.version}`,
          });
        }
      }
    }
  }

  if (toolById.python?.found) {
    await add({
      path: toolById.python.path,
      source: 'primary',
      version: toolById.python.version ?? null,
      kind: 'interpreter',
      label: '主解释器',
    });
  }

  if (includeVersions) {
    for (const entry of pythons) {
      if (entry.version) continue;
      entry.version = await pythonVersion(runProcess, entry.path, { signal, timeoutMs });
    }
  }
  pythons.sort(
    (a, b) =>
      Number(b.default) - Number(a.default) ||
      (compareVersions(b.version ?? '', a.version ?? '') ?? 0) ||
      a.path.localeCompare(b.path),
  );
  if (!pythons.length) warnings.push('未发现任何 Python 解释器');
  return { pythons, conda, warnings };
}

export async function collectInventory({
  runProcess,
  signal,
  env = process.env,
  toolById = {},
  context,
  timeoutMs = 8000,
  deep = false,
} = {}) {
  // deep 只决定"是否给每个解释器都跑一次 --version"；主解释器版本已由工具解析拿到。
  const { pythons, conda, warnings } = await collectPythons({
    runProcess,
    signal,
    env,
    toolById,
    context,
    timeoutMs,
    includeVersions: deep,
  });
  return { pythons, pythonCount: pythons.length, conda, warnings };
}

// ---------------------------------------------------------------------------
// 加速设备
// ---------------------------------------------------------------------------

function parseNvidiaCsv(text) {
  const devices = [];
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 3) continue;
    devices.push({
      vendor: 'nvidia',
      index: Number(cells[0]) || devices.length,
      name: cells[1] ?? '',
      memoryTotalMB: Number(cells[2]) || null,
      memoryUsedMB: Number(cells[3]) || null,
      driverVersion: cells[4] ?? '',
      computeCapability: cells[5] ?? '',
      temperatureC: Number(cells[6]) || null,
      utilizationPercent: Number(cells[7]) || null,
      raw: line,
    });
  }
  return devices;
}

function parseAscendInfo(text) {
  const devices = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, all) => index > 0 && index < all.length - 1);
    if (!cells.length) continue;
    const index = Number(cells[0]);
    if (!Number.isInteger(index)) continue;
    const name = cells[1] ?? '';
    if (!name || /^name$/i.test(name)) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    devices.push({
      vendor: 'ascend',
      index,
      name,
      memoryTotalMB: null,
      memoryUsedMB: null,
      driverVersion: '',
      computeCapability: '',
      temperatureC: null,
      utilizationPercent: null,
      raw: line,
    });
  }
  return devices;
}

function parseRocmJson(data) {
  if (!data || typeof data !== 'object') return [];
  const devices = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/^\d+$/.test(key) || !value || typeof value !== 'object') continue;
    devices.push({
      vendor: 'amd',
      index: Number(key),
      name: value['Card series'] ?? value['Card model'] ?? value['Device Name'] ?? '',
      memoryTotalMB: null,
      memoryUsedMB: null,
      driverVersion: String(value['Driver version'] ?? ''),
      computeCapability: '',
      temperatureC: Number(value['Temperature (Sensor edge) (C)']) || null,
      utilizationPercent: Number(value['GPU use (%)']) || null,
      raw: '',
    });
  }
  return devices;
}

export async function collectGpu({ runProcess, signal, toolById = {}, timeoutMs = 8000, deep = false }) {
  const devices = [];
  const details = { nvidia: null, ascend: null, amd: null };
  const warnings = [];
  const query = [
    'index',
    'name',
    'memory.total',
    'memory.used',
    'driver_version',
    'compute_cap',
    'temperature.gpu',
    'utilization.gpu',
  ].join(',');

  const nvidia = toolById['nvidia-smi'];
  if (nvidia?.found) {
    const result = await tryRun(runProcess, nvidia.path, [`--query-gpu=${query}`, '--format=csv,noheader,nounits'], {
      signal,
      timeoutMs: Math.min(timeoutMs, 10000),
    });
    if (result.ok) {
      const parsed = parseNvidiaCsv(result.stdout);
      devices.push(...parsed);
      details.nvidia = {
        path: nvidia.path,
        smiVersion: nvidia.version ?? null,
        driverVersion: parsed[0]?.driverVersion ?? '',
        deviceCount: parsed.length,
      };
      if (!parsed.length) warnings.push('nvidia-smi 未返回任何 GPU');
    } else {
      details.nvidia = { path: nvidia.path, smiVersion: nvidia.version ?? null, driverVersion: '', deviceCount: 0 };
      warnings.push(`nvidia-smi 查询失败：${firstLine(result.stderr) || '命令执行失败'}`);
    }
  }

  const ascend = toolById['npu-smi'];
  if (ascend?.found) {
    const list = await tryRun(runProcess, ascend.path, ['info', '-l'], { signal, timeoutMs: Math.min(timeoutMs, 10000) });
    const count = Number(/Total\s+NPU\s+count\s*:\s*(\d+)/i.exec(list.stdout ?? '')?.[1] ?? 0);
    const info = await tryRun(runProcess, ascend.path, ['info'], { signal, timeoutMs: Math.min(timeoutMs, 15000) });
    const parsed = info.ok ? parseAscendInfo(info.stdout) : [];
    if (info.ok && parsed.length) devices.push(...parsed);
    else if (count > 0) {
      for (let index = 0; index < count; index += 1) {
        devices.push({
          vendor: 'ascend',
          index,
          name: '',
          memoryTotalMB: null,
          memoryUsedMB: null,
          driverVersion: '',
          computeCapability: '',
          temperatureC: null,
          utilizationPercent: null,
          raw: '',
        });
      }
    }
    details.ascend = {
      path: ascend.path,
      claimCount: count,
      detectedCount: parsed.length,
      raw: String(info.stdout ?? '')
        .replace(/\r/g, '')
        .slice(0, 1200),
    };
    if (!parsed.length && count === 0) warnings.push('npu-smi 未报告 NPU 数量，可能需要 root 权限或驱动未就绪');
  }

  const rocm = toolById['rocm-smi'];
  if (rocm?.found && deep) {
    const result = await tryRun(runProcess, rocm.path, ['--showproductname', '--showmeminfo', 'vram', '--json'], {
      signal,
      timeoutMs: Math.min(timeoutMs, 10000),
    });
    const data = result.ok ? parseJsonLoose(result.stdout) : null;
    const parsed = parseRocmJson(data);
    devices.push(...parsed);
    details.amd = { path: rocm.path, deviceCount: parsed.length };
  }

  const vendors = [...new Set(devices.map((device) => device.vendor))];
  return { devices, deviceCount: devices.length, vendors, details, warnings };
}
