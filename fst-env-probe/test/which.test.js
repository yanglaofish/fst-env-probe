import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createScanContext,
  executableExts,
  expandInstallPatterns,
  findRemoteMountFor,
  isStoreShim,
  isWindows,
  knownDirs,
  pathSeparator,
  platformKey,
  realPathOf,
  resolveExecutableAll,
  siblingDirs,
  splitEnvList,
  splitSearchPath,
} from '../lib/which.js';

test('平台辅助函数', () => {
  assert.equal(platformKey('win32'), 'win32');
  assert.equal(platformKey('darwin'), 'darwin');
  assert.equal(platformKey('freebsd'), 'linux');
  assert.equal(isWindows('win32'), true);
  assert.equal(isWindows('linux'), false);
  assert.equal(pathSeparator('win32'), ';');
  assert.equal(pathSeparator('linux'), ':');
  assert.deepEqual(executableExts('linux'), ['']);
  assert.ok(executableExts('win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD' }).includes('.exe'));
  assert.ok(!executableExts('win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' }).includes('.ps1'));
});

test('splitSearchPath 去重并保留顺序', () => {
  const dirs = splitSearchPath('linux', { PATH: '/usr/bin:/bin:/usr/bin' });
  assert.deepEqual(dirs, ['/usr/bin', '/bin']);
  const win = splitSearchPath('win32', { PATH: 'C:\\a;C:\\A;C:\\b' });
  assert.deepEqual(win, ['C:\\a', 'C:\\b']);
  assert.deepEqual(splitSearchPath('win32', { Path: 'C:\\x' }), ['C:\\x']);
  assert.deepEqual(splitSearchPath('linux', {}), []);
});

test('splitEnvList 按平台分隔符拆分并去引号', () => {
  assert.deepEqual(splitEnvList('/a:/b:/a', 'linux'), ['/a', '/b', '/a']);
  assert.deepEqual(splitEnvList('"C:\\a";C:\\b', 'win32'), ['C:\\a', 'C:\\b']);
  assert.deepEqual(splitEnvList('', 'linux'), []);
  assert.deepEqual(splitEnvList(undefined, 'linux'), []);
});

test('knownDirs 随平台返回可搜索目录', () => {
  const linux = knownDirs('linux', { HOME: '/home/dev' });
  assert.ok(linux.includes('/usr/local/bin'));
  assert.ok(linux.includes('/home/dev/.local/bin'));
  const win = knownDirs('win32', { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.ok(win.some((dir) => dir.endsWith('System32')));
  assert.ok(win.some((dir) => dir.endsWith('AppData\\Roaming\\npm')));
});

test('解析当前 Node 可执行文件', async () => {
  const hits = await resolveExecutableAll('node', { platform: process.platform, env: process.env });
  assert.ok(hits.length >= 1, 'PATH 中应当能找到 node');
  assert.ok(hits[0].path.length > 0);
  assert.ok(['PATH', 'configured', 'known'].includes(hits[0].source));
});

test('未知命令返回空结果', async () => {
  assert.deepEqual(await resolveExecutableAll('fst-definitely-not-a-real-command-9f3c', { platform: process.platform, env: process.env }), []);
  assert.deepEqual(await resolveExecutableAll('', { platform: process.platform, env: process.env }), []);
});

test('绝对路径直接命中', async () => {
  const hits = await resolveExecutableAll(process.execPath, { platform: process.platform, env: process.env });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'explicit');
});

test('Windows 上优先返回带扩展名的可执行文件', { skip: process.platform !== 'win32' }, async () => {
  const hits = await resolveExecutableAll('npm', { platform: 'win32', env: process.env });
  assert.ok(hits.length >= 1, '应当能找到 npm');
  assert.match(hits[0].path, /\.(cmd|exe|bat)$/i, '不应把无扩展名的 shell 脚本当作首选');
});

test('isStoreShim 识别 Windows 应用商店别名', () => {
  assert.equal(isStoreShim('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'), true);
  assert.equal(isStoreShim('C:\\Python312\\python.exe'), false);
  assert.equal(isStoreShim('/usr/bin/python3'), false);
  assert.equal(isStoreShim(''), false);
});

test('siblingDirs 由锚点推断同族目录', async () => {
  const dirs = await siblingDirs('/usr/bin/git', ['bin', 'libexec/git-core']);
  assert.ok(Array.isArray(dirs));
});

test('realPathOf 解析符号链接，失败时返回空串', async () => {
  const resolved = await realPathOf(process.execPath);
  assert.ok(resolved.length > 0);
  assert.equal(await realPathOf('/definitely/not/here/xyz'), '');
});

test('findRemoteMountFor 命中挂载点及其子目录', () => {
  const remote = [
    { mount: '/home', fstype: 'nfs4' },
    { mount: '/opt/tools', fstype: 'cifs' },
  ];
  assert.equal(findRemoteMountFor('/home', remote, 'linux').fstype, 'nfs4');
  assert.equal(findRemoteMountFor('/home/user/bin', remote, 'linux').fstype, 'nfs4');
  assert.equal(findRemoteMountFor('/opt/tools/bin', remote, 'linux').fstype, 'cifs');
  assert.equal(findRemoteMountFor('/usr/bin', remote, 'linux'), null);
  // 目录名前缀相似但不是挂载点下的路径
  assert.equal(findRemoteMountFor('/homework/bin', remote, 'linux'), null);
  assert.equal(findRemoteMountFor('/opt/toolshed', remote, 'linux'), null);
  assert.equal(findRemoteMountFor('', remote, 'linux'), null);
});

test('Windows 上按盘符与 UNC 前缀匹配远程路径', () => {
  const remote = [
    { mount: 'Z:\\', fstype: 'smb' },
    { mount: '\\\\', fstype: 'unc' },
  ];
  assert.equal(findRemoteMountFor('Z:\\tools\\bin', remote, 'win32').fstype, 'smb');
  assert.equal(findRemoteMountFor('\\\\server\\share\\bin', remote, 'win32').fstype, 'unc');
  assert.equal(findRemoteMountFor('C:\\Python312', remote, 'win32'), null);
});

test('扫描上下文记录被跳过的远程挂载点，不做静默漏检', async () => {
  const env = { PATH: '/nfs/tools/bin:/usr/bin' };
  const context = createScanContext({
    platform: 'linux',
    env,
    remoteMounts: [{ mount: '/nfs', fstype: 'nfs4' }],
  });
  const hits = await resolveExecutableAll('node', { platform: 'linux', env, context });
  assert.deepEqual(hits, [], '远程挂载下的目录不应被读取');
  assert.equal(context.skipped.length >= 1, true, '跳过必须被记录下来');
  assert.equal(context.skipped[0].mount, '/nfs');
  assert.equal(context.skipped[0].reason, 'remote-mount');
});

test('扫描上下文在 allowRemoteMounts 时不跳过远程目录', async () => {
  const env = { PATH: '/nfs/tools/bin:/usr/bin' };
  const context = createScanContext({
    platform: 'linux',
    env,
    remoteMounts: [{ mount: '/nfs', fstype: 'nfs4' }],
    allowRemoteMounts: true,
  });
  await resolveExecutableAll('node', { platform: 'linux', env, context });
  assert.equal(context.skipped.length, 0, '允许扫描时不应记录跳过');
});

test('expandInstallPatterns 按段通配发现 PATH 之外的安装', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'envprobe-install-'));
  try {
    for (const version of ['v18.20.0', 'v20.11.0']) {
      await mkdir(path.join(root, 'versions', 'node', version, 'bin'), { recursive: true });
      await writeFile(path.join(root, 'versions', 'node', version, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    }
    const found = await expandInstallPatterns([`${root}/versions/node/*/bin/node`], {
      platform: process.platform,
      env: process.env,
    });
    assert.equal(found.length, 2, '两个已安装版本都应被发现');
    assert.ok(found.every((item) => item.source === 'installation'));
    assert.ok(found.some((item) => item.path.includes('v18.20.0')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expandInstallPatterns 支持前缀通配并忽略不匹配项', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'envprobe-prefix-'));
  try {
    for (const name of ['Python312', 'Python313', 'notpython', '.hidden']) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, 'python'), '#!/bin/sh\n', { mode: 0o755 });
    }
    const found = await expandInstallPatterns([`${root}/Python*/python`], {
      platform: process.platform,
      env: process.env,
    });
    assert.equal(found.length, 2, '只应命中 Python312 与 Python313');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expandInstallPatterns 跳过远程挂载下的目录并记录', async () => {
  // 用当前平台的路径形态：模式展开本来就只服务本机平台。
  const mount = process.platform === 'win32' ? 'C:\\' : '/';
  const pattern = process.platform === 'win32' ? 'C:\\tools\\*\\bin\\thing' : '/tools/*/bin/thing';
  const context = createScanContext({
    platform: process.platform,
    remoteMounts: [{ mount, fstype: 'nfs4' }],
  });
  const found = await expandInstallPatterns([pattern], { platform: process.platform, env: {}, context });
  assert.deepEqual(found, [], '远程挂载下的安装目录不应被读取');
  assert.ok(context.skipped.length >= 1, '跳过必须被记录');
  assert.equal(context.skipped[0].reason, 'remote-mount');
});

test('expandInstallPatterns 对空值返回空数组', async () => {
  assert.deepEqual(await expandInstallPatterns([], {}), []);
  assert.deepEqual(await expandInstallPatterns([null, '', '   '], {}), []);
});
