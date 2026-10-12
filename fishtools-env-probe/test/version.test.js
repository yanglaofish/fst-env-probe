import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, compilePattern, extractVersion, parseVersion, satisfiesVersion } from '../lib/version.js';
test('parseVersion 解析常见版本写法', () => {
  assert.deepEqual(parseVersion('3.13.13'), [3, 13, 13, 0]);
  assert.deepEqual(parseVersion('go1.22.1'), [1, 22, 1, 0]);
  assert.deepEqual(parseVersion('v2.50.1.windows.1'), [2, 50, 1, 0]);
  assert.deepEqual(parseVersion('26.3.2'), [26, 3, 2, 0]);
  assert.equal(parseVersion('unknown'), null);
  assert.equal(parseVersion(''), null);
});

test('compareVersions 按段比较', () => {
  assert.equal(compareVersions('3.9.0', '3.10.0'), -1);
  assert.equal(compareVersions('3.10.0', '3.9.0'), 1);
  assert.equal(compareVersions('3.9', '3.9.0'), 0);
  assert.equal(compareVersions('abc', '3.9'), null);
});

test('extractVersion 优先取第一行，避免误取依赖版本', () => {
  const yum = '4.14.0\n  Installed: rpm-4.16.1.3-9.el9\n  Built against: python3.9-3.9.18';
  assert.equal(extractVersion(yum), '4.14.0');
  assert.equal(extractVersion('git version 2.50.1.windows.1'), '2.50.1');
  assert.equal(extractVersion('openjdk version "17.0.9" 2023-10-17'), '17.0.9');
  assert.equal(extractVersion('v1.29.380'), '1.29.380');
  assert.equal(extractVersion('conda 26.3.2'), '26.3.2');
  assert.equal(extractVersion(''), null);
  assert.equal(extractVersion('no digits here'), null);
});

test('extractVersion 支持自定义正则', () => {
  assert.equal(extractVersion('7-Zip 23.01 (x64) : Copyright', { pattern: '(\\d+\\.\\d+)' }), '23.01');
});

test('satisfiesVersion 覆盖比较符与常用范围写法', () => {
  assert.equal(satisfiesVersion('3.13.13', '>=3.9'), true);
  assert.equal(satisfiesVersion('3.8.0', '>=3.9'), false);
  assert.equal(satisfiesVersion('3.9.5', '>=3.9 <4'), true);
  assert.equal(satisfiesVersion('4.0.0', '>=3.9 <4'), false);
  assert.equal(satisfiesVersion('4.0.0', '>=3.9,<4'), false);
  assert.equal(satisfiesVersion('3.9.5', '>= 3.9'), true);
  assert.equal(satisfiesVersion('3.9.5', '^3.9'), true);
  assert.equal(satisfiesVersion('4.0.0', '^3.9'), false);
  assert.equal(satisfiesVersion('0.2.5', '^0.2.3'), true);
  assert.equal(satisfiesVersion('0.3.0', '^0.2.3'), false);
  assert.equal(satisfiesVersion('3.9.9', '~3.9'), true);
  assert.equal(satisfiesVersion('3.10.0', '~3.9'), false);
  assert.equal(satisfiesVersion('3.12.1', '3.12.x'), true);
  assert.equal(satisfiesVersion('3.13.1', '3.12.x'), false);
  assert.equal(satisfiesVersion('2.0.0', '*'), true);
  assert.equal(satisfiesVersion('2.0.0', ''), true);
  assert.equal(satisfiesVersion('26.3.2', '>=3.9'), true);
  assert.equal(satisfiesVersion('not-a-version', '>=3.9'), false);
  assert.equal(satisfiesVersion('1.0.0', 'not-a-range'), false);
});

test('compilePattern 拒绝非法或过长的正则', () => {
  assert.equal(compilePattern('(\\d+\\.\\d+)').source, '(\\d+\\.\\d+)');
  assert.equal(compilePattern('([unclosed'), null);
  assert.equal(compilePattern(''), null);
  assert.equal(compilePattern(undefined), null);
  assert.equal(compilePattern('x'.repeat(300)), null);
});

test('extractVersion 在自定义正则非法或不匹配时回退通用提取', () => {
  // 非法正则不能让检测整体失败
  assert.equal(extractVersion('7-Zip 23.01', { pattern: '([unclosed' }), '23.01');
  // 正则合法但没匹配上，仍然给出可用版本
  assert.equal(extractVersion('version 1.2.3', { pattern: 'v(\\d+\\.\\d+)' }), '1.2.3');
  // 正常命中时以正则结果为准
  assert.equal(extractVersion('mycli v2.7.3 build 9', { pattern: 'v(\\d+\\.\\d+)' }), '2.7');
  // 带 g 标志的正则不会因为 lastIndex 残留而丢结果
  const greedy = { pattern: '(\\d+\\.\\d+)' };
  assert.equal(extractVersion('a 1.1.1', greedy), '1.1');
  assert.equal(extractVersion('a 2.2.2', greedy), '2.2');
});
