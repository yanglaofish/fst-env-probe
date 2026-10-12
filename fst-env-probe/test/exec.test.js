import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPowerShellError,
  firstLine,
  joinPowerShell,
  parseJsonLoose,
  pwshJson,
  resolvePowerShell,
  toArray,
} from '../lib/exec.js';
import { createFallbackRunProcess } from '../lib/run-process.js';

test('joinPowerShell 不产生空的 ;; 语句', () => {
  const script = joinPowerShell(['$a=1;', '$b=2', '   ', '$c=3;;']);
  assert.equal(script, '$a=1;$b=2;$c=3');
  assert.ok(!script.includes(';;'));
});

test('joinPowerShell 保留哈希字面量内部的单分号', () => {
  const script = joinPowerShell(['$x=1', '[pscustomobject]@{a=$x;b=2} | ConvertTo-Json -Compress']);
  assert.equal(script, '$x=1;[pscustomobject]@{a=$x;b=2} | ConvertTo-Json -Compress');
});

test('cleanPowerShellError 还原 CLIXML 报错文本', () => {
  const clixml =
    '#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">At line:1 char:5_x000D__x000A_+ $a=@{;}_x000D__x000A_</S><S S="Error">Missing } in hash literal.</S></Objs>';
  const message = cleanPowerShellError(clixml);
  assert.ok(message.includes('At line:1'), message);
  assert.ok(!message.includes('CLIXML'));
  assert.equal(cleanPowerShellError('plain error\nsecond line'), 'plain error');
  assert.equal(cleanPowerShellError(''), '');
});

test('parseJsonLoose 容忍 BOM 与前后噪声', () => {
  assert.deepEqual(parseJsonLoose('\uFEFF{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('warning\n{"a":[1,2]}\ntrailing'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('[1,2,3]'), [1, 2, 3]);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose('   '), null);
  assert.equal(parseJsonLoose('not json at all'), null);
});

test('toArray 与 firstLine 的边界行为', () => {
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray(1), [1]);
  assert.deepEqual(toArray([1, 2]), [1, 2]);
  assert.equal(firstLine('a\r\nb'), 'a');
  assert.equal(firstLine(''), '');
});

test('pwshJson 能取到结构化数据并给出可读错误', { skip: process.platform !== 'win32' }, async () => {
  const executable = await resolvePowerShell();
  assert.ok(executable, 'Windows 上应当能找到 PowerShell');
  const runProcess = createFallbackRunProcess();

  const ok = await pwshJson(runProcess, '[pscustomobject]@{answer=41+1;name="env-probe"} | ConvertTo-Json -Depth 3 -Compress', {
    timeoutMs: 20000,
  });
  assert.equal(ok.ok, true, ok.error?.message);
  assert.equal(ok.data.answer, 42);
  assert.equal(ok.data.name, 'env-probe');

  // 故意制造语法错误：必须失败，且错误信息不能只是 '#< CLIXML'
  const syntaxError = await pwshJson(runProcess, '$a=@{;};[pscustomobject]@{b=1} | ConvertTo-Json', { timeoutMs: 20000 });
  assert.equal(syntaxError.ok, false);
  assert.ok(syntaxError.error.message.length > 0);
  assert.notEqual(syntaxError.error.message.trim(), '#< CLIXML');
});

test('pwshJson 在非 Windows 平台明确报错', { skip: process.platform === 'win32' }, async () => {
  const runProcess = createFallbackRunProcess();
  const result = await pwshJson(runProcess, '[pscustomobject]@{a=1} | ConvertTo-Json', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NO_POWERSHELL');
});
