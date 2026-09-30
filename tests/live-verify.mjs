/**
 * dsh-skill-center 实机验证（对着运行中的 DSH GUI 打真实 HTTP）。
 *
 * ⚠️ 前提：宿主半区必须已经加载（改过 lib/index.js 后需要重启 DSH 应用）。
 *   如果脚本报「新路由不可用」，说明跑的还是旧模块 —— 重启应用后再跑。
 *
 * 为什么不用 tests/_harness.mjs：这里要验证的是**真实进程里的真实路由**，
 * 包括真的改写文件、真的拉起文件管理器。
 *
 * 安全性：写操作只作用于本脚本在系统临时目录里新建的夹具技能；
 * 两个真实技能目录只被读取。来源目录会被临时改（加一个夹具组），
 * 脚本开头**快照**用户当前的来源目录，结束/异常时都按快照还原
 * （只有运行前本就是内置默认态才用 reset）。
 *
 * 运行：
 *   node tests/live-verify.mjs             # 含一次真实的「打开文件夹」（会弹资源管理器）
 *   node tests/live-verify.mjs --no-reveal # 跳过弹窗那一步
 *   DSH_GUI_URL=http://127.0.0.1:19387 node tests/live-verify.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_GUI_URL ?? 'http://127.0.0.1:19387'
const WITH_REVEAL = !process.argv.includes('--no-reveal')

const results = []
const check = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function api(path, options = {}) {
	const hasBody = options.body !== undefined
	const response = await fetch(`${BASE}${path}`, {
		method: options.method ?? 'GET',
		headers: hasBody ? { 'content-type': 'application/json' } : undefined,
		body: hasBody ? JSON.stringify(options.body) : undefined,
	})
	let body
	try {
		body = await response.json()
	} catch {
		body = undefined
	}
	return { status: response.status, body }
}

// ── 0. 夹具：一个临时技能根，写操作只落在这里 ──────────────────────────────
const base = await mkdtemp(join(tmpdir(), 'dsh-skill-center-live-'))
const fixtureRoot = join(base, 'skills')
const demoDir = join(fixtureRoot, 'live-demo')
const demoFile = join(demoDir, 'SKILL.md')
await mkdir(demoDir, { recursive: true })
const demoSource = `---
name: live-demo
description: 实机验证用的临时技能，脚本结束即删除。
---

# live-demo

这行正文必须原样保留。
`
await writeFile(demoFile, demoSource, 'utf8')

// 夹具里的迷你智能体（专家团形态）：验真实进程能不能识别 / 注册 / 出头像
const LEAD_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO45ur4HwAFrQJcCCRDDgAAAABJRU5ErkJggg==',
	'base64',
)
const agentDir = join(fixtureRoot, 'live-expert')
const agentManifestFile = join(agentDir, '.codebuddy-plugin', 'plugin.json')
const agentLeadDoc = join(agentDir, 'agents', 'live-expert.md')
await mkdir(join(agentDir, '.codebuddy-plugin'), { recursive: true })
await mkdir(join(agentDir, 'agents'), { recursive: true })
await mkdir(join(agentDir, 'avatars'), { recursive: true })
await writeFile(
	agentManifestFile,
	JSON.stringify(
		{
			name: 'live-expert',
			version: '1.0.0',
			expertType: 'team',
			agentName: 'live-expert',
			displayName: { zh: '实机验证专家团' },
			description: 'live fixture agent',
			profession: { zh: '夹具主理人' },
			avatar: 'avatars/expert.png',
			agents: ['./agents/live-expert.md'],
			tags: [{ zh: '夹具' }],
			quickPrompts: [{ zh: '实机验证一下' }],
			members: [
				{ id: 'live-expert', displayName: { zh: '实机总调' }, avatar: 'avatars/expert.png', role: 'lead' },
			],
		},
		null,
		2,
	),
	'utf8',
)
await writeFile(agentLeadDoc, '# 实机验证专家团提示词\n夹具正文。\n', 'utf8')
await writeFile(join(agentDir, 'avatars', 'expert.png'), LEAD_PNG)
console.log(`夹具：${fixtureRoot}（技能 + 智能体）\nGUI：${BASE}\n`)

let restored = false
let snapshotGroups = null
let snapshotSource = null
try {
	// ── 1. 新路由是否已加载（旧模块会 401/没有 source 字段）────────────────
	const listed = await api('/api/skill-center/list')
	const hasNewFields = listed.body?.groups?.[0]?.skills?.[0]?.enabled !== undefined
	check('宿主半区已加载新代码（list 带 source/enabled/kind/linked）', listed.status === 200 && hasNewFields,
		`status=${listed.status} source=${JSON.stringify(listed.body?.source)} 技能字段=${Object.keys(listed.body?.groups?.[0]?.skills?.[0] ?? {}).join(',')}`)
	if (!hasNewFields) {
		console.log('\n⚠️  新路由不可用：请重启 DSH 应用（宿主插件模块不热重载），然后重跑本脚本。')
		process.exitCode = 1
	} else {
		// ── 2. 默认来源目录（数量随各人技能库而定，不作硬断言）──────────────
		const groups = listed.body.groups
		// 快照用户当前的来源目录：本脚本会临时加一个夹具组，收尾必须按快照还原，
		// 不能无脑 reset —— 那会删掉用户自己保存的组（实测踩过这个坑）。
		snapshotGroups = groups.map((g) => ({ id: g.id, label: g.label, root: g.root }))
		snapshotSource = listed.body.source
		check('来源目录状态可读（内置默认 / 用户自定义）',
			['default', 'file', 'config'].includes(listed.body.source), `source=${listed.body.source}`)
		check('来源目录结构合法（每组带 id/label/root 且已完成扫描）',
			groups.length > 0 && groups.every((g) => typeof g.id === 'string' && typeof g.label === 'string' &&
				typeof g.root === 'string' && Array.isArray(g.skills)),
			groups.map((g) => `${g.label}:${g.skills.length}`).join(' · '))
		check('每项都带 kind/folder/linked 且字段类型正确',
			groups.every((g) => g.skills.every((s) => (s.kind === 'file' || s.kind === 'dir' || s.kind === 'agent') &&
				typeof s.folder === 'string' && typeof s.enabled === 'boolean' && typeof s.linked === 'boolean')))
		// 真实目录里若已有专家团（kind=agent）就顺手验字段口径；没有就跳过
		const realAgents = groups.flatMap((g) => g.skills.filter((s) => s.kind === 'agent').map((s) => ({ group: g.id, skill: s })))
		if (realAgents.length === 0) {
			console.log('（真实目录里没有 kind=agent 的专家团，跳过真实目录 agent 断言）')
		} else {
			check('真实目录里的专家团字段完整（tags/quickPrompts/members/agentDocs 类型正确）',
				realAgents.every(({ skill }) => Array.isArray(skill.tags) && Array.isArray(skill.quickPrompts) &&
					Array.isArray(skill.members) && Array.isArray(skill.agentDocs) &&
					typeof skill.hasAvatar === 'boolean' && typeof skill.profession === 'string'),
				realAgents.map(({ skill }) => `${skill.id}:${skill.members.length}人`).join(' · '))
		}
		check('read 路由可读首个技能正文',
			await (async () => {
				const first = groups.flatMap((g) => g.skills.map((s) => ({ group: g.id, skill: s })))[0]
				if (first === undefined) return true // 技能库为空时跳过
				const one = await api(`/api/skill-center/read?group=${encodeURIComponent(first.group)}&id=${encodeURIComponent(first.skill.id)}`)
				return one.status === 200 && typeof one.body?.content === 'string' && one.body.content.length > 0
			})())

		// ── 2b. 运行时技能桥：启用中的技能必须真的进了 DSH 会话的技能表 ──────
		const enabledTotal = groups.reduce((sum, g) => sum + g.skills.filter((s) => s.enabled !== false).length, 0)
		const registry = listed.body.registry
		check('list 带 registry 汇总（界面「已接入会话」用它）', registry !== undefined,
			registry === undefined ? '缺少 registry' : `registered=${registry.registered} failed=${registry.failed} sources=${JSON.stringify(registry.sources)}`)
		check('每个启用中的技能都有结论（已注册 / 或给出未接入原因）',
			registry !== undefined && registry.registered + registry.failed === enabledTotal,
			`注册 ${registry?.registered} + 失败 ${registry?.failed} 应 = 启用 ${enabledTotal}；失败原因=${JSON.stringify(registry?.errors ?? [])}`)
		check('每个技能都带 registered 标记，且与启用态一致',
			groups.every((g) => g.skills.every((s) => s.registered === (s.enabled !== false))),
			groups.map((g) => `${g.label}:${g.skills.filter((s) => s.registered).length}/${g.skills.length}`).join(' · '))

		// ── 3. GET /groups ────────────────────────────────────────────────
		const got = await api('/api/skill-center/groups')
		check('GET /groups 返回来源目录与 storePath', got.status === 200 && typeof got.body?.storePath === 'string',
			`status=${got.status} storePath=${got.body?.storePath}`)

		// ── 4. POST /groups：加入夹具目录（真实目录保持不动）──────────────
		const nextGroups = groups
			.map((g) => ({ id: g.id, label: g.label, root: g.root }))
			.concat([{ id: 'live-fixture', label: '临时夹具', root: fixtureRoot }])
		const saved = await api('/api/skill-center/groups', { method: 'POST', body: { groups: nextGroups } })
		check('POST /groups 保存并落盘', saved.status === 200 && saved.body?.source === 'file',
			`status=${saved.status} source=${saved.body?.source}`)
		const afterSave = await api('/api/skill-center/list')
		const fixtureGroup = afterSave.body?.groups?.find((g) => g.id === 'live-fixture')
		check('保存后 list 立刻反映新来源目录', fixtureGroup !== undefined && fixtureGroup.skills.length === 2,
			fixtureGroup === undefined ? '找不到 live-fixture' : `live-fixture 条目=${fixtureGroup.skills.map((s) => s.id).join(',')}`)

		// ── 4b. 专家团（agent）：真实进程识别 / 注册 / 头像 ────────────────
		const liveAgent = fixtureGroup?.skills?.find((s) => s.id === 'live-expert')
		check('专家团被真实宿主识别为 kind=agent，字段齐全',
			liveAgent !== undefined && liveAgent.kind === 'agent' &&
				liveAgent.name === '实机验证专家团' && liveAgent.expertType === 'team' &&
				Array.isArray(liveAgent.members) && liveAgent.members.length === 1 &&
				liveAgent.members[0].id === 'live-expert' && liveAgent.tags[0] === '夹具' &&
				liveAgent.quickPrompts[0] === '实机验证一下' && liveAgent.hasAvatar === true &&
				Array.isArray(liveAgent.agentDocs) && liveAgent.agentDocs.length === 1,
			liveAgent === undefined
				? '没识别成 agent'
				: `${liveAgent.name} · ${liveAgent.members.length} 人 · tags=${JSON.stringify(liveAgent.tags)} · avatar=${liveAgent.hasAvatar}`)
		check('专家团已进 DSH 会话技能表（registered=true，注册名 = agentId）',
			liveAgent?.registered === true && (afterSave.body?.registry?.names ?? []).includes('live-expert'),
			`registered=${liveAgent?.registered} names 含 live-expert=${(afterSave.body?.registry?.names ?? []).includes('live-expert')}`)
		check('专家团 read 返回 lead 提示词正文',
			await (async () => {
				const one = await api('/api/skill-center/read?group=live-fixture&id=live-expert')
				return one.status === 200 && one.body?.kind === 'agent' &&
					String(one.body?.content ?? '').includes('实机验证专家团提示词')
			})())
		const avatarResponse = await fetch(`${BASE}/api/skill-center/avatar?group=live-fixture&id=live-expert&which=lead`)
		const avatarBytes = new Uint8Array(await avatarResponse.arrayBuffer())
		check('头像路由返回真实图片字节（真宿主、真文件）',
			avatarResponse.status === 200 &&
				String(avatarResponse.headers.get('content-type')).startsWith('image/png') &&
				avatarBytes.length === LEAD_PNG.length &&
				Buffer.compare(Buffer.from(avatarBytes), LEAD_PNG) === 0,
			`status=${avatarResponse.status} type=${avatarResponse.headers.get('content-type')} bytes=${avatarBytes.length}`)
		const badWhich = await fetch(`${BASE}/api/skill-center/avatar?group=live-fixture&id=live-expert&which=nope`)
		const traversalWhich = await fetch(`${BASE}/api/skill-center/avatar?group=live-fixture&id=live-expert&which=../../secret.png`)
		check('头像路由拒绝未知 which 与穿越串（都 404）',
			badWhich.status === 404 && traversalWhich.status === 404,
			`nope=${badWhich.status} 穿越=${traversalWhich.status}`)
		const storePath = got.body?.storePath
		check('持久化文件已写出（位置由 API 返回，不写死本机路径）',
			typeof storePath === 'string' && existsSync(storePath), `storePath=${storePath}`)

		// ── 5. POST /set-enabled：真改写夹具文件 ──────────────────────────
		const off = await api('/api/skill-center/set-enabled', { method: 'POST', body: { group: 'live-fixture', id: 'live-demo', enabled: false } })
		const offText = await readFile(demoFile, 'utf8')
		check('停用：路由返回 200 且文件写入 disable-model-invocation: true',
			off.status === 200 && offText.includes('disable-model-invocation: true'),
			`status=${off.status} changed=${off.body?.changed}`)
		check('停用：正文与其他 frontmatter 字段逐字保留',
			offText.includes('description: 实机验证用的临时技能') && offText.includes('这行正文必须原样保留。'))
		const offList = await api('/api/skill-center/list')
		check('停用：list 里该项 enabled=false',
			offList.body?.groups?.find((g) => g.id === 'live-fixture')?.skills?.[0]?.enabled === false)
		check('停用：立刻退出 DSH 会话的技能表（registered=false，注册数减一）',
			off.body?.registered === false &&
				offList.body?.groups?.find((g) => g.id === 'live-fixture')?.skills?.[0]?.registered === false,
			`set-enabled 返回 registered=${off.body?.registered} 注册数=${off.body?.registry?.registered}`)

		const on = await api('/api/skill-center/set-enabled', { method: 'POST', body: { group: 'live-fixture', id: 'live-demo', enabled: true } })
		const onText = await readFile(demoFile, 'utf8')
		check('启用：该行被删掉，文件回到原始字节', onText === demoSource)
		check('启用：立刻回到 DSH 会话的技能表（registered=true）',
			on.body?.registered === true,
			`set-enabled 返回 registered=${on.body?.registered} 注册数=${on.body?.registry?.registered}`)

		// ── 6. POST /reveal：真的拉起文件管理器 ──────────────────────────
		if (WITH_REVEAL) {
			console.log('\n（下一步会真的弹出资源管理器窗口，用于验证「打开文件夹」）')
			const revealed = await api('/api/skill-center/reveal', { method: 'POST', body: { group: 'live-fixture', id: 'live-demo' } })
			check('打开文件夹：路由返回 200 且给出定位命令',
				revealed.status === 200 && typeof revealed.body?.command === 'string',
				`${revealed.body?.command} ${(revealed.body?.args ?? []).join(' ')}`)
		} else {
			console.log('（--no-reveal：跳过「打开文件夹」实测）')
		}

		// ── 7. 围栏：非 loopback 拿不到 ───────────────────────────────────
		const remote = await fetch(`${BASE}/api/skill-center/list`, { headers: { 'X-Forwarded-For': '8.8.8.8' } })
		check('本机请求正常（对照）', remote.status === 200, `status=${remote.status}`)

		// ── 8. 还原来源目录：按开头快照恢复（原本就是默认态才 reset）────────
		const expectIds = snapshotSource === 'default' ? ['dsh', 'workbuddy'] : snapshotGroups.map((g) => g.id)
		const reset = await api('/api/skill-center/groups',
			{ method: 'POST', body: snapshotSource === 'default' ? { reset: true } : { groups: snapshotGroups } })
		restored = reset.status === 200
		const finalList = await api('/api/skill-center/list')
		const finalIds = (finalList.body?.groups ?? []).map((g) => g.id)
		check('已按运行前快照还原来源目录（不破坏用户配置）',
			JSON.stringify(finalIds) === JSON.stringify(expectIds),
			`运行前 source=${snapshotSource} ids=[${snapshotGroups.map((g) => g.id)}] → 现在 source=${finalList.body?.source} ids=[${finalIds}]`)
	}
} finally {
	if (!restored && snapshotSource !== null) {
		try {
			await api('/api/skill-center/groups',
				{ method: 'POST', body: snapshotSource === 'default' ? { reset: true } : { groups: snapshotGroups } })
			console.log('（收尾：已按运行前快照还原来源目录）')
		} catch {}
	}
	await rm(base, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '✅ 实机验证全部通过' : `❌ ${failed.length}/${results.length} 项未通过`}（共 ${results.length} 项）`)
if (failed.length > 0) process.exitCode = 1
