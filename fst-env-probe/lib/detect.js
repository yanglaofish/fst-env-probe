// 检测编排：分组并行采集、汇总为稳定结构，并提供给动作、命令与共享服务复用。
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GROUPS, GROUP_IDS, withCustomProbes, commandNamesFor, groupMeta } from './catalog.js';
import { collectSystem, collectEnv } from './groups/system.js';
import { collectNetwork } from './groups/network.js';
import { collectTools, collectShells, aggregateFlags, probeVersion, resolveToolHits, orderHits } from './groups/toolchain.js';
import { collectContainers, collectInventory, collectGpu, collectPythons } from './groups/platform.js';
import { clearDirectoryCache, resolveExecutableAll, isStoreShim, expandPathValue, createScanContext, realPathOf } from './which.js';
import { detectRemoteMounts, formatMounts, clearMountCache } from './mounts.js';
import { tryRun, mapLimit, extractVersion, platformTarget } from './exec.js';
import { satisfiesVersion, isVersionRange, clearVersionCaches } from './version.js';
import { EnvProbeError } from './errors.js';
import { createFallbackRunProcess } from './run-process.js';

export const SCHEMA_VERSION = 1;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function expandPath(target, env = process.env) {
  if (typeof target !== 'string' || !target.trim()) return '';
  const expanded = target
    .trim()
    .replace(/%([^%]+)%/g, (raw, name) => env[name] ?? env[name.toUpperCase()] ?? raw)
    .replace(/^~(?=[\\/]|$)/, env.HOME ?? env.USERPROFILE ?? '~');
  return path.resolve(expanded);
}

function collectExtraDirs(config, input) {
  return [
    ...(Array.isArray(config.extraPaths) ? config.extraPaths : []),
    ...(Array.isArray(input.extraPaths) ? input.extraPaths : []),
  ]
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => path.resolve(expandPathValue(item)));
}

export function resolveGroups(input = {}, config = {}) {
  const defaults = config.groups && typeof config.groups === 'object' ? config.groups : {};
  const requested = Array.isArray(input.groups) && input.groups.length ? input.groups : null;
  if (requested) {
    const invalid = requested.filter((id) => !GROUP_IDS.includes(id));
    if (invalid.length) {
      throw new EnvProbeError(`未知的检测分组：${invalid.join('、')}`, {
        code: 'ENVPROBE_INPUT',
        details: { group: invalid, available: GROUP_IDS },
      });
    }
  }
  const selected = new Set();
  for (const id of GROUP_IDS) {
    if (requested) {
      if (requested.includes(id)) selected.add(id);
      continue;
    }
    if (defaults[id] === false) continue;
    selected.add(id);
  }
  if (!selected.size) {
    throw new EnvProbeError('至少需要选择一个检测分组', { code: 'ENVPROBE_INPUT', details: { available: GROUP_IDS } });
  }
  return selected;
}

function pickTools(tools, input, groups) {
  const only = (Array.isArray(input.toolIds) ? input.toolIds : []).map((id) => String(id).trim()).filter(Boolean);
  if (only.length) {
    const known = new Set(tools.map((tool) => tool.id));
    const invalid = only.filter((id) => !known.has(id));
    if (invalid.length) {
      throw new EnvProbeError(`未知的工具标识：${invalid.join('、')}`, {
        code: 'ENVPROBE_INPUT',
        details: { toolId: invalid },
      });
    }
    return tools.filter((tool) => only.includes(tool.id));
  }
  return tools.filter((tool) => groups.has(tool.group));
}

// 采集器依赖的工具：Git Bash 由 git 推导，只选 shell 分组时也必须解析 git。
const COLLECTOR_DEPENDENCIES = { shell: ['git'] };

function withCollectorDependencies(selected, allTools, collectors) {
  const ids = new Set(selected.map((tool) => tool.id));
  for (const [group, dependencies] of Object.entries(COLLECTOR_DEPENDENCIES)) {
    if (!collectors.has(group)) continue;
    for (const id of dependencies) ids.add(id);
  }
  return allTools.filter((tool) => ids.has(tool.id));
}

/**
 * 建立一次扫描的上下文：先识别远程挂载点。
 * 远程挂载上的文件系统调用可能永不返回（NFS hard mount 不可中断），
 * 因此默认跳过它们，并把"跳过了哪里"一路记录下来，绝不让它变成静默漏检。
 */
async function buildScanContext({ runProcess, signal, env, config = {}, input = {} }) {
  const allowRemoteMounts = input.allowRemoteMounts ?? config.allowRemoteMounts ?? false;
  const mountInfo = await detectRemoteMounts({
    runProcess,
    signal,
    platform: process.platform,
    timeoutMs: clamp(input.timeoutMs ?? config.timeoutMs ?? 5000, 1000, 30000),
  });
  const context = createScanContext({
    platform: process.platform,
    env,
    remoteMounts: mountInfo.remote,
    allowRemoteMounts,
    directoryTimeoutMs: clamp(config.scanTimeoutMs ?? 3000, 500, 60000),
    signal,
  });
  return { context, mountInfo };
}

/** 把扫描过程中跳过的远程挂载点与超时目录汇总成告警：有漏检必须说出来。 */
function scanWarnings(context, mountInfo) {
  const messages = [...(mountInfo?.warnings ?? [])];
  const skippedMounts = [...new Set(context.skipped.filter((item) => item.reason === 'remote-mount').map((item) => `${item.fstype}: ${item.mount}`))];
  if (skippedMounts.length) {
    messages.push(
      `已跳过 ${skippedMounts.length} 个远程挂载点下的目录（${formatMounts(context.skipped.filter((item) => item.reason === 'remote-mount'))}` +
        `${skippedMounts.length > 5 ? ' 等' : ''}）；这些位置里的工具不会被检测到，如需纳入请设置 allowRemoteMounts: true`,
    );
  }
  const timedOut = [...new Set(context.timedOut)];
  if (timedOut.length) {
    messages.push(
      `有 ${timedOut.length} 个目录读取超时（${timedOut.slice(0, 3).join('、')}${timedOut.length > 3 ? ' 等' : ''}），` +
        '其中的工具可能未被检出；可提高 scanTimeoutMs 或检查这些路径是否可用',
    );
  }
  return { messages, skippedMounts, timedOut };
}

export async function runDetection({
  runProcess,
  signal,
  env = process.env,
  config = {},
  input = {},
  log = async () => {},
} = {}) {
  const started = Date.now();
  const { tools, toolById, rejected = [] } = withCustomProbes(config.extraProbes ?? []);
  const groups = resolveGroups(input, config);
  const onlyTools = (Array.isArray(input.toolIds) ? input.toolIds : []).length > 0;
  const explicitlyGrouped = Array.isArray(input.groups) && input.groups.length > 0;
  // 只点名工具时不再跑系统/网络等重采集，保证「给我一个 python 路径」足够轻。
  const collectors = onlyTools && !explicitlyGrouped ? new Set() : groups;
  const timeoutMs = clamp(input.timeoutMs ?? config.timeoutMs ?? 8000, 1000, 60000);
  const concurrency = clamp(input.concurrency ?? config.concurrency ?? 6, 1, 16);
  const deep = !!input.deep;
  const extraDirs = collectExtraDirs(config, input);
  const selectedTools = withCollectorDependencies(pickTools(tools, input, groups), tools, collectors);
  if (input.refresh) clearDirectoryCache();

  const { context: scanContext, mountInfo } = await buildScanContext({ runProcess, signal, env, config, input });

  const warnings = [];
  const stats = [];
  // 配置里的自定义探测器被静默丢弃是最难排查的失败之一，必须显式告警。
  if (rejected.length) {
    warnings.push(
      `配置里有 ${rejected.length} 个自定义探测器被忽略：需要合法的 id（字母开头）与至少一个候选命令名`,
    );
  }
  const track = async (id, task, title = groupMeta(id).title) => {
    const at = Date.now();
    try {
      const value = await task;
      stats.push({ id, title, ok: true, durationMs: Date.now() - at, error: '' });
      return value;
    } catch (error) {
      if (signal?.aborted) throw error;
      stats.push({ id, title, ok: false, durationMs: Date.now() - at, error: error?.message ?? String(error) });
      warnings.push(`${title}采集失败：${error?.message ?? error}`);
      return null;
    }
  };

  await log('开始环境检测', { groups: [...collectors], tools: selectedTools.length, deep });

  const [systemResult, networkResult, toolResult] = await Promise.all([
    collectors.has('system') ? track('system', collectSystem({ runProcess, signal, env, timeoutMs })) : null,
    collectors.has('network') ? track('network', collectNetwork({ runProcess, signal, env, timeoutMs })) : null,
    selectedTools.length
      ? track(
          'tools',
          collectTools({
            runProcess,
            signal,
            env,
            tools: selectedTools,
            timeoutMs,
            concurrency,
            extraDirs,
            deep,
            context: scanContext,
          }),
          '工具解析',
        )
      : null,
  ]);

  const resolvedToolById = toolResult?.byId ?? {};
  warnings.push(...(systemResult?.warnings ?? []), ...(networkResult?.warnings ?? []));

  await log('工具探测完成', { checked: selectedTools.length, found: toolResult?.stats.found ?? 0 });

  const [shells, containers, inventory, gpu] = await Promise.all([
    collectors.has('shell')
      ? track(
          'shell',
          collectShells({ runProcess, signal, env, toolById: resolvedToolById, timeoutMs, deep, context: scanContext }),
        )
      : null,
    collectors.has('container')
      ? track('container', collectContainers({ runProcess, signal, env, toolById: resolvedToolById, timeoutMs }))
      : null,
    collectors.has('language') || collectors.has('package')
      ? track(
          'language',
          collectInventory({ runProcess, signal, env, toolById: resolvedToolById, timeoutMs, deep, context: scanContext }),
          '语言与包环境',
        )
      : null,
    collectors.has('gpu')
      ? track('gpu', collectGpu({ runProcess, signal, toolById: resolvedToolById, timeoutMs, deep }))
      : null,
  ]);

  warnings.push(
    ...(shells?.warnings ?? []),
    ...(containers?.warnings ?? []),
    ...(inventory?.warnings ?? []),
    ...(gpu?.warnings ?? []),
  );

  // Windows 上往往只有 Git for Windows 附带的 bash，它不在 PATH 里。
  // 补链到 bash 条目，让 paths.bash / flags.bash 对下游插件真正可用。
  if (toolResult && shells?.gitBash?.path && resolvedToolById.bash && !resolvedToolById.bash.found) {
    resolvedToolById.bash = {
      ...resolvedToolById.bash,
      found: true,
      path: shells.gitBash.path,
      source: 'git-bash',
      version: shells.gitBash.version ?? null,
      note: resolvedToolById.bash.note || '由 Git for Windows 提供',
    };
    toolResult.paths.bash = shells.gitBash.path;
    toolResult.flags.bash = true;
    toolResult.stats.found += 1;
    toolResult.stats.versioned += shells.gitBash.version ? 1 : 0;
  }

  const envInfo = collectors.has('env') ? collectEnv(env) : null;
  if (collectors.has('env')) {
    stats.push({ id: 'env', title: groupMeta('env').title, ok: true, durationMs: 0, error: '' });
  }
  const scan = scanWarnings(scanContext, mountInfo);
  warnings.push(...scan.messages);
  const extraFlags = {
    gpu: (gpu?.deviceCount ?? 0) > 0,
    npu: (gpu?.vendors ?? []).includes('ascend'),
    kubeconfig: !!containers?.k8s?.kubeconfigExists,
    containerDaemon: (containers?.engines ?? []).some((engine) => engine.daemonReachable === true),
    // 采集失败必须能被条件判断看见，否则"没装"与"没采到"无法区分。
    probeFailed: stats.some((item) => !item.ok),
    // 有跳过的远程挂载点或超时目录时置位，提醒"这份结果可能不完整"。
    incompleteScan: scan.skippedMounts.length > 0 || scan.timedOut.length > 0,
  };
  const flags = aggregateFlags({ ...(toolResult?.flags ?? {}), ...extraFlags });
  const failedGroups = stats.filter((item) => !item.ok);

  const report = {
    ok: failedGroups.length === 0,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    platformTarget: platformTarget(),
    platform: systemResult?.platform ?? null,
    hardware: systemResult?.hardware ?? null,
    shells: shells ?? null,
    tools: resolvedToolById,
    paths: toolResult?.paths ?? {},
    flags,
    containers: containers ?? null,
    inventory: inventory ?? null,
    network: networkResult ?? null,
    gpu: gpu ?? null,
    env: envInfo,
    groups: stats,
    warnings,
    errors: failedGroups.map((item) => ({ id: item.id, title: item.title, message: item.error })),
    scan: {
      directories: scanContext.directories,
      cacheHits: scanContext.cacheHits,
      allowRemoteMounts: scanContext.allowRemoteMounts,
      remoteMounts: (mountInfo?.remote ?? []).map((entry) => ({ mount: entry.mount, fstype: entry.fstype })),
      skippedRemote: scan.skippedMounts,
      timedOut: scan.timedOut,
    },
    summary: {
      groupCount: stats.length,
      groupFailed: stats.filter((item) => !item.ok).length,
      toolsChecked: selectedTools.length,
      toolsFound: toolResult?.stats.found ?? 0,
      toolsVersioned: toolResult?.stats.versioned ?? 0,
      pathCount: Object.keys(toolResult?.paths ?? {}).length,
      adapterCount: networkResult?.adapterCount ?? 0,
      gpuCount: gpu?.deviceCount ?? 0,
      pythonCount: inventory?.pythonCount ?? 0,
      condaEnvCount: inventory?.conda?.envs?.length ?? 0,
      kubernetesContexts: containers?.k8s?.contextCount ?? 0,
      warningCount: warnings.length,
    },
    durationMs: Date.now() - started,
  };
  await log('环境检测结束', { durationMs: report.durationMs, found: report.summary.toolsFound });
  return report;
}

// ---------------------------------------------------------------------------
// Python 清单：供 envprobe.python 命令与工作流直接用
// ---------------------------------------------------------------------------

export async function listPythons({ runProcess, signal, env = process.env, config = {}, input = {}, log = async () => {} } = {}) {
  const { toolById } = withCustomProbes(config.extraProbes ?? []);
  const { context, mountInfo } = await buildScanContext({ runProcess, signal, env, config, input });
  const timeoutMs = clamp(input.timeoutMs ?? config.timeoutMs ?? 8000, 1000, 60000);
  await log('枚举 Python 解释器', { allowRemoteMounts: context.allowRemoteMounts });

  // collectPythons 需要的是"检测结果"（found/path/version），不是注册表条目，这里先解析一次。
  const detected = {};
  for (const id of ['python', 'conda']) {
    const spec = toolById.get(id);
    if (!spec) continue;
    const hits = await resolveToolHits({ spec, platform: process.platform, env, context });
    const primary = hits.find((hit) => !isStoreShim(hit.path)) ?? hits[0] ?? null;
    const probed =
      primary && spec.versionArgs.length
        ? await probeVersion(spec, primary.path, { runProcess, signal, timeoutMs })
        : { version: null };
    detected[id] = { found: !!primary, path: primary?.path ?? '', version: probed.version ?? null, title: spec.title };
  }

  // 用专题枚举而不是通用检查：它会带上 conda 环境与 py 启动器登记的全部版本。
  const { pythons, conda, warnings } = await collectPythons({
    runProcess,
    signal,
    env,
    toolById: detected,
    context,
    timeoutMs,
    includeVersions: input.includeVersions !== false,
    includeCondaEnvs: input.includeConda !== false,
  });

  const scan = scanWarnings(context, mountInfo);
  warnings.push(...scan.messages);
  const launchers = pythons.filter((entry) => entry.kind === 'launcher');
  const interpreters = pythons.filter((entry) => entry.kind !== 'launcher');
  // 与 detect/check 的 paths.python 保持一致：优先"工具解析的首要命中"，其次 PATH 上的。
  const preferred = detected.python?.path ?? '';
  const primary =
    (preferred ? interpreters.find((entry) => entry.available && entry.path === preferred) : null) ??
    interpreters.find((entry) => entry.source === 'primary' && entry.available) ??
    interpreters.find((entry) => entry.source === 'PATH' && entry.available) ??
    interpreters.find((entry) => entry.available) ??
    interpreters[0] ??
    null;

  await log('Python 枚举完成', { count: pythons.length, primary: primary?.path ?? '' });
  return {
    ok: interpreters.length > 0,
    count: pythons.length,
    pythons,
    launchers,
    primary: primary?.path ?? null,
    primaryVersion: primary?.version ?? null,
    conda,
    skippedRemote: scan.skippedMounts,
    timedOut: scan.timedOut,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 任意环境项的直接检查：envprobe.check 与各分组快捷入口都走这里
// ---------------------------------------------------------------------------

/**
 * 检查任意工具或任意分组：
 * - 给 tool：注册表标识（docker/kubectl/python…）或任意命令名（含自定义工具）；
 * - 给 group：列出该分组下全部检测项；
 * - 都不给：列出全部检测项。
 * @returns {Promise<{ok:boolean,count:number,foundCount:number,results:Array,missing:string[],paths:object,scan:object,warnings:string[]}>}
 */
export async function checkTools({
  runProcess,
  signal,
  env = process.env,
  config = {},
  input = {},
  log = async () => {},
} = {}) {
  const { tools, toolById } = withCustomProbes(config.extraProbes ?? []);
  const { context, mountInfo } = await buildScanContext({ runProcess, signal, env, config, input });
  const timeoutMs = clamp(input.timeoutMs ?? config.timeoutMs ?? 8000, 1000, 60000);
  const concurrency = clamp(input.concurrency ?? config.concurrency ?? 6, 1, 16);
  const includeVersion = input.includeVersion !== false;
  const wantCandidates = input.candidates !== false;
  const extraDirs = collectExtraDirs(config, input);

  const queries = (Array.isArray(input.tool) ? input.tool : [input.tool])
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  const group = typeof input.group === 'string' ? input.group.trim() : '';
  if (group && group !== 'all' && !GROUP_IDS.includes(group)) {
    throw new EnvProbeError(`未知的检测分组：${group}`, {
      code: 'ENVPROBE_INPUT',
      details: { available: [...GROUP_IDS, 'all'] },
    });
  }

  const targets = [];
  if (queries.length) {
    for (const query of queries) targets.push({ id: query, spec: toolById.get(query) ?? null });
  } else {
    const selected = group && group !== 'all' ? tools.filter((tool) => tool.group === group) : tools;
    for (const spec of selected) targets.push({ id: spec.id, spec });
  }

  const results = await mapLimit(
    targets,
    concurrency,
    async (target) => {
      const { spec } = target;
      const entry = {
        id: target.id,
        title: spec?.title ?? target.id,
        group: spec?.group ?? 'custom',
        found: false,
        path: '',
        realPath: '',
        version: null,
        versionRaw: '',
        source: '',
        candidates: [],
        installations: [],
        shim: false,
        error: '',
        note: spec?.note ?? '',
      };
      if (!spec) {
        // 未注册的名字：只允许纯命令名，不允许借它执行路径形式的程序。
        if (!isValidCommandName(target.id)) {
          entry.error = '既不是已注册的检测项，也不是合法的命令名（不允许包含路径分隔符）';
          return entry;
        }
      }
      const names = spec ? commandNamesFor(spec, process.platform) : [target.id];
      const hits = await resolveToolHits({
        spec,
        query: target.id,
        platform: process.platform,
        env,
        extraDirs,
        context,
      });
      // 商店别名排到最后：它们存在但通常不可用。
      const ordered = orderHits(hits);
      const primary = ordered[0] ?? null;
      entry.candidates = (wantCandidates ? ordered : ordered.slice(0, 1)).map((hit) => hit.path);
      if (!primary) {
        entry.error = `未找到命令：${names.join(' / ')}`;
        return entry;
      }

      // 未注册的命令用一个通用的版本参数序列试一遍。
      const versionSpec = spec ?? { versionArgs: [['--version'], ['-V'], ['version']], parse: null };
      const probeOne = async (file) => {
        if (!includeVersion || !versionSpec.versionArgs.length) return { version: null, versionRaw: '', error: '' };
        return probeVersion(versionSpec, file, { runProcess, signal, timeoutMs });
      };

      const primaryProbe = await probeOne(primary.path);
      entry.found = true;
      entry.path = primary.path;
      entry.realPath = await realPathOf(primary.path);
      entry.source = primary.source;
      entry.shim = isStoreShim(primary.path);
      entry.version = primaryProbe.version;
      entry.versionRaw = primaryProbe.versionRaw;
      entry.error = primaryProbe.error;

      // 每个安装各自的版本：用户要的是"有多个就多个"，版本也要跟着给出。
      const inspected = wantCandidates ? ordered : ordered.slice(0, 1);
      entry.installations = await mapLimit(
        inspected,
        concurrency,
        async (hit, index) => {
          const probed = index === 0 ? primaryProbe : await probeOne(hit.path);
          return {
            path: hit.path,
            realPath: await realPathOf(hit.path),
            version: probed.version,
            source: hit.source,
            shim: isStoreShim(hit.path),
            primary: index === 0,
            error: probed.error,
          };
        },
        { signal },
      );
      return entry;
    },
    { signal },
  );

  const scan = scanWarnings(context, mountInfo);
  const found = results.filter((entry) => entry.found);
  const missing = results.filter((entry) => !entry.found).map((entry) => entry.id);
  await log('环境检查完成', { checked: results.length, found: found.length, missing: missing.length });

  return {
    ok: results.length > 0 && missing.length === 0,
    count: results.length,
    foundCount: found.length,
    results,
    missing,
    // 便捷绑定：找到的项直接给路径，用法与 detect 的 paths 一致
    paths: Object.fromEntries(found.map((entry) => [entry.id, entry.path])),
    scan: {
      allowRemoteMounts: context.allowRemoteMounts,
      skippedRemote: scan.skippedMounts,
      timedOut: scan.timedOut,
    },
    warnings: scan.messages,
  };
}

// ---------------------------------------------------------------------------
// 按需解析指定工具（供其他插件取路径）
// ---------------------------------------------------------------------------

function normalizeRequest(raw) {
  if (typeof raw === 'string') return { id: raw.trim(), names: [], version: '', required: true, label: '' };
  if (raw && typeof raw === 'object') {
    return {
      id: String(raw.id ?? '').trim(),
      names: (Array.isArray(raw.names) ? raw.names : []).filter((name) => typeof name === 'string' && name.trim()),
      version: typeof raw.version === 'string' ? raw.version : '',
      required: raw.required !== false,
      label: typeof raw.label === 'string' ? raw.label : '',
    };
  }
  return null;
}

// 工具标识会直接作为输出对象的键，必须排除 __proto__/constructor/prototype 之类的危险名。
const TOOL_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// 候选命令名只允许"命令名"，不允许路径：否则工作流输入可以借 names 执行任意路径的程序。
const COMMAND_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidToolId(id) {
  return typeof id === 'string' && TOOL_ID_RE.test(id) && !FORBIDDEN_KEYS.has(id);
}

export function isValidCommandName(name) {
  return typeof name === 'string' && COMMAND_NAME_RE.test(name) && !name.includes('..');
}

export async function resolveTools({
  runProcess,
  signal,
  env = process.env,
  config = {},
  input = {},
  log = async () => {},
} = {}) {
  const { toolById, rejected = [] } = withCustomProbes(config.extraProbes ?? []);
  if (rejected.length) await log('配置里的自定义探测器被忽略', { count: rejected.length });
  const requests = (Array.isArray(input.tools) ? input.tools : []).map(normalizeRequest).filter((item) => item?.id);
  if (!requests.length) {
    throw new EnvProbeError('请至少指定一个要解析的工具', { code: 'ENVPROBE_INPUT', details: { field: 'tools' } });
  }
  // 标识会成为输出对象的键，候选命令名会用于执行版本命令：两者都来自工作流输入，必须先校验。
  const invalidIds = requests.map((request) => request.id).filter((id) => !isValidToolId(id));
  if (invalidIds.length) {
    throw new EnvProbeError(`工具标识不合法：${invalidIds.join('、')}`, {
      code: 'ENVPROBE_INPUT',
      details: { toolId: invalidIds },
    });
  }
  const invalidNames = requests.flatMap((request) => request.names).filter((name) => !isValidCommandName(name));
  if (invalidNames.length) {
    throw new EnvProbeError(`候选命令名不合法（不允许路径分隔符）：${invalidNames.join('、')}`, {
      code: 'ENVPROBE_INPUT',
      details: { names: invalidNames },
    });
  }
  const invalidRanges = requests.map((request) => request.version).filter((range) => range && !isVersionRange(range));
  if (invalidRanges.length) {
    throw new EnvProbeError(`版本范围无法解析：${invalidRanges.join('、')}`, {
      code: 'ENVPROBE_INPUT',
      details: { version: invalidRanges },
    });
  }
  const timeoutMs = clamp(input.timeoutMs ?? config.timeoutMs ?? 8000, 1000, 60000);
  const concurrency = clamp(input.concurrency ?? config.concurrency ?? 6, 1, 16);
  const deep = input.deep !== false;
  const extraDirs = collectExtraDirs(config, input);
  if (input.refresh) clearDirectoryCache();
  const { context: scanContext } = await buildScanContext({ runProcess, signal, env, config, input });

  const entries = await mapLimit(
    requests,
    concurrency,
    async (request) => {
      const spec = toolById.get(request.id);
      const names = request.names.length ? request.names : spec ? commandNamesFor(spec, process.platform) : [request.id];
      let hit = null;
      for (const name of names) {
        const found = await resolveExecutableAll(name, { platform: process.platform, env, extraDirs, context: scanContext });
        const real = found.find((item) => !isStoreShim(item.path)) ?? found[0];
        if (real) {
          hit = real;
          break;
        }
      }
      const entry = {
        id: request.id,
        label: request.label || spec?.title || request.id,
        found: !!hit,
        path: hit?.path ?? '',
        source: hit?.source ?? '',
        version: spec?.version ?? null,
        versionRaw: '',
        expected: request.version,
        satisfied: null,
        error: '',
      };
      if (!hit) {
        entry.error = `未找到命令：${names.join(' / ')}`;
        entry.satisfied = request.version ? false : null;
        return entry;
      }
      if (spec && spec.versionArgs.length && deep) {
        // 复用工具链采集里的同一份探测实现，避免两处漂移（尤其别让上次失败的 error 残留）。
        const probed = await probeVersion(spec, hit.path, { runProcess, signal, timeoutMs });
        entry.version = probed.version;
        entry.versionRaw = probed.versionRaw;
        entry.error = probed.error;
      }
      if (request.version) entry.satisfied = entry.version ? satisfiesVersion(entry.version, request.version) : false;
      return entry;
    },
    { signal },
  );

  // 键来自已校验的工作流输入，仍用 null 原型容器做纵深防护。
  const paths = Object.create(null);
  const tools = Object.create(null);
  const missing = [];
  const unsatisfied = [];
  for (const entry of entries) {
    tools[entry.id] = entry;
    if (entry.found && entry.path) paths[entry.id] = entry.path;
    else missing.push(entry.id);
    // 只有"确实找到但版本不符"才算 unsatisfied；没找到的由 missing/requiredMissing 表达。
    if (entry.found && entry.expected && entry.satisfied === false) unsatisfied.push(entry.id);
  }
  const requiredMissing = requests
    .filter((request) => request.required)
    .map((request) => request.id)
    .filter((id) => missing.includes(id));
  const ok = requiredMissing.length === 0 && unsatisfied.length === 0;

  await log('工具解析完成', {
    requested: requests.length,
    found: Object.keys(paths).length,
    missing: missing.length,
  });
  return { ok, missing, unsatisfied, requiredMissing, paths, tools, resolvedAt: new Date().toISOString() };
}

export async function verifyRequirements({ runProcess, signal, env, config = {}, input = {}, log } = {}) {
  const requirements = (Array.isArray(input.requirements) ? input.requirements : [])
    .map((raw) => (raw && typeof raw === 'object' ? { ...raw, id: String(raw.id ?? '').trim() } : null))
    .filter((item) => item?.id);
  if (!requirements.length) {
    throw new EnvProbeError('请至少指定一项环境要求', { code: 'ENVPROBE_INPUT', details: { field: 'requirements' } });
  }
  const knownToolIds = withCustomProbes(config.extraProbes ?? []).toolById;
  const resolved = await resolveTools({
    runProcess,
    signal,
    env,
    config,
    input: {
      tools: requirements.map((item) => ({
        id: item.id,
        names: item.names,
        // 写法非法的版本范围不在这里整体抛错，交给下面的逐项检查报告。
        version: isVersionRange(item.version) ? item.version : '',
        label: item.label,
      })),
      deep: input.deep !== false,
      timeoutMs: input.timeoutMs,
      concurrency: input.concurrency,
      extraPaths: input.extraPaths,
      refresh: input.refresh,
    },
    log,
  });

  const checks = [];
  for (const requirement of requirements) {
    const entry = resolved.tools[requirement.id];
    const check = {
      id: requirement.id,
      label: requirement.label || entry?.label || requirement.id,
      status: 'ok',
      found: !!entry?.found,
      path: entry?.path ?? '',
      version: entry?.version ?? null,
      expected: requirement.version ?? '',
      message: '',
    };
    if (!entry?.found) {
      check.status = 'missing';
      check.message = entry?.error || '未找到该命令';
    } else if (requirement.version) {
      if (!isVersionRange(requirement.version)) {
        check.status = 'invalid_range';
        check.message = `版本范围写法无法解析：${requirement.version}`;
      } else if (!entry.version) {
        check.status = 'unknown_version';
        check.message = `要求 ${requirement.version}，但无法识别实际版本`;
      } else if (!satisfiesVersion(entry.version, requirement.version)) {
        check.status = 'version_mismatch';
        check.message = `要求 ${requirement.version}，实际 ${entry.version}`;
      }
    }
    if (check.status === 'ok' && requirement.command) {
      const args = Array.isArray(requirement.args) ? requirement.args.map(String) : [];
      if (!knownToolIds.has(requirement.id)) {
        // 未注册的 id 只做存在性检查：不允许借"附加命令"执行任意程序。
        check.status = 'command_skipped';
        check.message = '该工具不在检测注册表中，附加命令校验已跳过';
      } else {
        const argv = [String(requirement.command), ...args];
        if (log) await log('执行附加校验命令', { tool: requirement.id, argv });
        const run = await tryRun(runProcess, entry.path, argv, {
          signal,
          timeoutMs: clamp(input.timeoutMs ?? config.timeoutMs ?? 8000, 1000, 60000),
        });
        if (!run.ok) {
          check.status = 'command_failed';
          check.message = `额外命令执行失败（退出码 ${run.exitCode ?? '未知'}）`;
        }
      }
    }
    checks.push(check);
  }

  const failed = checks.filter((check) => check.status !== 'ok');
  const report = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    missing: failed.filter((check) => check.status === 'missing').map((check) => check.id),
    paths: resolved.paths,
    tools: resolved.tools,
  };
  if (log) await log('环境要求校验完成', { passed: report.passed, failed: report.failed });
  return report;
}

// ---------------------------------------------------------------------------
// 快照文件：把检测结果落到固定位置，供其他插件或外部工具读取
// ---------------------------------------------------------------------------

export function resolveSnapshotPath({
  config = {},
  input = {},
  projectDir,
  stateDir,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const explicit = [input.snapshotPath, config.snapshotPath].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  if (explicit) return resolveSnapshotTarget(explicit, { projectDir, stateDir, env, cwd });
  if (!input.snapshot) return '';
  // stateDir 是宿主 0.4.0 起的插件私有持久目录；只读项目或无应用的独立宿主下为 undefined。
  if (typeof stateDir === 'string' && stateDir) return path.join(stateDir, 'environment-latest.json');
  if (typeof projectDir === 'string' && projectDir) return path.join(projectDir, '.flow', 'env', 'latest.json');
  return path.join(cwd, 'environment-latest.json');
}

/**
 * 显式快照路径：绝对路径按用户意图直接使用；
 * 相对路径以项目目录（而不是宿主进程 cwd）为基准，并拒绝 ../ 逃逸。
 */
function resolveSnapshotTarget(value, { projectDir, stateDir, env, cwd }) {
  const expanded = expandPathValue(value, env);
  // resolve 而不是 normalize：posix 风格的 "/x" 在 Windows 上也能补全盘符，行为可预期。
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  const base = path.resolve(projectDir || stateDir || cwd);
  const resolved = path.resolve(base, expanded);
  const relative = path.relative(base, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new EnvProbeError(`快照路径超出项目目录：${value}`, {
      code: 'ENVPROBE_INPUT',
      details: { snapshotPath: value, base },
    });
  }
  return resolved;
}

export async function writeSnapshot(report, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}

export async function readSnapshot(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export function catalogSummary(config = {}) {
  const { tools, rejected = [] } = withCustomProbes(config.extraProbes ?? []);
  return {
    groups: GROUPS,
    rejectedCount: rejected.length,
    tools: tools.map((tool) => ({
      id: tool.id,
      title: tool.title,
      group: tool.group,
      custom: tool.source === 'custom',
      commands: commandNamesFor(tool, process.platform),
      hasVersionProbe: tool.versionArgs.length > 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// 共享服务：带缓存的探测引擎供其他插件调用
// ---------------------------------------------------------------------------

const FALLBACK = createFallbackRunProcess();

function cacheKeyOf(input = {}) {
  return JSON.stringify({
    groups: Array.isArray(input.groups) ? [...input.groups].sort() : null,
    toolIds: Array.isArray(input.toolIds) ? [...input.toolIds].map(String).sort() : null,
    deep: !!input.deep,
    // 影响解析结果的输入都要进键，否则不同调用方会互相命中陈旧结果。
    extraPaths: Array.isArray(input.extraPaths) ? [...input.extraPaths].map(String).sort() : null,
    timeoutMs: input.timeoutMs ?? null,
    concurrency: input.concurrency ?? null,
  });
}

/** 环境指纹：服务被多个插件共享时，不同 env 不能共用同一份缓存。 */
function envFingerprint(env = process.env) {
  return ['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'SystemRoot', 'windir']
    .map((key) => `${key}=${env?.[key] ?? ''}`)
    .join('|');
}

export function createProbeEngine(config = {}) {
  const ttlSeconds = Number(config.cacheTtlSeconds);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? ttlSeconds * 1000 : 300000;
  const cache = new Map();
  const knownToolIds = new Set(withCustomProbes(config.extraProbes ?? []).toolIds);
  const contextOf = (context = {}) => ({
    runProcess: typeof context.runProcess === 'function' ? context.runProcess : FALLBACK,
    signal: context.signal,
    log: typeof context.log === 'function' ? context.log : async () => {},
    env: context.env ?? process.env,
  });

  const engine = {
    async detect(input = {}, context = {}) {
      const { runProcess, signal, log, env } = contextOf(context);
      const key = `${cacheKeyOf(input)}#${envFingerprint(env)}`;
      const cached = cache.get(key);
      // 命中时返回副本：调用方改写结果不应污染其他调用方。
      if (!input.refresh && cached && Date.now() - cached.at < ttlMs) return structuredClone(cached.value);
      const report = await runDetection({ runProcess, signal, log, env, config, input });
      if (ttlMs > 0) {
        cache.set(key, { at: Date.now(), value: report });
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      }
      return structuredClone(report);
    },
    async resolve(input = {}, context = {}) {
      const { runProcess, signal, log, env } = contextOf(context);
      return resolveTools({ runProcess, signal, log, env, config, input });
    },
    async verify(input = {}, context = {}) {
      const { runProcess, signal, log, env } = contextOf(context);
      return verifyRequirements({ runProcess, signal, log, env, config, input });
    },
    /** 检查任意工具或分组：给 tool（标识或任意命令名）或 group，返回每个安装及其版本。 */
    async check(input = {}, context = {}) {
      const { runProcess, signal, log, env } = contextOf(context);
      return checkTools({ runProcess, signal, log, env, config, input });
    },
    /** 取单个工具路径；找不到或标识未注册时返回 null，不抛错。 */
    async pathOf(id, context = {}) {
      if (!isValidToolId(id) || !knownToolIds.has(id)) return null;
      const report = await engine.detect({ toolIds: [id] }, context);
      return report.paths?.[id] ?? null;
    },
    /** 一次拿多个工具路径；未找到或未注册的为 null。 */
    async pathsFor(ids, context = {}) {
      const wanted = [...ids].filter((id) => isValidToolId(id) && knownToolIds.has(id));
      const report = wanted.length ? await engine.detect({ toolIds: wanted }, context) : { paths: {} };
      return Object.fromEntries(ids.map((id) => [id, report.paths?.[id] ?? null]));
    },
    /** 要求某个工具存在且满足版本范围，否则抛错。 */
    async require(id, version = '', context = {}) {
      const resolved = await engine.resolve({ tools: [{ id, version, required: true }] }, context);
      if (!resolved.ok) {
        throw new EnvProbeError(`环境不满足：${id}${version ? ` ${version}` : ''}`, {
          code: 'ENVPROBE_MISSING',
          details: { id, version, missing: resolved.missing, unsatisfied: resolved.unsatisfied },
        });
      }
      return resolved.tools[id];
    },
    catalog: () => catalogSummary(config),
    invalidate() {
      const size = cache.size;
      cache.clear();
      clearDirectoryCache();
      clearVersionCaches();
      clearMountCache();
      return size;
    },
    cacheInfo() {
      return {
        ttlSeconds: ttlMs / 1000,
        entries: [...cache.entries()].map(([key, value]) => ({ key, at: new Date(value.at).toISOString() })),
      };
    },
  };
  return engine;
}
