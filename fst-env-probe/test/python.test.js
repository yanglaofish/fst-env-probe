import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePyLauncher } from '../lib/groups/platform.js';

test('parsePyLauncher 解析 py -0p 的真实输出格式', () => {
  // 这是 py -0p 的原始输出：默认版本那行在星号前有一个空格。
  const text = [
    ' -V:3.12 *        C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    ' -V:3.13          C:\\Users\\x\\Python313\\python.exe',
  ].join('\n');
  const found = parsePyLauncher(text);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], {
    path: 'C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    version: '3.12',
    default: true,
  });
  // 星号不能被吃进路径，默认标记也必须被识别
  assert.equal(found[0].path.includes('*'), false, '星号不属于路径');
  assert.equal(found[1].path, 'C:\\Users\\x\\Python313\\python.exe');
  assert.equal(found[1].default, false);
});

test('parsePyLauncher 忽略非版本行', () => {
  const found = parsePyLauncher('No installed Pythons found!\n\nInstalled Pythons found by py Launcher for Windows\n');
  assert.deepEqual(found, []);
  assert.deepEqual(parsePyLauncher(''), []);
  assert.deepEqual(parsePyLauncher(undefined), []);
});
