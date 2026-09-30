/**
 * dsh-skill-center 运行时技能桥验证：**开关是否真的决定「DSH 会话能不能看到」**。
 *
 * 这是本轮需求（开启的技能要被 DSH 会话识别到）的验收测试。宿主半区把启用中的技能
 * 注册进 `ctx.skills`，停用的 dispose 掉；这里用假注册表断言注册/注销/内容/兜底。
 *
 * 运行：node tests/skill-bridge.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { call, makeFixture, startHost } from './_harness.mjs'

const NONEXISTENT_STORE = join(tmpdir(), 'dsh-skill-center-bridge', 'skill-center.json')
const NO_SPAWN = { DSH_SKILL_CENTER_NO_SPAWN: '1' }

// ═══════════ A. 真实目录：只断言不变式（内容随各人技能库而异） ═══════════
const real = await startHost({}, { ...NO_SPAWN, DSH_SKILL_CENTER_STORE: NONEXISTENT_STORE })
assert.deepEqual(real.host.inject, ['webServer', 'skills'], '应声明 webServer + skills 两个服务')

const listed = await call(real.byPath, 'GET', '/api/skill-center/list')
const bridge = listed.json.registry
const realEnabled = listed.json.groups.reduce(
	(sum, group) => sum + group.skills.filter((skill) => skill.enabled !== false).length,
	0,
)
assert.ok(bridge !== undefined, 'list 应带 registry 汇总（界面靠它显示「已接入会话」）')
// 不变式：每个**启用中**的技能都必须有结论——要么已注册，要么给出未接入的原因。
// 具体注册了什么、有多少个，随各人技能库而异，因此不在这里断言。
assert.equal(
	bridge.registered + bridge.failed,
	realEnabled,
	`启用 ${realEnabled} 个 → 注册 ${bridge.registered} + 失败 ${bridge.failed} 应恰好相等`,
)
assert.equal(bridge.names.length, bridge.registered, 'names 数量应与注册数一致')
assert.ok(
	bridge.sources.every((source) => source === 'runtime' || source === 'bundled'),
	`source 取值应受支持：${JSON.stringify(bridge.sources)}`,
)
for (const group of listed.json.groups) {
	for (const skill of group.skills) {
		if (skill.enabled === false) {
			assert.equal(skill.registered, false, `${skill.id}: 停用的技能不应在会话技能表里`)
			continue
		}
		assert.ok(
			skill.registered === true || typeof skill.registerError === 'string',
			`${skill.id}: 启用的技能要么已接入，要么必须给出原因`,
		)
	}
}
console.log(
	`真实目录不变式 OK：启用 ${realEnabled} 个 → 注册 ${bridge.registered} / 失败 ${bridge.failed}（source=${bridge.sources.join(',') || '—'}）`,
)

// ═══════════ C. 夹具：无 frontmatter / 链接技能 / source 兜底 ═══════════
const fixture = await makeFixture()
const GROUP = { id: 'fx', label: '测试技能', root: fixture.root }
const fx = await startHost({ groups: [GROUP] }, { ...NO_SPAWN, DSH_SKILL_CENTER_STORE: fixture.store })
const fxList = await call(fx.byPath, 'GET', '/api/skill-center/list')
const fxIds = fxList.json.groups[0].skills.map((skill) => skill.id)
assert.equal(fxList.json.registry.failed, 0, `夹具不该有注册失败：${JSON.stringify(fxList.json.registry.errors)}`)
assert.equal(fxList.json.registry.registered, fxIds.length, '夹具里启用中的技能都应注册')
assert.equal(fx.registry.entries.get('beta').registration.description.includes('单文件技能'), true, '无 description 时应从正文兜底')
if (fxIds.includes('linked')) {
	assert.equal(fx.registry.entries.has('linked'), true, '链接技能可读 ⇒ 也应进会话技能表（只是不可改写）')
}
console.log(`夹具 OK：${fxIds.join(', ')} 全部注册；无 frontmatter 的 beta 用正文兜底出 description`)

// 注册内容（夹具技能，与真实技能库无关）：正文已剥离 frontmatter + description/path/source
const alphaEntry = fx.registry.entries.get('alpha')
assert.ok(alphaEntry !== undefined, 'alpha 应在注册表里')
assert.ok(!alphaEntry.registration.content.includes('name: alpha'), '注册内容不该含 frontmatter')
assert.ok(alphaEntry.registration.content.includes('# alpha'), '注册内容应含正文')
assert.ok(alphaEntry.registration.description.includes('夹具技能 alpha'), 'description 应取自 frontmatter')
assert.equal(alphaEntry.registration.path, join(fixture.root, 'alpha', 'SKILL.md'), '应带上源文件路径')
assert.equal(alphaEntry.registration.source, 'runtime', '优先使用 runtime source')
assert.ok(alphaEntry.registration.description.length > 0, '注册表要求 description 非空')
console.log('注册内容 OK：frontmatter 已剥离、正文完整、description/path/source 正确')

// 开关 = 会话可见性（拿夹具技能验证，改完即还原，绝不碰真实技能）
const off = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'alpha',
	enabled: false,
})
assert.equal(off.status, 200)
assert.equal(off.json.registered, false, '停用后该技能应立刻移出会话技能表')
assert.equal(fx.registry.entries.has('alpha'), false, '注册表里也应被 dispose')
assert.ok(fx.registry.disposed >= 1, '应调用过 disposer')
assert.equal(off.json.registry.registered, fxIds.length - 1, '注册数应减一')
const offList = await call(fx.byPath, 'GET', '/api/skill-center/list')
assert.equal(
	offList.json.groups[0].skills.find((skill) => skill.id === 'alpha').registered,
	false,
	'list 里该项应显示未接入',
)
const on = await call(fx.byPath, 'POST', '/api/skill-center/set-enabled', {
	group: 'fx',
	id: 'alpha',
	enabled: true,
})
assert.equal(on.json.registered, true, '启用后应立刻回到会话技能表')
assert.equal(fx.registry.entries.has('alpha'), true, '注册表里应重新注册')
assert.equal(on.json.registry.registered, fxIds.length, '注册数应恢复')
console.log('开关 ↔ 会话可见性 OK：停用即摘掉、启用即挂回（夹具技能，无副作用）')

// source 被拒时自动退回 bundled（官方范例里跑通的那个取值）
const fallback = await startHost(
	{ groups: [GROUP] },
	{ ...NO_SPAWN, DSH_SKILL_CENTER_STORE: fixture.store },
	{ allowedSources: ['bundled'] },
)
const fallbackList = await call(fallback.byPath, 'GET', '/api/skill-center/list')
assert.equal(fallbackList.json.registry.failed, 0, 'runtime 被拒后应自动退回 bundled 并成功')
assert.equal(fallback.registry.entries.get('alpha').registration.source, 'bundled')
assert.deepEqual(fallbackList.json.registry.sources, ['bundled'])
console.log('source 兜底 OK：runtime 被拒 → 自动用 bundled 注册成功')

// ═══════════ D. 改来源目录 → 注册表跟着对齐 ═══════════
const saved = await call(fx.byPath, 'POST', '/api/skill-center/groups', {
	groups: [{ id: 'fx', label: '改名技能', root: fixture.root }],
})
assert.equal(saved.status, 200)
assert.equal(saved.json.registry.registered, fxIds.length, '保存来源目录后注册表应重新对齐')
assert.equal(fx.registry.entries.size, fxIds.length)
const reset = await call(fx.byPath, 'POST', '/api/skill-center/groups', { reset: true })
assert.equal(reset.status, 200)
assert.equal(reset.json.source, 'config')
assert.equal(fx.registry.entries.size, fxIds.length, 'reset 回 config 后仍应保持同步')
console.log('来源目录同步 OK：保存 / 恢复默认都会重新对齐注册表')

// ═══════════ E. 重名技能：只注册一个，另一个必须带原因（界面靠它显示「未接入」）═══════════
const dupRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-center-dup-'))
await mkdir(join(dupRoot, 'one'), { recursive: true })
await mkdir(join(dupRoot, 'two'), { recursive: true })
const dupSkill = '---\nname: same-name\ndescription: 重名夹具\n---\n\n# x\n'
await writeFile(join(dupRoot, 'one', 'SKILL.md'), dupSkill, 'utf8')
await writeFile(join(dupRoot, 'two', 'SKILL.md'), dupSkill, 'utf8')
const dup = await startHost(
	{ groups: [{ id: 'dup', label: '重名夹具', root: dupRoot }] },
	{ ...NO_SPAWN, DSH_SKILL_CENTER_STORE: join(dupRoot, 'store.json') },
)
const dupList = await call(dup.byPath, 'GET', '/api/skill-center/list')
assert.equal(dupList.json.registry.registered, 1, '同名技能只应注册一个')
assert.equal(dupList.json.registry.failed, 1, '另一个应被记为失败')
assert.ok(
	dupList.json.registry.errors[0].reason.includes('重复'),
	`失败原因应说明重名：${JSON.stringify(dupList.json.registry.errors)}`,
)
const dupSkills = dupList.json.groups[0].skills
assert.equal(dupSkills.filter((skill) => skill.registered === true).length, 1, 'list 里应恰好一个 registered')
assert.equal(
	dupSkills.filter((skill) => typeof skill.registerError === 'string' && skill.registerError.length > 0).length,
	1,
	'list 里应恰好一个带 registerError（界面用它显示未接入原因）',
)
console.log(`重名处理 OK：同名只注册 1 个，另一个带原因「${dupList.json.registry.errors[0].reason.slice(0, 30)}…」`)
await rm(dupRoot, { recursive: true, force: true })

await fixture.cleanup()
console.log('\n✅ skill-bridge: 全部断言通过（会话可见性 ↔ 开关 / 内容与兜底 / source 兼容 / 目录同步）')
