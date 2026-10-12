import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import plugin from '../index.js';
import { catalogSummary, checkTools, listPythons, resolveGroups, resolveSnapshotPath, resolveTools, runDetection, verifyRequirements } from '../lib/detect.js';
import { renderMarkdown, summarize } from '../lib/render.js';
import { createFallbackRunProcess } from '../lib/run-process.js';
import { EnvProbeError } from '../lib/errors.js';
import { GROUP_IDS, GROUPS, TOOL_IDS } from '../lib/catalog.js';

const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];

// 复刻宿主 contracts.js 对判定预设路径的检查，提前发现"引用了未声明字段"。
function resolveSchemaPath(schema, fieldPath) {
  let current = schema;
  for (const part of fieldPath.split('.')) {
    if (current?.properties && Object.hasOwn(current.properties, part)) current = current.properties[part];
    else if (current?.type === 'array' && /^\d+$/.test(part)) current = current.items;
    else throw new Error(`未声明的输出字段：${fieldPath}`);
  }
  return current;
}

test('插件元数据符合宿主约定', () => {
  assert.equal(plugin.id, 'fishtools-env-probe');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.sdk, '^0.1.0');
  assert.ok(plugin.title && plugin.description);
  assert.deepEqual(plugin.platforms, ['win32', 'linux', 'darwin']);
});

test('每个动作都声明了 input/output 与 run', () => {
  const names = Object.keys(plugin.actions);
  assert.ok(names.includes('detect'));
  assert.ok(names.includes('resolve'));
  assert.ok(names.includes('verify'));
  assert.ok(names.includes('report'));
  assert.ok(names.includes('catalog'));
  for (const [name, action] of Object.entries(plugin.actions)) {
    assert.equal(typeof action.run, 'function', `${name} 缺少 run`);
    assert.ok(action.title, `${name} 缺少 title`);
    assert.ok(action.input && typeof action.input === 'object', `${name} 缺少 input schema`);
    assert.ok(action.output && typeof action.output === 'object', `${name} 缺少 output schema`);
  }
});

test('命令名称与指向合法', () => {
  const seen = new Set();
  for (const [name, command] of Object.entries(plugin.commands)) {
    assert.match(name, /^[a-zA-Z][\w.-]*$/, `命令名非法：${name}`);
    assert.ok(!seen.has(name));
    seen.add(name);
    const hasAction = typeof command.action === 'string';
    const hasRun = typeof command.run === 'function';
    assert.notEqual(hasAction, hasRun, `${name} 必须且只能声明 action 或 run`);
    if (hasAction) assert.ok(plugin.actions[command.action], `${name} 指向不存在的动作 ${command.action}`);
  }
});

test('条件预设的路径与操作符都合法', () => {
  for (const [actionName, action] of Object.entries(plugin.actions)) {
    for (const [key, preset] of Object.entries(action.conditions ?? {})) {
      assert.ok(preset.title, `${actionName}.${key} 缺少标题`);
      assert.ok(OPERATORS.includes(preset.op), `${actionName}.${key} 操作符非法`);
      if (preset.op !== 'exists') assert.ok(Object.hasOwn(preset, 'value'), `${actionName}.${key} 缺少比较值`);
      assert.doesNotThrow(() => resolveSchemaPath(action.output, preset.path), `${actionName}.${key} 引用了未声明字段`);
    }
  }
});

test('配置 schema 只包含可公开默认值', () => {
  assert.ok(plugin.config);
  for (const key of Object.keys(plugin.defaultConfig ?? {})) {
    assert.ok(Object.hasOwn(plugin.config.properties, key), `defaultConfig 里的 ${key} 未在 config schema 中声明`);
  }
});

test('paths 与 flags 覆盖全部内置工具', () => {
  const paths = plugin.actions.detect.output.properties.paths.properties;
  const flags = plugin.actions.detect.output.properties.flags.properties;
  for (const id of TOOL_IDS) {
    assert.ok(Object.hasOwn(paths, id), `paths 缺少 ${id}`);
    assert.ok(Object.hasOwn(flags, id), `flags 缺少 ${id}`);
  }
  assert.ok(paths.python);
  assert.ok(flags.gpu);
  assert.ok(flags.npu);
});

test('分组解析：默认全部、可裁剪、非法值报错', () => {
  const all = resolveGroups({}, {});
  assert.equal(all.size, GROUP_IDS.length);
  const narrowed = resolveGroups({ groups: ['shell', 'gpu'] }, {});
  assert.deepEqual([...narrowed], ['shell', 'gpu']);
  const configOff = resolveGroups({}, { groups: { gpu: false } });
  assert.equal(configOff.has('gpu'), false);
  const explicitWins = resolveGroups({ groups: ['gpu'] }, { groups: { gpu: false } });
  assert.equal(explicitWins.has('gpu'), true);
  assert.throws(() => resolveGroups({ groups: ['nope'] }, {}), EnvProbeError);
});

test('轻量解析：只点名工具时不跑重采集', async () => {
  const runProcess = createFallbackRunProcess();
  const report = await runDetection({ runProcess, config: {}, input: { toolIds: ['node'] } });
  assert.equal(report.ok, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.platform, null, '只点名工具时不应采集系统信息');
  assert.equal(report.network, null);
  assert.equal(report.gpu, null);
  assert.ok(report.paths.node, 'node 应当被找到');
  assert.equal(report.flags.node, true);
  assert.equal(report.tools.node.found, true);
  assert.ok(report.durationMs >= 0);
});

test('环境变量分组不依赖子进程', async () => {
  const runProcess = createFallbackRunProcess();
  const report = await runDetection({ runProcess, config: {}, input: { groups: ['env'] } });
  assert.ok(report.env);
  assert.ok(Array.isArray(report.env.pathEntries));
  assert.ok(report.env.pathEntryCount > 0);
  assert.equal(report.paths && Object.keys(report.paths).length, 0);
});

test('resolveTools 报告缺失与版本范围', async () => {
  const runProcess = createFallbackRunProcess();
  const result = await resolveTools({
    runProcess,
    config: {},
    input: {
      tools: [
        { id: 'node', version: '>=18' },
        { id: 'not-a-real-tool-xyz', required: true },
      ],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.paths.node);
  assert.ok(result.tools.node.version);
  assert.deepEqual(result.requiredMissing, ['not-a-real-tool-xyz']);
  assert.ok(result.missing.includes('not-a-real-tool-xyz'));

  const impossible = await resolveTools({
    runProcess,
    config: {},
    input: { tools: [{ id: 'node', version: '>=99.0.0' }] },
  });
  assert.equal(impossible.ok, false);
  assert.deepEqual(impossible.unsatisfied, ['node']);
});

test('verifyRequirements 逐项给出状态', async () => {
  const runProcess = createFallbackRunProcess();
  const result = await verifyRequirements({
    runProcess,
    config: {},
    input: { requirements: [{ id: 'node' }, { id: 'missing-tool-abc' }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.checks.find((check) => check.id === 'node').status, 'ok');
  assert.equal(result.checks.find((check) => check.id === 'missing-tool-abc').status, 'missing');
  assert.ok(result.paths.node);
});

test('detect 动作端到端产出报告与快照', async () => {
  const runProcess = createFallbackRunProcess();
  const printed = [];
  const report = await plugin.actions.detect.run(
    { toolIds: ['node', 'git'], snapshot: false },
    {
      runProcess,
      config: {},
      env: process.env,
      signal: undefined,
      log: async () => {},
      print: async (message, data) => printed.push([message, data]),
      outputDir: process.cwd(),
      application: undefined,
    },
  );
  assert.equal(report.ok, true);
  assert.ok(report.paths.node);
  assert.ok(Object.hasOwn(report.flags, 'git'));
  assert.ok(Array.isArray(report.groups));
  assert.ok(printed.length >= 1);
  assert.ok(JSON.stringify(report).length > 0);
});

test('renderMarkdown 与 summarize 可用', async () => {
  const runProcess = createFallbackRunProcess();
  const report = await runDetection({ runProcess, config: {}, input: { groups: ['env'] } });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# 环境检测报告/);
  assert.match(markdown, /## 环境变量/);
  assert.match(markdown, /## 系统与主机/);
  assert.ok(typeof summarize(report) === 'string' && summarize(report).length > 0);
});

test('report 动作写出 Markdown 与 JSON 文件', async () => {
  const runProcess = createFallbackRunProcess();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'envprobe-'));
  try {
    const result = await plugin.actions.report.run(
      { groups: ['env'], format: 'both', includeMarkdown: true, snapshot: false },
      {
        runProcess,
        config: {},
        env: process.env,
        log: async () => {},
        print: async () => {},
        outputDir: directory,
      },
    );
    assert.equal(result.ok, true);
    assert.ok(result.files.markdown, '应当写出 Markdown 报告');
    assert.ok(result.files.json, '应当写出 JSON 报告');
    assert.match(result.markdown, /# 环境检测报告/);
    const markdown = await readFile(result.files.markdown, 'utf8');
    assert.match(markdown, /## 环境变量/);
    const json = JSON.parse(await readFile(result.files.json, 'utf8'));
    assert.equal(json.schemaVersion, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows 上只选 shell 分组也要能拿到 Git Bash', { skip: process.platform !== 'win32' }, async () => {
  const runProcess = createFallbackRunProcess();
  const report = await runDetection({ runProcess, config: {}, input: { groups: ['shell'] } });
  // 采集器依赖补链后 git 也会被解析；本机确实没装 Git 时才跳过断言。
  if (!report.tools?.git?.found) return;
  assert.ok(report.shells?.gitBash?.path, '装了 Git 就应当推导出 Git Bash');
  assert.equal(report.flags.bash, true, '有 Git Bash 时 flags.bash 应为 true');
  assert.ok(report.paths.bash, '有 Git Bash 时 paths.bash 应当可用');
});

test('快照路径按 stateDir → projectDir → cwd 逐级回退', () => {
  const base = { input: { snapshot: true } };
  assert.equal(
    resolveSnapshotPath({ ...base, stateDir: path.join('/state', 'abc') }),
    path.join('/state', 'abc', 'environment-latest.json'),
  );
  assert.equal(
    resolveSnapshotPath({ ...base, projectDir: '/proj' }),
    path.join('/proj', '.flow', 'env', 'latest.json'),
  );
  assert.equal(resolveSnapshotPath({ ...base, cwd: '/cwd' }), path.join('/cwd', 'environment-latest.json'));
  // 显式配置优先于任何默认位置
  assert.equal(
    resolveSnapshotPath({ ...base, stateDir: '/s', config: { snapshotPath: '/cfg/x.json' } }),
    path.resolve('/cfg/x.json'),
  );
  assert.equal(
    resolveSnapshotPath({ ...base, stateDir: '/s', input: { snapshot: true, snapshotPath: '/in/y.json' } }),
    path.resolve('/in/y.json'),
  );
  // 没要求写快照时不应产生路径
  assert.equal(resolveSnapshotPath({ input: {} }), '');
});

test('resolveTools 的 names 覆盖只影响解析，不会执行注册表外的命令', async () => {
  const runProcess = createFallbackRunProcess();
  const unknown = await resolveTools({
    runProcess,
    config: {},
    input: { tools: [{ id: 'not-in-catalog', names: ['node'] }] },
  });
  assert.ok(unknown.paths['not-in-catalog'], '按候选命令名解析出路径');
  assert.equal(unknown.tools['not-in-catalog'].version, null, '注册表外的 id 没有版本探测参数，不应执行命令');
  assert.equal(unknown.tools['not-in-catalog'].versionRaw, '');
});

test('拒绝会污染原型或指向路径的工具标识与命令名', async () => {
  const runProcess = createFallbackRunProcess();
  await assert.rejects(
    resolveTools({ runProcess, config: {}, input: { tools: ['__proto__'] } }),
    /工具标识不合法/,
  );
  await assert.rejects(
    resolveTools({ runProcess, config: {}, input: { tools: [{ id: 'evil', names: ['C:\\Windows\\System32\\cmd.exe'] }] } }),
    /候选命令名不合法/,
  );
  await assert.rejects(
    resolveTools({ runProcess, config: {}, input: { tools: [{ id: 'evil2', names: ['../bin/sh'] }] } }),
    /候选命令名不合法/,
  );
  await assert.rejects(
    resolveTools({ runProcess, config: {}, input: { tools: [{ id: 'node', version: 'latest' }] } }),
    /版本范围无法解析/,
  );
});

test('可选工具缺失或版本写错不影响整体判定', async () => {
  const runProcess = createFallbackRunProcess();
  const optional = await resolveTools({
    runProcess,
    config: {},
    input: { tools: [{ id: 'no-such-optional-tool', required: false, version: '>=1.0' }] },
  });
  assert.equal(optional.ok, true, '可选工具缺失不应判定整体失败');
  assert.deepEqual(optional.requiredMissing, []);
  assert.deepEqual(optional.unsatisfied, [], '未找到的项不该同时出现在 unsatisfied');
  assert.deepEqual(optional.missing, ['no-such-optional-tool']);

  const verified = await verifyRequirements({
    runProcess,
    config: {},
    input: { requirements: [{ id: 'node', version: 'latest' }] },
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.checks[0].status, 'invalid_range', '范围写法错误要单独报告而不是整体抛错');
});

test('附加命令只对注册表内的工具执行', async () => {
  const runProcess = createFallbackRunProcess();
  const registered = await verifyRequirements({
    runProcess,
    config: {},
    input: { requirements: [{ id: 'node', command: '--version' }] },
  });
  assert.equal(registered.checks[0].status, 'ok', '注册表内的工具可以执行附加命令');

  const unregistered = await verifyRequirements({
    runProcess,
    config: {},
    input: { requirements: [{ id: 'nodejs', names: ['node'], command: '--version' }] },
  });
  assert.equal(unregistered.checks[0].status, 'command_skipped', '未注册的 id 不允许执行附加命令');
});

test('显式快照路径不能越出项目目录', () => {
  assert.throws(
    () => resolveSnapshotPath({ input: { snapshot: true, snapshotPath: '../outside.json' }, projectDir: '/proj' }),
    /超出项目目录/,
  );
  assert.equal(
    resolveSnapshotPath({ input: { snapshot: true, snapshotPath: 'reports/env.json' }, projectDir: '/proj' }),
    path.resolve('/proj/reports/env.json'),
    '相对路径以项目目录为基准',
  );
});

test('detect 报告说明扫描范围，跳过了什么不能静默', async () => {
  const runProcess = createFallbackRunProcess();
  const report = await runDetection({ runProcess, config: {}, input: { toolIds: ['node'] } });
  assert.ok(report.scan, '报告必须说明扫描范围');
  assert.equal(typeof report.scan.directories, 'number');
  assert.equal(typeof report.scan.allowRemoteMounts, 'boolean');
  assert.ok(Array.isArray(report.scan.skippedRemote));
  assert.ok(Array.isArray(report.scan.timedOut));
  assert.equal(typeof report.flags.incompleteScan, 'boolean');
});

test('listPythons 枚举本机 Python 并给出可绑定的主解释器', async () => {
  const runProcess = createFallbackRunProcess();
  const result = await listPythons({ runProcess, config: {}, env: process.env, input: { timeoutMs: 8000 } });
  assert.ok(Array.isArray(result.pythons));
  assert.equal(result.count, result.pythons.length);
  for (const entry of result.pythons) {
    assert.ok(typeof entry.path === 'string' && entry.path.length > 0, '每个条目都要有路径');
    assert.ok(['interpreter', 'launcher', 'conda-env'].includes(entry.kind), `未知类型：${entry.kind}`);
    assert.equal(typeof entry.available, 'boolean');
    assert.equal(typeof entry.default, 'boolean');
    assert.equal(typeof entry.realPath, 'string');
  }
  const usable = result.pythons.filter((entry) => entry.kind !== 'launcher' && entry.available);
  if (usable.length) {
    assert.ok(result.primary, 'primary 应当给出可直接绑定的解释器路径');
    assert.ok(result.ok);
  }
});

test('每个检测分组都有直接的斜杠入口', () => {
  for (const group of GROUPS) {
    assert.ok(plugin.commands[`envprobe.${group.id}`], `缺少 /envprobe.${group.id}`);
  }
  for (const name of ['envprobe.check', 'envprobe.list', 'envprobe.python', 'envprobe.detect']) {
    assert.ok(plugin.commands[name], `缺少 /${name}`);
  }
});

test('check 能查任意工具、任意命令名与整个分组', async () => {
  const runProcess = createFallbackRunProcess();
  const run = (input) => checkTools({ runProcess, config: {}, env: process.env, input });

  // 1) 注册表标识
  const one = await run({ tool: 'node' });
  assert.equal(one.count, 1);
  assert.equal(one.results[0].found, true);
  assert.ok(one.paths.node, '找到的项要给出可直接绑定的路径');
  assert.ok(one.results[0].realPath.length > 0, '应给出解析符号链接后的真实路径');

  // 2) 多工具 + 缺失项
  const many = await run({ tool: ['node', 'not-a-real-tool-xyz'] });
  assert.equal(many.count, 2);
  assert.equal(many.foundCount, 1);
  assert.deepEqual(many.missing, ['not-a-real-tool-xyz']);
  assert.equal(many.ok, false, '有缺项时 ok 应为 false');

  // 3) 路径形式不是合法命令名，只报错不执行
  const invalid = await run({ tool: ['C:\\Windows\\System32\\cmd.exe'] });
  assert.equal(invalid.results[0].found, false);
  assert.match(invalid.results[0].error, /不允许包含路径分隔符/);

  // 4) 分组查询
  const group = await run({ group: 'gpu' });
  assert.ok(group.count > 0);
  assert.ok(group.results.every((entry) => entry.group === 'gpu'));

  // 5) 未知分组要明确报错
  await assert.rejects(run({ group: 'nope' }), /未知的检测分组/);
});

test('listPythons 的主解释器与 detect 的 paths.python 一致', async () => {
  const runProcess = createFallbackRunProcess();
  const [list, report] = await Promise.all([
    listPythons({ runProcess, config: {}, env: process.env, input: { timeoutMs: 20000 } }),
    runDetection({ runProcess, config: {}, input: { toolIds: ['python'], deep: true } }),
  ]);
  if (!list.primary) return; // 本机确实没有 Python 时跳过
  assert.equal(list.primary, report.paths.python, '两个入口给出的主解释器必须一致');
  const match = list.pythons.find((entry) => entry.path === list.primary);
  assert.equal(match?.source, 'primary', '首选条目应被标记为 primary 来源');
});

// 这些分组只在完整探测时才会跑，必须单独覆盖——否则采集器里的错误会一直漏到线上。
for (const [group, verify] of [
  ['system', (report) => assert.ok(report.platform && report.hardware)],
  ['container', (report) => {
    assert.ok(report.containers);
    assert.equal(typeof report.containers.k8s.kubeconfigExists, 'boolean');
  }],
  ['gpu', (report) => {
    assert.ok(report.gpu);
    assert.ok(Array.isArray(report.gpu.devices));
  }],
  ['env', (report) => assert.ok(report.env)],
]) {
  test(`分组 ${group} 能独立完成采集`, async () => {
    const runProcess = createFallbackRunProcess();
    const report = await runDetection({ runProcess, config: {}, input: { groups: [group] } });
    const entry = report.groups.find((item) => item.id === group);
    assert.equal(entry?.ok, true, `${group} 采集失败：${JSON.stringify(report.warnings)}`);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    verify(report);
  });
}

test('extraProbes 声明的 installPatterns 能在 check 中命中', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'envprobe-custom-'));
  try {
    await mkdir(path.join(root, 'v9', 'bin'), { recursive: true });
    const fake = path.join(root, 'v9', 'bin', 'mytool');
    await writeFile(fake, '#!/bin/sh\necho mytool 9.9.9\n', { mode: 0o755 });
    const runProcess = createFallbackRunProcess();
    const result = await checkTools({
      runProcess,
      // 故意把 PATH 清空：只能靠 installPatterns 找到，才能证明配置真的生效。
      env: { ...process.env, PATH: '' },
      config: {
        extraProbes: [
          {
            id: 'mytool',
            names: ['mytool-definitely-not-on-path'],
            installPatterns: { default: [`${root}/*/bin/mytool`] },
          },
        ],
      },
      input: { tool: 'mytool', includeVersion: false, candidates: true },
    });
    assert.equal(result.foundCount, 1, JSON.stringify(result.results[0]));
    assert.equal(result.results[0].path, fake);
    assert.equal(result.results[0].installations.length, 1);
    assert.equal(result.results[0].installations[0].source, 'installation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog 动作列出全部可检测项', async () => {
  const result = await plugin.actions.catalog.run({}, { config: {}, print: async () => {} });
  assert.equal(result.toolCount, TOOL_IDS.length);
  assert.equal(result.groupCount, GROUP_IDS.length);
  assert.ok(result.tools.some((tool) => tool.id === 'python'));
});

test('catalogSummary 反映自定义探测器', () => {
  const summary = catalogSummary({ extraProbes: [{ id: 'mytool', names: ['mytool'] }] });
  assert.ok(summary.tools.some((tool) => tool.id === 'mytool' && tool.custom));
});
