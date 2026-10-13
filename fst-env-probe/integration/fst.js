// 在独立临时工作区使用真正安装的 fst；内部 API 仅供兼容测试，插件生产代码不依赖它。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import plugin from '../index.js';
import { createFallbackRunProcess } from '../lib/run-process.js';
import { resolveExecutable } from '../lib/which.js';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const runProcess = createFallbackRunProcess();
const npm = await resolveExecutable('npm');
assert.ok(npm, '请先安装 Node/npm');
const npmRoot = (await runProcess(npm.path, ['root', '-g'])).stdout.trim();
const hostPackage = path.join(npmRoot, '@yanglaofish', 'fishtools', 'package.json');
const hostInfo = JSON.parse(await readFile(hostPackage, 'utf8'));
const requireHost = createRequire(pathToFileURL(hostPackage));
const { createApplication } = await import(pathToFileURL(requireHost.resolve('@mytools/core')));
const fstBin = path.join(path.dirname(hostPackage), hostInfo.bin.fst);

async function workspace(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fst-envprobe-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function command(app, name, input = {}, context = {}) {
  const result = await (await app.startCommand(name, input, context)).done;
  assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  return result.output;
}

test('真实 fst 校验及质量检查无诊断', async () => {
  console.log(`兼容验证宿主：${hostInfo.name}@${hostInfo.version}，${process.platform}/${process.arch}`);
  for (const name of ['validate', 'lint']) {
    const result = await runProcess(process.execPath, [fstBin, 'plugin', name, pluginRoot, '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, true);
    assert.deepEqual(output.diagnostics, []);
  }
});

test('真实宿主运行全部动作、交互命令、快照及工作流绑定', async (t) => {
  const projectDir = await workspace(t, 'actions');
  const app = await createApplication({ projectDir, plugins: [{ plugin, root: pluginRoot }] });
  t.after(() => app.close());
  const catalog = await command(app, 'envprobe.catalog');
  assert.equal(catalog.groupCount, 10);
  assert.equal(catalog.toolCount, 141);
  assert.equal((await command(app, 'envprobe.service')).ready, true);
  const detected = await command(app, 'envprobe.detect', { toolIds: ['node', 'npm'], snapshot: true });
  assert.equal(detected.flags.node, true);
  assert.ok(detected.tools.node.version);
  assert.ok(detected.tools.npm.version, JSON.stringify(detected.tools.npm));
  assert.ok(detected.snapshotPath.startsWith(path.join(projectDir, '.flow', 'plugin-state')));
  assert.equal(JSON.parse(await readFile(detected.snapshotPath, 'utf8')).paths.node, detected.paths.node);
  const resolved = await command(app, 'envprobe.resolve', { tools: [{ id: 'node', version: '>=24' }] });
  assert.equal(resolved.ok, true);
  const verified = await command(app, 'envprobe.verify', { requirements: [{ id: 'node', version: '>=24' }] });
  assert.equal(verified.ok, true);
  assert.equal((await command(app, 'envprobe.check', { tool: 'node', candidates: false })).foundCount, 1);
  assert.ok(Array.isArray((await command(app, 'envprobe.python', { includeVersions: false, includeConda: false })).pythons));
  const report = await command(app, 'envprobe.report', { groups: ['env'], format: 'both' });
  assert.equal(report.ok, true);
  assert.ok((await readFile(report.files.markdown, 'utf8')).includes('环境'));
  assert.equal(JSON.parse(await readFile(report.files.json, 'utf8')).schemaVersion, 1);
  await command(app, 'envprobe.env', { includeVersion: false }, { ui: {} });
  const which = await command(app, 'envprobe.which', {}, { ui: { input: async () => 'node' } });
  assert.equal(which.found, true);
  await app.saveWorkflow({
    id: 'envprobe-binding', schemaVersion: 1, title: '环境路径绑定验证', inputs: { type: 'object' },
    steps: [
      { id: 'detect', action: 'fst-env-probe:detect', with: { toolIds: ['node'] } },
      { id: 'report', action: 'fst-env-probe:report', with: { groups: ['env'], fileBase: { $ref: 'steps.detect.output.tools.node.id' } } },
    ],
    outputs: { executable: { $ref: 'steps.detect.output.paths.node' }, report: { $ref: 'steps.report.output.files.json' } },
  });
  const run = await (await app.startRun('envprobe-binding')).done;
  assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
  assert.equal(run.output.executable, detected.paths.node);
  assert.ok(run.output.report.endsWith('node-report.json'));
});

test('共享服务自动重启及配置持久化无需全局维护', async (t) => {
  const projectDir = await workspace(t, 'runtime');
  const app = await createApplication({ projectDir, plugins: [] });
  t.after(() => app.close());
  await app.linkPlugin(pluginRoot);
  assert.equal((await command(app, 'envprobe.service')).ttlSeconds, 300);
  await app.configurePlugin(plugin.id, { cacheTtlSeconds: 0 });
  assert.equal(app.maintenance, false);
  assert.equal((await command(app, 'envprobe.service')).ttlSeconds, 0);
  await app.close();
  const restarted = await createApplication({ projectDir });
  t.after(() => restarted.close());
  assert.equal((await command(restarted, 'envprobe.service')).ttlSeconds, 0);
});

test('npm 归档可独立安装并经真实 CLI 执行', async (t) => {
  const root = await workspace(t, 'package');
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  await writeFile(path.join(projectDir, 'flow.project.json'), JSON.stringify({ plugins: [], config: {} }));
  const packed = await runProcess(npm.path, ['pack', pluginRoot, '--json', '--pack-destination', root], { timeout: 60000 });
  assert.equal(packed.exitCode, 0, packed.stderr);
  const archive = path.join(root, JSON.parse(packed.stdout)[0].filename);
  const installed = await runProcess(process.execPath, [fstBin, '--project', projectDir, 'plugin', 'add', archive], {
    timeout: 120000, env: { npm_config_registry: 'https://registry.npmjs.org' },
  });
  assert.equal(installed.exitCode, 0, installed.stderr);
  const result = await runProcess(process.execPath, [fstBin, '--project', projectDir, 'command', 'envprobe.service']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify({ tool: ['node', 'npm'], candidates: false }));
  const checked = await runProcess(process.execPath, [fstBin, '--project', projectDir, 'command', 'envprobe.check', '--input', input]);
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).foundCount, 2);
});
