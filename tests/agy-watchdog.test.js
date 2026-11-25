// 25/11: luot implement bi han gio cua PM giet truoc khi ghi result.json (full gate cargo noi && o cuoi, agy cho lenh nen im lang).
// Khoa: han theo loai luot, im lang khi cho lenh nen khong bi giet o han thuong, ly do ket thuc doc tu tep dau ra, tu lam tiep DUNG 1 lan,
// prompt bat ghi result.json tam truoc khi kiem chung dai. agy that khong bao gio duoc goi: ANTIGRAVITY_PM_AGY tro vao script gia.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newConversation, agyTurnEndReason, humanMs } from '../src/agentapi.js';
import { loadConfig, agyTurnLimits, DEFAULT_CONFIG } from '../src/config.js';
import { createTask, contractPaths, loadTask, recordVerdict, recordDispatch, recordRun, recordProof, gate } from '../src/tasks.js';
import { kiemKhuonResult, doiChieuKhaiTest } from '../src/policy.js';
import { buildImplementMessage, buildReworkMessage, buildAutoContinueMessage, PROVISIONAL_RESULT_RULE } from '../src/prompt.js';
import { lyDoDeDoc } from '../src/auto-continue.js';
import { TOOLS_BY_NAME } from '../src/tools.js';
import { homeStateDir } from '../src/util.js';
import { tmpProject, tmpDir, cleanup, writeFile, sampleTaskArgs, PNG_1PX, tick } from './helpers.js';

const ARGON = 'gemini-4-argon-high';
const MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ENV_KEYS = ['PM_AGY_TURN_MAX_MS', 'PM_AGY_SILENT_MAX_MS', 'PM_AGY_BG_SILENT_MAX_MS'];
const KEYS = ['ANTIGRAVITY_PM_AGY', 'ANTIGRAVITY_PM_AGY_SKIP_PERMISSIONS', 'FAKE_MODE', 'FAKE_RESUME', 'FAKE_LOG', 'FAKE_KID_FILE', ...ENV_KEYS];

function withEnv(t, env) {
  const prev = {};
  for (const k of KEYS) prev[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => { for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

// ---------------------------------------------------------------- 1. han theo loai luot

test('han theo loai luot: implement / rework / message 90 phut, con lai 20; im lang 10, cho lenh nen 45; loai la = custom', (t) => {
  withEnv(t, {});
  for (const k of ['implement', 'rework', 'message']) assert.equal(agyTurnLimits(k).turnMax, 90 * MIN, k);
  for (const k of ['plan_review', 'audit', 'proof', 'custom']) assert.equal(agyTurnLimits(k).turnMax, 20 * MIN, k);
  assert.equal(agyTurnLimits('implement').silentMax, 10 * MIN);
  assert.equal(agyTurnLimits('audit').bgSilentMax, 45 * MIN);
  assert.equal(agyTurnLimits('khong-co').kind, 'custom');
  assert.equal(agyTurnLimits(undefined).turnMax, 20 * MIN);
});

test('han theo loai luot: cau hinh (loai, roi default; so = moi loai), env PM_AGY_* de len tat ca (0 = tat)', (t) => {
  withEnv(t, {});
  const cfg = { agyTurnMaxMs: { implement: 5000, default: 7000 }, agySilentMaxMs: 300, agyBackgroundSilentMaxMs: { audit: 9 } };
  assert.equal(agyTurnLimits('implement', cfg).turnMax, 5000);
  assert.equal(agyTurnLimits('audit', cfg).turnMax, 7000);
  assert.equal(agyTurnLimits('rework', cfg).turnMax, 7000, 'object cua nguoi dung khong co rework thi dung default CUA NO');
  assert.equal(agyTurnLimits('proof', cfg).silentMax, 300);
  assert.equal(agyTurnLimits('audit', cfg).bgSilentMax, 9);
  assert.equal(agyTurnLimits('implement', cfg).bgSilentMax, 45 * MIN, 'object khong co loai va khong co default thi roi ve mac dinh');
  Object.assign(process.env, { PM_AGY_TURN_MAX_MS: '1234', PM_AGY_SILENT_MAX_MS: '0', PM_AGY_BG_SILENT_MAX_MS: '55' });
  for (const k of ['implement', 'audit']) {
    assert.deepEqual(agyTurnLimits(k, cfg), { kind: k, turnMax: 1234, silentMax: 0, bgSilentMax: 55 });
  }
  process.env.PM_AGY_TURN_MAX_MS = 'abc';   // env hong: bo qua, khong lam hong han
  assert.equal(agyTurnLimits('implement', cfg).turnMax, 5000);
});

test('loadConfig: khoa agy*MaxMs gop voi mac dinh theo loai, khong bao "khoa la"; gia tri hong thi canh bao va dung mac dinh', (t) => {
  withEnv(t, {});
  const ok = tmpProject({ agyTurnMaxMs: { default: 1000 } });
  t.after(() => cleanup(ok));
  const cfg = loadConfig(ok);
  assert.ok(!cfg.warnings.some((w) => /agy/.test(w)), cfg.warnings.join('\n'));
  assert.equal(agyTurnLimits('audit', cfg).turnMax, 1000);
  assert.equal(agyTurnLimits('implement', cfg).turnMax, 90 * MIN, 'gop theo khoa: implement mac dinh van con');
  const bad = tmpProject({ agySilentMaxMs: 'muoi phut', agyTurnMaxMs: { implement: -1 } });
  t.after(() => cleanup(bad));
  const cfg2 = loadConfig(bad);
  assert.ok(cfg2.warnings.some((w) => /agySilentMaxMs/.test(w)), cfg2.warnings.join('\n'));
  assert.ok(cfg2.warnings.some((w) => /agyTurnMaxMs/.test(w)), cfg2.warnings.join('\n'));
  assert.deepEqual(cfg2.agySilentMaxMs, DEFAULT_CONFIG.agySilentMaxMs);
  assert.equal(agyTurnLimits('implement', cfg2).turnMax, 90 * MIN);
});

// ---------------------------------------------------------------- 2. im lang khi cho lenh nen

// FAKE_MODE: bgline = in dong "waiting for 1 background task(s)" roi im; bgkid = sinh lenh con CUA AGENT (env ANTIGRAVITY_AGENT=1) trong nhom
// roi im; helperkid = sinh lenh con KHONG mang bien do (phu tro cua agy, vd MCP) roi im; silent = im luon. FAKE_RESUME (luot --conversation):
// silent = im luon, khac = in result roi thoat. FAKE_LOG: moi lan chay ghi { args, pid }.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const a = process.argv.slice(2);
const i = a.indexOf('--conversation');
const id = i >= 0 ? a[i + 1] : 'abcd2511-2222-3333-4444-555555555555';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, pid: process.pid }) + '\\n');
console.log(JSON.stringify({ event: 'init', conversation_id: id, init: { cwd: process.cwd() } }));
const mode = i >= 0 ? (process.env.FAKE_RESUME || 'done') : process.env.FAKE_MODE;
// lenh con la node, khong phai /bin/sleep: ps -E cua macOS khong in env cua binary he thong (platform binary), lenh cua agent (cargo, test) thi in
const kid = (env) => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', env }); if (process.env.FAKE_KID_FILE) fs.writeFileSync(process.env.FAKE_KID_FILE, String(c.pid)); };
if (mode === 'bgline') { console.log('root agent idle; waiting for 1 background task(s) to finish'); console.log(''); setInterval(() => {}, 1000); }
else if (mode === 'bgkid') { kid({ ...process.env, ANTIGRAVITY_AGENT: '1' }); setInterval(() => {}, 1000); }
else if (mode === 'helperkid') { const env = { ...process.env }; delete env.ANTIGRAVITY_AGENT; kid(env); setInterval(() => {}, 1000); }
else if (mode === 'silent') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS' } }));
`;

function fakeAgy(t, env) {
  const dir = tmpDir('agpm-wd-');
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  const kidFile = path.join(dir, 'kid.pid');
  withEnv(t, { ANTIGRAVITY_PM_AGY: bin, ANTIGRAVITY_PM_AGY_SKIP_PERMISSIONS: '1', FAKE_LOG: log, FAKE_KID_FILE: kidFile, ...env });
  t.after(() => {
    for (const c of calls()) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* da het */ } }
    fs.rmSync(path.join(homeStateDir(), 'agy-conversations.json'), { force: true });
    cleanup(dir);
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const kidPid = () => (fs.existsSync(kidFile) ? Number(fs.readFileSync(kidFile, 'utf8')) : null);
  return { dir, calls, kidPid };
}

async function waitDead(pid, ms) {
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < ms) await sleep(50);
  return !alive(pid);
}

async function startTurn(t, mode, env, opts = {}) {
  const fake = fakeAgy(t, { FAKE_MODE: mode, ...env });
  const project = tmpProject({ defaultModel: ARGON });
  t.after(() => cleanup(project));
  const r = await newConversation({ prompt: 'x', model: ARGON, cwd: project, ...opts });
  return { ...fake, pid: r.parsed.pid, out: r.parsed.out };
}

test('agy in "waiting for background task" roi im: KHONG bi giet o han im lang thuong, chi o han cho lenh nen', { timeout: 20000 }, async (t) => {
  const { pid, out } = await startTurn(t, 'bgline', { PM_AGY_SILENT_MAX_MS: '400', PM_AGY_BG_SILENT_MAX_MS: '3000' });
  await sleep(1600);   // > 4 lan han im lang thuong
  assert.ok(alive(pid), 'agy dang cho lenh nen bi giet o han im lang 400 ms');
  assert.ok(await waitDead(pid, 6000), 'agy cho lenh nen van song sau han cho lenh nen');
  assert.match(fs.readFileSync(out, 'utf8'), /agy produced no output for 3000 ms while waiting for a background task/);
});

test('nhom agy con lenh CUA AGENT (ANTIGRAVITY_AGENT=1) dang song: im lang khong bi giet o han thuong; giet thi ca lenh con', { timeout: 20000 }, async (t) => {
  const { pid, out, kidPid } = await startTurn(t, 'bgkid', { PM_AGY_SILENT_MAX_MS: '400', PM_AGY_BG_SILENT_MAX_MS: '3000' });
  await sleep(1600);
  assert.ok(alive(pid), 'agy co lenh con cua agent bi giet o han im lang 400 ms');
  assert.ok(await waitDead(pid, 6000), 'agy van song sau han cho lenh nen');
  assert.match(fs.readFileSync(out, 'utf8'), /while waiting for a background task/);
  assert.ok(kidPid() && await waitDead(kidPid(), 4000), 'lenh con cua agent con song sau khi PM dung nhom');
});

test('lenh con KHONG phai cua agent (phu tro cua agy) khong keo dai han im lang (#1230 khong hoi quy)', { timeout: 20000 }, async (t) => {
  const { pid, out } = await startTurn(t, 'helperkid', { PM_AGY_SILENT_MAX_MS: '500', PM_AGY_BG_SILENT_MAX_MS: '60000' });
  assert.ok(await waitDead(pid, 4000), 'agy chi co lenh phu tro van song qua han im lang thuong');
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /agy produced no output for 500 ms/);
  assert.doesNotMatch(text, /while waiting for a background task/);
});

test('han cung van ap khi agy dang cho lenh nen', { timeout: 20000 }, async (t) => {
  const { pid, out } = await startTurn(t, 'bgline', { PM_AGY_TURN_MAX_MS: '1500', PM_AGY_SILENT_MAX_MS: '300', PM_AGY_BG_SILENT_MAX_MS: '0' });
  assert.ok(await waitDead(pid, 6000), 'agy cho lenh nen van song sau han cung');
  assert.match(fs.readFileSync(out, 'utf8'), /agy turn timed out after 1500 ms/);
});

test('loai luot + cau hinh di xuong watchTurn: newConversation kind=implement dung han implement cua cfg, su kien loi ghi kind', { timeout: 20000 }, async (t) => {
  const cfg = { agySilentMaxMs: { implement: 600, default: 0 }, agyTurnMaxMs: 0 };
  const { pid, out } = await startTurn(t, 'silent', {}, { kind: 'implement', cfg });
  assert.ok(await waitDead(pid, 5000), 'han im lang cua implement trong cfg khong duoc ap');
  const end = agyTurnEndReason(out);
  assert.equal(end.watchdog, true);
  assert.equal(end.kind, 'implement');
  assert.match(end.error, /agy produced no output for 600 ms/);
});

// ---------------------------------------------------------------- 3. ly do ket thuc

const RESULT = (r) => JSON.stringify({ event: 'result', result: { conversation_id: 'c', response: 'NOI DUNG CUA AGENT', ...r } });

test('agyTurnEndReason: tep that bi watchdog cu dung (khong co kind) -> watchdog, loi, finished_reason; KHONG tra ve response', (t) => {
  const dir = tmpDir('agpm-wd-end-');
  t.after(() => cleanup(dir));
  const f = path.join(dir, 'run.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ event: 'step_update', step_update: { step_index: 224, state: 'ACTIVE', tool_name: 'run_command' } }),
    'root agent idle; waiting for 1 background task(s) to finish', '',
    JSON.stringify({ event: 'error', error: 'agy turn timed out after 1200000 ms' }),
    'error: interrupted',
    RESULT({ status: 'ERROR', error: 'interrupted', finished_reason: 'interrupted' }), '',
  ].join('\n'));
  const end = agyTurnEndReason(f);
  assert.deepEqual(end, { error: 'agy turn timed out after 1200000 ms', watchdog: true, kind: null, status: 'ERROR', finishedReason: 'interrupted', failed: true });
  assert.ok(!JSON.stringify(end).includes('NOI DUNG CUA AGENT'));
  assert.equal(lyDoDeDoc(end.error), 'agy turn timed out after 20 min');
  assert.equal(humanMs(600000), '10 min');
  assert.equal(humanMs(400), '0.4 s');
});

test('agyTurnEndReason: luot xong / loi cua agy (khong phai PM) / dong result bi cat o dau doan doc / khong co tep', (t) => {
  const dir = tmpDir('agpm-wd-end-');
  t.after(() => cleanup(dir));
  const ok = path.join(dir, 'ok.jsonl');
  fs.writeFileSync(ok, `${JSON.stringify({ event: 'init' })}\n${RESULT({ status: 'SUCCESS' })}\n`);
  assert.deepEqual(agyTurnEndReason(ok), { error: null, watchdog: false, kind: null, status: 'SUCCESS', finishedReason: null, failed: false });
  const err = path.join(dir, 'err.jsonl');
  fs.writeFileSync(err, `${JSON.stringify({ event: 'error', error: 'quota exceeded' })}\n${RESULT({ status: 'ERROR', finished_reason: 'error' })}\n`);
  const e = agyTurnEndReason(err);
  assert.equal(e.watchdog, false);
  assert.equal(e.failed, true);
  assert.equal(e.finishedReason, 'error');
  const big = path.join(dir, 'big.jsonl');   // response 300 KB: dau dong result nam ngoai 256 KB cuoi
  fs.writeFileSync(big, `${RESULT({ status: 'ERROR', response: 'x'.repeat(300000), finished_reason: 'interrupted' })}\n`);
  assert.equal(agyTurnEndReason(big).finishedReason, 'interrupted');
  assert.equal(agyTurnEndReason(path.join(dir, 'khong-co.jsonl')), null);
  assert.equal(agyTurnEndReason(null), null);
});

// ---------------------------------------------------------------- 4. tu lam tiep 1 lan (pm_status)

const call = async (name, args) => { const out = await TOOLS_BY_NAME.get(name).handler(args); return typeof out === 'string' ? { text: out } : out; };

async function implementTask(t, env) {
  const fake = fakeAgy(t, { FAKE_MODE: 'silent', ...env });
  const dir = tmpProject({ defaultModel: ARGON, testCommand: 'cargo test --workspace' });
  t.after(() => cleanup(dir));
  const created = await call('pm_task_create', { project: dir, title: 'a', brief: 'b', definitionOfDone: ['c'] });
  const taskId = /T\d{4}-[a-z0-9-]+/.exec(created.text)[0];
  await call('pm_plan', { project: dir, taskId, content: '# x\n1. lam\n2. test', files: ['src/a.js'] });
  await call('pm_dispatch', { project: dir, taskId, kind: 'implement', force: true });
  const [first] = fake.calls();
  assert.ok(await waitDead(first.pid, 5000), 'kich ban hong: luot implement gia khong bi watchdog dung');
  return { ...fake, dir, taskId };
}

test('pm_status: luot implement bi watchdog dung, chua co result.json -> noi ly do va tu gui DUNG 1 tin lam tiep cho vong nay', { timeout: 30000 }, async (t) => {
  const { dir, taskId, calls } = await implementTask(t, { PM_AGY_SILENT_MAX_MS: '400', FAKE_RESUME: 'silent' });
  const s1 = await call('pm_status', { project: dir, taskId });
  assert.match(s1.text, /Luot agy: BI PM DUNG \(watchdog: agy produced no output for 0\.4 s\)/, s1.text);
  assert.match(s1.text, /TU LAM TIEP \(1 lan, vong 0\)/, s1.text);
  assert.equal(calls().length, 2, 'phai gui dung 1 tin lam tiep');
  const resume = calls()[1].args;
  assert.ok(resume.includes('--conversation'));
  const msg = resume[resume.indexOf('--print') + 1];
  assert.match(msg, /het han gio cua PM/);
  assert.match(msg, /"tests": \{"status": "pending"\}/);
  assert.match(msg, /KHONG chay full gate .*cargo test --workspace/);
  const cfg = loadConfig(dir);
  const task = loadTask(cfg, taskId);
  assert.equal(task.autoContinue.round, task.round);
  assert.ok(task.dispatches.some((d) => d.kind === 'auto_continue'));
  // luot lam tiep CUNG bi dung: khong gui lan hai trong vong nay
  assert.ok(await waitDead(calls()[1].pid, 5000), 'kich ban hong: luot lam tiep khong bi watchdog dung');
  const s2 = await call('pm_status', { project: dir, taskId, nudge: false });
  assert.match(s2.text, /Luot agy: BI PM DUNG/, s2.text);
  assert.match(s2.text, /da tu lam tiep 1 lan o vong 0/, s2.text);
  assert.equal(calls().length, 2, 'tu lam tiep lan hai trong cung vong');
});

test('pm_status: luot bi dung nhung result.json da moi (ghi sau lan giao) -> khong tu lam tiep', { timeout: 30000 }, async (t) => {
  const { dir, taskId, calls } = await implementTask(t, { PM_AGY_SILENT_MAX_MS: '400' });
  const cfg = loadConfig(dir);
  tick();
  writeFile(contractPaths(cfg, loadTask(cfg, taskId)).result, JSON.stringify({ phase: 'IMPLEMENT', summary: 'x', files_changed: [], tests: { status: 'pending' } }));
  const s = await call('pm_status', { project: dir, taskId });
  assert.match(s.text, /Luot agy: BI PM DUNG/, s.text);
  assert.doesNotMatch(s.text, /TU LAM TIEP/);
  assert.equal(calls().length, 1);
});

// ---------------------------------------------------------------- 5. prompt + khuon result.json tam

test('prompt implement / rework / tu lam tiep: ghi result.json TAM truoc kiem chung dai, tung lenh rieng, test nham dich, full gate la cua PM', () => {
  const dir = tmpProject({ testCommand: 'cargo test --workspace' });
  const cfg = loadConfig(dir);
  const task = createTask(cfg, sampleTaskArgs());
  const impl = buildImplementMessage(cfg, task);
  assert.ok(impl.includes(PROVISIONAL_RESULT_RULE));
  assert.match(PROVISIONAL_RESULT_RULE, /TRUOC khi bat dau build/);
  assert.match(impl, /"tests": \{"status": "pending"\}/);
  assert.match(impl, /"status": "passed\|failed\|pending"/, 'schema tests co truong status');
  assert.match(impl, /TUNG lenh kiem chung rieng.*KHONG noi .*`&&`/);
  assert.match(impl, /NHAM DICH/);
  assert.match(impl, /`cargo test --workspace` la viec PM se tu chay .*PM dung luot sau 90 phut/);
  assert.doesNotMatch(impl, /Chay test cua project va ghi exit code that vao result\.json: `cargo test/, 'khong con bat agent chay full gate');
  const rework = buildReworkMessage(cfg, { ...task, round: 1 }, { findings: ['a.js:1 sai'] });
  assert.ok(rework.includes(PROVISIONAL_RESULT_RULE));
  assert.match(rework, /TUNG lenh kiem chung rieng/);
  const cont = buildAutoContinueMessage(cfg, task, 'agy turn timed out after 90 min');
  assert.match(cont, /agy turn timed out after 90 min/);
  assert.match(cont, /"tests": \{"status": "pending"\}/);
  cleanup(dir);
});

test('khuon result.json: tests {status: "pending"} hop le; thieu ca hai truong / status khac khong exitCode van SAI KHUON', () => {
  const base = { phase: 'IMPLEMENT', summary: 'x', files_changed: [] };
  assert.deepEqual(kiemKhuonResult({ ...base, tests: { status: 'pending' } }), []);
  assert.deepEqual(kiemKhuonResult({ ...base, tests: { status: 'pending', exitCode: 0 } }), []);
  for (const tests of [{}, { status: 'PASS' }, { status: 'passed' }, { status: 'pending', exitCode: 'x' }]) {
    assert.ok(kiemKhuonResult({ ...base, tests }).some((l) => /exitCode/.test(l)), JSON.stringify(tests));
  }
  const xmlDo = { source: 'xml', failures: 2, errors: 0, failedNames: ['A'] };
  assert.equal(doiChieuKhaiTest({ tests: { status: 'pending' } }, xmlDo), null, 'bao cao tam khong khai so nao: khong phai khai sai');
  assert.match(doiChieuKhaiTest({ tests: { exitCode: 0, failed: 0 } }, xmlDo), /KHAI SAI/);
});

test('cong: result.json tam (tests pending) KHONG thay duoc lan chay test xanh cua PM; co lan chay do thi dat kem canh bao', () => {
  const dir = tmpProject({ testCommand: 'echo ok' });
  const cfg = loadConfig(dir);
  const task = createTask(cfg, sampleTaskArgs());
  const p = contractPaths(cfg, task);
  const ctx = { changedFiles: ['src/Kinh.kt', 'src/test/java/KinhTest.kt'] };
  writeFile(p.plan, '# Ke hoach\n- Buoc 1');
  recordVerdict(cfg, task, { kind: 'plan', verdict: 'pass' });
  recordDispatch(cfg, task, { kind: 'implement', conversationId: 'c-test' });
  tick();
  writeFile(p.result, JSON.stringify({ phase: 'IMPLEMENT', summary: 'da lam', files_changed: ctx.changedFiles, tests: { status: 'pending' } }));
  recordVerdict(cfg, task, { kind: 'audit', verdict: 'pass' });
  recordVerdict(cfg, task, { kind: 'review', verdict: 'pass' });
  const img = path.join(p.proofDir, 'shot.png');
  writeFile(img, PNG_1PX);
  recordProof(cfg, task, { label: 'man hinh', provider: 'adb', file: img, bytes: PNG_1PX.length });
  const g1 = gate(cfg, task, ctx);
  assert.equal(g1.ok, false, 'pending + chua co lan chay test cua PM ma cong dat');
  assert.ok(g1.missing.some((m) => /test/i.test(m)), g1.missing.join('\n'));
  assert.ok(!g1.missing.some((m) => /sai khuon/.test(m)), g1.missing.join('\n'));
  recordRun(cfg, task, { kind: 'test', command: 'echo ok', exitCode: 0, durationMs: 10, evidence: { source: 'stdout', weak: true, noop: false, ok: true, reason: 'test' } });
  const g2 = gate(cfg, task, ctx);
  assert.equal(g2.ok, true, g2.missing.join('\n'));
  assert.ok(g2.warnings.some((w) => /bao cao TAM/.test(w)), g2.warnings.join('\n'));
  cleanup(dir);
});
