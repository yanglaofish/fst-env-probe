// 系统采集：操作系统、内核、发行版、主机、CPU、内存、磁盘、虚拟化与环境变量。
import os from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tryRun, pwshJson, toArray, joinPowerShell } from '../exec.js';
import { isWindows, platformKey, splitEnvList } from '../which.js';
import { redactCredentials } from '../redact.js';

function bytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseOsRelease(text) {
  const result = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    }
    result[match[1]] = value;
  }
  return result;
}

function parseKeyValueLines(text) {
  const result = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r/g, '');
    const match = /^([A-Za-z][\w .-]*):\s*(.*)$/.exec(line);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

function parseDf(text) {
  const disks = [];
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  for (const line of lines.slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const total = Number(match[2]) * 1024;
    const used = Number(match[3]) * 1024;
    const free = Number(match[4]) * 1024;
    disks.push({
      mount: match[6].trim(),
      filesystem: match[1],
      label: '',
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
    });
  }
  return disks;
}

function cimDisk(item) {
  const total = bytes(item.size);
  const free = bytes(item.free);
  const used = total !== null && free !== null ? total - free : null;
  return {
    mount: item.mount ?? '',
    filesystem: item.fs ?? '',
    label: item.label ?? '',
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usedPercent: total && used !== null ? Math.round((used / total) * 1000) / 10 : null,
  };
}

/** PowerShell 5.1 的 ConvertTo-Json 会把 DateTime 输出成 "/Date(毫秒)/"，统一转成 ISO。 */
function isoDate(value) {
  if (typeof value !== 'string' || !value) return '';
  const dotNet = /\/Date\((-?\d+)\)\//.exec(value);
  if (dotNet) {
    const time = Number(dotNet[1]);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

// 注意：哈希字面量必须整体作为一个片段，否则片段间插入的 ';' 会落到 '@{' 之后，
// 形成空成员并导致整段脚本语法错误（此时 stdout 为空、stderr 只有 '#< CLIXML'）。
const WINDOWS_SYSTEM_SCRIPT = joinPowerShell([
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$cs=Get-CimInstance Win32_ComputerSystem',
  '$disk=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")',
  '$cpu=@(Get-CimInstance Win32_Processor)',
  '[pscustomobject]@{' +
    'caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;arch=$os.OSArchitecture;' +
    'installDate=$os.InstallDate;lastBoot=$os.LastBootUpTime;csd=$os.CSDVersion;' +
    'manufacturer=$cs.Manufacturer;model=$cs.Model;domain=$cs.Domain;user=$cs.UserName;' +
    'physicalMemory=$cs.TotalPhysicalMemory;sockets=$cs.NumberOfProcessors;' +
    'cpu=@($cpu | ForEach-Object {[pscustomobject]@{name=$_.Name;cores=$_.NumberOfCores;threads=$_.NumberOfLogicalProcessors;mhz=$_.MaxClockSpeed;socket=$_.SocketDesignation}});' +
    'disk=@($disk | ForEach-Object {[pscustomobject]@{mount=$_.DeviceID;fs=$_.FileSystem;label=$_.VolumeName;size=$_.Size;free=$_.FreeSpace}})' +
    '} | ConvertTo-Json -Depth 5 -Compress',
]);

function windowsEdition(caption, build) {
  const number = Number(build);
  if (/Windows 11/i.test(caption)) return 'Windows 11';
  if (Number.isFinite(number) && number >= 22000) return 'Windows 11';
  if (/Windows 10/i.test(caption)) return 'Windows 10';
  if (/Windows Server/i.test(caption)) return caption;
  return caption || 'Windows';
}

function basePlatform() {
  const cpus = os.cpus() ?? [];
  const key = platformKey();
  return {
    os: os.platform(),
    osName: key === 'win32' ? 'Windows' : key === 'darwin' ? 'macOS' : 'Linux',
    type: os.type(),
    release: os.release(),
    kernel: os.release(),
    version: os.version?.() ?? '',
    arch: os.arch(),
    machine: typeof os.machine === 'function' ? os.machine() : process.arch,
    endianness: os.endianness(),
    bits: process.arch.includes('64') ? 64 : 32,
    distro: {},
    hostname: os.hostname(),
    fqdn: os.hostname(),
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
    isRoot: (() => {
      try {
        return os.userInfo().uid === 0;
      } catch {
        return false;
      }
    })(),
    home: os.homedir(),
    tmpdir: os.tmpdir(),
    cwd: process.cwd(),
    uptimeSeconds: Math.round(os.uptime()),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    locale: process.env.LANG ?? process.env.LC_ALL ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '',
    shell: process.env.SHELL ?? process.env.ComSpec ?? '',
    virtual: { containerized: false, kind: '', hypervisor: '' },
    cpuModel: cpus[0]?.model?.trim() ?? '',
  };
}

async function detectLinuxVirtualization(env) {
  const info = { containerized: false, kind: '', hypervisor: '' };
  try {
    if (existsSync('/.dockerenv')) {
      info.containerized = true;
      info.kind = 'docker';
    }
  } catch {
    /* 忽略 */
  }
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf8');
    if (/kubepods/i.test(cgroup)) {
      info.containerized = true;
      info.kind = 'kubernetes';
    } else if (/docker|containerd|libpod/i.test(cgroup) && !info.kind) {
      info.containerized = true;
      info.kind = 'container';
    }
  } catch {
    /* 忽略 */
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    info.containerized = true;
    info.kind = 'kubernetes';
  }
  return info;
}

export async function collectSystem({ runProcess, signal, env = process.env, timeoutMs = 10000 }) {
  const warnings = [];
  const platform = basePlatform();
  const hardware = {
    cpu: {
      model: platform.cpuModel,
      cores: null,
      threads: null,
      sockets: null,
      speedMHz: (os.cpus()?.[0]?.speed ?? null) || null,
      maxClockMHz: null,
      loadAvg: os.loadavg().map((value) => Math.round(value * 100) / 100),
      availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus()?.length ?? null),
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      usedBytes: os.totalmem() - os.freemem(),
      usedPercent: os.totalmem() > 0 ? Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10 : null,
      swapTotalBytes: null,
      swapFreeBytes: null,
    },
    disks: [],
  };

  if (isWindows()) {
    const result = await pwshJson(runProcess, WINDOWS_SYSTEM_SCRIPT, { signal, timeoutMs });
    if (result.ok) {
      const data = result.data ?? {};
      platform.distro = {
        id: 'windows',
        name: windowsEdition(data.caption, data.build),
        version: data.version ?? '',
        build: data.build ?? '',
        edition: data.caption ?? '',
        arch: data.arch ?? '',
        installDate: isoDate(data.installDate),
      };
      platform.fqdn = data.domain ? `${platform.hostname}.${data.domain}` : platform.hostname;
      platform.domain = data.domain ?? '';
      platform.manufacturer = data.manufacturer ?? '';
      platform.model = data.model ?? '';
      platform.lastBoot = isoDate(data.lastBootUpTime ?? data.lastBoot);
      platform.patch = data.csd ?? '';
      const cpu = toArray(data.cpu)[0] ?? {};
      const threads = os.cpus()?.length ?? null;
      const cores = Number(cpu.cores) || null;
      hardware.cpu.model = (cpu.name ?? '').trim() || hardware.cpu.model;
      hardware.cpu.cores = cores;
      hardware.cpu.threads = threads;
      hardware.cpu.sockets = Number(data.sockets) || null;
      // WMI 的 MaxClockSpeed 常是标称值，Node 的值更接近实际；两者都保留，不让低值覆盖高值。
      hardware.cpu.maxClockMHz = Number(cpu.mhz) || null;
      if (!hardware.cpu.speedMHz) hardware.cpu.speedMHz = Number(cpu.mhz) || null;
      const physical = bytes(data.physicalMemory);
      if (physical) hardware.memory.totalBytes = physical;
      hardware.memory.usedPercent =
        hardware.memory.totalBytes > 0
          ? Math.round(((hardware.memory.totalBytes - hardware.memory.freeBytes) / hardware.memory.totalBytes) * 1000) / 10
          : hardware.memory.usedPercent;
      hardware.disks = toArray(data.disk).map(cimDisk);
      if (/virtual|vmware|virtualbox|hyper-v|qemu|kvm|parallels/i.test(`${data.manufacturer} ${data.model}`)) {
        platform.virtual.hypervisor = `${data.manufacturer} ${data.model}`.trim();
      }
    } else {
      warnings.push(`Windows 系统信息读取失败：${result.error?.message ?? '未知错误'}`);
    }
  } else {
    const plat = platformKey();
    if (plat === 'linux') {
      try {
        const release = parseOsRelease(await readFile('/etc/os-release', 'utf8'));
        platform.distro = {
          id: release.ID ?? 'linux',
          name: release.NAME ?? '',
          version: release.VERSION ?? '',
          versionId: release.VERSION_ID ?? '',
          codename: release.VERSION_CODENAME ?? '',
          pretty: release.PRETTY_NAME ?? '',
          arch: release.ARCH ?? '',
        };
      } catch {
        warnings.push('读取 /etc/os-release 失败，仅有内核信息');
      }
      platform.virtual = await detectLinuxVirtualization(env);
    } else if (plat === 'darwin') {
      const swVers = await tryRun(runProcess, 'sw_vers', [], { signal, timeoutMs });
      if (swVers.ok) {
        const info = parseKeyValueLines(swVers.stdout);
        platform.distro = {
          id: 'macos',
          name: info.ProductName ?? 'macOS',
          version: info.ProductVersion ?? '',
          build: info.BuildVersion ?? '',
          pretty: `${info.ProductName ?? 'macOS'} ${info.ProductVersion ?? ''}`.trim(),
        };
      }
      const cpuBrand = await tryRun(runProcess, 'sysctl', ['-n', 'machdep.cpu.brand_string'], { signal, timeoutMs });
      if (cpuBrand.ok && cpuBrand.stdout.trim()) hardware.cpu.model = cpuBrand.stdout.trim();
    }
    const df = await tryRun(runProcess, 'df', ['-kP'], { signal, timeoutMs });
    if (df.ok) hardware.disks = parseDf(df.stdout);
    else warnings.push('df -kP 不可用，磁盘信息缺失');
  }

  return { platform, hardware, warnings };
}

const ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'USER',
  'SHELL',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'JAVA_HOME',
  'JRE_HOME',
  'PYTHONHOME',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_EXE',
  'CUDA_HOME',
  'CUDA_PATH',
  'ASCEND_HOME_PATH',
  'KUBECONFIG',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'GO_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOTNET_ROOT',
  'NVM_HOME',
  'NVM_SYMLINK',
  'MAVEN_HOME',
  'M2_HOME',
  'GRADLE_HOME',
  'MSYSTEM',
  'WSL_DISTRO_NAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'FLOW_OUTPUT_DIR',
  'FISHTOOLS_HOME',
];

export function collectEnv(env = process.env, platform = process.platform) {
  const selected = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    // 报告与快照会被分享，代理类变量里的 user:password 必须先脱敏。
    if (typeof value === 'string' && value !== '') selected[key] = redactCredentials(value);
  }
  const rawPath = env.PATH ?? env.Path ?? env.path ?? '';
  const entries = splitEnvList(rawPath, platform);
  const seen = new Set();
  const duplicates = [];
  for (const entry of entries) {
    const key = isWindows(platform) ? entry.toLowerCase() : entry;
    if (seen.has(key)) duplicates.push(entry);
    else seen.add(key);
  }
  return {
    selected,
    pathEntries: entries,
    pathEntryCount: entries.length,
    pathDuplicates: [...new Set(duplicates)],
  };
}
