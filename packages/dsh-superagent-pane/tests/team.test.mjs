// 最小回归：pane 的 team-plan 解析与 lane 枚举/存活判定。
// 运行：先 npm run build，再 node --test tests/team.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isValidLaneName, laneDir, listTeamLanes, readTeamPlan, teamStatus } from '../lib/guard.js'
import { readCcStatus } from '../src/ccvis.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pane-team-'))
  const cc = join(root, '.cc-worker')
  mkdirSync(cc, { recursive: true })
  writeFileSync(join(cc, 'team-plan.json'), JSON.stringify([
    { lane: 'ccw1', task: '子任务一' },
    { lane: 'ccw2', task: '子任务二\n第二行' },
    { lane: 'w1', task: '旧命名' },
    { lane: 'ccw9', task: '越界编号' },
    { lane: 'ccw3', task: '子任务三' },
  ]))
  const lane = (name) => {
    const dir = join(cc, 'lanes', name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  writeFileSync(join(lane('ccw1'), 'task.txt'), '子任务一\n')
  writeFileSync(join(lane('ccw1'), 'result.json'), JSON.stringify({
    ok: true, cost_usd: 1.25, num_turns: 4, session_id: 's1',
  }))
  writeFileSync(join(lane('ccw1'), 'handoff.md'), '# ok\n')
  writeFileSync(join(lane('ccw2'), 'task.txt'), '子任务二 第二行\n')
  writeFileSync(join(lane('ccw2'), 'result.json'), JSON.stringify({ ok: false, error: '测试失败', cost_usd: 0.5 }))
  // lead 有会话但没有 result.json：按活动时间算 running。
  writeFileSync(join(lane('lead'), 'task.txt'), '统筹\n')
  writeFileSync(join(lane('lead'), 'session_id'), 'lead-session\n')
  return root
}

test('lane 名与路径：安全字符集、main 与并行 lane', () => {
  assert.equal(isValidLaneName('ccw1'), true)
  assert.equal(isValidLaneName('lead'), true)
  assert.equal(isValidLaneName('a/b'), false)
  assert.equal(isValidLaneName('../x'), false)
  assert.equal(laneDir('/t', 'main'), join('/t', '.cc-worker'))
  assert.equal(laneDir('/t', 'ccw2'), join('/t', '.cc-worker', 'lanes', 'ccw2'))
})

test('team-plan 解析：合法 ccw 条目保留，旧命名/空任务单列', () => {
  const plan = readTeamPlan(fixture())
  assert.equal(plan.exists, true)
  assert.deepEqual(plan.lanes.map(entry => entry.lane), ['ccw1', 'ccw2', 'ccw3'])
  assert.equal(plan.lanes[1].task, '子任务二 第二行')
  assert.deepEqual(plan.invalid.map(entry => entry.lane), ['w1', 'ccw9'])
  assert.equal(plan.error, undefined)
})

test('team-plan 缺失/损坏如实报告', () => {
  const root = mkdtempSync(join(tmpdir(), 'pane-team-bad-'))
  assert.equal(readTeamPlan(root).exists, false)
  mkdirSync(join(root, '.cc-worker'), { recursive: true })
  writeFileSync(join(root, '.cc-worker', 'team-plan.json'), '{not json')
  assert.match(readTeamPlan(root).error, /不是合法 JSON/)
  writeFileSync(join(root, '.cc-worker', 'team-plan.json'), '{"a":1}')
  assert.match(readTeamPlan(root).error, /不是 JSON 数组/)
})

test('lane 枚举与状态：完成/失败/等待/执行中', () => {
  const root = fixture()
  const now = Date.now()
  const lanes = listTeamLanes(root, now)
  assert.deepEqual(lanes.map(item => item.lane), ['ccw1', 'ccw2', 'ccw3', 'lead'])
  const byLane = Object.fromEntries(lanes.map(item => [item.lane, item]))
  assert.equal(byLane.ccw1.state, 'done')
  assert.equal(byLane.ccw1.costUsd, 1.25)
  assert.equal(byLane.ccw1.turns, 4)
  assert.equal(byLane.ccw1.sessionId, 's1')
  assert.equal(byLane.ccw1.handoff, true)
  assert.equal(byLane.ccw2.state, 'failed')
  assert.equal(byLane.ccw2.error, '测试失败')
  assert.equal(byLane.ccw3.state, 'pending')
  assert.equal(byLane.ccw3.task, '子任务三')
  assert.equal(byLane.lead.state, 'running')
})

test('纯 team 运行也 present，并按 lane 推导整体状态', () => {
  const root = fixture()
  const status = readCcStatus(root)
  assert.equal(status.present, true)
  // lead 还在跑 → 整体优先显示 running；失败路数由 lanes 明细与面板摘要标出。
  assert.equal(status.state, 'running')
  assert.deepEqual(status.team?.lanes.map(lane => `${lane.lane}:${lane.state}`),
    ['ccw1:done', 'ccw2:failed', 'ccw3:pending', 'lead:running'])
})

test('没有计划也能枚举已有 lane 目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'pane-team-noplan-'))
  const dir = join(root, '.cc-worker', 'lanes', 'ccw1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task.txt'), '手工 lane\n')
  const status = teamStatus(root)
  assert.equal(status.plan.exists, false)
  assert.equal(status.lanes.length, 1)
  assert.equal(status.lanes[0].state, 'pending')
  assert.equal(status.lanes[0].task, '手工 lane')
})