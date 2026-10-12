import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEnv, collectSystem } from '../lib/groups/system.js';
import { collectNetwork } from '../lib/groups/network.js';
import { createFallbackRunProcess } from '../lib/run-process.js';

test('系统采集产出平台、内存与磁盘基础信息', async () => {
  const result = await collectSystem({
    runProcess: createFallbackRunProcess(),
    env: process.env,
    timeoutMs: 20000,
  });
  assert.ok(result.platform.os, '应当报告操作系统类型');
  assert.ok(result.platform.arch, '应当报告架构');
  assert.ok(result.platform.hostname, '应当报告主机名');
  assert.ok(result.hardware.memory.totalBytes > 0, '应当报告内存总量');
  assert.ok(Array.isArray(result.hardware.disks));
  assert.ok(Array.isArray(result.warnings));
  const installDate = result.platform.distro?.installDate;
  if (installDate) assert.match(installDate, /^\d{4}-\d{2}-\d{2}T/, '日期必须是 ISO 而不是 .NET /Date()/ 格式');
});

test('Windows 系统采集补齐核心数、插槽与磁盘', { skip: process.platform !== 'win32' }, async () => {
  const result = await collectSystem({
    runProcess: createFallbackRunProcess(),
    env: process.env,
    timeoutMs: 20000,
  });
  assert.ok(/Windows/i.test(result.platform.distro.name), `发行版识别为 ${result.platform.distro.name}`);
  assert.ok(result.platform.distro.build, '应当报告构建号');
  assert.ok(result.hardware.cpu.cores >= 1, '应当报告物理核心数');
  assert.ok(result.hardware.cpu.threads >= 1, '应当报告逻辑线程数');
  assert.ok(result.hardware.cpu.sockets >= 1, '应当报告物理插槽数');
  assert.ok(result.hardware.cpu.maxClockMHz > 0, '应当报告 WMI 标称主频');
  assert.ok(result.hardware.disks.length >= 1, '应当列出本地磁盘');
  assert.equal(result.warnings.length, 0, `不应有告警：${JSON.stringify(result.warnings)}`);
});

test('网络采集返回网卡、地址与代理结构', async () => {
  const network = await collectNetwork({
    runProcess: createFallbackRunProcess(),
    env: process.env,
    timeoutMs: 20000,
  });
  assert.ok(Array.isArray(network.adapters));
  assert.ok(network.adapters.length >= 1, '至少应当能看到回环网卡');
  assert.ok(typeof network.primary === 'object');
  assert.ok(Array.isArray(network.gateways));
  assert.ok(Array.isArray(network.dnsServers));
  assert.ok(typeof network.proxies.enabled === 'boolean');
  assert.ok(Array.isArray(network.warnings));
  for (const adapter of network.adapters) {
    assert.ok(typeof adapter.name === 'string');
    assert.ok(Array.isArray(adapter.addresses));
    assert.ok(Array.isArray(adapter.gateways));
    assert.ok(Array.isArray(adapter.dnsServers));
  }
});

test('环境变量采集裁剪关键变量与 PATH 明细', () => {
  const env = collectEnv({ PATH: '/a:/b:/a', JAVA_HOME: '/jdk', HOME: '/home/x' }, 'linux');
  assert.deepEqual(env.pathEntries, ['/a', '/b', '/a']);
  assert.equal(env.pathEntryCount, 3);
  assert.deepEqual(env.pathDuplicates, ['/a']);
  assert.equal(env.selected.JAVA_HOME, '/jdk');
  assert.equal(env.selected.HOME, '/home/x');
  assert.equal(collectEnv({}, 'linux').pathEntryCount, 0);

  const win = collectEnv({ Path: 'C:\\a;C:\\A;C:\\b' }, 'win32');
  assert.deepEqual(win.pathEntries, ['C:\\a', 'C:\\A', 'C:\\b']);
  assert.deepEqual(win.pathDuplicates, ['C:\\A'], 'Windows 上的 PATH 去重必须忽略大小写');
});
