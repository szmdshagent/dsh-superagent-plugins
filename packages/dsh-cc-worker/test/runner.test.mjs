// dsh-cc-worker 自带执行器的纯函数测试：不真起 claude，只验参数拼装与校验。
// 运行：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClaudeArgs, parseStreamLog, stateBase, validateRequest } from '../lib/index.js'

const config = {
  workRoot: '/w',
  claudeBin: 'claude',
  skipPermissions: false,
  extraArgs: [],
  defaultTimeoutS: 60,
  defaultMaxTurns: 5,
}

test('默认不跳过审批', () => {
  const args = buildClaudeArgs({ task: 'hi', dir: '/w/t1' }, 'new', 'SID', config)
  assert.ok(args.includes('--permission-mode'))
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default')
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('显式开启才跳过审批', () => {
  const args = buildClaudeArgs({ task: 'hi', dir: '/w/t1' }, 'new', 'SID', { ...config, skipPermissions: true })
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.includes('--permission-mode'))
})

test('新会话用 --session-id，续跑用 --resume', () => {
  const fresh = buildClaudeArgs({ task: 'hi', dir: '/w/t1' }, 'new', 'SID', config)
  assert.equal(fresh[fresh.indexOf('--session-id') + 1], 'SID')
  const resume = buildClaudeArgs({ task: 'hi', dir: '/w/t1' }, 'resume', 'SID', config)
  assert.equal(resume[resume.indexOf('--resume') + 1], 'SID')
})

test('任务正文与轮数参数透传', () => {
  const args = buildClaudeArgs({ task: 'do it', dir: '/w/t1', maxTurns: 3 }, 'new', 'SID', config)
  assert.equal(args[args.length - 1], 'do it')
  assert.equal(args[args.indexOf('--max-turns') + 1], '3')
  assert.ok(args.at(-2) === '-p')
})

test('状态目录：main 与 lane 分开', () => {
  assert.equal(stateBase('/w/t1'), '/w/t1/.cc-worker')
  assert.equal(stateBase('/w/t1', 'w1'), '/w/t1/.cc-worker/lanes/w1')
})

test('目录必须落在 workRoot 之下', () => {
  assert.doesNotThrow(() => validateRequest({ task: 'x', dir: '/w/t1' }, config))
  assert.throws(() => validateRequest({ task: 'x', dir: '/etc' }, config), /must be under/)
  assert.throws(() => validateRequest({ task: 'x', dir: '/w-evil' }, config), /must be under/)
})

test('lane 名只允许安全字符', () => {
  assert.doesNotThrow(() => validateRequest({ task: 'x', dir: '/w/t1', lane: 'w_1-a' }, config))
  assert.throws(() => validateRequest({ task: 'x', dir: '/w/t1', lane: '../etc' }, config), /invalid lane/)
})

test('空任务被拒', () => {
  assert.throws(() => validateRequest({ task: '   ', dir: '/w/t1' }, config), /empty prompt/)
})

test('解析 stream-json：取最后一条 result', () => {
  const log = [
    '{"type":"assistant","text":"thinking"}',
    'not json at all',
    '{"type":"result","result":"42","session_id":"S9","total_cost_usd":0.05}',
  ].join('\n')
  assert.deepEqual(parseStreamLog(log), { result: '42', sessionId: 'S9', costUsd: 0.05 })
})

test('解析 stream-json：没有 result 时返回空对象', () => {
  assert.deepEqual(parseStreamLog('{"type":"assistant"}'), {})
})