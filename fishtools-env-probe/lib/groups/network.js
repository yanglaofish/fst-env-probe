// 网络采集：网卡、地址、网关、DNS、系统代理。
// 基础信息用 Node 原生（跨平台、零子进程），平台细节用系统命令补齐。
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { tryRun, pwshJson, toArray, parseJsonLoose, joinPowerShell } from '../exec.js';
import { isWindows, platformKey } from '../which.js';
import { redactCredentials } from '../redact.js';

function normalizeMac(mac) {
  return String(mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function adaptersFromNode() {
  const interfaces = os.networkInterfaces();
  const adapters = [];
  for (const [name, list] of Object.entries(interfaces)) {
    const addresses = [];
    let mac = '';
    for (const item of list ?? []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (!mac && item.mac && item.mac !== '00:00:00:00:00:00') mac = item.mac;
      addresses.push({
        family,
        address: item.address,
        netmask: item.netmask ?? '',
        cidr: item.cidr ?? '',
        prefixLength: item.cidr && item.cidr.includes('/') ? Number(item.cidr.split('/')[1]) : null,
        internal: !!item.internal,
        scopeid: item.scopeid ?? null,
      });
    }
    adapters.push({
      name,
      description: name,
      mac,
      mtu: null,
      speedMbps: null,
      up: true,
      connected: addresses.some((item) => !item.internal && item.family === 'IPv4'),
      type: '',
      dhcp: null,
      dnsSuffix: '',
      addresses,
      gateways: [],
      dnsServers: [],
    });
  }
  return adapters;
}

function proxyFromEnv(env) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (typeof env[key] === 'string' && env[key].trim()) return redactCredentials(env[key].trim());
    }
    return '';
  };
  return {
    source: 'environment',
    enabled: false,
    http: pick('HTTP_PROXY', 'http_proxy'),
    https: pick('HTTPS_PROXY', 'https_proxy'),
    all: pick('ALL_PROXY', 'all_proxy'),
    noProxy: pick('NO_PROXY', 'no_proxy'),
    autoConfigUrl: '',
    system: '',
  };
}

const WINDOWS_NETWORK_SCRIPT = joinPowerShell([
  '$cfg=@(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=true" | ForEach-Object {[pscustomobject]@{description=$_.Description;mac=$_.MACAddress;ip=@($_.IPAddress);subnet=@($_.IPSubnet);gateway=@($_.DefaultIPGateway);dns=@($_.DNSServerSearchOrder);dhcp=[bool]$_.DHCPEnabled;dnsSuffix=$_.DNSDomain}})',
  '$link=@(Get-CimInstance Win32_NetworkAdapter | ForEach-Object {[pscustomobject]@{guid=$_.GUID;name=$_.Name;connection=$_.NetConnectionID;status=$_.NetConnectionStatus;speed=$_.Speed;enabled=$_.NetEnabled;type=$_.AdapterType;mac=$_.MACAddress}})',
  '$reg=Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
  '[pscustomobject]@{config=$cfg;link=$link;proxy=[pscustomobject]@{enable=$reg.ProxyEnable;server=$reg.ProxyServer;override=$reg.ProxyOverride;autoConfig=$reg.AutoConfigURL}} | ConvertTo-Json -Depth 5 -Compress',
]);

async function supplementWindows(result, { runProcess, signal, timeoutMs }) {
  const response = await pwshJson(runProcess, WINDOWS_NETWORK_SCRIPT, { signal, timeoutMs });
  if (!response.ok) {
    result.warnings.push(`Windows 网卡信息读取失败：${response.error?.message ?? '未知错误'}`);
    return;
  }
  const data = response.data ?? {};
  const byMac = new Map();
  for (const adapter of result.adapters) {
    const key = normalizeMac(adapter.mac);
    if (key) byMac.set(key, adapter);
  }
  for (const item of toArray(data.config)) {
    const key = normalizeMac(item.mac);
    const target = (key && byMac.get(key)) || result.adapters.find((adapter) => adapter.description === item.description);
    const gateways = toArray(item.gateway).filter(Boolean);
    const dnsServers = toArray(item.dns).filter(Boolean);
    if (target) {
      target.description = item.description || target.description;
      target.gateways = gateways;
      target.dnsServers = dnsServers;
      target.dhcp = item.dhcp ?? null;
      target.dnsSuffix = item.dnsSuffix ?? '';
      target.connected = target.addresses.some((address) => !address.internal && address.family === 'IPv4');
    } else {
      result.adapters.push({
        name: item.description || 'unknown',
        description: item.description || '',
        mac: item.mac || '',
        mtu: null,
        speedMbps: null,
        up: true,
        connected: true,
        type: '',
        dhcp: item.dhcp ?? null,
        dnsSuffix: item.dnsSuffix ?? '',
        addresses: toArray(item.ip).filter(Boolean).map((address) => ({
          family: address.includes(':') ? 'IPv6' : 'IPv4',
          address,
          netmask: '',
          cidr: '',
          prefixLength: null,
          internal: address === '127.0.0.1' || address === '::1',
          scopeid: null,
        })),
        gateways,
        dnsServers,
      });
    }
  }
  const links = toArray(data.link);
  for (const link of links) {
    const key = normalizeMac(link.mac);
    const target = key ? byMac.get(key) : null;
    if (!target) continue;
    if (link.connection) target.name = link.connection;
    if (link.type) target.type = link.type;
    const speed = Number(link.speed);
    if (Number.isFinite(speed) && speed > 0) target.speedMbps = Math.round(speed / 1_000_000);
    if (link.status !== undefined && link.status !== null) target.up = Number(link.status) === 2;
  }
  const proxy = data.proxy ?? {};
  result.proxies.system = redactCredentials(proxy.server ?? '');
  result.proxies.autoConfigUrl = redactCredentials(proxy.autoConfig ?? '');
  result.proxies.systemEnabled = Number(proxy.enable) === 1;
  result.proxies.enabled = result.proxies.systemEnabled || !!(result.proxies.http || result.proxies.https);
  result.proxies.source = result.proxies.systemEnabled ? 'system+environment' : 'environment';
  if (result.proxies.systemEnabled && proxy.server) {
    const parts = String(proxy.server).split(';').map((item) => item.trim()).filter(Boolean);
    for (const part of parts) {
      const [scheme, address] = part.includes('=') ? part.split('=') : ['http', part];
      const safe = redactCredentials(address);
      if (scheme.toLowerCase() === 'https') result.proxies.https ||= safe;
      else result.proxies.http ||= safe;
    }
    if (proxy.override) result.proxies.noProxy ||= String(proxy.override).split(';').filter(Boolean).join(',');
  }
  // 只做汇总，去重统一在 collectNetwork 末尾进行。
  result.gateways = result.adapters.flatMap((adapter) => adapter.gateways);
  result.dnsServers = result.adapters.flatMap((adapter) => adapter.dnsServers);
}

async function supplementLinux(result, { runProcess, signal, timeoutMs }) {
  const ipAddr = await tryRun(runProcess, 'ip', ['-j', 'addr'], { signal, timeoutMs });
  const parsed = ipAddr.ok ? parseJsonLoose(ipAddr.stdout) : null;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const target = result.adapters.find((adapter) => adapter.name === item.ifname);
      if (!target) continue;
      if (item.mtu) target.mtu = Number(item.mtu);
      if (item.address) target.mac = item.address;
      if (item.operstate) target.up = String(item.operstate).toUpperCase() === 'UP';
      if (Number(item.speed)) target.speedMbps = Number(item.speed);
      if (Array.isArray(item.addr_info) && item.addr_info.length) {
        target.addresses = item.addr_info.map((info) => {
          const local = info.local ?? '';
          return {
            family: info.family === 'inet' ? 'IPv4' : 'IPv6',
            address: local,
            netmask: '',
            cidr: info.prefixlen !== undefined ? `${local}/${info.prefixlen}` : '',
            prefixLength: info.prefixlen ?? null,
            // 回环地址不能算"真实地址"，否则主地址选择会落到 lo 上。
            internal: String(item.ifname) === 'lo' || info.scope === 'host' || local === '127.0.0.1' || local === '::1',
            scopeid: null,
          };
        });
        target.connected = target.addresses.some((address) => !address.internal && address.family === 'IPv4');
      }
    }
  } else if (ipAddr.error?.code !== 'ENOENT') {
    result.warnings.push('ip -j addr 解析失败，仅提供基础网卡信息');
  }

  const route = await tryRun(runProcess, 'ip', ['-j', 'route', 'show', 'default'], { signal, timeoutMs });
  const routes = route.ok ? parseJsonLoose(route.stdout) : null;
  if (Array.isArray(routes)) {
    for (const entry of routes) {
      const target = result.adapters.find((adapter) => adapter.name === entry.dev);
      if (target && entry.gateway && !target.gateways.includes(entry.gateway)) target.gateways.push(entry.gateway);
      if (entry.gateway) result.gateways.push(entry.gateway);
    }
  }

  try {
    const resolv = await readFile('/etc/resolv.conf', 'utf8');
    const servers = resolv
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^nameserver\s+/i.test(line))
      .map((line) => line.replace(/^nameserver\s+/i, '').trim())
      .filter(Boolean);
    if (servers.length) {
      result.dnsServers.push(...servers);
      for (const adapter of result.adapters) {
        if (adapter.connected && !adapter.dnsServers.length) adapter.dnsServers = [...servers];
      }
    }
  } catch {
    /* 无 resolv.conf */
  }
}

function parseIfconfig(text) {
  const adapters = [];
  let current = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    const header = /^(\S+):\s+flags=\S+\s+mtu\s+(\d+)/.exec(rawLine);
    if (header) {
      current = {
        name: header[1],
        description: header[1],
        mac: '',
        mtu: Number(header[2]),
        speedMbps: null,
        up: /UP/i.test(rawLine),
        connected: false,
        type: '',
        dhcp: null,
        dnsSuffix: '',
        addresses: [],
        gateways: [],
        dnsServers: [],
      };
      adapters.push(current);
      continue;
    }
    if (!current) continue;
    const ether = /^\s+ether\s+([0-9a-f:]+)/i.exec(rawLine);
    if (ether) current.mac = ether[1];
    const inet = /^\s+inet\s+(\d+\.\d+\.\d+\.\d+)\s+netmask\s+(0x[0-9a-f]+)/i.exec(rawLine);
    if (inet) {
      const prefix = Number.parseInt(inet[2].slice(2), 16)
        .toString(2)
        .split('')
        .filter((bit) => bit === '1').length;
      current.addresses.push({
        family: 'IPv4',
        address: inet[1],
        netmask: '',
        cidr: `${inet[1]}/${prefix}`,
        prefixLength: prefix,
        internal: inet[1].startsWith('127.'),
        scopeid: null,
      });
    }
    const inet6 = /^\s+inet6\s+([0-9a-f:]+)(%\S+)?\s+prefixlen\s+(\d+)/i.exec(rawLine);
    if (inet6) {
      current.addresses.push({
        family: 'IPv6',
        address: inet6[1],
        netmask: '',
        cidr: `${inet6[1]}/${inet6[3]}`,
        prefixLength: Number(inet6[3]),
        internal: inet6[1] === '::1',
        scopeid: null,
      });
    }
  }
  return adapters;
}

function parseDefaultRoute(unixNetstat) {
  for (const rawLine of String(unixNetstat ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === 'default' && fields[1]) return fields[1];
    if (fields[0] === '0.0.0.0' && fields[1] && fields[1] !== '0.0.0.0') return fields[1];
  }
  return '';
}

async function supplementDarwin(result, { runProcess, signal, timeoutMs }) {
  const ifconfig = await tryRun(runProcess, 'ifconfig', ['-a'], { signal, timeoutMs });
  if (ifconfig.ok) {
    const parsed = parseIfconfig(ifconfig.stdout);
    if (parsed.length) {
      result.adapters = parsed;
      result.adapters.push(...adaptersFromNode().filter((adapter) => !parsed.some((item) => item.name === adapter.name)));
    }
  }
  const route = await tryRun(runProcess, 'netstat', ['-rn', '-f', 'inet'], { signal, timeoutMs });
  if (route.ok) {
    const gateway = parseDefaultRoute(route.stdout);
    if (gateway) {
      result.gateways.push(gateway);
      const target = result.adapters.find((adapter) => adapter.connected) ?? result.adapters[0];
      if (target) target.gateways.push(gateway);
    }
  }
  const scutil = await tryRun(runProcess, 'scutil', ['--dns'], { signal, timeoutMs });
  if (scutil.ok) {
    const servers = [
      ...new Set(
        scutil.stdout
          .split('\n')
          .map((line) => line.trim())
          .map((line) => /^nameserver\[\d+\]\s*:\s*(\S+)/.exec(line)?.[1])
          .filter(Boolean),
      ),
    ];
    if (servers.length) {
      result.dnsServers.push(...servers);
      const target = result.adapters.find((adapter) => adapter.connected) ?? result.adapters[0];
      if (target) target.dnsServers.push(...servers);
    }
  }
}

function pickPrimary(adapters) {
  const candidates = adapters.filter((adapter) => adapter.addresses.some((address) => !address.internal && address.family === 'IPv4'));
  const withGateway = candidates.filter((adapter) => adapter.gateways.length);
  const selected = withGateway[0] ?? candidates[0];
  if (!selected) return { ipv4: '', ipv6: '', adapter: '', mac: '' };
  const ipv4 = selected.addresses.find((address) => !address.internal && address.family === 'IPv4');
  const ipv6 = selected.addresses.find((address) => !address.internal && address.family === 'IPv6' && !/^fe80/i.test(address.address));
  return {
    ipv4: ipv4?.address ?? '',
    ipv6: ipv6?.address ?? '',
    adapter: selected.name ?? '',
    mac: selected.mac ?? '',
  };
}

export async function collectNetwork({ runProcess, signal, env = process.env, timeoutMs = 10000 }) {
  const result = {
    hostname: os.hostname(),
    adapters: adaptersFromNode(),
    gateways: [],
    dnsServers: [],
    primary: { ipv4: '', ipv6: '', adapter: '', mac: '' },
    proxies: proxyFromEnv(env),
    warnings: [],
  };
  const platform = platformKey();
  if (isWindows()) await supplementWindows(result, { runProcess, signal, timeoutMs });
  else if (platform === 'linux') await supplementLinux(result, { runProcess, signal, timeoutMs });
  else await supplementDarwin(result, { runProcess, signal, timeoutMs });
  result.primary = pickPrimary(result.adapters);
  result.gateways = [...new Set(result.gateways ?? [])];
  result.dnsServers = [...new Set(result.dnsServers ?? [])];
  result.adapterCount = result.adapters.length;
  result.upCount = result.adapters.filter((adapter) => adapter.connected).length;
  return result;
}
