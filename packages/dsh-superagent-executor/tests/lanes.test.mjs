// 最小回归：cc-worker team/lane 参数校验与 lane 维度状态聚合。
// 运行：先 npm run build，再 node --test tests/lanes.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ccWorkerVerdict, invokesCcWorker } from '../lib/guard.js'
import {
  costByLane, laneBase, listLaneSummaries, listLanes, listRuns, laneSummary, totalCost,
} from '../lib/state.js'

const DIR = '/home/szm/.dsh/state/superagent/work/t'
const base = `cc-worker run "做点事" --dir ${DIR} --max-turns 5`

function run(resultLine) {
  return JSON.stringify(resultLine)
}

function resultEvent({ cost = 0, turns = 0, cacheRead = 0, error = false }) {
  return { type: 'result', total_cost_usd: cost, num_turns: turns, is_error: error,
    modelUsage: { m: { cacheReadInputTokens: cacheRead } } }
}

// ——— guard ———

test('合法的 team lane 参数放行', () => {
  assert.equal(ccWorkerVerdict(`${base} --lane ccw1 --workers 2 --task "子任务"`), undefined)
  assert.equal(ccWorkerVerdict(`${base} --lane main`), undefined)
  // team 自己的 lead lane 由 cc-worker 内部使用，必须放行。
  assert.equal(ccWorkerVerdict(`${base} --lane lead`), undefined)
})

test('非法 lane 名被拒绝：旧命名与路径穿越', () => {
  assert.match(ccWorkerVerdict(`${base} --lane w1`), /ccw1\.\.ccwN/)
  assert.match(ccWorkerVerdict(`${base} --lane ../etc`), /不合法/)
  assert.match(ccWorkerVerdict(`${base} --lane ccw1/../x`), /不合法/)
})

test('lane 编号不得超过 workers（默认上限 4）', () => {
  assert.match(ccWorkerVerdict(`${base} --lane ccw3 --workers 2`), /超出团队规模/)
  assert.equal(ccWorkerVerdict(`${base} --lane ccw2 --workers 2`), undefined)
  assert.match(ccWorkerVerdict(`${base} --lane ccw5`), /超出团队规模/)
})

test('--workers 越界或缺失取值被拒绝', () => {
  assert.match(ccWorkerVerdict(`${base} --workers 5`), /1\.\.4/)
  assert.match(ccWorkerVerdict(`${base} --workers`), /缺少取值/)
  assert.match(ccWorkerVerdict(`${base} --workers abc`), /1\.\.4/)
})

test('team 不允许嵌套', () => {
  const team = `cc-worker team "总任务" --dir ${DIR} --max-turns 5`
  const old = process.env.CC_TEAM_DEPTH
  try {
    delete process.env.CC_TEAM_DEPTH
    assert.equal(ccWorkerVerdict(team), undefined)
    process.env.CC_TEAM_DEPTH = '1'
    assert.match(ccWorkerVerdict(team), /team 不能嵌套/)
  } finally {
    if (old === undefined) delete process.env.CC_TEAM_DEPTH
    else process.env.CC_TEAM_DEPTH = old
  }
})

test('--task 缺少描述被拒绝；只提到 cc-worker 名字的命令不校验', () => {
  assert.match(ccWorkerVerdict(`${base} --lane ccw1 --task`), /--task 缺少任务描述/)
  assert.equal(invokesCcWorker('cat /tmp/cc-worker.log'), false)
  assert.equal(ccWorkerVerdict('cat /tmp/cc-worker.log'), undefined)
  assert.equal(invokesCcWorker('env FOO=1 /home/szm/.local/bin/cc-worker run x'), true)
})

// ——— state：lane 路径与聚合 ———

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'exec-lanes-'))
  const mainRuns = join(root, '.cc-worker', 'runs')
  mkdirSync(mainRuns, { recursive: true })
  writeFileSync(join(mainRuns, '20260101-000000.jsonl'), run(resultEvent({ cost: 1.5, turns: 3, cacheRead: 100 })) + '\n')
  writeFileSync(join(root, '.cc-worker', 'task.txt'), 'main 任务\n')

  const lane = (name) => {
    const dir = join(root, '.cc-worker', 'lanes', name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  writeFileSync(join(lane('ccw1'), 'task.txt'), '子任务一\n')
  // 真实布局里 result.json 与 runs 归档同时存在：run 归档是可累计的权威记录。
  mkdirSync(join(lane('ccw1'), 'runs'), { recursive: true })
  writeFileSync(join(lane('ccw1'), 'runs', '20260101-000001.jsonl'),
    run(resultEvent({ cost: 2.5, turns: 5, cacheRead: 200 })) + '\n')
  writeFileSync(join(lane('ccw1'), 'result.json'), JSON.stringify({
    ok: true, cost_usd: 2.5, num_turns: 5, session_id: 's1', tokens: { cache_read: 200 },
  }))
  writeFileSync(join(lane('ccw1'), 'handoff.md'), '# done\n')
  writeFileSync(join(lane('ccw2'), 'task.txt'), '子任务二\n')
  writeFileSync(join(lane('ccw2'), 'result.json'), JSON.stringify({ ok: false, error: 'boom', cost_usd: 0.5 }))
  writeFileSync(join(lane('ccw3'), 'task.txt'), '还没开跑\n')

  // 有运行痕迹、无 result.json：新文件算 running，把时间推后 20 分钟算 failed。
  const ccw4 = lane('ccw4')
  mkdirSync(join(ccw4, 'runs'), { recursive: true })
  // 只有 assistant 事件、没有 result：正在跑或被超时杀掉，靠活动时间区分。
  writeFileSync(join(ccw4, 'runs', '20260101-000000.jsonl'), JSON.stringify({ type: 'assistant', message: {} }) + '\n')
  return root
}

test('lane 路径枚举与排序：main → ccwN', () => {
  const root = fixture()
  assert.equal(laneBase(root, 'main'), join(root, '.cc-worker'))
  assert.equal(laneBase(root, 'ccw1'), join(root, '.cc-worker', 'lanes', 'ccw1'))
  assert.deepEqual(listLanes(root), ['main', 'ccw1', 'ccw2', 'ccw3', 'ccw4'])
})

test('每个 lane 输出存活/完成/失败与自身成本', () => {
  const root = fixture()
  const now = Date.now()
  const list = listLaneSummaries(root, now)
  const byLane = Object.fromEntries(list.map(item => [item.lane, item]))
  assert.equal(byLane.main.state, 'done')
  assert.equal(byLane.main.costUsd, 1.5)
  assert.equal(byLane.ccw1.state, 'done')
  assert.equal(byLane.ccw1.costUsd, 2.5)
  assert.equal(byLane.ccw1.turns, 5)
  assert.equal(byLane.ccw1.sessionId, 's1')
  assert.equal(byLane.ccw2.state, 'failed')
  assert.equal(byLane.ccw2.error, 'boom')
  assert.equal(byLane.ccw3.state, 'idle')
  assert.equal(laneSummary(root, 'ccw4', now).state, 'running')
  assert.equal(laneSummary(root, 'ccw4', now + 20 * 60_000).state, 'failed')
})

test('成本熔断按 lane 聚合，不再只看 main', () => {
  const root = fixture()
  assert.equal(totalCost(root), 1.5 + 2.5 + 0.5)
  assert.deepEqual(costByLane(root), { main: 1.5, ccw1: 2.5, ccw2: 0.5, ccw3: 0, ccw4: 0 })
  assert.equal(listRuns(root, 'ccw1').length, 1)
  assert.equal(listRuns(root, 'ccw1')[0].costUsd, 2.5)
})