/**
 * 测试夹具：给两个测试文件共用的最小宿主驱动。
 *
 * 设计要点：
 *  - 写操作（启用/停用、来源目录）只在**临时夹具目录**上跑，绝不碰用户真实技能；
 *  - 临时 store（DSH_SKILL_CENTER_STORE）与演练开关（DSH_SKILL_CENTER_NO_SPAWN）
 *    通过环境变量注入，宿主半区在每次请求时读取，因此导入后设置也生效。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 记录式假 response（宿主只用到 status/header/body 三个写口）。 */
export function makeResponse() {
	const out = { statusCode: undefined, headers: undefined, body: '' }
	return {
		writeHead(status, headers) {
			out.statusCode = status
			out.headers = headers
		},
		end(body) {
			out.body = body ?? ''
		},
		get result() {
			return out
		},
	}
}

/** 一个 loopback 的假请求（可选 JSON body，支持 for await 读取）。 */
export function makeRequest(method, url, body) {
	return {
		method,
		url,
		socket: { remoteAddress: '127.0.0.1' },
		headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
		},
	}
}

/** 记一个非 loopback 的假请求（围栏用）。 */
export function makeRemoteRequest(method, url) {
	return {
		method,
		url,
		socket: { remoteAddress: '192.168.1.20' },
		headers: { host: '192.168.1.20:19387' },
	}
}

/**
 * 挂载真实宿主半区并抓取路由。
 * @param config 插件 config（含 groups 时即作为来源目录）
 * @param env 注入的环境变量（临时 store / 演练开关）
 * @param options.allowedSources 假技能注册表接受的 source（默认 runtime + bundled）
 */
export async function startHost(config = {}, env = {}, options = {}) {
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	const allowedSources = options.allowedSources ?? ['runtime', 'bundled']
	/** 假技能注册表：记录注册/注销，供测试断言「会话能不能看到这个技能」。 */
	const registry = { entries: new Map(), registered: 0, disposed: 0 }
	const skills = {
		register(registration) {
			if (!allowedSources.includes(registration.source)) {
				throw new Error(`unknown skill source: ${registration.source}`)
			}
			const token = {}
			registry.entries.set(registration.name, { registration, token })
			registry.registered += 1
			return () => {
				registry.disposed += 1
				const current = registry.entries.get(registration.name)
				if (current !== undefined && current.token === token) registry.entries.delete(registration.name)
			}
		},
	}
	const captured = []
	const host = await import('../lib/index.js')
	host.apply(
		{
			logger: { warn() {} },
			effect(callback) {
				const dispose = callback()
				return () => {
					if (typeof dispose === 'function') dispose()
				}
			},
			webServer: {
				register(route) {
					captured.push(route)
					return () => {}
				},
			},
			skills,
		},
		config,
	)
	return {
		host,
		routes: captured,
		byPath: new Map(captured.map((route) => [route.path, route])),
		registry,
	}
}

/** 直接驱动一条宿主路由。 */
export async function call(byPath, method, url, body) {
	const parsed = new URL(url, 'http://127.0.0.1:19387')
	const route = byPath.get(parsed.pathname)
	assert.ok(route !== undefined, `no route for ${parsed.pathname}`)
	const response = makeResponse()
	await route.handler(makeRequest(method, parsed.pathname + parsed.search, body), response)
	const result = response.result
	return {
		status: result.statusCode,
		json: result.body === '' ? undefined : JSON.parse(result.body),
	}
}

/** 用假 fetch 把浏览器半区的相对路径打回真实宿主路由（含真实文件读写）。 */
export function makeFetch(byPath) {
	return async (input, init = {}) => {
		const url = new URL(String(input), 'http://127.0.0.1:19387')
		const route = byPath.get(url.pathname)
		if (route === undefined) throw new Error(`no route for ${url.pathname}`)
		let payload
		if (init.body !== undefined) {
			try {
				payload = JSON.parse(String(init.body))
			} catch {
				payload = undefined
			}
		}
		const response = makeResponse()
		await route.handler(makeRequest(init.method ?? 'GET', url.pathname + url.search, payload), response)
		const { statusCode, body } = response.result
		return {
			ok: statusCode === 200,
			status: statusCode,
			json: async () => JSON.parse(body),
		}
	}
}

const ALPHA = `---
name: alpha
description: 夹具技能 alpha（目录型）
---

# alpha
正文第一行。
`

const BETA = `# beta

单文件技能，没有 frontmatter。
`

/** 链接目录里的技能：必须声明**自己的** name，否则会与 alpha 重名。 */
const LINKED = `---
name: linked
description: 夹具技能 linked（junction 目录）
---

# linked
正文。
`

/** 两张 1×1 真 PNG（Pillow 生成并回读校验过），用来验头像路由返回的是**图片字节**。 */
const LEAD_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO45ur4HwAFrQJcCCRDDgAAAABJRU5ErkJggg=='
const HELPER_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPwyvn+HwAFXgKtDVB5HAAAAABJRU5ErkJggg=='

/** 夹具 lead 提示词（带 frontmatter：注册正文里必须被剥掉）。 */
const AGENT_LEAD_DOC = `---
name: expert-lead
description: 夹具 lead 提示词
---

# expert 提示词
夹具专家团的 lead 提示词正文。
`

/** 迷你专家团清单：覆盖 zh/en 文案、tags、quickPrompts、members、越界头像探针。 */
const AGENT_MANIFEST = {
	name: 'expert',
	version: '1.0.0',
	description: 'Mini expert team fixture (英文兜底)',
	expertType: 'team',
	agentName: 'expert',
	teamInfo: { leadAgent: 'expert', memberAgents: ['helper', 'ghost'] },
	displayName: { zh: '夹具专家团', en: 'Fixture Expert' },
	profession: { zh: '夹具主理人' },
	displayDescription: { zh: '夹具：一个迷你专家团，用来验证 agent 形态。' },
	avatar: 'avatars/expert.png',
	tags: [{ zh: '夹具' }, { en: 'Fixture' }],
	quickPrompts: [{ zh: '帮我分派一下' }, { en: 'Route this' }],
	agents: ['./agents/lead.md', './team/helper/agents/helper.md'],
	skills: [],
	members: [
		{
			id: 'expert',
			displayName: { zh: '夹具总调' },
			profession: { zh: '主理人' },
			avatar: 'avatars/expert.png',
			role: 'lead',
		},
		{
			id: 'helper',
			displayName: { en: 'Helper' },
			profession: { zh: '操作员' },
			avatar: './team/helper/avatars/expert.png',
			role: 'member',
		},
		// 越界探针：指向专家团目录之外的 secret.png，必须被解析成「没有头像」
		{ id: 'ghost', displayName: { zh: '越界探针' }, avatar: '../../secret.png', role: 'member' },
	],
}

/**
 * 造一个临时技能根：
 *   alpha/SKILL.md    目录型技能（有 frontmatter）
 *   beta.md           单文件技能（无 frontmatter）
 *   expert/           专家团（agent 形态，见 AGENT_MANIFEST）
 *   .hidden/SKILL.md  点开头，应跳过
 *   noskill/README.md 目录里没有 SKILL.md，应跳过
 *   README.md         文档，应跳过
 *   linked/SKILL.md   符号链接目录（若系统不允许建链接则跳过该项）
 * @returns {Promise<{root, store, linked, agent, cleanup}>} agent 里带专家团的关键路径
 */
export async function makeFixture() {
	const base = await mkdtemp(join(tmpdir(), 'dsh-skill-center-'))
	const root = join(base, 'skills')
	const store = join(base, 'skill-center.json')
	await mkdir(join(root, 'alpha'), { recursive: true })
	await mkdir(join(root, '.hidden'), { recursive: true })
	await mkdir(join(root, 'noskill'), { recursive: true })
	await writeFile(join(root, 'alpha', 'SKILL.md'), ALPHA, 'utf8')
	await writeFile(join(root, 'beta.md'), BETA, 'utf8')
	await writeFile(join(root, '.hidden', 'SKILL.md'), ALPHA, 'utf8')
	await writeFile(join(root, 'noskill', 'README.md'), 'not a skill\n', 'utf8')
	await writeFile(join(root, 'README.md'), 'docs\n', 'utf8')

	// ── 迷你专家团（agent 形态）──
	const expertDir = join(root, 'expert')
	const agentDir = join(expertDir, '.codebuddy-plugin')
	const helperDir = join(expertDir, 'team', 'helper')
	await mkdir(agentDir, { recursive: true })
	await mkdir(join(expertDir, 'agents'), { recursive: true })
	await mkdir(join(expertDir, 'avatars'), { recursive: true })
	await mkdir(join(expertDir, 'references'), { recursive: true })
	await mkdir(join(helperDir, 'agents'), { recursive: true })
	await mkdir(join(helperDir, 'avatars'), { recursive: true })
	const manifestFile = join(agentDir, 'plugin.json')
	const leadDoc = join(expertDir, 'agents', 'lead.md')
	const leadAvatar = join(expertDir, 'avatars', 'expert.png')
	const helperAvatar = join(helperDir, 'avatars', 'expert.png')
	const secret = join(base, 'secret.png')
	await writeFile(manifestFile, JSON.stringify(AGENT_MANIFEST, null, 2), 'utf8')
	await writeFile(leadDoc, AGENT_LEAD_DOC, 'utf8')
	await writeFile(join(expertDir, 'agents', 'README.md'), '不是提示词\n', 'utf8')
	await writeFile(join(helperDir, 'agents', 'helper.md'), '# helper 提示词\n', 'utf8')
	await writeFile(join(expertDir, 'references', 'notes.md'), '# 参考资料\n', 'utf8')
	await writeFile(leadAvatar, Buffer.from(LEAD_PNG_B64, 'base64'))
	await writeFile(helperAvatar, Buffer.from(HELPER_PNG_B64, 'base64'))
	// 越界探针：真文件，就放在技能根之外 —— 守卫失效时会被读到
	await writeFile(secret, Buffer.from(HELPER_PNG_B64, 'base64'))

	let linked = false
	try {
		await mkdir(join(base, 'outside'), { recursive: true })
		await writeFile(join(base, 'outside', 'SKILL.md'), LINKED, 'utf8')
		await symlink(join(base, 'outside'), join(root, 'linked'), 'junction')
		linked = true
	} catch {
		linked = false
	}

	return {
		root,
		store,
		linked,
		agent: {
			id: 'expert',
			dir: expertDir,
			manifest: manifestFile,
			leadDoc,
			helperDoc: join(helperDir, 'agents', 'helper.md'),
			leadAvatar,
			helperAvatar,
			/** 专家团目录之外的真图片：越界头像必须读不到它。 */
			secret,
		},
		cleanup: async () => {
			await rm(base, { recursive: true, force: true })
		},
	}
}
