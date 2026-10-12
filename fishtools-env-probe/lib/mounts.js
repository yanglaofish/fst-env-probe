// 远程/网络文件系统探测。
//
// 为什么需要：在不可达的远程挂载点上做文件系统调用，可能让调用进程进入内核级
// 不可中断睡眠（典型是 Linux 的 NFS hard mount），此时连 SIGKILL 都无效。
// 插件跑在宿主进程里，所以这类目录必须被识别出来，默认不去碰。
import { readFile } from 'node:fs/promises';
import { tryRun, pwshJson, toArray } from './exec.js';

// 明确的网络/集群文件系统类型（小写）。
const NETWORK_FSTYPES = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  'sshfs',
  'davfs',
  'davfs2',
  'webdav',
  'afpfs',
  '9p',
  'ceph',
  'afs',
  'coda',
  'glusterfs',
  'lustre',
  'beegfs',
  'panfs',
  'vboxsf',
  'prl_fs',
  'autofs',
]);

// FUSE 里也有本地文件系统（fuse.ntfs 等），只把网络类的算进来。
const FUSE_NETWORK = /(sshfs|rclone|smb|davfs|curlftp|gvfs|mega|ceph|gluster|nfs|s3ql|s3backer)/;

export function isNetworkFsType(fstype) {
  const value = String(fstype ?? '').trim().toLowerCase();
  if (!value) return false;
  if (NETWORK_FSTYPES.has(value)) return true;
  return value.startsWith('fuse.') && FUSE_NETWORK.test(value);
}

/** /proc/self/mounts 里空格等字符会被转义成八进制。 */
function unescapeMountField(value) {
  return String(value ?? '').replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 8)));
}

export function parseLinuxMounts(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    entries.push({
      source: unescapeMountField(fields[0]),
      mount: unescapeMountField(fields[1]),
      fstype: fields[2].toLowerCase(),
    });
  }
  return entries;
}

export function parseMacMounts(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    // 例：map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
    // 源字段可能含空格，所以两侧都用非贪婪匹配。
    const match = /^(.+?)\s+on\s+(.+?)\s+\(([^,)]+)/.exec(rawLine.trim());
    if (!match) continue;
    entries.push({ source: match[1], mount: match[2], fstype: match[3].trim().toLowerCase() });
  }
  return entries;
}

const WINDOWS_NETWORK_DRIVES = [
  '@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=4" | Select-Object -ExpandProperty DeviceID) | ConvertTo-Json -Compress',
];

// 挂载表在一次会话里基本不变；加短 TTL 缓存，避免每次查询都多跑一次系统调用。
const MOUNT_CACHE_TTL_MS = 30000;
let mountCache = null;

export function clearMountCache() {
  mountCache = null;
}

/**
 * 找出当前系统上的远程/网络文件系统挂载点（带 30 秒缓存）。
 * @returns {Promise<{mounts:Array,remote:Array,warnings:string[]}>}
 */
export async function detectRemoteMounts({
  runProcess,
  signal,
  platform = process.platform,
  timeoutMs = 5000,
  refresh = false,
} = {}) {
  const now = Date.now();
  if (!refresh && mountCache && mountCache.platform === platform && now - mountCache.at < MOUNT_CACHE_TTL_MS) {
    return mountCache.result;
  }
  const key = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const mounts = [];
  const warnings = [];
  if (key === 'linux') {
    try {
      mounts.push(...parseLinuxMounts(await readFile('/proc/self/mounts', 'utf8')));
    } catch {
      warnings.push('读取 /proc/self/mounts 失败，无法识别远程挂载点');
    }
  } else if (key === 'darwin') {
    const result = await tryRun(runProcess, 'mount', [], { signal, timeoutMs });
    if (result.ok) mounts.push(...parseMacMounts(result.stdout));
    else warnings.push('mount 命令不可用，无法识别远程挂载点');
  } else if (typeof runProcess === 'function') {
    const response = await pwshJson(runProcess, WINDOWS_NETWORK_DRIVES.join(';'), { signal, timeoutMs });
    if (response.ok) {
      for (const drive of toArray(response.data).filter(Boolean)) {
        const letter = String(drive).trim();
        if (!/^[A-Za-z]:$/.test(letter)) continue;
        mounts.push({ source: 'network-drive', mount: `${letter}\\`, fstype: 'smb' });
      }
    }
  }
  const remote = mounts.filter((entry) => isNetworkFsType(entry.fstype));
  // UNC 路径不可能从挂载表里穷举，用固定前缀参与匹配。
  if (key === 'win32') remote.push({ source: 'unc', mount: '\\\\', fstype: 'unc' });
  const result = { mounts, remote, warnings };
  mountCache = { at: now, platform, result };
  return result;
}

export function formatMounts(remote = [], limit = 5) {
  return remote
    .slice(0, limit)
    .map((entry) => `${entry.fstype}: ${entry.mount}`)
    .join('、');
}
