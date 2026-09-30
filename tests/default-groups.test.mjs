/**
 * default-groups.test.mjs — 内置默认来源目录里的「WorkBuddy 专家」发现机制。
 *
 * 规则：默认态（source === 'default'）扫描 `<WORKBUDDY_HOME>/plugins/marketplaces/<市场>/plugins`，
 * 每个存在的市场产出一个 `optional: true` 候选组，但**只有该市场里真的存在智能体
 * （kind:'agent'）时才注入**（判据是智能体数，不是总条目数 —— 纯插件市场不该被带进来）；
 * 用户保存过来源目录（source === 'file'）后完全以 store 为准，不再注入。
 *
 * 全程用 WORKBUDDY_HOME / DSH_SKILL_CENTER_STORE 注入临时目录，不碰真实市场目录与真实技能。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHost, call } from './_harness.mjs'

const results = []
function check(label, ok, detail) {
	const pass = Boolean(ok)
	results.push({ label, ok: pass })
	console.log(`${pass ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 造一个真智能体目录：`.codebuddy-plugin/plugin.json`（agents[] 非空）+ agents/*.md。 */
async function makeAgent(dir, { name, zh }) {
	await mkdir(join(dir, '.codebuddy-plugin'), { recursive: true })
	await mkdir(join(dir, 'agents'), { recursive: true })
	await writeFile(
		join(dir, '.codebuddy-plugin', 'plugin.json'),
		JSON.stringify({
			name,
			agentName: name,
			agents: ['./agents/lead.md'],
			displayName: { zh },
			displayDescription: { zh: `${zh} 的描述` },
		}),
		'utf8',
	)
	await writeFile(join(dir, 'agents', 'lead.md'), `# ${name} lead\n`, 'utf8')
}

/** 造一个技能型插件（只有 SKILL.md —— 不该被当成智能体，也不该让空市场被注入）。 */
async function makeSkillPlugin(dir, name) {
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 技能型插件\n---\n\n正文\n`, 'utf8')
}

const base = await mkdtemp(join(tmpdir(), 'dsh-skill-center-defaults-'))
const wb = join(base, 'wb')
const markets = join(wb, 'plugins', 'marketplaces')
const store = join(base, 'store.json') // 不存在 ⇒ 走内置默认

// 市场 1：experts —— 1 个真智能体 + 1 个技能型插件（有智能体 ⇒ 该组应注入）
await makeAgent(join(markets, 'experts', 'plugins', 'real-expert'), { name: 'real-expert', zh: '真专家' })
await makeSkillPlugin(join(markets, 'experts', 'plugins', 'skill-only'), 'skill-only')
// 市场 2：codebuddy-plugins-official —— 只有技能型（= 空市场，绝不能注入）
await makeSkillPlugin(join(markets, 'codebuddy-plugins-official', 'plugins', 'skill-a'), 'skill-a')
await makeSkillPlugin(join(markets, 'codebuddy-plugins-official', 'plugins', 'skill-b'), 'skill-b')
// 市场 3：my-experts —— 1 个真智能体
await makeAgent(join(markets, 'my-experts', 'plugins', 'my-lead'), { name: 'my-lead', zh: '我的专家' })
// 市场 4：cb_teams_marketplace —— 1 个真智能体（名字带下划线，id 必须 slug 化）
await makeAgent(join(markets, 'cb_teams_marketplace', 'plugins', 'team-a'), { name: 'team-a', zh: '团队A' })
// 市场 5：只有目录、没有 plugins 子目录 ⇒ 不产出
await mkdir(join(markets, 'no-plugins-dir'), { recursive: true })

const host = await startHost(
	{},
	{ WORKBUDDY_HOME: wb, DSH_SKILL_CENTER_STORE: store, DSH_SKILL_CENTER_NO_SPAWN: '1' },
)
const body = (await call(host.byPath, 'GET', '/api/skill-center/list')).json
const ids = body.groups.map((g) => g.id)
const labelOf = (id) => body.groups.find((g) => g.id === id)?.label

check('默认态被识别（source=default）', body.source === 'default', `source=${body.source}`)
check('两个固定组原样保留', ids.includes('dsh') && ids.includes('workbuddy'), `ids=${ids.join(', ')}`)
check(
	'有真智能体的市场被注入（experts / my-experts / cb_teams_marketplace）',
	['workbuddy-experts', 'workbuddy-my-experts', 'workbuddy-cb-teams-marketplace'].every((id) => ids.includes(id)),
	`ids=${ids.join(', ')}`,
)
check(
	'只有技能型的市场被丢弃（codebuddy-plugins-official 不得出现）',
	!ids.includes('workbuddy-codebuddy-plugins-official'),
	`ids=${ids.join(', ')}`,
)
check('没有 plugins 子目录的市场不产出', !ids.includes('workbuddy-no-plugins-dir'), `ids=${ids.join(', ')}`)
check('组总数 = 2 固定 + 3 真专家市场', body.groups.length === 5, `groups=${body.groups.length}` + ` ids=${ids.join(', ')}`)
check('experts → label「workbuddy专家」', labelOf('workbuddy-experts') === 'workbuddy专家', `label=${labelOf('workbuddy-experts')}`)
check('my-experts → label「workbuddy专家（我的）」', labelOf('workbuddy-my-experts') === 'workbuddy专家（我的）', `label=${labelOf('workbuddy-my-experts')}`)
check('cb_teams_marketplace → label「workbuddy团队」', labelOf('workbuddy-cb-teams-marketplace') === 'workbuddy团队', `label=${labelOf('workbuddy-cb-teams-marketplace')}`)
check('可选组在 list 里带 optional:true', body.groups.find((g) => g.id === 'workbuddy-experts')?.optional === true)

const experts = body.groups.find((g) => g.id === 'workbuddy-experts')
const agent = experts.skills.find((s) => s.id === 'real-expert')
check('可选组里的真智能体被判为 kind=agent', agent?.kind === 'agent', `kind=${agent?.kind}`)
check('智能体名字/描述取自清单（zh 优先）', agent?.name === '真专家' && agent?.description === '真专家 的描述', `${agent?.name} / ${agent?.description}`)
check('同组里的技能型插件仍是技能', experts.skills.find((s) => s.id === 'skill-only')?.kind === 'dir', `kind=${experts.skills.find((s) => s.id === 'skill-only')?.kind}`)
check('智能体已注册进 DSH 技能表（registered=true）', agent?.registered === true, `registered=${agent?.registered}`)
check('注册名 = agentId（真的进了假的 ctx.skills）', host.registry.entries.has('real-expert'), `注册表含 real-expert=${host.registry.entries.has('real-expert')}`)

const enabledTotal = body.groups.reduce((sum, g) => sum + g.skills.filter((s) => s.enabled !== false).length, 0)
check(
	'registry 不变式仍成立（registered + failed === 启用数）',
	body.registry.registered + body.registry.failed === enabledTotal,
	`注册 ${body.registry.registered} + 失败 ${body.registry.failed} = 启用 ${enabledTotal}`,
)

// —— defaults 与实际生效一致（"重置后看到的"必须等于"重置后得到的"）——
const groupsRoute = await call(host.byPath, 'GET', '/api/skill-center/groups')
const defaults = groupsRoute.json.defaults
const defaultIds = defaults.map((g) => g.id)
check(
	'GET /groups 的 defaults 含可选组、且已剔除空市场',
	defaultIds.includes('workbuddy-experts') && !defaultIds.includes('workbuddy-codebuddy-plugins-official'),
	`defaults=${defaultIds.join(', ')}`,
)
check('defaults 里的可选组带 optional:true', defaults.find((g) => g.id === 'workbuddy-experts')?.optional === true)

// —— 用户保存过来源目录：不再注入任何可选组，也不强塞两个固定组 ——
const saved = await call(host.byPath, 'POST', '/api/skill-center/groups', {
	groups: [{ id: 'mine', label: '我的目录', root: join(markets, 'experts', 'plugins') }],
})
check('保存来源目录成功（source=file）', saved.status === 200 && saved.json.source === 'file', `status=${saved.status} source=${saved.json?.source}`)
const afterSave = (await call(host.byPath, 'GET', '/api/skill-center/list')).json
const savedIds = afterSave.groups.map((g) => g.id)
check(
	'保存后完全以 store 为准：不注入可选组',
	afterSave.source === 'file' && savedIds.length === 1 && savedIds[0] === 'mine',
	`source=${afterSave.source} ids=${savedIds.join(', ')}`,
)
check('保存后的目录里的智能体照常注册', afterSave.registry.registered >= 1 && host.registry.entries.has('real-expert'), `registered=${afterSave.registry.registered}`)

// —— reset：回到默认态，并与 defaults 完全一致 ——
const reset = await call(host.byPath, 'POST', '/api/skill-center/groups', { reset: true })
const resetIds = reset.json.groups.map((g) => g.id)
check(
	'reset 回到默认态并再次注入真专家市场（与 defaults 逐项一致）',
	reset.json.source === 'default' && resetIds.join(',') === defaultIds.join(','),
	`reset=[${resetIds.join(', ')}] defaults=[${defaultIds.join(', ')}]`,
)

// —— 市场根不存在：默认只有两个固定组 ——
const bare = join(base, 'bare-home')
await mkdir(bare, { recursive: true })
const host2 = await startHost({}, { WORKBUDDY_HOME: bare, DSH_SKILL_CENTER_STORE: join(base, 'store2.json'), DSH_SKILL_CENTER_NO_SPAWN: '1' })
const bareBody = (await call(host2.byPath, 'GET', '/api/skill-center/list')).json
const bareIds = bareBody.groups.map((g) => g.id)
check(
	'WORKBUDDY_HOME 下没有市场目录 ⇒ 默认仍是 2 组',
	bareBody.source === 'default' && bareBody.groups.length === 2 && bareIds.join(',') === 'dsh,workbuddy',
	`source=${bareBody.source} ids=${bareIds.join(', ')}`,
)

await rm(base, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(
	`\n${failed.length === 0 ? '✅ default-groups: 全部断言通过（发现 / 扫到有才加 / 标签 / 注册 / 不变式 / defaults / reset / store 优先 / 无市场）' : `❌ ${failed.length}/${results.length} 项未通过`}`,
)
if (failed.length > 0) process.exitCode = 1
