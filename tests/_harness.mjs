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

/**
 * 造一个临时技能根：
 *   alpha/SKILL.md    目录型技能（有 frontmatter）
 *   beta.md           单文件技能（无 frontmatter）
 *   .hidden/SKILL.md  点开头，应跳过
 *   noskill/README.md 目录里没有 SKILL.md，应跳过
 *   README.md         文档，应跳过
 *   linked/SKILL.md   符号链接目录（若系统不允许建链接则跳过该项）
 * @returns {Promise<{root: string, store: string, linked: boolean, cleanup: () => Promise<void>}>}
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
		cleanup: async () => {
			await rm(base, { recursive: true, force: true })
		},
	}
}
