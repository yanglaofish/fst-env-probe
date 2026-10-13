import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import plugin from '../index.js';
import { checkTools, createProbeEngine, listPythons, resolveTools, runDetection } from '../lib/detect.js';
import { createFallbackRunProcess } from '../lib/run-process.js';
import { createScanContext, expandInstallPatterns, resolveExecutableAll } from '../lib/which.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'envprobe-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('fst 0.5 普通用户权限、独立命令标题与自动更新声明完整', () => {
  assert.equal(plugin.requirements?.privilege?.linux?.level, 'user');
  assert.equal(plugin.requirements?.privilege?.win32?.level, 'user');
  assert.equal(plugin.runtime.updatePolicy, 'automatic');
  for (const command of Object.values(plugin.commands)) {
    if (command.run) assert.ok(command.title?.trim());
  }
});

test('报告保留采集失败状态与错误明细', async (t) => {
  const outputDir = await fixture(t);
  const env = { ...process.env };
  Object.defineProperty(env, 'PATH', { get() { throw new Error('模拟无法读取搜索路径'); } });
  const result = await plugin.actions.report.run({ toolIds: ['node'], format: 'json' }, {
    env, outputDir, runProcess: createFallbackRunProcess(), log: async () => {}, print: async () => {},
  });
  const saved = JSON.parse(await readFile(result.files.json, 'utf8'));
  assert.equal(saved.ok, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, saved.errors);
  assert.equal(result.flags.probeFailed, true);
});

test('resolve 与 check 同样识别 PATH 之外的安装目录', async (t) => {
  const root = await fixture(t);
  const executable = path.join(root, process.platform === 'win32' ? 'internal.exe' : 'internal');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  const config = { extraProbes: [{ id: 'internal', names: ['envprobe-unregistered-tool'], versionArgs: [], installPatterns: { default: [executable] } }] };
  const runProcess = createFallbackRunProcess();
  const checked = await checkTools({ runProcess, config, input: { tool: 'internal', includeVersion: false } });
  const resolved = await resolveTools({ runProcess, config, input: { tools: ['internal'], deep: false } });
  assert.equal(checked.paths.internal, executable);
  assert.equal(resolved.paths.internal, executable);
});

test('额外搜索目录使用本次 env 展开用户目录与变量', async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, 'bin');
  const executable = path.join(bin, process.platform === 'win32' ? 'envprobe-home-demo.exe' : 'envprobe-home-demo');
  await mkdir(bin);
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  const env = { ...process.env, HOME: root, USERPROFILE: root, PATH: '', Path: '', ENVPROBE_HOME: root };
  const runProcess = createFallbackRunProcess();
  for (const extraPaths of [['~/bin'], ['%ENVPROBE_HOME%/bin']]) {
    const result = await checkTools({ runProcess, env, input: { tool: 'envprobe-home-demo', includeVersion: false, extraPaths } });
    assert.equal(result.paths['envprobe-home-demo'], executable);
  }
});

test('Conda 注册表中的 Python 在所有路径入口保持一致', async (t) => {
  const root = await fixture(t);
  const prefix = path.join(root, 'conda', 'envs', 'demo');
  const executable = process.platform === 'win32' ? path.join(prefix, 'python.exe') : path.join(prefix, 'bin', 'python');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  await mkdir(path.join(root, '.conda'));
  await writeFile(path.join(root, '.conda', 'environments.txt'), `${prefix}\n`);
  const env = { ...process.env, PATH: '', Path: '', HOME: root, USERPROFILE: root, CONDA_PREFIX: prefix };
  const config = { extraProbes: [{ id: 'python', names: ['envprobe-no-python-on-path'], versionArgs: [] }] };
  const runProcess = async () => ({ exitCode: 0, stdout: 'Python 3.12.9', stderr: '' });
  const report = await runDetection({ runProcess, env, config, input: { toolIds: ['python'] } });
  const checked = await checkTools({ runProcess, env, config, input: { tool: 'python', includeVersion: false } });
  const resolved = await resolveTools({ runProcess, env, config, input: { tools: ['python'], deep: false } });
  const listed = await listPythons({ runProcess, env, config, input: { includeVersions: false } });
  assert.equal(report.paths.python, executable);
  assert.equal(checked.paths.python, executable);
  assert.equal(resolved.paths.python, executable);
  assert.equal(listed.primary, executable);
});

test('Windows py 启动器登记的非 PATH 解释器在所有入口保持一致', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, 'bin');
  const executable = path.join(root, 'custom-python', 'python.exe');
  await mkdir(bin);
  await mkdir(path.dirname(executable));
  await writeFile(path.join(bin, 'py.exe'), '');
  await writeFile(executable, '');
  const env = { ...process.env, PATH: bin, Path: bin, HOME: root, USERPROFILE: root, CONDA_PREFIX: '' };
  const config = { extraProbes: [{ id: 'python', names: ['envprobe-no-python-on-path'], versionArgs: [] }] };
  const runProcess = async (file) => ({ exitCode: 0, stdout: path.basename(file).toLowerCase() === 'py.exe' ? ` -V:3.12 * ${executable}` : 'Python 3.12.9', stderr: '' });
  const report = await runDetection({ runProcess, env, config, input: { toolIds: ['python'] } });
  const checked = await checkTools({ runProcess, env, config, input: { tool: 'python', includeVersion: false } });
  const resolved = await resolveTools({ runProcess, env, config, input: { tools: ['python'], deep: false } });
  const listed = await listPythons({ runProcess, env, config, input: { includeVersions: false, includeConda: false } });
  assert.equal(report.paths.python, executable);
  assert.equal(checked.paths.python, executable);
  assert.equal(resolved.paths.python, executable);
  assert.equal(listed.primary, executable);
});

test('显式文件和无通配安装目录同样跳过远程挂载', async () => {
  const file = process.execPath;
  const context = createScanContext({ remoteMounts: [{ mount: path.dirname(file), fstype: 'nfs' }] });
  assert.deepEqual(await resolveExecutableAll(file, { context }), []);
  assert.deepEqual(await expandInstallPatterns([file], { context }), []);
  assert.ok(context.skipped.length >= 2);
});

test('Windows 回退进程能启动 npm 风格 cmd 包装且参数不被执行', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  const script = path.join(root, 'echo-args.cjs');
  const batch = path.join(root, '包装 工具.cmd');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  await writeFile(batch, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ['--version', '中文 参数', 'x&echo injected', 'x"&echo injected', '%PATH%', '!PATH!', '尾部\\', ''];
  const result = await createFallbackRunProcess()(batch, args);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  await assert.rejects(createFallbackRunProcess()(batch, ['x\r\necho injected']), /换行/);
});

test('回退进程保留非零退出、取消、超时与输出上限语义', async () => {
  const run = createFallbackRunProcess();
  const result = await run(process.execPath, ['-e', 'process.stderr.write("失败");process.exit(7)']);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, '失败');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(process.execPath, [], { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), { code: 'TIMEOUT' });
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536))'], { maxBuffer: 1024 }), { code: 'OUTPUT_LIMIT' });
  const encoded = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from("中文", "utf16le"))'], { encoding: 'utf16le' });
  assert.equal(encoded.stdout, '中文');
});

test('回退进程超时后回收继承输出管道的子进程', async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'child-survived.txt');
  const script = path.join(root, 'parent.cjs');
  // 子进程若未被回收，会继续占用 stdout 并在稍后留下标记。
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'仍在运行'),1200)`;
  await writeFile(script, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000);`);
  const started = Date.now();
  await assert.rejects(createFallbackRunProcess()(process.execPath, [script], { timeout: 300 }), { code: 'TIMEOUT' });
  assert.ok(Date.now() - started < 5000, '回收不能等待子进程自行结束');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('服务缓存保留搜索目录顺序及远程扫描开关', async (t) => {
  const root = await fixture(t);
  const dirs = [path.join(root, 'a'), path.join(root, 'b')];
  const name = process.platform === 'win32' ? 'cache-probe.exe' : 'cache-probe';
  for (const dir of dirs) {
    await mkdir(dir);
    await writeFile(path.join(dir, name), '');
    await chmod(path.join(dir, name), 0o755);
  }
  const engine = createProbeEngine({ extraProbes: [{ id: 'cacheProbe', names: ['cache-probe'], versionArgs: [] }] });
  const context = { runProcess: createFallbackRunProcess() };
  const first = await engine.detect({ toolIds: ['cacheProbe'], extraPaths: dirs, allowRemoteMounts: false }, context);
  const second = await engine.detect({ toolIds: ['cacheProbe'], extraPaths: [...dirs].reverse(), allowRemoteMounts: true }, context);
  assert.equal(first.paths.cacheProbe, path.join(dirs[0], name));
  assert.equal(second.paths.cacheProbe, path.join(dirs[1], name));
  assert.equal(second.scan.allowRemoteMounts, true);
});

test('服务缓存按实际环境隔离且命中时也响应取消', async () => {
  const engine = createProbeEngine();
  const input = { groups: ['env'] };
  const context = { runProcess: createFallbackRunProcess(), env: { ...process.env, JAVA_HOME: 'A' } };
  const first = await engine.detect(input, context);
  const second = await engine.detect(input, { ...context, env: { ...context.env, JAVA_HOME: 'B' } });
  assert.equal(first.env.selected.JAVA_HOME, 'A');
  assert.equal(second.env.selected.JAVA_HOME, 'B');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.detect(input, { ...context, signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(runDetection({ ...context, input, signal: controller.signal }), { code: 'CANCELLED' });
});

test('Windows 已带扩展名的命令按原名查找', { skip: process.platform !== 'win32' }, async () => {
  const names = await resolveExecutableAll('node.exe');
  assert.ok(names.length > 0);
  assert.equal(names[0].path, (await resolveExecutableAll('node'))[0].path);
});

test('check 的 refresh 能发现同目录新增加的工具', async (t) => {
  const root = await fixture(t);
  const runProcess = createFallbackRunProcess();
  const input = { tool: 'envprobe-refresh-demo', extraPaths: [root], includeVersion: false };
  assert.equal((await checkTools({ runProcess, input })).foundCount, 0);
  const executable = path.join(root, process.platform === 'win32' ? 'envprobe-refresh-demo.exe' : 'envprobe-refresh-demo');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  assert.equal((await checkTools({ runProcess, input: { ...input, refresh: true } })).paths[input.tool], executable);
});
