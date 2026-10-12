// fst-env-probe —— 跨平台环境探测插件
// 仅使用 Node 内置模块与宿主动作上下文，不依赖任何内部 SDK 或第三方包。
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { GROUPS, GROUP_IDS, TOOLS } from './lib/catalog.js';
import {
  detectInput,
  detectOutput,
  resolveInput,
  resolveOutput,
  verifyInput,
  verifyOutput,
  reportInput,
  reportOutput,
  pythonsInput,
  pythonsOutput,
  checkInput,
  checkOutput,
  catalogOutput,
} from './lib/schema.js';
import {
  runDetection,
  resolveTools,
  verifyRequirements,
  resolveSnapshotPath,
  writeSnapshot,
  catalogSummary,
  listPythons,
  checkTools,
  createProbeEngine,
} from './lib/detect.js';
import { renderMarkdown, summarize } from './lib/render.js';
import { EnvProbeError } from './lib/errors.js';

const emptyInput = { type: 'object', title: '无参数', additionalProperties: false, properties: {} };

// 插件身份与版本只以 package.json 为准，避免两处硬编码漂移（fst plugin validate 会比对两者）。
const pkgRequire = createRequire(import.meta.url);
const PKG = pkgRequire('./package.json');

const customProbeSchema = {
  type: 'object',
  title: '自定义探测器',
  required: ['id', 'names'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', title: '工具标识', description: '字母开头，可含数字、点、下划线和短横线', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' },
    title: { type: 'string', title: '显示名' },
    group: { type: 'string', title: '归入分组', enum: GROUP_IDS, default: 'custom' },
    names: {
      type: 'array',
      title: '候选命令名',
      minItems: 1,
      items: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
      description: '按顺序尝试，第一个命中的生效；只写命令名，不能含路径',
    },
    versionArgs: {
      title: '版本命令参数',
      description: '字符串表示一个命令；数组的数组表示依次尝试的多个命令；空数组表示不做版本探测',
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', minItems: 1, items: { type: 'string' } },
        { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: { type: 'string' } } },
        { type: 'array', maxItems: 0 },
      ],
    },
    versionPattern: { type: 'string', title: '版本正则', description: '第一个捕获组即版本号' },
    pathHints: { type: 'array', title: '额外搜索目录', items: { type: 'string' } },
    installPatterns: {
      type: 'object',
      title: '多版本安装目录',
      description: '按平台声明目录模式（整段或段内一个 * 匹配一层目录），用来发现 PATH 之外的安装',
      additionalProperties: { type: 'array', items: { type: 'string' } },
      properties: {
        default: { type: 'array', title: '通用', items: { type: 'string' } },
        win32: { type: 'array', title: 'Windows', items: { type: 'string' } },
        linux: { type: 'array', title: 'Linux', items: { type: 'string' } },
        darwin: { type: 'array', title: 'macOS', items: { type: 'string' } },
      },
    },
    note: { type: 'string', title: '说明' },
  },
};

/** 共享服务名：消费方用 getService(SERVICE_NAME) 取探测引擎。 */
export const SERVICE_NAME = 'env.probe';

const serviceStatusOutput = {
  type: 'object',
  title: '共享服务状态',
  additionalProperties: true,
  required: ['service', 'ready', 'ttlSeconds', 'cachedResults', 'toolCount', 'groupCount'],
  properties: {
    service: { type: 'string', title: '服务名' },
    ready: { type: 'boolean', title: '已就绪' },
    ttlSeconds: { type: 'number', title: '缓存有效期（秒）' },
    cachedResults: { type: 'integer', title: '已缓存结果数' },
    toolCount: { type: 'integer', title: '可检测工具数' },
    groupCount: { type: 'integer', title: '检测分组数' },
    cachedKeys: { type: 'array', title: '缓存键', items: { type: 'string' } },
  },
};

const configSchema = {
  type: 'object',
  title: '环境探测配置',
  additionalProperties: false,
  properties: {
    timeoutMs: { type: 'integer', title: '单项命令超时（毫秒）', default: 8000, minimum: 1000, maximum: 60000 },
    concurrency: { type: 'integer', title: '并发数', default: 6, minimum: 1, maximum: 16 },
    cacheTtlSeconds: { type: 'integer', title: '共享服务缓存（秒）', default: 300, minimum: 0, maximum: 86400, description: '0 表示每次重新检测' },
    groups: {
      type: 'object',
      title: '默认分组开关',
      description: '关闭某些分组的默认检测，例如 {"gpu": false}',
      additionalProperties: false,
      properties: Object.fromEntries(GROUPS.map((group) => [group.id, { type: 'boolean', title: group.title }])),
    },
    extraPaths: { type: 'array', title: '额外搜索目录', items: { type: 'string' }, description: '追加在 PATH 之后、平台已知目录之前' },
    allowRemoteMounts: {
      type: 'boolean',
      title: '允许扫描远程挂载点',
      default: false,
      description:
        '默认跳过 NFS/CIFS/UNC 等远程挂载下的目录——那里的文件系统调用可能永不返回（NFS hard mount 不可中断）。打开后在 scanTimeoutMs 内尝试',
    },
    scanTimeoutMs: {
      type: 'integer',
      title: '单个目录读取超时（毫秒）',
      default: 3000,
      minimum: 500,
      maximum: 60000,
      description: '超过即放弃该目录并记入告警，避免一个慢目录拖住整个检测',
    },
    snapshotPath: {
      type: 'string',
      title: '快照文件路径',
      description: '固定写入位置：绝对路径按原样使用，相对路径以项目目录为基准且不能越界；留空则写入插件的 stateDir',
    },
    extraProbes: { type: 'array', title: '自定义探测器', items: customProbeSchema },
  },
};

async function withSnapshot(report, context, input) {
  const { config = {}, projectDir, stateDir, env = process.env, cwd = process.cwd(), signal } = context;
  const target = resolveSnapshotPath({ config, input, projectDir, stateDir, env, cwd });
  if (!target) return '';
  signal?.throwIfAborted();
  await writeSnapshot(report, target);
  return target;
}

const presetQueryInput = {
  type: 'object',
  title: '查询参数',
  additionalProperties: false,
  properties: {
    includeVersion: { type: 'boolean', title: '探测版本', default: true },
    candidates: { type: 'boolean', title: '列出全部命中路径', default: false },
  },
};

/** 把检查结果压成给用户看的短摘要（最多 30 行，避免刷屏）。 */
function summarizeCheck(result, label = '检查', limit = 30) {
  const lines = result.results.slice(0, limit).map((entry) => {
    if (!entry.found) return `✗ ${entry.title}　${entry.error || '未找到'}`;
    const main = `✓ ${entry.title}${entry.version ? ` ${entry.version}` : ''}　${entry.path}`;
    // 同一个命令有多个安装时，把其余安装各自的版本一并列出。
    const others = (entry.installations ?? []).filter((item) => !item.primary);
    if (!others.length) return main;
    const extra = others.map((item) => `　　· ${item.version ?? '未知版本'}　${item.path}`).join('\n');
    return `${main}\n${extra}`;
  });
  if (result.results.length > limit) lines.push(`… 共 ${result.results.length} 项，此处显示前 ${limit} 项`);
  return `${label}：找到 ${result.foundCount}/${result.count}\n${lines.join('\n')}`;
}

/** 分组快捷入口：TUI 里 /envprobe.<分组> 直接出结果，不用填参数。 */
function presetQueryCommand(group, label) {
  return {
    description: group === 'all' ? '列出全部检测项的检查结果' : `${label}的检查结果`,
    input: presetQueryInput,
    output: checkOutput,
    async run(input, context) {
      const { runProcess, signal, log, print, config = {}, env = process.env } = context;
      const result = await checkTools({ runProcess, signal, log, env, config, input: { ...input, group } });
      await print(summarizeCheck(result, label));
      return result;
    },
  };
}

const plugin = {
  id: PKG.name,
  version: PKG.version,
  sdk: '^0.1.0',
  title: '环境探测',
  description:
    '跨平台环境探测：采集操作系统与内核、Shell、语言运行时与包管理器、容器与 K8s、网卡与 IP、加速设备等环境信息，' +
    '输出结构化的工具路径（paths）与可用性标志（flags），既可直接绑定给其他插件当输入，也可作为工作流的环境检测入口独立调用。' +
    '同时把探测能力发布为 Cordis 共享服务 env.probe，其他插件可在代码里用 getService("env.probe").pathOf("python") 取路径。' +
    '只做探测，不安装、不修改环境。',
  platforms: ['win32', 'linux', 'darwin'],
  architectures: ['x64', 'arm64'],
  config: configSchema,
  defaultConfig: { timeoutMs: 8000, concurrency: 6, cacheTtlSeconds: 300 },

  /**
   * 顺带把探测能力发布为 Cordis 共享服务 env.probe：
   * 其他插件可 getService('env.probe').pathOf('python') 直接取本机路径，无需工作流转参。
   * 只用工作流绑定时用不到它；代价是常驻 TUI/Web 里改本插件配置或装卸插件时，
   * 需要先进入维护模式（CLI 的 plugin add/link/remove/configure 已自动使用管理模式，不受影响）。
   */
  runtime: {
    provides: [SERVICE_NAME],
    apply(ctx, config) {
      const engine = createProbeEngine(config ?? {});
      // 宿主在 ready 阶段调用 apply，此处 set 即完成服务发布；dispose 时清掉探测缓存。
      ctx.on('dispose', () => {
        engine.invalidate();
      });
      ctx.set(SERVICE_NAME, engine);
    },
  },

  commands: {
    'envprobe.detect': { description: '探测当前环境并返回结构化报告', action: 'detect' },
    'envprobe.report': { description: '生成环境报告（Markdown/JSON 文件）', action: 'report' },
    // 任意环境项的直接入口：可以查注册表标识，也可以查任意命令名
    'envprobe.check': { description: '检查任意工具或分组（含未内置的命令名）', action: 'check' },
    'envprobe.list': presetQueryCommand('all', '全部检测项'),
    // 每个检测分组一个快捷入口：/envprobe.network、/envprobe.gpu …
    ...Object.fromEntries(GROUPS.map((group) => [`envprobe.${group.id}`, presetQueryCommand(group.id, group.title)])),
    'envprobe.python': { description: '列出本机所有 Python（路径 / 版本 / 来源）', action: 'pythons' },
    'envprobe.resolve': { description: '解析指定工具的路径与版本', action: 'resolve' },
    'envprobe.verify': { description: '校验环境要求是否满足', action: 'verify' },
    'envprobe.catalog': { description: '列出全部可检测项', action: 'catalog' },
    'envprobe.service': { description: '查看共享服务 env.probe 的状态与缓存', action: 'status' },
    'envprobe.python': { description: '列出本机所有 Python（路径 / 版本 / 来源）', action: 'pythons' },
    'envprobe.which': {
      description: '交互查询某个工具在本机的路径',
      input: emptyInput,
      output: {
        type: 'object',
        title: '工具查询结果',
        additionalProperties: true,
        required: ['id', 'found', 'path', 'version'],
        properties: {
          id: { type: 'string', title: '工具标识' },
          label: { type: 'string', title: '显示名' },
          found: { type: 'boolean', title: '是否可用' },
          path: { type: 'string', title: '路径' },
          version: { type: ['string', 'null'], title: '版本' },
        },
      },
      async run(_input, { ui, signal, log, print, runProcess, config = {}, env = process.env }) {
        const raw = await ui.input('要查询的工具标识（如 python、docker、kubectl、conda）');
        const id = String(raw ?? '').trim();
        if (!id) throw new EnvProbeError('未输入工具标识', { code: 'ENVPROBE_INPUT' });
        signal?.throwIfAborted();
        const result = await resolveTools({
          runProcess,
          signal,
          log,
          env,
          config,
          input: { tools: [{ id, required: false }] },
        });
        const entry = result.tools[id] ?? { id, found: false, path: '', version: null };
        if (entry.found) {
          await print(`${entry.label ?? id}：${entry.path}${entry.version ? `（${entry.version}）` : ''}`);
        } else {
          await print(`未找到 ${id}${entry.error ? `：${entry.error}` : ''}`);
        }
        return {
          id,
          label: entry.label ?? id,
          found: !!entry.found,
          path: entry.path ?? '',
          version: entry.version ?? null,
        };
      },
    },
  },

  actions: {
    detect: {
      title: '探测当前环境',
      description:
        '采集系统、Shell、工具链、网络、容器/K8s、加速设备与环境变量；结果里的 paths 字段可直接绑定给其他插件需要路径的输入。' +
        '只做探测，不安装或修改任何环境。',
      input: detectInput,
      output: detectOutput,
      conditions: {
        pythonAvailable: { title: '找到 Python', path: 'paths.python', op: 'exists' },
        nodeAvailable: { title: '找到 Node.js', path: 'paths.node', op: 'exists' },
        condaAvailable: { title: '找到 conda', path: 'paths.conda', op: 'exists' },
        gitAvailable: { title: '找到 Git', path: 'paths.git', op: 'exists' },
        dockerAvailable: { title: '找到 docker', path: 'flags.docker', op: 'eq', value: true },
        kubectlAvailable: { title: '找到 kubectl', path: 'flags.kubectl', op: 'eq', value: true },
        kubeconfigFound: { title: '存在 kubeconfig', path: 'flags.kubeconfig', op: 'eq', value: true },
        gpuDetected: { title: '检测到加速设备', path: 'flags.gpu', op: 'eq', value: true },
        npuDetected: { title: '检测到昇腾 NPU', path: 'flags.npu', op: 'eq', value: true },
        containerDaemonUp: { title: '容器守护进程可用', path: 'flags.containerDaemon', op: 'eq', value: true },
      },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env, outputDir } = context;
        const report = await runDetection({ runProcess, signal, env, config, input, log });
        const target = await withSnapshot(report, { ...context, env, cwd: outputDir ?? process.cwd() }, input);
        if (target) {
          report.snapshotPath = target;
          await print('已写入环境快照', { file: target });
        }
        await print(summarize(report));
        return report;
      },
    },

    resolve: {
      title: '解析工具路径',
      description:
        '按工具标识（可带候选命令名与版本范围）解析绝对路径和实际版本，返回的 paths 可直接绑定到其他插件；必需项缺失时 ok 为 false 而不是抛错。',
      input: resolveInput,
      output: resolveOutput,
      conditions: { allFound: { title: '全部解析成功', path: 'ok', op: 'eq', value: true } },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env } = context;
        const result = await resolveTools({ runProcess, signal, log, env, config, input });
        const found = Object.keys(result.paths).length;
        if (result.ok) await print(`已解析 ${found} 个工具路径`);
        else {
          const missing = [...result.requiredMissing, ...result.unsatisfied];
          await print(`环境不满足：${missing.length ? missing.join('、') : '未知原因'}`, { missing: result.missing });
        }
        return result;
      },
    },

    verify: {
      title: '校验环境要求',
      description: '逐项校验工具是否存在、版本是否落在要求范围内、附加子命令是否可执行；返回 ok 与逐项明细，供工作流条件分支判断。',
      input: verifyInput,
      output: verifyOutput,
      conditions: { passed: { title: '环境要求全部满足', path: 'ok', op: 'eq', value: true } },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env } = context;
        const result = await verifyRequirements({ runProcess, signal, log, env, config, input });
        if (result.ok) await print(`环境校验通过（${result.passed} 项）`);
        else await print(`环境校验未通过：${result.failed}/${result.checks.length} 项不满足`);
        return result;
      },
    },

    report: {
      title: '生成环境报告',
      description:
        '执行完整探测并写出 Markdown 与 JSON 报告到本次运行的结果目录；返回值同时携带 paths 与 flags，便于在同一流程里继续给其他插件取路径。',
      input: reportInput,
      output: reportOutput,
      conditions: {
        reportReady: { title: '报告已生成', path: 'ok', op: 'eq', value: true },
        pythonAvailable: { title: '找到 Python', path: 'paths.python', op: 'exists' },
        gpuDetected: { title: '检测到加速设备', path: 'flags.gpu', op: 'eq', value: true },
      },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env, outputDir } = context;
        const report = await runDetection({ runProcess, signal, env, config, input, log });
        const directory = outputDir ?? process.cwd();
        const target = await withSnapshot(report, { ...context, env, cwd: directory }, input);
        if (target) report.snapshotPath = target;

        const markdown = renderMarkdown(report);
        const base = (input.fileBase || 'environment').replace(/[^\w.-]+/g, '-');
        const format = input.format ?? 'both';
        const files = {};
        if (format !== 'json') {
          signal?.throwIfAborted();
          files.markdown = path.join(directory, `${base}-report.md`);
          await writeFile(files.markdown, markdown, 'utf8');
        }
        if (format !== 'markdown') {
          signal?.throwIfAborted();
          files.json = path.join(directory, `${base}-report.json`);
          await writeFile(files.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
        const result = {
          ok: true,
          generatedAt: report.generatedAt,
          files,
          summary: report.summary,
          warnings: report.warnings,
          paths: report.paths,
          flags: report.flags,
          durationMs: report.durationMs,
        };
        if (input.includeMarkdown !== false) result.markdown = markdown;
        if (report.snapshotPath) result.snapshotPath = report.snapshotPath;
        await print(`环境报告已生成：${summarize(report)}`, files);
        return result;
      },
    },

    check: {
      title: '检查任意环境项',
      description:
        '按工具标识或命令名检查任意工具（含未内置的内网 CLI），或按分组列出整套检测项；' +
        '返回路径、真实路径（解析符号链接）、版本、来源与全部候选路径。扫描范围会在 scan 里说明，' +
        '跳过了哪些远程挂载点、哪些目录超时都写在 warnings 里，不会静默少给。',
      input: checkInput,
      output: checkOutput,
      conditions: { allFound: { title: '检查项全部可用', path: 'ok', op: 'eq', value: true } },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env } = context;
        const result = await checkTools({ runProcess, signal, log, env, config, input });
        const label = typeof input.group === 'string' && input.group ? `分组 ${input.group}` : '检查';
        await print(summarizeCheck(result, label));
        return result;
      },
    },

    pythons: {
      title: '列出本机所有 Python',
      description:
        '枚举 PATH、Windows py 启动器登记的版本与 conda 环境里的全部 Python，返回路径、真实路径（解析符号链接）、版本、来源与是否默认。' +
        '有多个就全部列出；primary 字段可直接绑定给需要解释器路径的插件。',
      input: pythonsInput,
      output: pythonsOutput,
      conditions: { found: { title: '找到 Python', path: 'ok', op: 'eq', value: true } },
      async run(input, context) {
        const { runProcess, signal, log, print, config = {}, env = process.env } = context;
        const result = await listPythons({ runProcess, signal, log, env, config, input });
        if (result.count) {
          const lines = result.pythons.map((entry) => {
            const kind = entry.kind === 'launcher' ? '（启动器）' : entry.kind === 'conda-env' ? '（conda 环境）' : '';
            const mark = entry.default ? ' ← 默认' : '';
            return `· ${entry.version ?? '未知版本'}　${entry.path}${kind}${mark}`;
          });
          await print(`找到 ${result.count} 个 Python：\n${lines.join('\n')}`);
        } else {
          await print('未找到任何 Python');
        }
        return result;
      },
    },

    status: {
      title: '查看共享服务状态',
      description: '报告 env.probe 服务的缓存有效期、已缓存结果数，以及当前可检测的工具与分组数量。',
      input: emptyInput,
      output: serviceStatusOutput,
      conditions: { ready: { title: '服务已就绪', path: 'ready', op: 'eq', value: true } },
      async run(_input, context) {
        const { getService, print } = context;
        const engine = getService(SERVICE_NAME);
        const cache = engine.cacheInfo();
        const catalog = engine.catalog();
        const result = {
          service: SERVICE_NAME,
          ready: true,
          ttlSeconds: cache.ttlSeconds,
          cachedResults: cache.entries.length,
          toolCount: catalog.tools.length,
          groupCount: catalog.groups.length,
          cachedKeys: cache.entries.map((entry) => entry.key),
        };
        await print(
          `env.probe 已就绪：可检测 ${result.toolCount} 个工具、${result.groupCount} 个分组；` +
            `缓存 ${result.cachedResults} 份结果（有效期 ${result.ttlSeconds} 秒）`,
        );
        return result;
      },
    },

    catalog: {
      title: '列出可检测项',
      description: '列出当前插件能够检测的分组与工具（含自定义探测器），便于选择 toolIds 或确认某个工具是否在支持范围内。',
      input: emptyInput,
      output: catalogOutput,
      async run(_input, { config = {}, print }) {
        const summary = catalogSummary(config);
        const result = {
          ...summary,
          toolCount: summary.tools.length,
          groupCount: summary.groups.length,
        };
        await print(`可检测项：${result.groupCount} 个分组、${result.toolCount} 个工具`);
        return result;
      },
    },
  },
};

export default plugin;
export { TOOLS, GROUP_IDS };
