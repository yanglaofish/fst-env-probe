// 输入输出 JSON Schema：paths / flags / tools 的键从探测器注册表派生，
// 这样工作流的字段选择器与条件预设都能看到具体工具，同时保留额外键的容错。
import { GROUPS, GROUP_IDS, TOOLS, TOOL_IDS } from './catalog.js';

const AGGREGATE_FLAGS = [
  'python',
  'node',
  'git',
  'shell',
  'packageManager',
  'containerRuntime',
  'kubernetes',
  'accelerator',
  'gpu',
  'npu',
  'kubeconfig',
  'containerDaemon',
  'probeFailed',
  'incompleteScan',
];

const toolTitles = Object.fromEntries(TOOLS.map((tool) => [tool.id, tool.title]));

const pathsSchema = {
  type: 'object',
  title: '工具路径',
  description: '仅包含实际找到的工具；可直接绑定到其他插件需要路径的输入字段，例如 steps.detect.output.paths.python',
  additionalProperties: { type: 'string' },
  properties: Object.fromEntries(
    TOOL_IDS.map((id) => [
      id,
      { type: 'string', title: `${toolTitles[id] ?? id} 路径`, description: `找到的 ${toolTitles[id] ?? id} 可执行文件绝对路径` },
    ]),
  ),
};

const flagsSchema = {
  type: 'object',
  title: '可用性标志',
  description: '每个工具标识对应一个布尔值，另含聚合标志；适合在条件分支中判断',
  additionalProperties: { type: 'boolean' },
  properties: Object.fromEntries(
    [...new Set([...TOOL_IDS, ...AGGREGATE_FLAGS])].map((id) => [id, { type: 'boolean', title: toolTitles[id] ?? id }]),
  ),
};

const toolsSchema = {
  type: 'object',
  title: '工具明细',
  description: '键为工具标识，值为该工具的检测明细',
  additionalProperties: { type: 'object', additionalProperties: true },
  properties: {},
};

const summarySchema = {
  type: 'object',
  title: '汇总',
  additionalProperties: true,
  properties: {
    groupCount: { type: 'integer', title: '采集分组数' },
    groupFailed: { type: 'integer', title: '失败分组数' },
    toolsChecked: { type: 'integer', title: '检测工具数' },
    toolsFound: { type: 'integer', title: '找到工具数' },
    toolsVersioned: { type: 'integer', title: '识别出版本数' },
    pathCount: { type: 'integer', title: '可用路径数' },
    adapterCount: { type: 'integer', title: '网卡数' },
    gpuCount: { type: 'integer', title: '加速设备数' },
    pythonCount: { type: 'integer', title: 'Python 解释器数' },
    condaEnvCount: { type: 'integer', title: 'conda 环境数' },
    kubernetesContexts: { type: 'integer', title: 'K8s 上下文数' },
    warningCount: { type: 'integer', title: '告警数' },
  },
};

const groupsSchema = {
  type: 'array',
  title: '采集分组明细',
  items: {
    type: 'object',
    required: ['id', 'title', 'ok', 'durationMs', 'error'],
    additionalProperties: true,
    properties: {
      id: { type: 'string', title: '分组' },
      title: { type: 'string', title: '名称' },
      ok: { type: 'boolean', title: '采集成功' },
      durationMs: { type: 'number', title: '耗时（毫秒）' },
      error: { type: 'string', title: '错误' },
    },
  },
};

const warningsSchema = { type: 'array', title: '告警', items: { type: 'string' } };

const errorsSchema = {
  type: 'array',
  title: '采集失败明细',
  description: '按分组记录采集失败原因；非空时 ok 为 false、flags.probeFailed 为 true',
  items: {
    type: 'object',
    required: ['id', 'title', 'message'],
    additionalProperties: true,
    properties: {
      id: { type: 'string', title: '分组' },
      title: { type: 'string', title: '名称' },
      message: { type: 'string', title: '失败原因' },
    },
  },
};

const detectInputProperties = {
  groups: {
    type: 'array',
    title: '检测分组',
    description: '留空表示按插件配置检测全部分组',
    uniqueItems: true,
    items: { type: 'string', enum: GROUP_IDS },
  },
  toolIds: {
    type: 'array',
    title: '只检测指定工具',
    description: '给出后只解析这些工具，并跳过系统/网络等重采集',
    uniqueItems: true,
    items: { type: 'string' },
  },
  deep: {
    type: 'boolean',
    title: '深度检测',
    default: false,
    description: '逐个解释器取版本、列出工具的全部命中路径、开启 ROCm 详情',
  },
  // 这两个不设 default：否则宿主会先填默认值，使插件配置里的设置永远失效。
  timeoutMs: {
    type: 'integer',
    title: '单项超时（毫秒）',
    minimum: 1000,
    maximum: 60000,
    description: '留空则使用插件配置的 timeoutMs',
  },
  concurrency: {
    type: 'integer',
    title: '并发数',
    minimum: 1,
    maximum: 16,
    description: '留空则使用插件配置的 concurrency',
  },
  extraPaths: { type: 'array', title: '额外搜索目录', items: { type: 'string' } },
  refresh: { type: 'boolean', title: '忽略目录缓存', default: false },
  snapshot: {
    type: 'boolean',
    title: '写入快照文件',
    default: false,
    description:
      '写入插件的跨运行状态目录（宿主的 stateDir，通常是 <项目>/.flow/plugin-state/<插件ID摘要>/environment-latest.json）；实际路径见返回值 snapshotPath',
  },
  snapshotPath: { type: 'string', title: '快照文件路径', description: '留空则使用插件配置或默认位置' },
};

export const detectInput = {
  type: 'object',
  title: '检测参数',
  additionalProperties: false,
  properties: detectInputProperties,
};

export const detectOutput = {
  type: 'object',
  title: '环境检测报告',
  additionalProperties: true,
  required: [
    'ok',
    'schemaVersion',
    'generatedAt',
    'platformTarget',
    'platform',
    'hardware',
    'shells',
    'tools',
    'paths',
    'flags',
    'containers',
    'inventory',
    'network',
    'gpu',
    'env',
    'groups',
    'warnings',
    'errors',
    'scan',
    'summary',
    'durationMs',
  ],
  properties: {
    ok: { type: 'boolean', title: '检测完成' },
    schemaVersion: { type: 'integer', title: '报告格式版本' },
    generatedAt: { type: 'string', title: '生成时间' },
    platformTarget: { type: 'string', title: '平台目标标识', description: '例如 win32-x64 或 linux-x64-glibc，与打包目标一致' },
    platform: {
      type: ['object', 'null'],
      title: '系统与主机',
      additionalProperties: true,
      properties: {
        os: { type: 'string', title: '操作系统类型' },
        osName: { type: 'string', title: '操作系统' },
        release: { type: 'string', title: '内核版本' },
        kernel: { type: 'string', title: '内核' },
        version: { type: 'string', title: '内核描述' },
        arch: { type: 'string', title: '架构' },
        hostname: { type: 'string', title: '主机名' },
        user: { type: 'string', title: '当前用户' },
        home: { type: 'string', title: '用户目录' },
        uptimeSeconds: { type: 'number', title: '运行时长（秒）' },
        timezone: { type: 'string', title: '时区' },
        distro: { type: 'object', title: '发行版', additionalProperties: true },
      },
    },
    hardware: {
      type: ['object', 'null'],
      title: '硬件',
      additionalProperties: true,
      properties: {
        cpu: { type: 'object', title: 'CPU', additionalProperties: true },
        memory: { type: 'object', title: '内存', additionalProperties: true },
        disks: { type: 'array', title: '磁盘', items: { type: 'object', additionalProperties: true } },
      },
    },
    shells: {
      type: ['object', 'null'],
      title: 'Shell 环境',
      additionalProperties: true,
      properties: {
        default: { type: 'string', title: '默认 shell' },
        available: { type: 'array', title: '可用 shell', items: { type: 'object', additionalProperties: true } },
        gitBash: { type: ['object', 'null'], title: 'Git Bash', additionalProperties: true },
        wsl: { type: ['object', 'null'], title: 'WSL', additionalProperties: true },
        warnings: warningsSchema,
      },
    },
    tools: toolsSchema,
    paths: pathsSchema,
    flags: flagsSchema,
    containers: {
      type: ['object', 'null'],
      title: '容器与 K8s',
      additionalProperties: true,
      properties: {
        engines: { type: 'array', title: '容器引擎', items: { type: 'object', additionalProperties: true } },
        engineCount: { type: 'integer', title: '引擎数' },
        k8s: { type: ['object', 'null'], title: 'K8s 上下文', additionalProperties: true },
      },
    },
    inventory: {
      type: ['object', 'null'],
      title: '语言与包环境',
      additionalProperties: true,
      properties: {
        pythons: { type: 'array', title: 'Python 解释器', items: { type: 'object', additionalProperties: true } },
        pythonCount: { type: 'integer', title: '解释器数' },
        conda: { type: ['object', 'null'], title: 'conda', additionalProperties: true },
      },
    },
    network: {
      type: ['object', 'null'],
      title: '网络',
      additionalProperties: true,
      properties: {
        hostname: { type: 'string', title: '主机名' },
        adapters: { type: 'array', title: '网卡', items: { type: 'object', additionalProperties: true } },
        adapterCount: { type: 'integer', title: '网卡数' },
        gateways: { type: 'array', title: '网关', items: { type: 'string' } },
        dnsServers: { type: 'array', title: 'DNS', items: { type: 'string' } },
        primary: { type: 'object', title: '主地址', additionalProperties: true },
        proxies: { type: 'object', title: '代理', additionalProperties: true },
      },
    },
    gpu: {
      type: ['object', 'null'],
      title: '加速设备',
      additionalProperties: true,
      properties: {
        devices: { type: 'array', title: '设备', items: { type: 'object', additionalProperties: true } },
        deviceCount: { type: 'integer', title: '设备数' },
        vendors: { type: 'array', title: '厂商', items: { type: 'string' } },
      },
    },
    env: {
      type: ['object', 'null'],
      title: '环境变量',
      additionalProperties: true,
      properties: {
        selected: { type: 'object', title: '关键变量', additionalProperties: { type: 'string' } },
        pathEntries: { type: 'array', title: 'PATH 条目', items: { type: 'string' } },
        pathEntryCount: { type: 'integer', title: 'PATH 条目数' },
        pathDuplicates: { type: 'array', title: '重复的 PATH 条目', items: { type: 'string' } },
      },
    },
    groups: groupsSchema,
    warnings: warningsSchema,
    errors: errorsSchema,
    scan: {
      type: 'object',
      title: '扫描范围',
      description: '本次扫描读了哪些目录、跳过了哪些远程挂载点、哪些目录超时；用于判断"没检测到"是不是因为没能查',
      additionalProperties: true,
      properties: {
        directories: { type: 'integer', title: '读取的目录数' },
        cacheHits: { type: 'integer', title: '目录缓存命中' },
        allowRemoteMounts: { type: 'boolean', title: '是否允许扫描远程挂载' },
        remoteMounts: { type: 'array', title: '识别到的远程挂载点', items: { type: 'object', additionalProperties: true } },
        skippedRemote: { type: 'array', title: '跳过的远程挂载点', items: { type: 'string' } },
        timedOut: { type: 'array', title: '读取超时的目录', items: { type: 'string' } },
      },
    },
    summary: summarySchema,
    durationMs: { type: 'number', title: '耗时（毫秒）' },
    snapshotPath: { type: 'string', title: '快照文件' },
  },
};

const runtimeInputProperties = {
  deep: { type: 'boolean', title: '深度检测', default: true, description: '是否运行版本命令确认实际版本' },
  timeoutMs: {
    type: 'integer',
    title: '单项超时（毫秒）',
    minimum: 1000,
    maximum: 60000,
    description: '留空则使用插件配置的 timeoutMs',
  },
  concurrency: {
    type: 'integer',
    title: '并发数',
    minimum: 1,
    maximum: 16,
    description: '留空则使用插件配置的 concurrency',
  },
  extraPaths: { type: 'array', title: '额外搜索目录', items: { type: 'string' } },
  refresh: { type: 'boolean', title: '忽略目录缓存', default: false },
};

export const resolveInput = {
  type: 'object',
  title: '解析参数',
  additionalProperties: false,
  required: ['tools'],
  properties: {
    tools: {
      type: 'array',
      title: '需要的工具',
      description: '字符串或对象；对象可给出候选命令名、版本范围与是否必需',
      minItems: 1,
      items: {
        oneOf: [
          { type: 'string', title: '工具标识' },
          {
            type: 'object',
            title: '工具请求',
            required: ['id'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', title: '工具标识' },
              names: { type: 'array', title: '候选命令名', description: '留空则使用内置清单', items: { type: 'string' } },
              version: { type: 'string', title: '版本范围', description: '例如 >=3.10、^20、~1.2' },
              required: { type: 'boolean', title: '必需', default: true, description: '缺失时判定为解析失败' },
              label: { type: 'string', title: '显示名' },
            },
          },
        ],
      },
    },
    ...runtimeInputProperties,
  },
};

export const resolveOutput = {
  type: 'object',
  title: '解析结果',
  additionalProperties: true,
  required: ['ok', 'missing', 'unsatisfied', 'requiredMissing', 'paths', 'tools', 'resolvedAt'],
  properties: {
    ok: { type: 'boolean', title: '全部满足' },
    missing: { type: 'array', title: '未找到', items: { type: 'string' } },
    unsatisfied: { type: 'array', title: '版本不满足', items: { type: 'string' } },
    requiredMissing: { type: 'array', title: '必需的缺失项', items: { type: 'string' } },
    paths: {
      type: 'object',
      title: '工具路径',
      description: '键为请求的工具标识；可直接绑定到其他插件需要路径的输入字段',
      additionalProperties: { type: 'string' },
      properties: {},
    },
    tools: toolsSchema,
    resolvedAt: { type: 'string', title: '解析时间' },
  },
};

export const verifyInput = {
  type: 'object',
  title: '校验参数',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      title: '环境要求',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', title: '工具标识' },
          label: { type: 'string', title: '显示名' },
          version: { type: 'string', title: '版本范围', description: '例如 >=3.10、^20、~1.2' },
          names: { type: 'array', title: '候选命令名', items: { type: 'string' } },
          command: { type: 'string', title: '附加子命令', description: '例如 version、--list-sdks；执行失败即判定不通过' },
          args: { type: 'array', title: '子命令参数', items: { type: 'string' } },
        },
      },
    },
    ...runtimeInputProperties,
  },
};

export const verifyOutput = {
  type: 'object',
  title: '校验结果',
  additionalProperties: true,
  required: ['ok', 'checkedAt', 'passed', 'failed', 'checks', 'missing', 'paths', 'tools'],
  properties: {
    ok: { type: 'boolean', title: '全部满足' },
    checkedAt: { type: 'string', title: '校验时间' },
    passed: { type: 'integer', title: '通过项' },
    failed: { type: 'integer', title: '未通过项' },
    checks: {
      type: 'array',
      title: '检查明细',
      items: {
        type: 'object',
        required: ['id', 'label', 'status', 'found', 'path', 'version', 'expected', 'message'],
        additionalProperties: true,
        properties: {
          id: { type: 'string', title: '工具标识' },
          label: { type: 'string', title: '显示名' },
          status: {
            type: 'string',
            title: '状态',
            enum: ['ok', 'missing', 'version_mismatch', 'unknown_version', 'invalid_range', 'command_failed', 'command_skipped'],
          },
          found: { type: 'boolean', title: '已找到' },
          path: { type: 'string', title: '路径' },
          version: { type: ['string', 'null'], title: '实际版本' },
          expected: { type: 'string', title: '要求' },
          message: { type: 'string', title: '说明' },
        },
      },
    },
    missing: { type: 'array', title: '缺失项', items: { type: 'string' } },
    paths: {
      type: 'object',
      title: '工具路径',
      additionalProperties: { type: 'string' },
      properties: {},
    },
    tools: toolsSchema,
  },
};

export const reportInput = {
  type: 'object',
  title: '报告参数',
  additionalProperties: false,
  properties: {
    ...detectInputProperties,
    format: { type: 'string', title: '输出格式', enum: ['markdown', 'json', 'both'], default: 'both' },
    includeMarkdown: { type: 'boolean', title: '返回值包含 Markdown 正文', default: true },
    fileBase: { type: 'string', title: '文件名前缀', default: 'environment' },
  },
};

export const reportOutput = {
  type: 'object',
  title: '报告结果',
  additionalProperties: true,
  required: ['ok', 'generatedAt', 'files', 'summary', 'warnings', 'paths', 'flags'],
  properties: {
    ok: { type: 'boolean', title: '采集成功', description: '报告文件仍会生成；采集失败时为 false，详见 errors' },
    generatedAt: { type: 'string', title: '生成时间' },
    files: {
      type: 'object',
      title: '生成的文件',
      additionalProperties: false,
      properties: {
        markdown: { type: 'string', title: 'Markdown 报告' },
        json: { type: 'string', title: 'JSON 报告' },
      },
    },
    markdown: { type: 'string', title: 'Markdown 正文' },
    summary: summarySchema,
    warnings: warningsSchema,
    errors: errorsSchema,
    paths: pathsSchema,
    scan: detectOutput.properties.scan,
    flags: flagsSchema,
    snapshotPath: { type: 'string', title: '快照文件' },
    durationMs: { type: 'number', title: '耗时（毫秒）' },
  },
};

export const checkInput = {
  type: 'object',
  title: '环境检查参数',
  additionalProperties: false,
  properties: {
    tool: {
      title: '要检查的工具',
      description: '注册表标识（docker、kubectl、python…）或任意命令名（含未内置的内网工具）；可给一个或多个。留空则按 group 列出',
      oneOf: [
        { type: 'string', title: '单个工具' },
        { type: 'array', title: '多个工具', items: { type: 'string' } },
      ],
    },
    group: {
      type: 'string',
      title: '按分组列出',
      enum: [...GROUP_IDS, 'all'],
      description: '列出该分组下全部检测项；all 表示全部',
    },
    candidates: {
      type: 'boolean',
      title: '列出全部命中路径',
      default: true,
      description: '同一个命令在多个目录都有时，全部列出（例如多个 Python）',
    },
    includeVersion: { type: 'boolean', title: '探测版本', default: true },
    timeoutMs: {
      type: 'integer',
      title: '单项超时（毫秒）',
      minimum: 1000,
      maximum: 60000,
      description: '留空则使用插件配置的 timeoutMs',
    },
    concurrency: {
      type: 'integer',
      title: '并发数',
      minimum: 1,
      maximum: 16,
      description: '留空则使用插件配置的 concurrency',
    },
    refresh: { type: 'boolean', title: '忽略目录缓存', default: false },
    extraPaths: { type: 'array', title: '额外搜索目录', items: { type: 'string' } },
    allowRemoteMounts: { type: 'boolean', title: '允许扫描远程挂载点', description: '留空则使用插件配置，默认跳过远程目录' },
  },
};

export const checkOutput = {
  type: 'object',
  title: '环境检查结果',
  additionalProperties: true,
  required: ['ok', 'count', 'foundCount', 'results', 'missing', 'warnings'],
  properties: {
    ok: { type: 'boolean', title: '检查项全部可用' },
    count: { type: 'integer', title: '检查项数' },
    foundCount: { type: 'integer', title: '找到数' },
    results: {
      type: 'array',
      title: '检查明细',
      items: {
        type: 'object',
        required: ['id', 'title', 'found', 'path', 'candidates'],
        additionalProperties: true,
        properties: {
          id: { type: 'string', title: '标识' },
          title: { type: 'string', title: '名称' },
          group: { type: 'string', title: '分组' },
          found: { type: 'boolean', title: '是否可用' },
          path: { type: 'string', title: '路径' },
          realPath: { type: 'string', title: '真实路径', description: '解析符号链接后' },
          version: { type: ['string', 'null'], title: '版本' },
          versionRaw: { type: 'string', title: '版本原始输出' },
          source: { type: 'string', title: '来源', description: 'PATH / known / configured / explicit' },
          candidates: { type: 'array', title: '全部命中路径', items: { type: 'string' } },
          installations: {
            type: 'array',
            title: '每个安装及其版本',
            description: '同一个命令的每个安装位置（含 PATH 之外的多版本安装），各自带上版本',
            items: {
              type: 'object',
              required: ['path', 'version', 'source'],
              additionalProperties: true,
              properties: {
                path: { type: 'string', title: '路径' },
                realPath: { type: 'string', title: '真实路径' },
                version: { type: ['string', 'null'], title: '版本' },
                source: { type: 'string', title: '来源', description: 'PATH / known / configured / installation' },
                shim: { type: 'boolean', title: '是商店别名' },
                primary: { type: 'boolean', title: '是否首要命中' },
                error: { type: 'string', title: '说明' },
              },
            },
          },
          shim: { type: 'boolean', title: '是商店别名' },
          error: { type: 'string', title: '说明' },
          note: { type: 'string', title: '备注' },
        },
      },
    },
    missing: { type: 'array', title: '未找到', items: { type: 'string' } },
    paths: {
      type: 'object',
      title: '可用路径',
      description: '找到的项映射到路径，与 detect 的 paths 用法一致',
      additionalProperties: { type: 'string' },
      properties: {},
    },
    scan: { type: 'object', title: '扫描范围', additionalProperties: true },
    warnings: warningsSchema,
  },
};

export const pythonsInput = {
  type: 'object',
  title: 'Python 枚举参数',
  additionalProperties: false,
  properties: {
    includeVersions: {
      type: 'boolean',
      title: '获取每个解释器的版本',
      default: true,
      description: '关闭时不运行 Python 版本命令，可更快返回路径清单',
    },
    includeConda: { type: 'boolean', title: '包含 conda 环境', default: true },
    refresh: { type: 'boolean', title: '忽略目录缓存', default: false },
    extraPaths: { type: 'array', title: '额外搜索目录', items: { type: 'string' } },
    allowRemoteMounts: { type: 'boolean', title: '允许扫描远程挂载点', description: '留空则使用插件配置，默认跳过远程目录' },
    timeoutMs: {
      type: 'integer',
      title: '单项超时（毫秒）',
      minimum: 1000,
      maximum: 60000,
      description: '留空则使用插件配置的 timeoutMs',
    },
  },
};

export const pythonsOutput = {
  type: 'object',
  title: 'Python 清单',
  additionalProperties: true,
  required: ['ok', 'count', 'pythons', 'warnings'],
  properties: {
    ok: { type: 'boolean', title: '是否找到 Python' },
    count: { type: 'integer', title: '总数（含启动器）' },
    pythons: {
      type: 'array',
      title: 'Python 列表',
      items: {
        type: 'object',
        required: ['path', 'kind', 'available', 'default'],
        additionalProperties: true,
        properties: {
          path: { type: 'string', title: '路径' },
          realPath: { type: 'string', title: '真实路径', description: '解析符号链接后的路径，启动器常是软链' },
          version: { type: ['string', 'null'], title: '版本' },
          source: { type: 'string', title: '来源', description: 'PATH / known / conda / py 启动器 / 主解释器' },
          kind: { type: 'string', title: '类型', enum: ['interpreter', 'launcher', 'conda-env'] },
          label: { type: 'string', title: '说明' },
          available: { type: 'boolean', title: '路径可访问' },
          default: { type: 'boolean', title: '默认或当前活跃' },
        },
      },
    },
    primary: {
      type: ['string', 'null'],
      title: '主解释器路径',
      description: '可直接绑定给其他插件需要解释器路径的输入字段',
    },
    primaryVersion: { type: ['string', 'null'], title: '主解释器版本' },
    launchers: { type: 'array', title: '启动器', items: { type: 'object', additionalProperties: true } },
    conda: { type: ['object', 'null'], title: 'conda 环境', additionalProperties: true },
    skippedRemote: { type: 'array', title: '跳过的远程挂载点', items: { type: 'string' } },
    timedOut: { type: 'array', title: '读取超时的目录', items: { type: 'string' } },
    warnings: warningsSchema,
  },
};

export const catalogOutput = {  type: 'object',
  title: '可检测项清单',
  additionalProperties: true,
  required: ['groups', 'tools', 'toolCount', 'groupCount'],
  properties: {
    groups: { type: 'array', title: '分组', items: { type: 'object', additionalProperties: true } },
    tools: { type: 'array', title: '工具', items: { type: 'object', additionalProperties: true } },
    toolCount: { type: 'integer', title: '工具数' },
    groupCount: { type: 'integer', title: '分组数' },
    rejectedCount: { type: 'integer', title: '被忽略的自定义探测器数' },
  },
};

export const groupTitles = Object.fromEntries(GROUPS.map((group) => [group.id, group.title]));
