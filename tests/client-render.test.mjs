/**
 * dsh-skill-center 浏览器半区端到端验证（无浏览器）。
 *
 * 两段：
 *  A. 真实技能目录（只读）：页签分组 / 卡片 / 详情弹框 / 关闭三路径 / 搜索 / 开关与菜单存在性
 *  B. 临时夹具目录（可写）：启用停用真改写文件、⋯ 菜单（打开文件夹/复制路径/启停）、
 *     来源目录编辑器（改名保存 / 校验报错 / 恢复默认）
 *
 * 夹具段的写操作全部落在 mkdtemp 目录里，绝不碰用户真实技能。
 * 运行：node tests/client-render.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { makeFetch, makeFixture, startHost } from './_harness.mjs'

// ───────────────────────── 1. 伪 module loader + 伪 react ─────────────────────────
let loaded
globalThis.window = {
	__ModuleLoader__: { load(spec) { loaded = spec } },
}

const states = []
const callbackSlots = []
const effectSlots = []
let pendingEffects = []
let cursor = 0

/** React 的依赖比较（浅比较）。 */
const depsChanged = (previous, next) =>
	previous === undefined ||
	next === undefined ||
	previous.length !== next.length ||
	previous.some((value, index) => value !== next[index])

const hooks = {
	useState(initial) {
		const slot = cursor++
		if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
		return [states[slot], (next) => {
			states[slot] = typeof next === 'function' ? next(states[slot]) : next
		}]
	},
	useEffect(effect, deps) {
		const slot = cursor++
		const previous = effectSlots[slot]
		const changed = previous === undefined || depsChanged(previous.deps, deps)
		effectSlots[slot] = { deps, cleanup: previous?.cleanup }
		if (changed) pendingEffects.push({ slot, effect })
	},
	useCallback(callback, deps) {
		const slot = cursor++
		const previous = callbackSlots[slot]
		const changed = previous === undefined || depsChanged(previous.deps, deps)
		callbackSlots[slot] = { deps, value: changed ? callback : previous.value }
		return callbackSlots[slot].value
	},
}

/** 假 document：只收集 keydown 监听，供 pressEscape 驱动。 */
const domListeners = []
globalThis.document = {
	addEventListener(type, listener) {
		domListeners.push({ type, listener })
	},
	removeEventListener(type, listener) {
		const index = domListeners.findIndex((entry) => entry.type === type && entry.listener === listener)
		if (index >= 0) domListeners.splice(index, 1)
	},
}
const pressEscape = () => {
	for (const entry of domListeners.slice()) {
		if (entry.type === 'keydown') entry.listener({ key: 'Escape' })
	}
}

const ReactFake = {
	Fragment: 'Fragment',
	useState: hooks.useState,
	useEffect: hooks.useEffect,
	useCallback: hooks.useCallback,
}
const jsx = (type, props) => ({ type, props: props ?? {} })
const JsxRuntimeFake = { jsx, jsxs: jsx, Fragment: 'Fragment' }
const requireShim = (id) => {
	if (id === 'react') return ReactFake
	if (id === 'react/jsx-runtime') return JsxRuntimeFake
	throw new Error(`unexpected require(${id})`)
}

await import('../lib/client.js')
assert.equal(loaded.id, 'dsh-skill-center', '客户端 bundle id 应为包名')
const client = loaded.factory(requireShim)
assert.deepEqual(client.inject, ['slots'])

// ───────────────────────── 2. 伪 slots ─────────────────────────
const registrations = []
client.apply({
	slots: {
		inject(seat, callback) {
			assert.ok(seat === 'sidebar.panellist' || seat === 'main', `未知座位：${seat}`)
			return callback()
		},
		register(options, component) {
			registrations.push({ options, component })
			return () => {}
		},
	},
	effect(callback) {
		const dispose = callback()
		return () => { if (typeof dispose === 'function') dispose() }
	},
})
assert.equal(registrations.length, 2, '应注册侧栏行 + 中栏页')
const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.options.name === 'main')
assert.equal(sidebar.options.id, 'skill-center')
assert.equal(sidebar.options.label(), '技能中心')
assert.equal(main.options.key, 'skill-center')
const iconTree = sidebar.component({ size: 18, active: false })
assert.equal(iconTree.type, 'svg')
console.log('侧栏注册 OK：id=skill-center order=42 label=技能中心 · 图标 svg 渲染 OK')

// ───────────────────────── 3. 渲染工具 ─────────────────────────
const Page = main.component
/** 渲染一次并跑掉本轮变化了的 effect（先 cleanup 再重跑，贴近 React）。 */
const render = () => {
	cursor = 0
	pendingEffects = []
	const tree = Page({})
	for (const entry of pendingEffects) {
		const record = effectSlots[entry.slot]
		if (typeof record.cleanup === 'function') record.cleanup()
		record.cleanup = entry.effect()
	}
	return tree
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 120))
const waitFor = async (predicate, timeoutMs = 6000, stepMs = 25) => {
	const started = Date.now()
	for (;;) {
		// 允许同步/异步断言：await 非 Promise 也会得到原值
		if (await predicate()) return true
		if (Date.now() - started > timeoutMs) return false
		await new Promise((resolve) => setTimeout(resolve, stepMs))
	}
}

/** 深度遍历：函数组件就地展开（本插件的卡片/弹框都是纯函数组件，无 hook）。 */
function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit)
		return
	}
	if (typeof node.type === 'function') {
		walk(node.type(node.props ?? {}), visit)
		return
	}
	visit(node)
	walk(node.props?.children, visit)
}

function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return ''
	if (typeof node === 'string') return node + '\n'
	if (typeof node === 'number') return String(node) + '\n'
	if (Array.isArray(node)) return node.map(textOf).join('')
	if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
	return textOf(node.props?.children)
}

const findAll = (tree, predicate) => {
	const hits = []
	walk(tree, (node) => { if (predicate(node)) hits.push(node) })
	return hits
}
const findOne = (tree, predicate) => findAll(tree, predicate)[0]
const cardsOf = (tree) => findAll(tree, (node) => node.props?.['data-dsc-card'] !== undefined)
const tabsOf = (tree) => findAll(tree, (node) => node.props?.['data-dsc-tab'] !== undefined)
const byAction = (tree, action) => findOne(tree, (node) => node.props?.['data-dsc-action'] === action)
const cardById = (tree, id) => findOne(tree, (node) => node.props?.['data-dsc-card'] === id)
const clickEvent = () => ({ stopPropagation() {} })
const menuEvent = () => ({
	stopPropagation() {},
	currentTarget: { getBoundingClientRect: () => ({ left: 100, bottom: 200 }) },
})

// ═══════════════════ A. 真实目录（只读） ═══════════════════
const NONEXISTENT_STORE = join(tmpdir(), 'dsh-skill-center-does-not-exist', 'skill-center.json')
const real = await startHost({}, { DSH_SKILL_CENTER_STORE: NONEXISTENT_STORE, DSH_SKILL_CENTER_NO_SPAWN: '1' })
globalThis.fetch = makeFetch(real.byPath)

let tree = render()
assert.ok(textOf(tree).includes('技能中心'), '页头应有「技能中心」')
assert.ok(await waitFor(() => /共 \d+ 个技能/.test(textOf(render()))), 'list 路由应在超时前返回数据')

tree = render()
const text = textOf(tree)
const tabs = tabsOf(tree)
assert.equal(tabs.length, 2, `顶部应有 2 个页签，实际 ${tabs.length}`)
assert.equal(tabs[0].props['data-dsc-tab'], 'dsh')
assert.equal(tabs[1].props['data-dsc-tab'], 'workbuddy')
assert.equal(tabs[0].props['aria-selected'], true, '默认应选中 dsh技能')

const dshCards = cardsOf(tree)
assert.ok(Array.isArray(dshCards), '应能取到当前页签的卡片')
assert.ok(/共 \d+ 个技能/.test(text), `页头应显示总数，实际：${text.slice(0, 120)}`)

// 会话可见性徽标：值随各人技能库而异 —— 只断言存在、文案格式、以及卡片标记与启用态一致
const registryBadge = findOne(tree, (node) => node.props?.['data-dsc-registry'] !== undefined)
assert.ok(registryBadge !== undefined, '页头应有「已接入会话」徽标')
assert.ok(
	/已接入会话 \d+\/\d+/.test(textOf(registryBadge)),
	`徽标文案应为「已接入会话 X/Y」，实际：${textOf(registryBadge).trim()}`,
)
for (const card of dshCards) {
	const id = card.props['data-dsc-card']
	assert.equal(typeof card.props['data-dsc-registered'], 'boolean', `${id}: 应带 registered 标记`)
	assert.equal(card.props['data-dsc-registered'], card.props['data-dsc-enabled'], `${id}: 会话可见性应与启用态一致`)
}
console.log(`会话可见性徽标 OK：页头「${textOf(registryBadge).trim()}」（值随技能库而定），卡片标记与启用态一致`)
console.log(`页签 OK：${tabs.length} 个页签 · 首个页签 ${dshCards.length} 张卡片（数量随技能库而定）`)

// 每张卡片都要有 ⋯ 菜单与启用开关，且 ⋯ 必须排在开关**左边**
for (const card of dshCards) {
	const id = card.props['data-dsc-card']
	assert.ok(findOne(card, (node) => node.props?.['data-dsc-toggle'] === id) !== undefined, `${id} 应有启用开关`)
	assert.ok(findOne(card, (node) => node.props?.['data-dsc-menu'] === id) !== undefined, `${id} 应有 ⋯ 菜单按钮`)
	const order = []
	walk(card, (node) => {
		if (node.props?.['data-dsc-toggle'] === id) order.push('toggle')
		if (node.props?.['data-dsc-menu'] === id) order.push('menu')
	})
	assert.deepEqual(order, ['menu', 'toggle'], `${id}: 「⋯」应排在启用开关左边，实际 ${order.join(' → ')}`)
}
if (dshCards.length > 0) {
	const anyToggle = findOne(dshCards[0], (node) => node.props?.['data-dsc-toggle'] !== undefined)
	assert.equal(anyToggle.props.role, 'switch', '开关应是 role=switch')
	assert.equal(typeof anyToggle.props['aria-checked'], 'boolean')
}
console.log('卡片操作 OK：每张卡片都带 role=switch 的启用开关与 ⋯ 菜单按钮')

// 切页签（数量随技能库而异：断言"切换生效 + 卡片都来自当前页签的根"）
tabs[1].props.onClick()
tree = render()
const afterSwitch = tabsOf(tree)
assert.equal(afterSwitch[1].props['aria-selected'], true, '切换后应选中第二个页签')
assert.equal(afterSwitch[0].props['aria-selected'], false)
const rootMeta = findOne(
	tree,
	(node) =>
		typeof node.props?.children === 'string' &&
		node.props.children === node.props?.title &&
		node.props.children.endsWith('skills'),
)
const switchedCards = cardsOf(tree)
if (rootMeta !== undefined) {
	for (const card of switchedCards) {
		assert.ok(String(card.props.title).startsWith(String(rootMeta.props.children)), '卡片都应来自当前页签的根')
	}
}
console.log(`切换页签 OK：第二个页签选中，${switchedCards.length} 张卡片都来自当前根`)

// 详情弹框 / 关闭三路径 / 搜索 的断言都基于夹具技能（见 B 段）——这里先备好两个纯查询帮手。
const backdropOf = (current) => findOne(current, (node) => node.props?.['data-dsc-dialog'] !== undefined)
const searchBoxOf = (current) => findOne(current, (node) => node.props?.['aria-label'] === '搜索技能')

// ═══════════════════ B. 夹具目录（可写） ═══════════════════
const fixture = await makeFixture()
const fx = await startHost(
	{ groups: [{ id: 'fx', label: '测试技能', root: fixture.root }] },
	{ DSH_SKILL_CENTER_STORE: fixture.store, DSH_SKILL_CENTER_NO_SPAWN: '1' },
)
globalThis.fetch = makeFetch(fx.byPath)

// 清空搜索 + 刷新 → 切到夹具数据
searchBoxOf(tree).props.onKeyDown({ key: 'Escape' })
tree = render()
byAction(tree, 'refresh').props.onClick()
assert.ok(await waitFor(() => cardsOf(render()).length === 4), '刷新后应显示夹具的 4 个条目（alpha/beta/expert/linked）')
tree = render()
assert.equal(tabsOf(tree).length, 1, '夹具只有一个来源目录')
assert.equal(tabsOf(tree)[0].props['data-dsc-tab'], 'fx')
assert.ok(textOf(tree).includes('插件配置'), '来源标记应显示“插件配置”（config.groups）')
console.log('夹具页签 OK：1 个来源目录 fx · 4 个条目（含专家团）· 来源标记「插件配置」')

// ── 详情弹框（夹具技能 alpha：正文 + 大小 + 「打开文件夹」按钮）──
const alphaCard = cardById(tree, 'alpha')
assert.ok(alphaCard !== undefined, '应能定位夹具技能 alpha')
alphaCard.props.onClick()
tree = render()
assert.ok(backdropOf(tree) !== undefined, '点击卡片应打开详情弹框')
assert.ok(await waitFor(() => textOf(render()).includes('# alpha')), '弹框应加载出正文')
tree = render()
const dialogText = textOf(tree)
assert.ok(dialogText.includes('# alpha'), '弹框正文应含技能正文')
assert.ok(/\d+\s*(B|KB|MB)/.test(dialogText), `弹框头部应显示文件大小，实际：${dialogText.slice(0, 160)}`)
assert.ok(backdropOf(tree) !== undefined, '弹框应仍打开')
assert.ok(
	findOne(
		tree,
		(node) => node.props?.['data-dsc-action'] === 'reveal' && node.props?.style?.cursor === 'pointer',
	) !== undefined,
	'详情弹框应带「打开文件夹」按钮',
)
console.log('详情弹框 OK：正文 + 大小 + 「打开文件夹」按钮（夹具 alpha，与真实技能库无关）')

// ── 关闭三路径：✕ / 背景点击 / Esc ──
const reopenDialog = () => {
	cardById(tree, 'alpha').props.onClick()
}
findOne(tree, (node) => node.props?.['aria-label'] === '关闭' && node.type === 'button').props.onClick()
tree = render()
assert.equal(backdropOf(tree), undefined, '✕ 应关闭弹框')
reopenDialog()
assert.ok(await waitFor(() => textOf(render()).includes('# alpha')))
tree = render()
backdropOf(tree).props.onClick()
tree = render()
assert.equal(backdropOf(tree), undefined, '点背景应关闭弹框')
reopenDialog()
assert.ok(await waitFor(() => textOf(render()).includes('# alpha')))
tree = render()
pressEscape()
tree = render()
assert.equal(backdropOf(tree), undefined, 'Esc 应关闭弹框')
console.log('关闭 OK：✕ 按钮 / 背景点击 / Esc（document 监听）三条路径都能关闭详情弹框')

// ── 搜索过滤（夹具三个技能：alpha / beta / linked）──
searchBoxOf(tree).props.onChange({ target: { value: 'beta' } })
tree = render()
const betaOnly = cardsOf(tree)
assert.equal(betaOnly.length, 1, `搜 beta 应只剩 1 张卡片，实际 ${betaOnly.length}`)
assert.equal(betaOnly[0].props['data-dsc-card'], 'beta')
// 专家团的标签也参与搜索
searchBoxOf(tree).props.onChange({ target: { value: 'Fixture' } })
tree = render()
const tagOnly = cardsOf(tree)
assert.equal(tagOnly.length, 1, `按标签搜应命中专家团，实际 ${tagOnly.length} 张`)
assert.equal(tagOnly[0].props['data-dsc-card'], 'expert')
searchBoxOf(tree).props.onKeyDown({ key: 'Escape' })
tree = render()
assert.equal(cardsOf(tree).length, 4, 'Esc 清空后应恢复 4 个条目')
console.log('搜索 OK：搜 beta → 1 张卡片；按标签搜 Fixture → 专家团；Esc 清空 → 恢复 4 个条目')

// ── 专家团卡片（头像走 avatar 路由 + 显示名 + 标签 + 团队徽标 + 开关/菜单）──
const expertCard = cardById(tree, 'expert')
assert.ok(expertCard !== undefined, '专家团应渲染成一张卡片')
assert.equal(expertCard.props['data-dsc-kind'], 'agent', '卡片应带 kind=agent')
const cardAvatar = findOne(expertCard, (node) => node.type === 'img')
assert.ok(cardAvatar !== undefined, '专家团卡片应用头像图（而不是首字母块）')
assert.ok(
	String(cardAvatar.props.src).startsWith('api/skill-center/avatar'),
	`头像 URL 必须是文档相对路径，实际：${cardAvatar.props.src}`,
)
assert.ok(String(cardAvatar.props.src).includes('group=fx'), '头像 URL 应带 group')
assert.ok(String(cardAvatar.props.src).includes('which=lead'), '卡片头像应是 lead')
assert.ok(textOf(expertCard).includes('夹具专家团'), '卡片显示名应取清单里的 zh 文案')
assert.ok(
	findOne(expertCard, (node) => node.props?.['data-dsc-tags'] === 'expert') !== undefined,
	'卡片应渲染标签 chips',
)
assert.ok(
	findOne(expertCard, (node) => node.props?.['data-dsc-team'] === 'expert') !== undefined,
	'卡片应有团队徽标',
)
assert.ok(textOf(expertCard).includes('3 人团队'), `徽标应显示人数，实际：${textOf(expertCard)}`)
assert.ok(
	findOne(expertCard, (node) => node.props?.['data-dsc-toggle'] !== undefined) !== undefined,
	'专家团也要有启用开关',
)
assert.ok(
	findOne(expertCard, (node) => node.props?.['data-dsc-menu'] !== undefined) !== undefined,
	'专家团也要有 ⋯ 菜单',
)
console.log('专家团卡片 OK：头像图（avatar 路由）+ 显示名 + 标签 chips + 「3 人团队」+ 开关/菜单')

// ── 专家团详情弹框：profession / 团队帮你做 / 团队成员 / lead 提示词 ──
expertCard.props.onClick()
tree = render()
assert.ok(backdropOf(tree) !== undefined, '点专家团卡片应打开详情弹框')
assert.ok(await waitFor(() => textOf(render()).includes('# expert 提示词')), '弹框应加载 lead 提示词正文')
tree = render()
const agentDialog = textOf(tree)
assert.ok(agentDialog.includes('夹具主理人'), '弹框应显示 profession')
assert.ok(
	findOne(tree, (node) => node.props?.['data-dsc-agent-docs'] === 'expert') !== undefined,
	'弹框应显示提示词份数（agentDocs）',
)
assert.ok(agentDialog.includes('2 份提示词'), `应显示「N 份提示词」，实际：${agentDialog.slice(0, 200)}`)
assert.ok(
	findOne(tree, (node) => node.props?.['data-dsc-quick-prompts'] === 'expert') !== undefined,
	'弹框应有「团队帮你做」区块',
)
assert.ok(agentDialog.includes('团队帮你做'), '区块标题应为「团队帮你做」')
assert.ok(agentDialog.includes('帮我分派一下'), '应逐条列出 quickPrompts')
assert.ok(
	findOne(tree, (node) => node.props?.['data-dsc-members'] === 'expert') !== undefined,
	'弹框应有「团队成员」区块',
)
assert.ok(agentDialog.includes('团队成员（3）'), `成员区块应显示人数，实际：${agentDialog.slice(0, 200)}`)
assert.ok(agentDialog.includes('夹具总调'), '应列出 lead 的名字')
assert.ok(agentDialog.includes('Helper'), '应列出成员名字（缺 zh 时回退 en）')
assert.ok(agentDialog.includes('越界探针'), '应列出没有头像的成员')
const dialogAvatars = findAll(
	backdropOf(tree),
	(node) => node.type === 'img' && String(node.props?.src ?? '').includes('api/skill-center/avatar'),
)
assert.ok(dialogAvatars.length >= 2, `弹框内应渲染 lead 头像 + 有头像的成员，实际 ${dialogAvatars.length}`)
assert.ok(
	dialogAvatars.some((node) => String(node.props.src).includes('which=helper')),
	'成员头像应按成员 id 请求',
)
assert.equal(
	dialogAvatars.some((node) => String(node.props.src).includes('which=ghost')),
	false,
	'没有头像的成员（越界探针）不该发图片请求',
)
console.log('专家团弹框 OK：profession + 团队帮你做 + 团队成员（头像按成员 id 走 avatar 路由）+ lead 正文')

// 关掉弹框，不影响后面的断言
findOne(tree, (node) => node.props?.['aria-label'] === '关闭' && node.type === 'button').props.onClick()
tree = render()
assert.equal(backdropOf(tree), undefined, '✕ 应能关掉专家团弹框')

// linked 是 junction：可列出，但开关必须被禁用
const linkedCard = cardById(tree, 'linked')
assert.ok(linkedCard !== undefined, 'junction 技能应被列出')
const linkedToggle = findOne(linkedCard, (node) => node.props?.['data-dsc-toggle'] !== undefined)
assert.equal(linkedToggle.props.disabled, true, 'junction 技能的开关必须禁用')

// ── 启用开关：真改写文件 ──
const alphaFile = join(fixture.root, 'alpha', 'SKILL.md')
assert.ok(!(await readFile(alphaFile, 'utf8')).includes('disable-model-invocation'), '前置：alpha 未停用')
const alphaToggle = findOne(cardById(tree, 'alpha'), (node) => node.props?.['data-dsc-toggle'] !== undefined)
alphaToggle.props.onClick(clickEvent())
assert.ok(
	await waitFor(() => cardById(render(tree), 'alpha')?.props['data-dsc-enabled'] === false),
	'停用后卡片应变为停用态',
)
assert.ok(
	await waitFor(async () => (await readFile(alphaFile, 'utf8')).includes('disable-model-invocation: true')),
	'停用必须真的写进 SKILL.md',
)
tree = render()
assert.ok(textOf(cardById(tree, 'alpha')).includes('已停用'), '卡片应显示「已停用」标签')
assert.equal(cardById(tree, 'alpha').props['data-dsc-registered'], false, '停用后应标记为未接入会话')
console.log('开关 OK：点停用 → SKILL.md 写入 disable-model-invocation: true，卡片显示「已停用」且退出会话技能表')

// 再启用 → 文件还原
findOne(cardById(tree, 'alpha'), (node) => node.props?.['data-dsc-toggle'] !== undefined).props.onClick(clickEvent())
assert.ok(
	await waitFor(async () => !(await readFile(alphaFile, 'utf8')).includes('disable-model-invocation')),
	'启用后应删掉该行',
)
tree = render()
assert.equal(cardById(tree, 'alpha').props['data-dsc-enabled'], true)
console.log('开关 OK：再启用 → 该行被删掉，卡片回到启用态')

// ── ⋯ 菜单：三个动作 ──
findOne(cardById(tree, 'alpha'), (node) => node.props?.['data-dsc-menu'] !== undefined).props.onClick(menuEvent())
tree = render()
const panel = findOne(tree, (node) => node.props?.['data-dsc-menu-panel'] !== undefined)
assert.ok(panel !== undefined, '点 ⋯ 应弹出菜单')
const menuActions = findAll(panel, (node) => typeof node.props?.['data-dsc-action'] === 'string').map((node) => node.props['data-dsc-action'])
assert.ok(menuActions.includes('reveal'), '菜单应有「打开文件夹」')
assert.ok(menuActions.includes('copy'), '菜单应有「复制路径」')
assert.ok(menuActions.includes('toggle'), '菜单应有「启用/停用技能」')
assert.ok(textOf(panel).includes('alpha'), '菜单应显示技能路径')
console.log(`菜单 OK：⋯ → 打开文件夹 / 复制路径 / 启停（${menuActions.join(' / ')}）`)

// 打开文件夹（演练模式：只回命令不真拉起）
findOne(panel, (node) => node.props?.['data-dsc-action'] === 'reveal').props.onClick()
assert.ok(await waitFor(() => textOf(render()).includes('explorer.exe')), '打开文件夹应回显将要执行的命令')
tree = render()
assert.ok(textOf(tree).includes('explorer.exe'), '应有 toast 提示')
console.log('打开文件夹 OK：调用 reveal 路由并回显 explorer.exe 命令（演练模式，未真弹窗）')

// 菜单里的启停：停用 beta
findOne(cardById(tree, 'beta'), (node) => node.props?.['data-dsc-menu'] !== undefined).props.onClick(menuEvent())
tree = render()
findOne(findOne(tree, (node) => node.props?.['data-dsc-menu-panel'] !== undefined), (node) => node.props?.['data-dsc-action'] === 'toggle').props.onClick()
const betaFile = join(fixture.root, 'beta.md')
assert.ok(await waitFor(async () => (await readFile(betaFile, 'utf8')).includes('disable-model-invocation: true')), '菜单启停应生效')
console.log('菜单启停 OK：对无 frontmatter 的 beta.md 也补出了开关')

// ── 来源目录编辑器 ──
byAction(tree, 'open-groups').props.onClick()
assert.ok(await waitFor(() => findOne(render(), (node) => node.props?.['data-dsc-groups'] !== undefined) !== undefined), '应打开来源目录编辑器')
tree = render()
const rootInput = findOne(tree, (node) => node.props?.['data-dsc-group-root'] === '0')
const labelInput = findOne(tree, (node) => node.props?.['data-dsc-group-label'] === '0')
assert.ok(rootInput !== undefined && labelInput !== undefined, '编辑器应有 id/显示名/路径三个输入')
assert.equal(rootInput.props.value, fixture.root, '路径应回填当前值')
console.log('来源目录编辑器 OK：回填当前 id / 显示名 / 路径')

// 改显示名 → 保存 → 页签跟着改（证明来源目录确实可改）
labelInput.props.onChange({ target: { value: '改名技能' } })
assert.ok(byAction(render(), 'save-groups') !== undefined, '应有保存按钮')
byAction(render(tree), 'save-groups').props.onClick()
assert.ok(
	await waitFor(() => tabsOf(render()).some((tab) => textOf(tab).includes('改名技能'))),
	'保存后页签应使用新的显示名',
)
assert.equal(existsSync(fixture.store), true, '保存应写出持久化文件')
console.log('改名保存 OK：页签变为「改名技能」，并写出持久化文件')

// 非法输入 → 校验报错（并留在编辑器里）
byAction(render(), 'open-groups').props.onClick()
await waitFor(() => findOne(render(), (node) => node.props?.['data-dsc-group-root'] === '0') !== undefined)
tree = render()
findOne(tree, (node) => node.props?.['data-dsc-group-root'] === '0').props.onChange({ target: { value: 'relative\\path' } })
byAction(render(), 'save-groups').props.onClick()
assert.ok(
	await waitFor(() => findOne(render(), (node) => node.props?.['data-dsc-note'] === 'error') !== undefined),
	'非法路径应就地报错',
)
tree = render()
assert.ok(textOf(tree).includes('绝对路径'), '错误信息应说明原因')
console.log('校验 OK：相对路径被拒绝并就地报错，编辑器不关闭')

// 恢复默认 → 回到 config.groups
byAction(tree, 'reset-groups').props.onClick()
assert.ok(await waitFor(() => tabsOf(render()).some((tab) => textOf(tab).includes('测试技能'))), '恢复默认后应回到 config 的显示名')
assert.equal(existsSync(fixture.store), false, '恢复默认应删掉持久化文件')
console.log('恢复默认 OK：删除持久化文件并回到插件配置')

// ── 重名技能：未注册的那张卡片要显示「未接入」+ 原因 tooltip ──
const dupRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-center-client-dup-'))
await mkdir(join(dupRoot, 'one'), { recursive: true })
await mkdir(join(dupRoot, 'two'), { recursive: true })
const dupSkill = '---\nname: same-name\ndescription: 重名夹具\n---\n\n# x\n'
await writeFile(join(dupRoot, 'one', 'SKILL.md'), dupSkill, 'utf8')
await writeFile(join(dupRoot, 'two', 'SKILL.md'), dupSkill, 'utf8')
const dupHost = await startHost(
	{ groups: [{ id: 'dup', label: '重名夹具', root: dupRoot }] },
	{ DSH_SKILL_CENTER_NO_SPAWN: '1', DSH_SKILL_CENTER_STORE: join(dupRoot, 'store.json') },
)
globalThis.fetch = makeFetch(dupHost.byPath)
byAction(render(), 'refresh').props.onClick()
assert.ok(await waitFor(() => cardsOf(render()).length === 2), '重名夹具应有 2 张卡片')
tree = render()
const unregisteredTags = findAll(tree, (node) => node.props?.['data-dsc-unregistered'] !== undefined)
assert.equal(unregisteredTags.length, 1, '恰好一张卡片应显示「未接入」')
assert.ok(textOf(unregisteredTags[0]).includes('未接入'))
assert.ok(
	String(unregisteredTags[0].props.title).includes('重复'),
	`tooltip 应说明重名原因，实际：${unregisteredTags[0].props.title}`,
)
const dupBadge = findOne(tree, (node) => node.props?.['data-dsc-registry'] !== undefined)
assert.equal(dupBadge.props['data-dsc-registry'], '1', '只应接入 1 个')
assert.ok(textOf(dupBadge).includes('已接入会话 1/2'), `徽标应显示 1/2，实际：${textOf(dupBadge).trim()}`)
console.log('未接入标签 OK：重名里未注册的那张显示「未接入」+ 原因 tooltip，徽标 1/2')
await rm(dupRoot, { recursive: true, force: true })

await fixture.cleanup()
void settle
console.log('\n✅ client-render: 全部断言通过（页签 / 卡片 / 开关 / 菜单 / 详情弹框 / 来源目录编辑器）')
