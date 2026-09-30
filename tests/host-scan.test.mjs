/**
 * dsh-skill-center 宿主半区验证。
 *
 * 分两段：
 *  A. 真实技能目录（只读）：两组技能 / 预览 / 围栏 / 错误路径
 *  B. 临时夹具目录（可写）：启用停用真改写 frontmatter / reveal 命令 / 来源目录读写
 *     ——写操作全部落在 mkdtemp 出来的夹具里，绝不碰用户真实技能文件。
 *
 * 运行：node tests/host-scan.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { call, makeFetch, makeRemoteRequest, makeResponse, makeRequest, makeFixture, startHost } from './_harness.mjs'

const NONEXISTENT_STORE = join(tmpdir(), 'dsh-skill-center-does-not-exist', 'skill-center.json')

// ───────────────────────── A. 真实目录（只读） ─────────────────────────
const real = await startHost({}, { DSH_SKILL_CENTER_STORE: NONEXISTENT_STORE, DSH_SKILL_CENTER_NO_SPAWN: '1' })
assert.equal(real.routes.length, 6, '应注册 6 条路由（list/read/set-enabled/reveal/groups/avatar）')
for (const route of real.routes) assert.equal(route.kind, 'exact')
console.log(`路由 OK：${real.routes.map((route) => route.path.replace('/api/skill-center/', '')).join(' / ')}`)

const listed = await call(real.byPath, 'GET', '/api/skill-center/list')
assert.equal(listed.status, 200)
assert.equal(listed.json.source, 'default', '无持久化文件、无配置时应为内置默认')
assert.equal(listed.json.groups.length, 2)
const [dshGroup, workbuddyGroup] = listed.json.groups
assert.equal(dshGroup.id, 'dsh')
assert.equal(dshGroup.label, 'dsh技能')
assert.equal(workbuddyGroup.id, 'workbuddy')
assert.equal(workbuddyGroup.label, 'workbuddy技能')
// 真实技能库的内容与数量随机器而异 —— 这一段只断言**结构**，
// 内容类（正文 / 数量 / 具体技能名）断言全部交给下面的夹具段。
for (const group of listed.json.groups) {
	assert.ok(typeof group.root === 'string' && group.root.endsWith('skills'), `${group.id}: root 应指向 skills 目录`)
	assert.equal(typeof group.exists, 'boolean')
	assert.ok(Array.isArray(group.skills))
	const ids = group.skills.map((skill) => skill.id)
	assert.equal(ids.filter((id) => id.startsWith('.')).length, 0, `${group.id}: 不应列出隐藏条目`)
	assert.equal(ids.filter((id) => id.toLowerCase() === 'readme').length, 0, `${group.id}: 不应列出 README`)
	for (const skill of group.skills) {
		assert.ok(skill.kind === 'file' || skill.kind === 'dir', `${skill.id}: 应带 kind`)
		assert.ok(typeof skill.folder === 'string' && skill.path.startsWith(group.root), `${skill.id}: 路径应落在该根下`)
		assert.equal(typeof skill.enabled, 'boolean')
		assert.equal(typeof skill.linked, 'boolean')
		assert.equal(typeof skill.registered, 'boolean')
		assert.ok(skill.size > 0, `${skill.id}: 应有文件大小`)
	}
}
console.log('清单结构 OK：默认两组、字段齐全（数量随各人技能库而定，内容断言见夹具段）')

// 围栏与错误路径
const remote = makeResponse()
await real.byPath
	.get('/api/skill-center/list')
	.handler(makeRemoteRequest('GET', '/api/skill-center/list'), remote)
assert.equal(remote.result.statusCode, 403, 'LAN 客户端应被拒绝')
assert.equal(
	(await call(real.byPath, 'GET', '/api/skill-center/read?group=nope&id=x')).status,
	400,
)
assert.equal(
	(await call(real.byPath, 'GET', '/api/skill-center/read?group=dsh&id=__nope__')).status,
	404,
)
assert.equal((await call(real.byPath, 'POST', '/api/skill-center/list')).status, 405)
console.log('围栏 OK：非 loopback 403 / 未知分组 400 / 未知技能 404 / 方法不符 405')

// ───────────────────────── B. 夹具目录（可写） ─────────────────────────
const fixture = await makeFixture()
const GROUP = { id: 'fx', label: '测试技能', root: fixture.root }
const fx = await startHost(
	{ groups: [GROUP] },
	{ DSH_SKILL_CENTER_STORE: fixture.store, DSH_SKILL_CENTER_NO_SPAWN: '1' },
)
assert.equal(existsSync(fixture.store), false, '夹具 store 一开始不应存在')

const fxList = await call(fx.byPath, 'GET', '/api/skill-center/list')
assert.equal(fxList.status, 200)
assert.equal(fxList.json.source, 'config', '没有 store 时应用 config.groups')
assert.equal(fxList.json.groups.length, 1)
const fxGroup = fxList.json.groups[0]
const ids = fxGroup.skills.map((skill) => skill.id)
assert.ok(ids.includes('alpha'), '应发现目录型技能 alpha')
assert.ok(ids.includes('beta'), '应发现单文件技能 beta')
assert.equal(ids.includes('.hidden'), false, '隐藏目录应跳过')
assert.equal(ids.includes('noskill'), false, '无 SKILL.md 的目录应跳过')
assert.equal(ids.includes('README'), false, 'README.md 应跳过')
assert.equal(ids.includes('linked'), fixture.linked, `linked 是否列出应与能否建链接一致（linked=${fixture.linked}）`)
assert.ok(ids.includes('expert'), '专家团目录（有 .codebuddy-plugin/plugin.json）应被识别为 agent 条目')
const alpha = fxGroup.skills.find((skill) => skill.id === 'alpha')
const beta = fxGroup.skills.find((skill) => skill.id === 'beta')
assert.equal(alpha.kind, 'dir')
assert.equal(beta.kind, 'file')
assert.equal(alpha.name, 'alpha', 'frontmatter 里的 name 应被采用')
assert.equal(alpha.enabled, true)
assert.equal(alpha.folder, join(fixture.root, 'alpha'))
assert.ok(beta.description === '' || typeof beta.description === 'string')
console.log(`夹具清单 OK：${ids.join(', ')}（α 有 frontmatter、β 无 frontmatter、隐藏/无 SKILL.md/README 均跳过）`)

// ── 专家团（agent 形态）：字段、文案回退、成员、头像可达性 ──────────
const expert = fxGroup.skills.find((skill) => skill.id === 'expert')
assert.equal(expert.kind, 'agent', 'expert 应是 agent 条目')
assert.equal(expert.name, '夹具专家团', '显示名应取清单里的 zh 文案')
assert.equal(expert.profession, '夹具主理人', 'profession（zh）应带出')
assert.equal(expert.expertType, 'team', 'expertType 应带出')
assert.deepEqual(expert.tags, ['夹具', 'Fixture'], 'tags 应按 zh → en 取值')
assert.deepEqual(expert.quickPrompts, ['帮我分派一下', 'Route this'], 'quickPrompts 应按 zh → en 取值')
assert.deepEqual(
	expert.agentDocs,
	['agents/lead.md', 'team/helper/agents/helper.md'],
	'agentDocs 应是清单里声明的提示词相对路径',
)
assert.equal(expert.description, '夹具：一个迷你专家团，用来验证 agent 形态。', '描述应取 displayDescription.zh')
assert.equal(expert.folder, fixture.agent.dir, 'folder 应是专家团目录')
assert.equal(expert.path, fixture.agent.leadDoc, 'path 应指向 lead 提示词（注册 / read / reveal 都用它）')
assert.equal(expert.enabled, true, 'store 里没有该字段时默认启用')
assert.equal(expert.linked, false, '普通目录不算链接')
assert.ok(expert.size > 0, '应带出 lead 提示词的大小')
assert.equal(expert.hasAvatar, true, 'lead 头像存在')
assert.deepEqual(
	expert.members.map((member) => member.id),
	['expert', 'helper', 'ghost'],
	'members 应逐个带出',
)
const helperMember = expert.members.find((member) => member.id === 'helper')
assert.equal(helperMember.name, 'Helper', '成员名缺 zh 时应回退 en')
assert.equal(helperMember.profession, '操作员', '成员 profession 应取 zh')
assert.equal(helperMember.role, 'member', '成员 role 应带出')
assert.equal(helperMember.hasAvatar, true, 'helper 头像存在')
assert.equal(
	expert.members.find((member) => member.id === 'ghost').hasAvatar,
	false,
	'越界头像（../../secret.png）必须判成「没有头像」',
)
assert.equal(
	JSON.stringify(expert).includes(fixture.agent.secret),
	false,
	'响应里不该出现越界文件的绝对路径',
)
assert.equal(
	JSON.stringify(expert).includes(fixture.agent.leadAvatar),
	false,
	'响应里不该出现头像的绝对路径（客户端只拿 which 去请求）',
)
console.log(
	`专家团 OK：${expert.name} · ${expert.expertType} · ${expert.members.length} 人 · tags=${expert.tags.join('/')} · 头像=${expert.hasAvatar}`,
)

// ── read：夹具技能的正文（内容类断言放这里，与真实技能库无关）──
const shown = await call(fx.byPath, 'GET', '/api/skill-center/read?group=fx&id=alpha')
assert.equal(shown.status, 200)
assert.equal(shown.json.id, 'alpha')
assert.equal(shown.json.kind, 'dir')
assert.equal(shown.json.linked, false)
assert.equal(shown.json.enabled, true)
assert.ok(shown.json.content.includes('夹具技能 alpha'), 'read 应返回该技能正文')
assert.ok(shown.json.bytes > 0, '应返回字节数')
const shownBeta = await call(fx.byPath, 'GET', '/api/skill-center/read?group=fx&id=beta')
assert.equal(shownBeta.status, 200)
assert.ok(shownBeta.json.content.includes('# beta'), '单文件技能的正文也应可读')
assert.equal(shownBeta.json.kind, 'file')
console.log('read OK：夹具 alpha / beta 正文可读，kind/linked/enabled 字段齐全')

// ── 专家团：read 返回 lead 提示词（与技能一致：原始文件内容，弹框直接复用）──
const agentRead = await call(fx.byPath, 'GET', '/api/skill-center/read?group=fx&id=expert')
assert.equal(agentRead.status, 200)
assert.equal(agentRead.json.kind, 'agent')
assert.equal(agentRead.json.path, fixture.agent.leadDoc, 'read 的目标应是 lead 提示词')
assert.ok(agentRead.json.content.includes('# expert 提示词'), 'read 应返回 lead 提示词正文')
assert.equal(agentRead.json.content.includes('"expertType"'), false, '不应把清单 JSON 当正文返回')
assert.ok(agentRead.json.bytes > 0, '应返回字节数')
console.log('专家团 read OK：详情弹框能直接复用（返回 lead 提示词）')

// ── 头像路由：路径只来自扫描结果 + 目录内校验 + 扩展名白名单 ──────────
const avatarCall = async (query) => {
	const response = makeResponse()
	await fx.byPath
		.get('/api/skill-center/avatar')
		.handler(makeRequest('GET', `/api/skill-center/avatar?${query}`), response)
	return response.result
}
const leadShot = await avatarCall('group=fx&id=expert&which=lead')
assert.equal(leadShot.statusCode, 200, 'lead 头像应 200')
assert.equal(leadShot.headers['content-type'], 'image/png')
assert.ok(Buffer.isBuffer(leadShot.body), '头像应返回原始字节（不是 JSON）')
assert.deepEqual(leadShot.body, await readFile(fixture.agent.leadAvatar), '返回字节应与磁盘上的 PNG 完全一致')
const helperShot = await avatarCall('group=fx&id=expert&which=helper')
assert.equal(helperShot.statusCode, 200)
assert.deepEqual(helperShot.body, await readFile(fixture.agent.helperAvatar), '成员头像应是各自那份文件')
assert.equal((await avatarCall('group=fx&id=expert&which=ghost')).statusCode, 404, '越界成员头像应 404')
assert.equal((await avatarCall('group=fx&id=expert&which=nobody')).statusCode, 404, '未知 which 应 404')
assert.equal(
	(await avatarCall('group=fx&id=expert&which=../../secret.png')).statusCode,
	404,
	'which 里的穿越串不能命中任何文件',
)
assert.equal(
	(await avatarCall('group=fx&id=expert&which=..%2F..%2Fsecret.png')).statusCode,
	404,
	'编码后的穿越串同样 404',
)
assert.equal((await avatarCall('group=nope&id=expert&which=lead')).statusCode, 400, '未知分组 400')
assert.equal(
	(await avatarCall('group=fx&id=alpha&which=lead')).statusCode,
	404,
	'技能条目没有头像（kind 不是 agent）→ 404',
)
console.log('头像路由 OK：lead/成员头像返回真 PNG 字节；越界 / 未知 which / 非 agent 一律 404')

const alphaFile = join(fixture.root, 'alpha', 'SKILL.md')
const betaFile = join(fixture.root, 'beta.md')
const alphaOriginal = await readFile(alphaFile, 'utf8')

// ── 停用 → frontmatter 真被改写 ──────────────────────────────────────
const off = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'alpha',
	enabled: false,
})
assert.equal(off.status, 200)
assert.equal(off.json.disabled, true)
assert.equal(off.json.changed, true)
const alphaOff = await readFile(alphaFile, 'utf8')
assert.ok(alphaOff.includes('disable-model-invocation: true'), '应写入 disable-model-invocation: true')
assert.ok(alphaOff.includes('# alpha') && alphaOff.includes('正文第一行。'), '正文必须逐字保留')
assert.ok(alphaOff.includes('description: 夹具技能 alpha（目录型）'), '其他 frontmatter 字段必须保留')
assert.ok(!existsSync(`${alphaFile}.tmp`), '不应留下临时文件')
const afterOff = await call(fx.byPath, 'GET', '/api/skill-center/list')
assert.equal(afterOff.json.groups[0].skills.find((skill) => skill.id === 'alpha').enabled, false, '列表应反映停用')
console.log('停用 OK：frontmatter 写入 disable-model-invocation: true，正文与其他字段逐字保留')

// ── 启用 → 该行被移除，文件回到原样 ─────────────────────────────────
const on = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'alpha',
	enabled: true,
})
assert.equal(on.status, 200)
assert.equal(on.json.enabled, true)
assert.equal(await readFile(alphaFile, 'utf8'), alphaOriginal, '启用后文件应回到作者原本的样子')
const again = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'alpha',
	enabled: true,
})
assert.equal(again.json.changed, false, '已经启用时不应改动文件')
console.log('启用 OK：删掉该行还原文件；无变化时 changed=false（不做无谓写入）')

// ── 无 frontmatter 的单文件技能：补一个最小块 ────────────────────────
const betaOff = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'beta',
	enabled: false,
})
assert.equal(betaOff.status, 200)
const betaText = await readFile(betaFile, 'utf8')
assert.ok(betaText.startsWith('---\n'), '应补出 frontmatter 块')
assert.ok(betaText.includes('disable-model-invocation: true'))
assert.ok(betaText.includes('# beta'), '原正文必须保留')
await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', { group: 'fx', id: 'beta', enabled: true })
assert.equal(await readFile(betaFile, 'utf8'), '# beta\n\n单文件技能，没有 frontmatter。\n', '还原应回到原始字节')
console.log('无 frontmatter OK：停用时补最小块，启用后逐字节还原')

// ── 符号链接技能拒绝改写 ─────────────────────────────────────────────
if (fixture.linked) {
	const linked = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
		group: 'fx',
		id: 'linked',
		enabled: false,
	})
	assert.equal(linked.status, 400, '符号链接技能必须拒绝改写')
	assert.equal(linked.json.error, 'linked skill cannot be modified')
	console.log('链接保护 OK：符号链接技能拒绝改写（400）')
} else {
	console.log('链接保护：本机不允许建链接，跳过该断言')
}

// ── reveal：命令构造 + 演练不真拉起 ──────────────────────────────────
const revealed = await call(fx.byPath, 'POST', '/api/skill-center/reveal', { group: 'fx', id: 'alpha' })
assert.equal(revealed.status, 200)
assert.equal(revealed.json.dryRun, true, '演练模式不应真的拉起文件管理器')
assert.equal(revealed.json.command, process.platform === 'win32' ? 'explorer.exe' : revealed.json.command)
if (process.platform === 'win32') {
	assert.deepEqual(revealed.json.args, [`/select,${alphaFile}`], 'win32 应为 explorer.exe /select,<path>')
}
assert.equal(revealed.json.folder, join(fixture.root, 'alpha'))
assert.equal((await call(fx.byPath, 'POST', '/api/skill-center/reveal', { group: 'fx', id: 'nope' })).status, 404)
assert.equal((await call(fx.byPath, 'POST', '/api/skill-center/reveal', { group: 'nope', id: 'alpha' })).status, 400)
console.log(`reveal OK：${revealed.json.command} ${revealed.json.args.join(' ')}（演练模式）`)

// ── 来源目录：读写 / 校验 / 持久化优先于 config / 恢复默认 ────────────
const getGroups = await call(fx.byPath, 'GET', '/api/skill-center/groups')
assert.equal(getGroups.status, 200)
assert.equal(getGroups.json.source, 'config')
assert.deepEqual(getGroups.json.groups, [GROUP])

const badId = await call(fx.byPath, 'POST', '/api/skill-center/groups', {
	groups: [{ id: 'Bad_ID', label: 'x', root: fixture.root }],
})
assert.equal(badId.status, 400)
assert.ok(badId.json.problems[0].includes('id 不合法'), badId.json.error)
const badRoot = await call(fx.byPath, 'POST', '/api/skill-center/groups', {
	groups: [{ id: 'ok', label: 'x', root: 'relative\\path' }],
})
assert.equal(badRoot.status, 400)
assert.ok(badRoot.json.problems[0].includes('绝对路径'))
const empty = await call(fx.byPath, 'POST', '/api/skill-center/groups', { groups: [] })
assert.equal(empty.status, 400)
console.log('来源目录校验 OK：非法 id / 相对路径 / 空列表都返回 400 + 具体原因')

const renamed = { id: 'fx', label: '改名技能', root: fixture.root }
const saved = await call(fx.byPath, 'POST', '/api/skill-center/groups', { groups: [renamed] })
assert.equal(saved.status, 200)
assert.equal(saved.json.source, 'file')
assert.equal(existsSync(fixture.store), true, '持久化文件应被写出')
const storedRaw = JSON.parse(await readFile(fixture.store, 'utf8'))
assert.deepEqual(storedRaw.groups, [renamed])

// 持久化优先于 config：label 应变成“改名技能”
const afterSave = await call(fx.byPath, 'GET', '/api/skill-center/list')
assert.equal(afterSave.json.source, 'file')
assert.equal(afterSave.json.groups[0].label, '改名技能', '存盘后应覆盖 config.groups')
assert.equal((await call(fx.byPath, 'GET', '/api/skill-center/groups')).json.source, 'file')
console.log('来源目录持久化 OK：POST 后写入 store，且优先于插件 config（label 已改名）')

const reset = await call(fx.byPath, 'POST', '/api/skill-center/groups', { reset: true })
assert.equal(reset.status, 200)
assert.equal(reset.json.source, 'config', 'reset 后应回到 config.groups')
assert.equal(existsSync(fixture.store), false, 'reset 应删除持久化文件')
assert.equal((await call(fx.byPath, 'GET', '/api/skill-center/list')).json.groups[0].label, '测试技能')
console.log('恢复默认 OK：删除 store 后回到 config / 内置默认')

// 写路由同样受围栏保护
const remotePost = makeResponse()
await fx.byPath
	.get('/api/skill-center/set-enabled')
	.handler(makeRemoteRequest('POST', '/api/skill-center/set-enabled'), remotePost)
assert.equal(remotePost.result.statusCode, 403, '写路由必须同样只接受 loopback')
const remoteGroups = makeResponse()
await fx.byPath
	.get('/api/skill-center/groups')
	.handler(makeRemoteRequest('POST', '/api/skill-center/groups'), remoteGroups)
assert.equal(remoteGroups.result.statusCode, 403)

// 夹具里不应残留临时文件
const leftovers = (await readdir(join(fixture.root, 'alpha'))).filter((name) => name.includes('.tmp'))
assert.deepEqual(leftovers, [], '不应残留 .tmp 文件')
assert.deepEqual(
	(await readdir(fixture.agent.dir)).filter((name) => name.includes('.tmp')),
	[],
	'专家团目录不该出现临时文件',
)

// ── 清单坏掉的专家团：list 不能崩，条目要带原因，不变式仍成立 ──────────
const brokenRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-center-broken-'))
await mkdir(join(brokenRoot, 'expert-broken', '.codebuddy-plugin'), { recursive: true })
await writeFile(join(brokenRoot, 'expert-broken', '.codebuddy-plugin', 'plugin.json'), '{ 这不是合法 JSON', 'utf8')
const broken = await startHost(
	{ groups: [{ id: 'broken', label: '坏清单', root: brokenRoot }] },
	{ DSH_SKILL_CENTER_STORE: join(brokenRoot, 'store.json'), DSH_SKILL_CENTER_NO_SPAWN: '1' },
)
const brokenList = await call(broken.byPath, 'GET', '/api/skill-center/list')
assert.equal(brokenList.status, 200, '清单解析失败时 list 仍应 200')
const brokenItem = brokenList.json.groups[0].skills.find((skill) => skill.id === 'expert-broken')
assert.ok(brokenItem !== undefined, '坏清单的目录仍应作为 agent 条目列出')
assert.equal(brokenItem.kind, 'agent')
assert.equal(brokenItem.registered, false, '解析失败 ⇒ 不该进技能表')
assert.ok(
	String(brokenItem.registerError ?? '').includes('无法解析'),
	`应给出未接入原因：${brokenItem.registerError}`,
)
assert.equal(brokenList.json.registry.registered + brokenList.json.registry.failed, 1, '不变式：启用 1 = 注册 0 + 失败 1')
await rm(brokenRoot, { recursive: true, force: true })
console.log('坏清单 OK：list 不崩，条目带「无法解析」原因，registered + failed 不变式仍成立')

await fixture.cleanup()
void makeFetch
console.log('\n✅ host-scan: 全部断言通过（真实目录只读 + 夹具写入 + 围栏/错误路径 + 专家团）')
