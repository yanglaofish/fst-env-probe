// Markdown 报告渲染：把检测结果整理成人类可读的分节表格。
import { GROUPS, TOOL_BY_ID } from './catalog.js';

const GROUP_ORDER = GROUPS.map((group) => group.id);

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    // 报告会进 Web/TUI 渲染，外部采集文本必须转义，避免 HTML 注入。
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ');
}

function cell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return esc(value);
}

function table(headers, rows) {
  if (!rows.length) return '_无数据_\n';
  const lines = [`| ${headers.map(esc).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

function bytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = number;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function duration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '—';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function section(title, body) {
  return `## ${title}\n\n${body}\n`;
}

function renderPlatform(report) {
  const platform = report.platform;
  if (!platform) return '_未采集（未选择 system 分组）_\n';
  const distro = platform.distro ?? {};
  const rows = [
    ['操作系统', platform.osName, platform.os],
    ['发行版', distro.pretty || distro.name || distro.edition || '—', distro.id ?? ''],
    ['版本', distro.version || platform.version || '—', distro.build ? `构建 ${distro.build}` : ''],
    ['内核', platform.kernel, platform.patch || ''],
    ['架构', `${platform.arch} (${platform.bits} 位)`, platform.machine],
    ['主机名', platform.fqdn || platform.hostname, platform.domain ? `域 ${platform.domain}` : ''],
    ['当前用户', platform.user, platform.isRoot ? 'root/管理员' : ''],
    ['用户目录', platform.home, ''],
    ['临时目录', platform.tmpdir, ''],
    ['时区', platform.timezone, platform.locale],
    ['运行时长', duration(platform.uptimeSeconds), platform.lastBoot ? `上次启动 ${platform.lastBoot}` : ''],
    ['虚拟化', platform.virtual?.kind || platform.virtual?.hypervisor || '物理机/未知', platform.virtual?.containerized ? '运行在容器内' : ''],
  ];
  return table(['项目', '值', '备注'], rows);
}

function renderHardware(report) {
  const hardware = report.hardware;
  if (!hardware) return '_未采集（未选择 system 分组）_\n';
  const cpu = hardware.cpu ?? {};
  const memory = hardware.memory ?? {};
  const parts = [
    table(['项目', '值'], [
      ['CPU', cpu.model || '—'],
      ['核心 / 线程', `${cpu.cores ?? '—'} 核 / ${cpu.threads ?? '—'} 线程`, ],
      ['CPU 插槽', cpu.sockets ?? '—'],
      ['主频', cpu.speedMHz ? `${cpu.speedMHz} MHz` : '—'],
      ['内存总量', bytes(memory.totalBytes)],
      ['内存可用', bytes(memory.freeBytes)],
      ['内存占用', memory.usedPercent === null || memory.usedPercent === undefined ? '—' : `${memory.usedPercent}%`],
      ['负载', Array.isArray(cpu.loadAvg) ? cpu.loadAvg.join(' / ') : '—'],
    ]),
  ];
  const disks = (hardware.disks ?? []).map((disk) => [
    disk.mount,
    disk.filesystem,
    bytes(disk.totalBytes),
    bytes(disk.freeBytes),
    disk.usedPercent === null || disk.usedPercent === undefined ? '—' : `${disk.usedPercent}%`,
  ]);
  if (disks.length) parts.push(`\n### 磁盘\n\n${table(['挂载点', '文件系统', '总量', '可用', '使用率'], disks)}`);
  return parts.join('\n');
}

function renderTools(report) {
  const tools = Object.values(report.tools ?? {});
  if (!tools.length) return '_未采集工具（可能只指定了部分分组）_\n';
  const buckets = new Map();
  for (const tool of tools) {
    if (!buckets.has(tool.group)) buckets.set(tool.group, []);
    buckets.get(tool.group).push(tool);
  }
  const order = [...GROUP_ORDER.filter((id) => buckets.has(id)), ...[...buckets.keys()].filter((id) => !GROUP_ORDER.includes(id))];
  const out = [];
  for (const groupId of order) {
    const list = buckets.get(groupId).sort((a, b) => Number(b.found) - Number(a.found) || a.id.localeCompare(b.id));
    const rows = list.map((tool) => [
      tool.title || tool.id,
      tool.found ? '可用' : '未找到',
      tool.version ?? (tool.found && !TOOL_BY_ID.get(tool.id)?.versionArgs.length ? '未探测' : '—'),
      tool.path,
    ]);
    const title = GROUPS.find((group) => group.id === groupId)?.title ?? groupId;
    out.push(`### ${title}\n\n${table(['工具', '状态', '版本', '路径'], rows)}`);
  }
  return out.join('\n');
}

function renderShells(report) {
  const shells = report.shells;
  if (!shells) return '_未采集（未选择 shell 分组）_\n';
  const rows = (shells.available ?? []).map((shell) => [shell.title, shell.version ?? '—', shell.path, shell.default ? '是' : '']);
  const parts = [table(['Shell', '版本', '路径', '默认'], rows)];
  if (shells.gitBash) {
    parts.push(`Git Bash：\`${shells.gitBash.path}\`${shells.gitBash.version ? `（${shells.gitBash.version}）` : ''}\n`);
  }
  if (shells.wsl) {
    const wsl = shells.wsl;
    const distros = (wsl.distributions ?? []).map((item) => [item.name, item.state, `WSL${item.version}`, item.default ? '是' : '']);
    parts.push(
      `WSL：\`${wsl.path}\`${wsl.version ? `（WSL ${wsl.version}）` : ''}${wsl.kernel ? `，内核 ${wsl.kernel}` : ''}` +
        `${wsl.error ? `，读取失败：${esc(wsl.error)}` : ''}\n`,
    );
    if (distros.length) parts.push(table(['发行版', '状态', '版本', '默认'], distros));
  }
  return parts.join('\n');
}

function renderNetwork(report) {
  const network = report.network;
  if (!network) return '_未采集（未选择 network 分组）_\n';
  const rows = (network.adapters ?? []).flatMap((adapter) => {
    const addresses = (adapter.addresses ?? []).filter((address) => !address.internal);
    if (!addresses.length) {
      return [[adapter.name, adapter.description, '—', adapter.mac, (adapter.gateways ?? []).join(', '), (adapter.dnsServers ?? []).join(', ')]];
    }
    return addresses.map((address) => [
      adapter.name,
      adapter.description,
      `${address.address}/${address.prefixLength ?? '?'}${address.family === 'IPv6' ? ' (v6)' : ''}`,
      adapter.mac,
      (adapter.gateways ?? []).join(', '),
      (adapter.dnsServers ?? []).join(', '),
    ]);
  });
  const parts = [
    table(['网卡', '描述', '地址', 'MAC', '网关', 'DNS'], rows),
  ];
  const primary = network.primary ?? {};
  parts.unshift(
    `主机名：\`${esc(network.hostname ?? '')}\`　主地址：\`${esc(primary.ipv4 || primary.ipv6 || '—')}\`　网关：${esc((network.gateways ?? []).join(', ') || '—')}　DNS：${esc((network.dnsServers ?? []).join(', ') || '—')}\n`,
  );
  const proxies = network.proxies ?? {};
  if (proxies.enabled || proxies.http || proxies.https) {
    parts.push(
      `代理：${proxies.enabled ? '已启用' : '仅环境变量'}` +
        `${proxies.system ? `，系统代理 \`${esc(proxies.system)}\`` : ''}` +
        `${proxies.http ? `，HTTP \`${esc(proxies.http)}\`` : ''}` +
        `${proxies.https ? `，HTTPS \`${esc(proxies.https)}\`` : ''}` +
        `${proxies.noProxy ? `，直连 ${esc(proxies.noProxy)}` : ''}\n`,
    );
  }
  return parts.join('\n');
}

function renderContainers(report) {
  const containers = report.containers;
  if (!containers) return '_未采集（未选择 container 分组）_\n';
  const rows = (containers.engines ?? []).map((engine) => [
    engine.name,
    engine.clientVersion ?? '—',
    engine.daemonReachable === true ? '可用' : engine.daemonReachable === false ? '不可达' : '未探测',
    engine.serverVersion || '—',
    engine.context || '—',
    engine.composeVersion || '—',
  ]);
  const parts = [`### 容器引擎\n\n${table(['引擎', '客户端', '守护进程', '服务端', '上下文', 'Compose'], rows)}`];
  const k8s = containers.k8s;
  if (k8s) {
    parts.push(
      `### Kubernetes\n\n` +
        table(['项目', '值'], [
          ['kubectl', k8s.kubectlPath || '未找到'],
          ['客户端版本', k8s.clientVersion ?? '—'],
          ['kubeconfig', k8s.kubeconfigExists ? k8s.kubeconfigPath : `未找到（${k8s.kubeconfigPath}）`],
          ['当前上下文', k8s.currentContext || '—'],
          ['上下文数量', k8s.contextCount ?? 0],
          ['集群可达', k8s.clusterReachable === true ? '是' : k8s.clusterReachable === false ? `否（${esc(k8s.error || '不可达')}）` : '未探测'],
          ['服务端版本', k8s.serverVersion || '—'],
        ]),
    );
    if ((k8s.contexts ?? []).length) {
      parts.push(`上下文列表：${k8s.contexts.map((item) => `\`${esc(item)}\``).join('、')}\n`);
    }
  }
  return parts.join('\n');
}

function renderInventory(report) {
  const inventory = report.inventory;
  if (!inventory) return '_未采集（未选择 language/package 分组）_\n';
  const pythons = (inventory.pythons ?? []).map((item) => [item.version ?? '—', item.source ?? '', item.path]);
  const conda = inventory.conda ?? {};
  const parts = [`### Python 解释器\n\n${table(['版本', '来源', '路径'], pythons)}`];
  if (conda.path || (conda.envs ?? []).length) {
    const envs = (conda.envs ?? []).map((item) => [item.path, item.python || '—', item.active ? '活跃' : '']);
    parts.push(
      `### conda\n\n` +
        `解释器：\`${esc(conda.path || '未找到')}\`　版本：${esc(conda.version ?? '—')}` +
        `${conda.activeEnv ? `　当前环境：${esc(conda.activeEnv)}` : ''}${conda.source ? `　来源：${esc(conda.source)}` : ''}\n` +
        (envs.length ? `\n${table(['环境目录', 'Python', '状态'], envs)}` : '\n'),
    );
  }
  return parts.join('\n');
}

function renderGpu(report) {
  const gpu = report.gpu;
  if (!gpu) return '_未采集（未选择 gpu 分组）_\n';
  const rows = (gpu.devices ?? []).map((device) => [
    device.vendor,
    device.index,
    device.name || '—',
    device.memoryTotalMB === null || device.memoryTotalMB === undefined ? '—' : `${device.memoryUsedMB ?? '?'} / ${device.memoryTotalMB} MB`,
    device.driverVersion || '—',
    device.temperatureC === null || device.temperatureC === undefined ? '—' : `${device.temperatureC} °C`,
    device.utilizationPercent === null || device.utilizationPercent === undefined ? '—' : `${device.utilizationPercent}%`,
  ]);
  const details = gpu.details ?? {};
  const notes = [];
  if (details.nvidia) notes.push(`nvidia-smi：\`${esc(details.nvidia.path)}\`，设备 ${details.nvidia.deviceCount} 个，驱动 ${esc(details.nvidia.driverVersion || '—')}`);
  if (details.ascend) notes.push(`npu-smi：\`${esc(details.ascend.path)}\`，报告 NPU 数量 ${details.ascend.claimCount}，解析出 ${details.ascend.detectedCount}`);
  if (details.amd) notes.push(`rocm-smi：设备 ${details.amd.deviceCount} 个`);
  if (!rows.length) return `${notes.join('\n') || '_未检测到加速设备_'}\n`;
  return `${table(['厂商', '序号', '型号', '显存(已用/总量)', '驱动', '温度', '利用率'], rows)}\n${notes.join('\n')}\n`;
}

function renderEnv(report) {
  const env = report.env;
  if (!env) return '_未采集（未选择 env 分组）_\n';
  const selected = Object.entries(env.selected ?? {});
  const rows = selected
    .filter(([key]) => key !== 'PATH' && key !== 'Path')
    .map(([key, value]) => [key, value]);
  const pathRows = (env.pathEntries ?? []).map((entry, index) => [index, entry]);
  const parts = [
    `PATH 条目 ${env.pathEntryCount ?? 0} 个${(env.pathDuplicates ?? []).length ? `，其中重复 ${env.pathDuplicates.length} 个` : ''}` +
      `${(env.pathDuplicates ?? []).length ? `：${env.pathDuplicates.map((item) => `\`${esc(item)}\``).join('、')}` : ''}\n`,
    table(['变量', '值'], rows),
  ];
  if (pathRows.length) parts.push(`<details><summary>PATH 明细（${pathRows.length} 条）</summary>\n\n${table(['#', '目录'], pathRows)}\n</details>\n`);
  return parts.join('\n');
}

export function renderMarkdown(report, options = {}) {
  const platform = report.platform;
  const distro = platform?.distro ?? {};
  const title = platform ? `${distro.name || platform.osName} ${distro.version || platform.release || ''}`.trim() : '未知平台';
  const head = [
    `# 环境检测报告`,
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 平台：${title}（${report.platformTarget ?? `${platform?.os ?? ''}/${platform?.arch ?? ''}`}）`,
    `- 主机：${platform?.fqdn || platform?.hostname || '—'}　用户：${platform?.user ?? '—'}`,
    `- 耗时：${report.durationMs ?? 0} ms`,
    `- 工具：找到 ${report.summary?.toolsFound ?? 0} / 检测 ${report.summary?.toolsChecked ?? 0}`,
    `- 网卡：${report.summary?.adapterCount ?? 0}　加速设备：${report.summary?.gpuCount ?? 0}　Python：${report.summary?.pythonCount ?? 0}`,
    '',
    report.snapshotPath ? `> 快照文件：\`${report.snapshotPath}\`` : '',
    '',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));

  const sections = [
    section('系统与主机', renderPlatform(report)),
    section('硬件', renderHardware(report)),
    section('Shell 环境', renderShells(report)),
    section('工具链', renderTools(report)),
    section('网络', renderNetwork(report)),
    section('容器与 Kubernetes', renderContainers(report)),
    section('语言与包环境', renderInventory(report)),
    section('加速设备', renderGpu(report)),
    section('环境变量', renderEnv(report)),
  ];

  if (options.includeGroups !== false) {
    const rows = (report.groups ?? []).map((item) => [item.title, item.ok ? '成功' : '失败', `${item.durationMs} ms`, item.error ?? '']);
    sections.push(section('采集分组', table(['分组', '状态', '耗时', '错误'], rows)));
  }
  if ((report.warnings ?? []).length) {
    sections.push(section('告警', `${report.warnings.map((item) => `- ${esc(item)}`).join('\n')}\n`));
  }
  return `${[...head, ...sections].join('\n')}`;
}

export function summarize(report) {
  const platform = report.platform;
  const distro = platform?.distro ?? {};
  const label = platform ? `${distro.name || platform.osName} ${distro.version || platform.release || ''}`.trim() : '未知平台';
  const found = Object.keys(report.paths ?? {}).length;
  return `${label}：找到 ${found} 个可用工具${report.summary?.warningCount ? `，${report.summary.warningCount} 条告警` : ''}`;
}
