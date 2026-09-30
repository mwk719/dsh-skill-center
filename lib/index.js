/**
 * dsh-skill-center — 技能中心（宿主半区）
 *
 * 为浏览器半区（./client）提供数据源：
 *   GET  /api/skill-center/list                 技能清单（含 enabled / kind / folder）
 *   GET  /api/skill-center/read?group=&id=      单个技能正文（上限 512KB）
 *   POST /api/skill-center/set-enabled          启用/停用（原子改写 frontmatter 的
 *                                               disable-model-invocation）
 *   POST /api/skill-center/reveal               在系统文件管理器中定位该技能文件
 *   GET  /api/skill-center/groups               当前来源目录 + 来源(file/config/default)
 *   POST /api/skill-center/groups               改写来源目录（持久化，支持 reset 恢复默认）
 *
 * 来源目录解析顺序：持久化文件 → 插件 config.groups → 内置默认两组。
 * 持久化文件默认 ~/.dsh/skill-center.json（可用 DSH_SKILL_CENTER_STORE 覆盖，便于测试）。
 *
 * 技能识别口径（与官方 dsh-skill-filesystem 的目录约定一致）：
 *   - 目录 + 目录内 SKILL.md  → 目录型技能，技能名 = 目录名
 *   - 根目录下的单个 .md 文件 → 单文件技能，技能名 = 文件名去 .md
 *   - 以 . 开头的条目（.git/.claude/.trash_*）、README.md 跳过
 *   - 目录 + .codebuddy-plugin/plugin.json（或 .claude-plugin/plugin.json）
 *                            → WorkBuddy「专家团 / 智能体」（kind: 'agent'）
 *
 * 智能体（agent）与技能的区别：
 *   - 没有 SKILL.md，正文取清单里 agents[] 的 lead 提示词；开关**绝不写文件**，
 *     只记在 store 的 `agents: {"<groupId>":{"<agentId>":bool}}`（缺字段 = 启用）；
 *   - 头像由 `GET /avatar` 提供，服务端只从**本次扫描解析出的绝对路径**取文件。
 *
 * 安全：所有路由只接受同源 loopback 请求；写路由与 reveal 的身份只认「最新一次
 * 扫描」解析出的路径（客户端传来的 path 从不作为凭据）；符号链接技能拒绝改写
 * （原地改写会越出技能根）；avatar 只认 `which` 这个键，路径由服务端自己拼，
 * 并二次校验必须落在该 agent 目录内 + 扩展名白名单。
 */
import { open, lstat, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Stable cordis plugin name. */
const name = 'skill-center'
/** Services required before the routes can mount. */
const inject = ['webServer', 'skills']

const ROUTES = {
  list: '/api/skill-center/list',
  read: '/api/skill-center/read',
  setEnabled: '/api/skill-center/set-enabled',
  reveal: '/api/skill-center/reveal',
  groups: '/api/skill-center/groups',
  avatar: '/api/skill-center/avatar',
}

/** 专家团 / 智能体清单所在目录（命中其一即认为是 agent 形态）。 */
const AGENT_MANIFEST_DIRS = ['.codebuddy-plugin', '.claude-plugin']
/** 清单文件名。 */
const AGENT_MANIFEST_FILE = 'plugin.json'
/** 头像白名单：扩展名 → Content-Type（不在表里的一律 404）。 */
const AVATAR_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

/** frontmatter 里控制「模型能否调用」的字段（停用 = true）。 */
const FIELD_DISABLED = 'disable-model-invocation'
/** frontmatter 只读文件头，避免把 200KB+ 的 SKILL.md 整个读进内存。 */
const HEAD_BYTES = 8192
/** 预览正文上限。 */
const MAX_CONTENT_BYTES = 512 * 1024
/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024
/** 文档性文件不算技能。 */
const SKIP_FILES = new Set(['readme.md'])
/** 描述/适用场景在列表里的截断长度。 */
const DESCRIPTION_LIMIT = 240

/** 默认技能组。 */
const DEFAULT_GROUPS = () => [
  { id: 'dsh', label: 'dsh技能', root: join(homedir(), '.dsh', 'skills') },
  { id: 'workbuddy', label: 'workbuddy技能', root: join(homedir(), '.workbuddy', 'skills') },
]

/** 持久化文件路径（测试可用环境变量指向临时文件）。 */
function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return process.env.DSH_SKILL_CENTER_STORE ?? join(home, 'skill-center.json')
}

/** 是否只回命令不真的拉起文件管理器（测试用）。 */
function dryRunSpawn() {
  return process.env.DSH_SKILL_CENTER_NO_SPAWN === '1'
}

// ─────────────────────────── 同源 loopback 围栏 ───────────────────────────

/** IPv4 127/8 判定。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** socket 远端地址是否属于 loopback（127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false
  const value = String(address).toLowerCase()
  if (value === '::1') return true
  if (value.startsWith('::ffff:')) return isIPv4Loopback(value.slice(7))
  return isIPv4Loopback(value)
}

/** Host 头是否指向 loopback authority。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 请求级围栏：loopback socket + loopback Host 头 + 浏览器同源标记。
 * socket 地址是权威依据，X-Forwarded-For 一律不信任。
 */
function isLoopbackRequest(request) {
  const socket = request?.socket
  if (socket === undefined || !isLoopbackAddress(socket.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ─────────────────────────── 轻量 frontmatter ───────────────────────────

/** 去掉标量两侧的引号。 */
function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** YAML 布尔（true/false/yes/no/on/off/1/0），非布尔返回 undefined。 */
function parseYamlBool(value) {
  const text = String(value).toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

/** 折叠空白并按上限截断。 */
function collapse(value, limit = DESCRIPTION_LIMIT) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/**
 * 解析文件头部的 YAML frontmatter 标量（name/description/whenToUse/
 * disable-model-invocation 等）。零依赖轻量实现，支持 | / > 块标量。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return {}
  const lines = match[1].split(/\r?\n/)
  const out = {}
  for (let index = 0; index < lines.length; index += 1) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index])
    if (kv === null) continue
    const key = kv[1]
    const rest = kv[2].trim()
    if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const block = []
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next]
        if (line.trim() === '' || /^\s+\S/.test(line)) {
          block.push(line.trim())
          continue
        }
        break
      }
      const joined = block.join(' ').trim()
      if (joined !== '') out[key] = unquote(joined)
      continue
    }
    out[key] = unquote(rest)
  }
  return out
}

/** 拆出 frontmatter 块与其余部分；无 frontmatter 返回 undefined。 */
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(text)
  return match === null ? undefined : { block: match[1], rest: match[2] }
}

// ────────────────── 专家团 / 智能体清单（WorkBuddy / CodeBuddy） ──────────────────

/** 取双语文案：{zh,en} → zh → en → fallback；非对象按字符串处理。 */
function pickText(value, fallback = '') {
  if (typeof value === 'string') return value.trim()
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['zh', 'en']) {
      const text = value[key]
      if (typeof text === 'string' && text.trim() !== '') return text.trim()
    }
  }
  return fallback
}

/** 取双语列表（[{zh,en}] → string[]），顺带滤掉空项。 */
function pickTextList(value, limit = 120) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const text = pickText(entry, '')
    if (text !== '') out.push(collapse(text, limit))
  }
  return out
}

/**
 * 把智能体清单（`.codebuddy-plugin/plugin.json`）归一化成列表项要用的字段。
 * 纯函数，不碰文件系统 —— 便于单测文案回退 / 成员 / 标签。
 *
 * @param {object} manifest 已解析的 plugin.json
 * @param {string} fallbackId 目录名（name 的最终兜底）
 */
function parseAgentManifest(manifest, fallbackId = '') {
  const source = manifest !== null && typeof manifest === 'object' ? manifest : {}
  const agentDocs = (Array.isArray(source.agents) ? source.agents : [])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim().replace(/^\.\//, ''))
  const members = (Array.isArray(source.members) ? source.members : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry, index) => {
      const id = String(entry.id ?? `member-${index + 1}`).trim() || `member-${index + 1}`
      return {
        id,
        name: pickText(entry.displayName, '') || id,
        profession: pickText(entry.profession, ''),
        role: String(entry.role ?? 'member').trim() || 'member',
        avatarRel: typeof entry.avatar === 'string' ? entry.avatar.trim() : '',
      }
    })
  const agentName = String(source.agentName ?? '').trim()
  const leadId = String(source?.teamInfo?.leadAgent ?? '').trim()
  // lead 提示词：与 agentName 同名的那份 → teamInfo.leadAgent → 第一份
  const leadDoc =
    agentDocs.find((doc) => basename(doc, '.md') === agentName) ??
    (leadId === '' ? undefined : agentDocs.find((doc) => basename(doc, '.md') === leadId)) ??
    agentDocs[0]
  const leadMember = members.find((member) => member.role === 'lead') ?? members[0]
  const avatarRel =
    (typeof source.avatar === 'string' ? source.avatar.trim() : '') ||
    (leadMember === undefined ? '' : leadMember.avatarRel)
  return {
    name: pickText(source.displayName, '') || String(source.name ?? '').trim() || fallbackId,
    description: pickText(source.displayDescription, '') || collapse(String(source.description ?? '')),
    profession: pickText(source.profession, ''),
    expertType: String(source.expertType ?? '').trim(),
    agentDocs,
    tags: pickTextList(source.tags, 60),
    quickPrompts: pickTextList(source.quickPrompts, 240),
    members,
    leadDoc: leadDoc ?? '',
    avatarRel,
  }
}

/**
 * 把清单里声明的相对路径解析到 baseDir 内。
 * 绝对路径、空串、越界（`..`）一律返回 undefined —— 这是头像/正文的防穿越第一道闸。
 */
function resolveInside(baseDir, rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return undefined
  const text = rel.trim()
  if (isAbsolute(text)) return undefined
  const abs = resolve(baseDir, text)
  const inside = relative(baseDir, abs)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
  return abs
}

/** 头像：必须落在 agent 目录内 + 扩展名白名单 + 是真实存在的文件。 */
async function resolveAvatarFile(baseDir, rel) {
  const abs = resolveInside(baseDir, rel)
  if (abs === undefined) return undefined
  if (AVATAR_TYPES[extname(abs).toLowerCase()] === undefined) return undefined
  return (await safeSize(abs)) === undefined ? undefined : abs
}

/**
 * 判定该目录是不是「专家团 / 智能体」形态，命中则返回清单文件绝对路径。
 *
 * 口径（按真实数据校准，见 tests/host-scan 的回归断言）：
 *   - 只是声明 `skills: ["./"]` 的技能型插件清单 → **不是**智能体（跳过，交给 SKILL.md 规则）
 *   - 声明的 `agents[]` 非空 → 是智能体
 *   - 清单解析不了 → 也按智能体列出（由调用方给出「无法解析」原因，不让 list 崩）
 */
async function findAgentManifest(dir) {
  for (const holder of AGENT_MANIFEST_DIRS) {
    const file = join(dir, holder, AGENT_MANIFEST_FILE)
    if ((await safeSize(file)) === undefined) continue
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      const docs = Array.isArray(manifest?.agents)
        ? manifest.agents.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : []
      if (docs.length === 0) return undefined
      return file
    } catch {
      return file
    }
  }
  return undefined
}

// ─────────────────────────── 来源目录 ───────────────────────────

/**
 * 校验来源目录列表。
 * @returns {{groups: Array, problems: string[]}}
 */
function parseGroups(input) {
  if (!Array.isArray(input)) return { groups: [], problems: ['groups 必须是数组'] }
  const groups = []
  const problems = []
  const seen = new Set()
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index]
    if (entry === null || typeof entry !== 'object') {
      problems.push(`第 ${index + 1} 项不是对象`)
      continue
    }
    const id = String(entry.id ?? '').trim()
    const label = String(entry.label ?? '').trim()
    const root = String(entry.root ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      problems.push(`第 ${index + 1} 项 id 不合法（小写字母/数字/连字符，且不以连字符开头）`)
      continue
    }
    if (seen.has(id)) {
      problems.push(`id 重复：${id}`)
      continue
    }
    if (label === '') {
      problems.push(`第 ${index + 1} 项缺少 label`)
      continue
    }
    if (root === '' || !isAbsolute(root)) {
      problems.push(`第 ${index + 1} 项 root 必须是绝对路径`)
      continue
    }
    seen.add(id)
    groups.push({ id, label, root })
  }
  return { groups, problems }
}

/**
 * 解析 store 里的智能体开关：`{ "<groupId>": { "<agentId>": true|false } }`。
 * 向后兼容：老文件没有 `agents` 字段、或字段坏掉，一律当作空表（不影响 groups 校验）。
 */
function parseAgentStates(input) {
  const out = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [groupId, value] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(groupId)) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const states = {}
    for (const [agentId, flag] of Object.entries(value)) {
      if (agentId === '' || typeof flag !== 'boolean') continue
      states[agentId] = flag
    }
    if (Object.keys(states).length > 0) out[groupId] = states
  }
  return out
}

/** 某个 agent 的启用态：缺字段 = 默认启用。 */
function agentEnabled(states, groupId, agentId) {
  const group = states === undefined || states === null ? undefined : states[groupId]
  if (group === undefined) return true
  const flag = group[agentId]
  return flag === undefined ? true : flag
}

/** 读取持久化的来源目录 + 智能体开关；文件不存在/不可解析返回 undefined。 */
async function loadStoredGroups() {
  let raw
  try {
    raw = await readFile(storePath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    const checked = parseGroups(parsed?.groups)
    // 持久化文件里存的是自证过的数据：即使个别项坏了，也照样用好的那些
    return { groups: checked.groups, agents: parseAgentStates(parsed?.agents), problems: checked.problems }
  } catch {
    return { groups: [], agents: {}, problems: [`${storePath()} 不是合法 JSON`] }
  }
}

/**
 * 解析当前生效的来源目录：持久化文件 → config.groups → 内置默认。
 * @returns {Promise<{groups: Array, agents: object, source: 'file'|'config'|'default', problems: string[]}>}
 */
async function resolveGroups(config) {
  const stored = await loadStoredGroups()
  const agents = stored?.agents ?? {}
  if (stored !== undefined && stored.groups.length > 0) {
    return { groups: stored.groups, agents, source: 'file', problems: stored.problems }
  }
  if (Array.isArray(config?.groups)) {
    const configured = parseGroups(config.groups)
    if (configured.groups.length > 0) {
      return { groups: configured.groups, agents, source: 'config', problems: configured.problems }
    }
  }
  return { groups: DEFAULT_GROUPS(), agents, source: 'default', problems: [] }
}

/**
 * 原子写入持久化文件（来源目录 + 智能体开关）。
 * `agents` 为空时**不写该字段** —— 老文件形状保持不变。
 */
async function saveStoredGroups(groups, agents = {}) {
  const file = storePath()
  const tmp = `${file}.${Date.now().toString(36)}.${randomBytes(6).toString('hex')}.tmp`
  const payload = { version: 1, groups }
  if (agents !== undefined && agents !== null && Object.keys(agents).length > 0) payload.agents = agents
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    })
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * 记录某个智能体的启用态。**只写 store，绝不碰智能体目录里的任何文件**
 * （这类目录没有 SKILL.md 可改，开关是纯内存态的持久化）。
 * @returns {Promise<{agents: object, changed: boolean}>}
 */
async function setAgentEnabled(config, groupId, agentId, enabled) {
  const resolved = await resolveGroups(config)
  const agents = { ...resolved.agents }
  const group = { ...(agents[groupId] ?? {}) }
  const previous = agentEnabled(resolved.agents, groupId, agentId)
  group[agentId] = enabled
  agents[groupId] = group
  // 当前生效的来源目录一并落盘：store 是智能体开关唯一的家
  await saveStoredGroups(resolved.groups, agents)
  return { agents, changed: previous !== enabled }
}

/** 删除持久化文件（回到 config/默认）。 */
async function clearStoredGroups() {
  try {
    await unlink(storePath())
    return true
  } catch {
    return false
  }
}

// ─────────────────────────── 技能扫描（只读） ───────────────────────────

/** stat 的安全封装，失败返回 undefined。 */
async function safeSize(file) {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/** 只读文件头若干字节。 */
async function readHead(file, bytes = HEAD_BYTES) {
  let handle
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/** 由一个技能文件组装列表项。 */
async function describeSkill(groupId, root, id, file, kind) {
  const head = await readHead(file)
  const meta = head === undefined ? {} : parseFrontmatter(head)
  const declared = typeof meta.name === 'string' ? meta.name.trim() : ''
  const disabled = parseYamlBool(meta[FIELD_DISABLED]) === true
  return {
    group: groupId,
    /** 身份：与 ?read / set-enabled / reveal 的 id 参数一一对应。 */
    id,
    /** frontmatter 里声明的技能名，缺失时退回 id。 */
    name: declared === '' ? id : declared,
    description: typeof meta.description === 'string' ? collapse(meta.description) : '',
    whenToUse: typeof meta.whenToUse === 'string' ? collapse(meta.whenToUse) : '',
    path: file,
    kind,
    /** 该技能所在目录（单文件技能 = 技能根）。 */
    folder: dirname(file),
    size: (await safeSize(file)) ?? 0,
    /** 模型是否可调用（disable-model-invocation 的反面）。 */
    enabled: !disabled,
    disabled,
    /** 路径上含符号链接 / junction：可列出、可读取，但拒绝改写。 */
    linked: await hasLinkOnPath(root, file),
  }
}

/**
 * 由一个智能体目录组装列表项（kind: 'agent'）。
 *
 * 清单解析失败也**不抛**：返回一条带 `broken` + `problem` 的降级条目，
 * 由技能桥记成「未接入」，界面照旧能看到它（并显示原因）。
 */
async function describeAgent(groupId, root, id, dir, manifestPath) {
  const item = {
    group: groupId,
    id,
    name: id,
    description: '',
    whenToUse: '',
    path: manifestPath,
    kind: 'agent',
    folder: dir,
    size: (await safeSize(manifestPath)) ?? 0,
    enabled: true,
    disabled: false,
    /** 路径上含链接 ⇒ 只读（与技能一致；agent 本来也不写文件）。 */
    linked: await hasLinkOnPath(root, manifestPath),
    expertType: '',
    tags: [],
    quickPrompts: [],
    members: [],
    agentDocs: [],
    hasAvatar: false,
  }
  // 头像表是**非枚举**属性：不进 JSON 响应，客户端只拿 which 来请求，
  // 永远拿不到真实路径；avatar 路由从这份扫描结果里取。
  Object.defineProperty(item, 'avatarFiles', { value: {}, enumerable: false })

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    item.broken = true
    item.problem = `智能体清单无法解析：${error instanceof Error ? error.message : String(error)}`
    return item
  }

  const parsed = parseAgentManifest(manifest, id)
  item.name = parsed.name
  item.description = parsed.description
  item.profession = parsed.profession
  item.expertType = parsed.expertType
  item.tags = parsed.tags
  item.quickPrompts = parsed.quickPrompts
  item.agentDocs = parsed.agentDocs

  // lead 提示词：既是「注册进技能表」的正文，也是 read / reveal 的目标
  const leadDoc = resolveInside(dir, parsed.leadDoc)
  if (leadDoc !== undefined && (await safeSize(leadDoc)) !== undefined) {
    item.path = leadDoc
    item.size = (await safeSize(leadDoc)) ?? item.size
  }

  // 头像：lead + 每个成员，逐个校验（目录内 + 白名单扩展名 + 真文件）
  const avatarFiles = item.avatarFiles
  const leadAvatar = await resolveAvatarFile(dir, parsed.avatarRel)
  if (leadAvatar !== undefined) avatarFiles.lead = leadAvatar
  const members = []
  for (const member of parsed.members) {
    const file = await resolveAvatarFile(dir, member.avatarRel)
    if (file !== undefined) avatarFiles[member.id] = file
    members.push({
      id: member.id,
      name: member.name,
      profession: member.profession,
      role: member.role,
      hasAvatar: file !== undefined,
    })
  }
  item.members = members
  item.hasAvatar = avatarFiles.lead !== undefined
  return item
}

/** 扫描一个技能根。 */
async function scanGroup(group, agentStates) {
  let entries
  try {
    entries = await readdir(group.root, { withFileTypes: true })
  } catch (error) {
    return {
      id: group.id,
      label: group.label,
      root: group.root,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
      skills: [],
    }
  }
  const skills = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // 目录 或 链接（junction 在 readdir 里报 isSymbolicLink 而不是 isDirectory）：
    // 都按目录型技能处理，能否改写由 describeSkill 的 linked 决定。
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const dir = join(group.root, entry.name)
      // 先按技能看（SKILL.md 优先，保证既有技能的分类与行为一个字节都不变）；
      // 没有 SKILL.md 才看它是不是专家团 / 智能体形态。
      const file = join(dir, 'SKILL.md')
      if ((await safeSize(file)) !== undefined) {
        skills.push(await describeSkill(group.id, group.root, entry.name, file, 'dir'))
        continue
      }
      const manifestPath = await findAgentManifest(dir)
      if (manifestPath !== undefined) {
        const agent = await describeAgent(group.id, group.root, entry.name, dir, manifestPath)
        // 启用态来自 store（缺字段 = 启用），不来自任何文件
        agent.enabled = agentEnabled(agentStates, group.id, agent.id)
        agent.disabled = !agent.enabled
        skills.push(agent)
        continue
      }
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!lower.endsWith('.md') || SKIP_FILES.has(lower)) continue
    skills.push(
      await describeSkill(group.id, group.root, entry.name.slice(0, -3), join(group.root, entry.name), 'file'),
    )
  }
  skills.sort((left, right) => left.id.localeCompare(right.id, 'en'))
  return { id: group.id, label: group.label, root: group.root, exists: true, skills }
}

// ─────────────────────────── 写操作 ───────────────────────────

/** 原子写文本（同目录临时文件 + rename 替换）。 */
async function writeAtomic(file, text) {
  const tmp = `${file}.${Date.now().toString(36)}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * 改写技能的 disable-model-invocation：
 *   停用 → 写入 `disable-model-invocation: true`
 *   启用 → 删掉该行（把文件还原成作者原本的样子）
 * 保留 BOM、原行尾风格与正文逐字节不变；没有 frontmatter 时补一个最小块。
 * @returns {Promise<{changed: boolean, disabled: boolean}>}
 */
async function setSkillEnabled(file, enabled) {
  const raw = await readFile(file)
  let text = raw.toString('utf8')
  let bom = ''
  if (text.charCodeAt(0) === 0xfeff) {
    bom = '\uFEFF'
    text = text.slice(1)
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const split = splitFrontmatter(text)
  const linePattern = new RegExp(`^${FIELD_DISABLED}\\s*:`)

  if (split === undefined) {
    if (enabled) return { changed: false, disabled: false }
    // 无 frontmatter：补一个最小块（name 用文件名兜底由调用方保证不必要，这里只写开关）
    const block = `${FIELD_DISABLED}: true`
    const next = `---${eol}${block}${eol}---${eol}${eol}${text}`
    await writeAtomic(file, bom + next)
    return { changed: true, disabled: true }
  }

  const lines = split.block.split(/\r?\n/)
  const found = lines.some((line) => linePattern.test(line))

  if (enabled) {
    if (!found) return { changed: false, disabled: false }
    const kept = lines.filter((line) => !linePattern.test(line))
    // 块里只剩这一行（例如给无 frontmatter 的文件补出来的块）：整块删掉，
    // 否则会留下一个空的 `---\n---`，文件就不再是作者原本的样子了。
    if (kept.every((line) => line.trim() === '')) {
      const rest = split.rest.replace(/^(?:\r?\n)+/, '')
      await writeAtomic(file, bom + rest)
      return { changed: true, disabled: false }
    }
    await writeAtomic(file, bom + `---${eol}${kept.join(eol)}${eol}---${split.rest}`)
    return { changed: true, disabled: false }
  }

  const written = found
    ? lines.map((line) => (linePattern.test(line) ? `${FIELD_DISABLED}: true` : line))
    : [...lines, `${FIELD_DISABLED}: true`]
  await writeAtomic(file, bom + `---${eol}${written.join(eol)}${eol}---${split.rest}`)
  return { changed: true, disabled: true }
}

/**
 * 构造在系统文件管理器中定位该路径的命令（纯函数，平台可注入，便于单测）。
 * win32 用 `explorer.exe /select,<path>`；其余平台打开所在目录。
 */
function revealSpec(path, platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    default:
      return { command: 'xdg-open', args: [dirname(path)] }
  }
}

/** 拉起文件管理器并立即返回（detached、无 stdio、不等待）。 */
function launchReveal(path) {
  const spec = revealSpec(path)
  if (dryRunSpawn()) return { ...spec, dryRun: true }
  const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' })
  // 路由已经返回，缺少处理程序之类的错误由操作系统弹窗体现
  child.on('error', () => {})
  child.unref()
  return { ...spec, dryRun: false }
}

// ─────────────────── 运行时技能桥（让 DSH 会话真的识别到） ───────────────────

/** 技能名必须是 kebab-case（skill 注册表的约束，与官方 provider 一致）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 取技能正文（剥掉 frontmatter 块与 BOM）。 */
function bodyOfSkill(text) {
  const split = splitFrontmatter(text)
  const raw = split === undefined ? text : split.rest
  return raw.replace(/^[\s\uFEFF]+/, '')
}

/** 注册表要求 description；没写时用正文首行非标题内容兜底。 */
function fallbackDescription(body, id) {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '' || text.startsWith('#') || text.startsWith('---')) continue
    return collapse(text, 160)
  }
  return `技能 ${id}（SKILL.md 未写 description）`
}

/**
 * 运行时技能桥：把「启用中」的技能注册进 `ctx.skills`，让 DSH 会话（skill 工具）
 * 真的能识别到；停用 / 改名 / 文件消失的技能会被 dispose 掉。
 *
 * 为什么走运行时注册而不是文件系统 provider：本机 `dsh-skill-filesystem` 不活跃
 * （文件型技能进不了目录），而运行时注册是 DSH 里既有的另一条通路——本 profile 的
 * 6 个纪律技能就是这样被识别的（见 cleverer-dsh/plugins/dsh-skill-provider.mjs）。
 * 这条路的好处：① 不依赖 provider；② 覆盖任意来源目录（含 `.workbuddy\skills`）；
 * ③ 开关直接等于「会话能否看到」，语义闭环。
 */
function makeSkillBridge(ctx) {
  /** name -> { disposer, key, path, source } */
  const active = new Map()
  /** name -> 失败原因（名字非法 / 重名 / 读取失败 / 注册报错） */
  const failures = new Map()
  let lastSync
  let ready = Promise.resolve()

  /**
   * 注册一个技能。`source` 取值有兼容性风险：先试 `runtime`（语义正确），
   * 被拒就退回官方范例里跑通的 `bundled`。
   */
  const register = (registration) => {
    try {
      return { disposer: ctx.skills.register({ ...registration, source: 'runtime' }), source: 'runtime' }
    } catch {
      return { disposer: ctx.skills.register({ ...registration, source: 'bundled' }), source: 'bundled' }
    }
  }

  const dispose = (name) => {
    const entry = active.get(name)
    if (entry === undefined) return
    active.delete(name)
    try {
      entry.disposer()
    } catch {}
  }

  return {
    /** 初始同步的完成信号：list 会等它，避免刚挂载时误报「未接入」。 */
    get ready() {
      return ready
    },
    track(promise) {
      ready = Promise.resolve(promise).catch(() => undefined)
      return ready
    },
    /** 按当前来源目录重新对齐注册表（新增 / 变更 / 失效一次处理）。 */
    async sync(groups, agentStates) {
      const wanted = new Map()
      failures.clear()
      for (const group of groups) {
        let scanned
        try {
          scanned = await scanGroup(group, agentStates)
        } catch {
          continue
        }
        for (const skill of scanned.skills) {
          // 会话可见性只由「启用」决定：停用的技能 / 智能体不注册
          if (skill.enabled === false) continue
          // 清单坏掉的智能体：记一条原因，不注册（保住 registered + failed === 启用数）
          if (skill.broken === true) {
            failures.set(skill.name, skill.problem ?? '智能体清单无法解析')
            continue
          }
          const name = SKILL_NAME_RE.test(skill.name)
            ? skill.name
            : SKILL_NAME_RE.test(skill.id)
              ? skill.id
              : undefined
          if (name === undefined) {
            failures.set(skill.name, `技能名「${skill.name}」不是 kebab-case，注册表不接受`)
            continue
          }
          if (wanted.has(name)) {
            failures.set(name, `技能名重复：${wanted.get(name).path} 与 ${skill.path}`)
            continue
          }
          wanted.set(name, skill)
        }
      }

      // 失效的：停用、改名、文件消失、名字不再合法
      for (const name of [...active.keys()]) {
        if (!wanted.has(name)) dispose(name)
      }

      let registered = 0
      for (const [name, skill] of wanted) {
        const key = `${skill.path}|${skill.size}`
        const existing = active.get(name)
        if (existing !== undefined && existing.key === key) {
          registered += 1
          continue
        }
        if (existing !== undefined) dispose(name)
        let body
        try {
          body = bodyOfSkill(await readFile(skill.path, 'utf8'))
        } catch (error) {
          failures.set(name, `读取失败：${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const registration = {
          name,
          description: skill.description !== '' ? skill.description : fallbackDescription(body, skill.id),
          content: body,
          path: skill.path,
        }
        if (skill.whenToUse !== '') registration.whenToUse = skill.whenToUse
        try {
          const result = register(registration)
          active.set(name, { disposer: result.disposer, key, path: skill.path, source: result.source })
          registered += 1
        } catch (error) {
          failures.set(name, `注册失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      lastSync = { registered, failed: failures.size, at: new Date().toISOString() }
      return lastSync
    },
    /** 该技能此刻是否真的在会话可见的技能表里。 */
    isRegistered(skill) {
      const name = active.has(skill.name) ? skill.name : active.has(skill.id) ? skill.id : undefined
      if (name === undefined) return false
      return active.get(name).path === skill.path
    },
    /** 该技能没进会话的原因（若有）。 */
    errorOf(skill) {
      return failures.get(skill.name) ?? failures.get(skill.id)
    },
    /** 给界面用的汇总。 */
    summary() {
      return {
        registered: active.size,
        failed: failures.size,
        names: [...active.keys()].sort(),
        sources: [...new Set([...active.values()].map((entry) => entry.source))],
        errors: [...failures.entries()].map(([name, reason]) => ({ name, reason })),
        lastSync,
      }
    },
    disposeAll() {
      for (const name of [...active.keys()]) dispose(name)
    },
  }
}

// ─────────────────────────── HTTP 帮手 ───────────────────────────

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** 围栏 + 方法检查，返回 true 表示可以继续。 */
function guard(request, response, method) {
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (request.method !== method) {
    writeJson(response, 405, { error: `method not allowed: ${request.method}` })
    return false
  }
  return true
}

/** 读取并解析 JSON 请求体（带上限）。 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text)
}

/**
 * 路径上是否出现符号链接 / junction（含技能目录本身是链接的情况）。
 *
 * 只 lstat 最终文件是不够的：`.workbuddy\skills\linked\SKILL.md` 里的文件本身是
 * 普通文件，但它的父目录可能是 junction——那时原地改写会越出技能根落到别处。
 * 因此从技能根逐段往下检查。
 * @returns {Promise<boolean>} true = 含链接（写操作应拒绝）
 */
async function hasLinkOnPath(root, file) {
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true
  let current = root
  for (const part of rel.split(/[\\/]/).filter((item) => item !== '')) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * 用一个具体技能做身份校验：只认「最新一次扫描」解析出的路径。
 * @returns {Promise<{group: object, skill: object}|undefined>} 未命中时已写响应并返回 undefined
 */
async function resolveSkill(groups, groupId, skillId, response, agentStates) {
  const group = groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) {
    writeJson(response, 400, { error: `unknown group: ${groupId}` })
    return undefined
  }
  if (skillId === '') {
    writeJson(response, 400, { error: 'missing id' })
    return undefined
  }
  const scanned = await scanGroup(group, agentStates)
  const skill = scanned.skills.find((candidate) => candidate.id === skillId)
  if (skill === undefined) {
    writeJson(response, 404, { error: `skill not found: ${skillId}` })
    return undefined
  }
  return { group, skill }
}

// ─────────────────────────── 路由 ───────────────────────────

/** 组装全部路由（exact 路径）。 */
function makeRoutes(ctx, config, bridge) {
  const warn = (error) => {
    try {
      ctx.logger?.warn?.(error)
    } catch {}
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        try {
          const resolved = await resolveGroups(config)
          await bridge.ready
          const scanned = []
          for (const group of resolved.groups) {
            const page = await scanGroup(group, resolved.agents)
            for (const skill of page.skills) {
              skill.registered = bridge.isRegistered(skill)
              // 只有「启用了却没进会话」才需要给原因；停用是预期状态，不算失败
              if (!skill.registered && skill.enabled !== false) {
                skill.registerError = bridge.errorOf(skill) ?? '未注册（原因未知）'
              }
            }
            scanned.push(page)
          }
          writeJson(response, 200, {
            groups: scanned,
            source: resolved.source,
            problems: resolved.problems,
            storePath: storePath(),
            registry: bridge.summary(),
            scannedAt: new Date().toISOString(),
          })
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.read,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        try {
          const url = new URL(request.url ?? '/', 'http://dsh.internal')
          const resolved = await resolveGroups(config)
          const hit = await resolveSkill(
            resolved.groups,
            url.searchParams.get('group') ?? '',
            url.searchParams.get('id') ?? '',
            response,
            resolved.agents,
          )
          if (hit === undefined) return
          const { skill } = hit
          const raw = await readFile(skill.path)
          const truncated = raw.byteLength > MAX_CONTENT_BYTES
          writeJson(response, 200, {
            group: skill.group,
            id: skill.id,
            name: skill.name,
            path: skill.path,
            folder: skill.folder,
            kind: skill.kind,
            enabled: skill.enabled,
            linked: skill.linked,
            bytes: raw.byteLength,
            truncated,
            content: (truncated ? raw.subarray(0, MAX_CONTENT_BYTES) : raw).toString('utf8'),
          })
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.setEnabled,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const resolved = await resolveGroups(config)
          const hit = await resolveSkill(
            resolved.groups,
            String(body?.group ?? ''),
            String(body?.id ?? ''),
            response,
            resolved.agents,
          )
          if (hit === undefined) return
          const { group, skill } = hit
          const enabled = body?.enabled === true
          // 专家团 / 智能体：开关是纯内存态（写 store），**绝不写它们目录里的任何文件**
          if (skill.kind === 'agent') {
            const applied = await setAgentEnabled(config, group.id, skill.id, enabled)
            await bridge.sync(resolved.groups, applied.agents)
            const next = (await scanGroup(group, applied.agents)).skills.find((item) => item.id === skill.id)
            writeJson(response, 200, {
              group: skill.group,
              id: skill.id,
              kind: 'agent',
              path: skill.path,
              enabled,
              disabled: !enabled,
              changed: applied.changed,
              registered: next === undefined ? false : bridge.isRegistered(next),
              registry: bridge.summary(),
            })
            return
          }
          if (await hasLinkOnPath(group.root, skill.path)) {
            writeJson(response, 400, { error: 'linked skill cannot be modified' })
            return
          }
          const result = await setSkillEnabled(skill.path, enabled)
          // 立刻对齐注册表：启用 → 马上进会话技能表；停用 → 马上移出
          await bridge.sync(resolved.groups, resolved.agents)
          writeJson(response, 200, {
            group: skill.group,
            id: skill.id,
            path: skill.path,
            enabled,
            disabled: !enabled,
            changed: result.changed,
            registered: bridge.isRegistered(skill),
            registry: bridge.summary(),
          })
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.reveal,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          const resolved = await resolveGroups(config)
          const hit = await resolveSkill(
            resolved.groups,
            String(body?.group ?? ''),
            String(body?.id ?? ''),
            response,
            resolved.agents,
          )
          if (hit === undefined) return
          const { skill } = hit
          const spec = launchReveal(skill.path)
          writeJson(response, 200, {
            group: skill.group,
            id: skill.id,
            path: skill.path,
            folder: skill.folder,
            command: spec.command,
            args: spec.args,
            dryRun: spec.dryRun === true,
          })
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.avatar,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        try {
          const url = new URL(request.url ?? '/', 'http://dsh.internal')
          const groupId = url.searchParams.get('group') ?? ''
          const agentId = url.searchParams.get('id') ?? ''
          const which = url.searchParams.get('which') ?? 'lead'
          const resolved = await resolveGroups(config)
          const group = resolved.groups.find((candidate) => candidate.id === groupId)
          if (group === undefined) {
            writeJson(response, 400, { error: `unknown group: ${groupId}` })
            return
          }
          // 路径只从「本次扫描结果」里取：客户端传的 which 只是查表键，绝不参与拼路径
          const scanned = await scanGroup(group, resolved.agents)
          const agent = scanned.skills.find((item) => item.id === agentId && item.kind === 'agent')
          if (agent === undefined) {
            writeJson(response, 404, { error: `agent not found: ${agentId}` })
            return
          }
          const file = agent.avatarFiles?.[which]
          if (file === undefined) {
            writeJson(response, 404, { error: `avatar not found: ${which}` })
            return
          }
          // 双保险：即使扫描结果被污染，也必须落在该 agent 目录内
          const inside = relative(agent.folder, file)
          if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
            writeJson(response, 404, { error: 'avatar outside agent folder' })
            return
          }
          const type = AVATAR_TYPES[extname(file).toLowerCase()]
          if (type === undefined) {
            writeJson(response, 404, { error: `unsupported avatar type: ${extname(file)}` })
            return
          }
          const bytes = await readFile(file)
          response.statusCode = 200
          response.writeHead(200, {
            'content-type': type,
            'content-length': String(bytes.byteLength),
            'cache-control': 'private, max-age=300',
          })
          response.end(bytes)
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.groups,
      handler: async (request, response) => {
        if (request.method === 'GET') {
          if (!guard(request, response, 'GET')) return
          try {
            const resolved = await resolveGroups(config)
            writeJson(response, 200, {
              groups: resolved.groups,
              source: resolved.source,
              problems: resolved.problems,
              storePath: storePath(),
              defaults: DEFAULT_GROUPS(),
            })
          } catch (error) {
            warn(error)
            writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request)
          if (body?.reset === true) {
            const cleared = await clearStoredGroups()
            const resolved = await resolveGroups(config)
            await bridge.sync(resolved.groups, resolved.agents)
            writeJson(response, 200, {
              groups: resolved.groups,
              source: resolved.source,
              reset: cleared,
              registry: bridge.summary(),
            })
            return
          }
          const checked = parseGroups(body?.groups)
          if (checked.problems.length > 0) {
            writeJson(response, 400, { error: checked.problems.join('；'), problems: checked.problems })
            return
          }
          if (checked.groups.length === 0) {
            writeJson(response, 400, { error: '至少要有一个来源目录' })
            return
          }
          // 改来源目录不动已有的智能体开关（用旧映射写出），避免顺手把开关清空
          const previous = await resolveGroups(config)
          await saveStoredGroups(checked.groups, previous.agents)
          await bridge.sync(checked.groups, previous.agents)
          const scanned = []
          for (const group of checked.groups) scanned.push(await scanGroup(group, previous.agents))
          writeJson(response, 200, {
            groups: checked.groups,
            source: 'file',
            storePath: storePath(),
            registry: bridge.summary(),
            scanned,
          })
        } catch (error) {
          warn(error)
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/**
 * 挂载技能中心路由 + 运行时技能桥。
 * @param {object} ctx - 宿主插件上下文（webServer / skills）。
 * @param {object} config - 已解析的插件配置。
 */
function applyImpl(ctx, config) {
  if (config?.enabled === false) return
  const bridge = makeSkillBridge(ctx)
  const routes = makeRoutes(ctx, config ?? {}, bridge)
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    // 挂载时先同步一次：当前「启用中」的技能立刻进入 DSH 会话的技能表
    bridge.track(
      resolveGroups(config ?? {}).then((resolved) => bridge.sync(resolved.groups, resolved.agents)),
    )
    return () => {
      for (const dispose of disposers) dispose()
      bridge.disposeAll()
    }
  }, 'skill-center: routes + skill bridge')
}

export {
  AVATAR_TYPES,
  ROUTES,
  SKILL_NAME_RE,
  agentEnabled,
  makeSkillBridge,
  parseAgentManifest,
  parseAgentStates,
  parseGroups,
  setSkillEnabled,
  revealSpec,
  applyImpl as apply,
  inject,
  name,
}
