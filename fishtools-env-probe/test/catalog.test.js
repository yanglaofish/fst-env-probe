import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS,
  GROUP_IDS,
  TOOLS,
  TOOL_BY_ID,
  commandNamesFor,
  groupMeta,
  normalizeCustomProbe,
  normalizeInstallPatterns,
  patternsFor,
  withCustomProbes,
} from '../lib/catalog.js';

test('内置工具清单结构完整', () => {
  const ids = TOOLS.map((tool) => tool.id);
  assert.equal(new Set(ids).size, ids.length, '工具标识必须唯一');
  for (const tool of TOOLS) {
    assert.match(tool.id, /^[A-Za-z][A-Za-z0-9._-]*$/, `工具标识非法：${tool.id}`);
    assert.ok(tool.title, `${tool.id} 缺少标题`);
    assert.ok(GROUP_IDS.includes(tool.group), `${tool.id} 的分组非法：${tool.group}`);
    assert.ok(
      ['win32', 'linux', 'darwin'].some((platform) => commandNamesFor(tool, platform).length > 0),
      `${tool.id} 缺少候选命令名`,
    );
    assert.ok(Array.isArray(tool.versionArgs));
  }
});

test('每个分组都有工具或由采集器提供', () => {
  const collectorGroups = ['system', 'shell', 'language', 'tool', 'container', 'package', 'network', 'gpu', 'env', 'custom'];
  for (const group of GROUPS) assert.ok(collectorGroups.includes(group.id));
  const used = new Set(TOOLS.map((tool) => tool.group));
  for (const tool of TOOLS) assert.ok(GROUP_IDS.includes(tool.group));
  assert.ok(used.has('language'));
  assert.ok(used.has('container'));
  assert.ok(used.has('package'));
  assert.ok(used.has('network'));
  assert.ok(used.has('gpu'));
  assert.ok(used.has('shell'));
});

test('命令名按平台选择', () => {
  const python = TOOL_BY_ID.get('python');
  assert.deepEqual(commandNamesFor(python, 'win32').slice(0, 2), ['python', 'python3']);
  assert.deepEqual(commandNamesFor(python, 'linux').slice(0, 2), ['python3', 'python']);
  assert.deepEqual(commandNamesFor(python, 'darwin').slice(0, 2), ['python3', 'python']);
  const yum = TOOL_BY_ID.get('yum');
  assert.deepEqual(commandNamesFor(yum, 'linux'), ['yum']);
});

test('用户自定义探测器合并与覆盖', () => {
  const merged = withCustomProbes([
    { id: 'mytool', title: '我的工具', names: ['mytool', 'mytool-cli'], versionArgs: '--version', pathHints: ['/opt/mytool/bin'] },
    { id: 'python', names: ['python-is-python3'] },
  ]);
  const mytool = merged.toolById.get('mytool');
  assert.ok(mytool, '自定义探测器应当被合入');
  assert.equal(mytool.group, 'custom');
  assert.equal(mytool.source, 'custom');
  assert.deepEqual(mytool.versionArgs, [['--version']]);
  assert.deepEqual(mytool.searchDirs, ['/opt/mytool/bin']);
  const python = merged.toolById.get('python');
  assert.deepEqual(commandNamesFor(python, 'linux'), ['python-is-python3']);
  assert.equal(merged.rejected.length, 0);
});

test('自定义探测器的多命令与版本正则', () => {
  const spec = normalizeCustomProbe({
    id: 'toolx',
    command: 'toolx',
    versionArgs: [['--version'], ['-v']],
    versionPattern: 'v(\\d+\\.\\d+)',
    group: 'tool',
  });
  assert.deepEqual(spec.version, [['--version'], ['-v']]);
  assert.deepEqual(spec.parse, { pattern: 'v(\\d+\\.\\d+)' });
  assert.equal(spec.group, 'tool');
});

test('非法自定义探测器被拒绝', () => {
  const merged = withCustomProbes([
    { id: '1bad', names: ['x'] },
    { names: ['x'] },
    { id: 'ok-tool' },
    null,
    { id: 'ok-tool2', names: [''] },
  ]);
  assert.equal(merged.rejected.length, 5);
  assert.ok(merged.toolById.has('ok-tool') === false, '缺少命令名的条目不应合入');
});

test('自定义探测器的非法版本正则会退回通用提取', () => {
  assert.equal(normalizeCustomProbe({ id: 'toolx', names: ['toolx'], versionPattern: '([bad' }).parse, null);
  assert.equal(normalizeCustomProbe({ id: 'tooly', names: ['tooly'], versionPattern: 'x'.repeat(300) }).parse, null);
  assert.deepEqual(normalizeCustomProbe({ id: 'toolz', names: ['toolz'], versionPattern: 'v(\\d+\\.\\d+)' }).parse, {
    pattern: 'v(\\d+\\.\\d+)',
  });
});

test('自定义探测器可以声明多版本安装目录', () => {
  const { toolById } = withCustomProbes([
    {
      id: 'node',
      names: ['node'],
      installPatterns: {
        default: ['/opt/nodejs/*/bin/node', '~/.nvm/versions/node/*/bin/node'],
        win32: ['%APPDATA%\\nvm\\v*\\node.exe'],
      },
    },
  ]);
  const tool = toolById.get('node');
  assert.ok(tool.patterns, 'installPatterns 必须被传递到规格上');
  const linux = patternsFor(tool, 'linux');
  assert.ok(linux.includes('/opt/nodejs/*/bin/node'));
  assert.ok(linux.includes('~/.nvm/versions/node/*/bin/node'));
  assert.deepEqual(patternsFor(tool, 'win32'), ['%APPDATA%\\nvm\\v*\\node.exe']);
  // 内置工具的声明不能被丢掉
  const { toolById: builtin } = withCustomProbes([]);
  assert.ok(patternsFor(builtin.get('python'), 'linux').some((item) => item.includes('pyenv')));
});

test('非法或空的 installPatterns 被忽略', () => {
  assert.deepEqual(normalizeInstallPatterns(null), {});
  assert.deepEqual(normalizeInstallPatterns('x'), {});
  assert.deepEqual(normalizeInstallPatterns({ default: 'not-an-array' }), {});
  assert.deepEqual(normalizeInstallPatterns({ default: ['', '  ', 42] }), {});
  const { toolById } = withCustomProbes([{ id: 'thing', names: ['thing'], installPatterns: { default: [] } }]);
  assert.deepEqual(toolById.get('thing').patterns, {});
  assert.deepEqual(patternsFor(toolById.get('thing'), 'linux'), []);
});

test('withCustomProbes 对同一份配置复用合并结果', () => {
  const probes = [{ id: 'cached-tool', names: ['cached-tool'] }];
  assert.equal(withCustomProbes(probes), withCustomProbes(probes));
  assert.notEqual(withCustomProbes(probes), withCustomProbes([{ id: 'cached-tool', names: ['cached-tool'] }]));
  assert.equal(withCustomProbes([]), withCustomProbes());
});

test('缺少命令名的自定义探测器被拒绝并记录', () => {
  const merged = withCustomProbes([{ id: 'no-names', title: '缺少命令名' }]);
  assert.equal(merged.toolById.has('no-names'), false);
  assert.equal(merged.rejected.length, 1);
});

test('groupMeta 对未知分组做兜底', () => {
  assert.equal(groupMeta('system').title, '系统与主机');
  assert.equal(groupMeta('nope').title, 'nope');
});
