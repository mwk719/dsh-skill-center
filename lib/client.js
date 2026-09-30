window.__ModuleLoader__.load({
	id: "dsh-skill-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-skill-center — 技能中心（浏览器半区）
		 *
		 * 侧栏「技能中心」入口（sidebar.panellist）+ 中栏页面（main，同 id keyed）。
		 * 两个座位都由 shell 插件声明，因此各自包在 ctx.slots.inject 里。
		 *
		 * 版面：
		 *   顶部  — 标题 + 总数 + 搜索 + 来源目录 + 刷新
		 *   分页  — 「dsh技能」「workbuddy技能」页签（各自数量 + 技能根路径 + 来源标记）
		 *   卡片  — 首字母头像 + 技能名 + 描述 + 启用开关 + 「⋯」菜单
		 *   弹框  — 技能详情（正文 / 打开文件夹）；来源目录编辑
		 *
		 * 数据来自宿主半区的路由；本文件不 import 任何 DSH 包，只用模块加载器
		 * 提供的 react / react/jsx-runtime，且无 JSX、无构建步骤。
		 */
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useCallback, useEffect, useState } = react;

		/** 侧栏行与中栏页共用的稳定 id。 */
		const PANEL_ID = "skill-center";
		/** 侧栏图标顺序。 */
		const PANEL_ORDER = 42;
		/** 侧栏与页面标题。 */
		const LABEL = "技能中心";
		/**
		 * 路由路径与宿主半区一致。**文档相对**（无前导斜杠）：GUI 用
		 * <base href="./"> 提供服务，根绝对路径会逃出子路径部署前缀。
		 */
		const API = {
			list: "api/skill-center/list",
			read: "api/skill-center/read",
			setEnabled: "api/skill-center/set-enabled",
			reveal: "api/skill-center/reveal",
			groups: "api/skill-center/groups",
			avatar: "api/skill-center/avatar",
		};

		/** 主题令牌（沿用 --dsw-alias-* 语义色，缺令牌时退回中性色）。 */
		const COLOR = {
			text: "var(--dsw-alias-label-primary, #1f2328)",
			muted: "var(--dsw-alias-label-secondary, #656d76)",
			border: "var(--dsw-alias-border-l1, rgba(128,128,128,0.28))",
			borderStrong: "var(--dsw-alias-border-l2, rgba(128,128,128,0.45))",
			layer1: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.04))",
			layer2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.09))",
			overlay: "var(--dsw-alias-bg-overlay, #ffffff)",
			brand: "var(--dsw-alias-brand-primary, #4a6cf7)",
			error: "var(--dsw-alias-state-error-primary, #d1242f)",
			warn: "var(--dsw-alias-state-warn-primary, #b45309)",
			success: "var(--dsw-alias-state-success-primary, #16a34a)",
		};

		const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

		/** 本插件自用的样式（统一 dsc- 前缀，避免污染全局）。 */
		const CSS = `
.dsc-card { transition: border-color .12s ease, background .12s ease, transform .12s ease; }
.dsc-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.45)) !important; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09)) !important; }
.dsc-card:active { transform: scale(.995); }
.dsc-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4a6cf7); outline-offset: 1px; }
.dsc-tab:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.dsc-iconbtn:hover, .dsc-close:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
.dsc-menuitem:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
.dsc-input:focus { border-color: var(--dsw-alias-brand-primary, #4a6cf7) !important; }
.dsc-dialog { animation: dsc-in .14s ease-out; }
.dsc-backdrop { animation: dsc-fade .14s ease-out; }
.dsc-menu { animation: dsc-pop .1s ease-out; }
@keyframes dsc-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dsc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsc-pop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
`;

		/** 同源请求 JSON；非 2xx 抛带宿主消息的错误。 */
		async function requestJson(path, options = {}) {
			const hasBody = options.body !== undefined;
			const response = await fetch(path, {
				method: options.method ?? "GET",
				headers: hasBody
					? { accept: "application/json", "content-type": "application/json" }
					: { accept: "application/json" },
				body: hasBody ? JSON.stringify(options.body) : undefined,
			});
			let body;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			if (!response.ok) {
				const message =
					body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return body;
		}

		/** 人类可读的字节数。 */
		function formatBytes(bytes) {
			if (typeof bytes !== "number" || bytes <= 0) return "0 B";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		}

		/** 技能名首字母（头像用）。 */
		function initialOf(name) {
			const text = String(name ?? "").replace(/^[^A-Za-z0-9\u4e00-\u9fa5]+/, "");
			return (text.slice(0, 1) || "?").toUpperCase();
		}

		/** 稳定的色相（同名同色），头像底色/字色都由它派生。 */
		function hueOf(text) {
			let hash = 0;
			const value = String(text ?? "");
			for (let index = 0; index < value.length; index += 1) {
				hash = (hash * 31 + value.charCodeAt(index)) % 360;
			}
			return hash;
		}

		function avatarStyle(name, small) {
			const hue = hueOf(name);
			const edge = small ? 22 : 26;
			return {
				width: `${edge}px`,
				height: `${edge}px`,
				flex: "0 0 auto",
				borderRadius: "50%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: small ? "11px" : "12px",
				fontWeight: 600,
				background: `hsl(${hue} 62% 88%)`,
				color: `hsl(${hue} 45% 32%)`,
			};
		}

		/** 分组来源的中文说明。 */
		function sourceLabel(source) {
			if (source === "file") return "已自定义";
			if (source === "config") return "插件配置";
			return "内置默认";
		}

		/**
		 * 专家团头像 URL（**文档相对**路径，与其它路由一致）。
		 * which = "lead" 或成员 id —— 服务端只把它当查表键，路径由服务端自己解析。
		 */
		function agentAvatarUrl(groupId, agentId, which) {
			return `${API.avatar}?group=${encodeURIComponent(groupId)}&id=${encodeURIComponent(agentId)}&which=${encodeURIComponent(which || "lead")}`;
		}

		/** 专家团徽标文案：N 人团队。 */
		function teamBadgeText(skill) {
			const count = Array.isArray(skill.members) ? skill.members.length : 0;
			return count > 0 ? `${count} 人团队` : "智能体";
		}

		/** 智能体头像（纯展示）：有图就用 <img>，没图**或加载失败**都回退成首字母色块。 */
		function AgentAvatar({ groupId, agentId, which, name, hasAvatar, size }) {
			const edge = size ?? 26;
			const box = {
				position: "relative",
				display: "inline-flex",
				width: `${edge}px`,
				height: `${edge}px`,
				flex: "0 0 auto",
			};
			// 首字母色块始终垫在底层：图片出错时把 <img> 藏掉就自然露出回退块，
			// 这样不需要 state/hook（本文件规定 hook 只能待在 SkillCenterPage 里）。
			const fallback = jsx("span", {
				key: "fallback",
				style: Object.assign({}, avatarStyle(name || agentId, edge <= 22), {
					position: "absolute",
					left: 0,
					top: 0,
					width: "100%",
					height: "100%",
				}),
				children: initialOf(name || agentId),
			});
			const image = hasAvatar === true
				? jsx("img", {
					key: "image",
					src: agentAvatarUrl(groupId, agentId, which),
					alt: "",
					loading: "lazy",
					decoding: "async",
					"data-dsc-avatar": `${agentId}:${which || "lead"}`,
					onError: (event) => {
						const img = event?.currentTarget;
						if (img) img.style.display = "none";
					},
					style: Object.assign({}, styles.agentAvatar, {
						position: "relative",
						zIndex: 1,
						width: `${edge}px`,
						height: `${edge}px`,
					}),
				})
				: null;
			return jsx("span", { style: box, children: image === null ? fallback : [fallback, image] });
		}

		const styles = {
			view: {
				display: "flex",
				flexDirection: "column",
				flex: "1 1 auto",
				height: "100%",
				boxSizing: "border-box",
				minHeight: 0,
				background: "var(--dsw-alias-bg-base, transparent)",
				color: COLOR.text,
			},
			header: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 18px 10px", flex: "0 0 auto" },
			title: { margin: 0, fontSize: "15px", fontWeight: 600 },
			count: { fontSize: "12px", color: COLOR.muted },
			search: {
				marginLeft: "auto",
				width: "220px",
				padding: "5px 9px",
				fontSize: "12px",
				color: "inherit",
				background: COLOR.layer2,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "6px",
				outline: "none",
			},
			button: {
				padding: "5px 11px",
				fontSize: "12px",
				color: "inherit",
				background: COLOR.layer2,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "6px",
				cursor: "pointer",
				flex: "0 0 auto",
			},
			primaryButton: {
				padding: "5px 13px",
				fontSize: "12px",
				color: "#fff",
				background: COLOR.brand,
				border: "1px solid transparent",
				borderRadius: "6px",
				cursor: "pointer",
				flex: "0 0 auto",
			},
			tabs: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				padding: "0 18px 12px",
				borderBottom: `1px solid ${COLOR.border}`,
				flex: "0 0 auto",
			},
			tab: (active) => ({
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "5px 12px",
				fontSize: "12px",
				color: active ? COLOR.text : COLOR.muted,
				background: active ? COLOR.layer2 : "transparent",
				border: `1px solid ${active ? COLOR.borderStrong : "transparent"}`,
				borderRadius: "999px",
				cursor: "pointer",
				font: "inherit",
			}),
			tabBadge: {
				fontSize: "11px",
				color: COLOR.muted,
				background: COLOR.layer2,
				borderRadius: "8px",
				padding: "0 6px",
			},
			meta: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
			rootPath: {
				fontSize: "10.5px",
				fontFamily: MONO,
				color: COLOR.muted,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
				maxWidth: "38vw",
			},
			badge: {
				fontSize: "10.5px",
				color: COLOR.muted,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "999px",
				padding: "1px 7px",
				whiteSpace: "nowrap",
			},
			warnBadge: {
				fontSize: "10.5px",
				color: COLOR.warn,
				border: `1px solid ${COLOR.warn}`,
				borderRadius: "999px",
				padding: "1px 7px",
				whiteSpace: "nowrap",
			},
			grid: {
				flex: "1 1 auto",
				minHeight: 0,
				overflowY: "auto",
				padding: "14px 18px 28px",
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))",
				gap: "10px",
				alignContent: "start",
			},
			card: {
				display: "flex",
				alignItems: "flex-start",
				gap: "10px",
				padding: "11px 12px",
				textAlign: "left",
				color: "inherit",
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "10px",
				cursor: "pointer",
				font: "inherit",
				minWidth: 0,
			},
			cardBody: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, flex: "1 1 auto" },
			cardTop: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
			cardName: {
				fontSize: "12.5px",
				fontFamily: MONO,
				fontWeight: 600,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			offTag: {
				fontSize: "10px",
				color: COLOR.muted,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "6px",
				padding: "0 4px",
				flex: "0 0 auto",
			},
			warnTag: {
				fontSize: "10px",
				color: COLOR.warn,
				border: `1px solid ${COLOR.warn}`,
				borderRadius: "6px",
				padding: "0 4px",
				flex: "0 0 auto",
			},
			cardDesc: {
				fontSize: "11.5px",
				lineHeight: 1.5,
				color: COLOR.muted,
				display: "-webkit-box",
				WebkitLineClamp: 3,
				WebkitBoxOrient: "vertical",
				overflow: "hidden",
			},
			cardActions: { display: "flex", alignItems: "center", gap: "4px", flex: "0 0 auto" },
			iconButton: {
				width: "24px",
				height: "24px",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: "13px",
				lineHeight: 1,
				color: COLOR.muted,
				background: "transparent",
				border: `1px solid transparent`,
				borderRadius: "6px",
				cursor: "pointer",
				flex: "0 0 auto",
			},
			hint: { padding: "6px 2px", fontSize: "12.5px", color: COLOR.muted, gridColumn: "1 / -1" },
			// ── 弹框 ──
			backdrop: {
				position: "fixed",
				inset: 0,
				zIndex: 1000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px",
				background: "rgba(0,0,0,0.42)",
			},
			dialog: {
				display: "flex",
				flexDirection: "column",
				width: "min(920px, 100%)",
				maxHeight: "min(84vh, 780px)",
				background: COLOR.overlay,
				border: `1px solid ${COLOR.borderStrong}`,
				borderRadius: "12px",
				boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
				overflow: "hidden",
			},
			dialogHead: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				padding: "12px 14px",
				borderBottom: `1px solid ${COLOR.border}`,
				flex: "0 0 auto",
			},
			dialogTitleBox: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1 1 auto" },
			dialogName: { fontSize: "13.5px", fontFamily: MONO, fontWeight: 600 },
			dialogMeta: { fontSize: "11px", fontFamily: MONO, color: COLOR.muted, wordBreak: "break-all" },
			close: {
				width: "26px",
				height: "26px",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: "15px",
				lineHeight: 1,
				color: COLOR.muted,
				background: "transparent",
				border: `1px solid ${COLOR.border}`,
				borderRadius: "7px",
				cursor: "pointer",
				flex: "0 0 auto",
			},
			dialogBody: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "14px" },
			pre: {
				margin: 0,
				padding: "12px",
				fontSize: "12px",
				lineHeight: 1.55,
				fontFamily: MONO,
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "8px",
			},
			error: { fontSize: "12.5px", color: COLOR.error },
			loading: { fontSize: "12.5px", color: COLOR.muted, padding: "10px 2px" },
			// ── 下拉菜单 ──
			menuBackdrop: { position: "fixed", inset: 0, zIndex: 1100, background: "transparent" },
			menu: {
				position: "fixed",
				zIndex: 1101,
				minWidth: "168px",
				padding: "4px",
				background: COLOR.overlay,
				border: `1px solid ${COLOR.borderStrong}`,
				borderRadius: "10px",
				boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
			},
			menuItem: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				width: "100%",
				padding: "7px 9px",
				fontSize: "12.5px",
				color: "inherit",
				background: "transparent",
				border: "none",
				borderRadius: "6px",
				cursor: "pointer",
				textAlign: "left",
				font: "inherit",
			},
			menuPath: {
				padding: "6px 9px 8px",
				fontSize: "10.5px",
				fontFamily: MONO,
				color: COLOR.muted,
				wordBreak: "break-all",
				borderBottom: `1px solid ${COLOR.border}`,
				marginBottom: "4px",
			},
			// ── 来源目录编辑器 ──
			row: {
				display: "grid",
				gridTemplateColumns: "112px 132px 1fr auto",
				gap: "8px",
				alignItems: "center",
				marginBottom: "8px",
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				fontSize: "12px",
				color: "inherit",
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "6px",
				outline: "none",
			},
			monoInput: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				fontSize: "11.5px",
				fontFamily: MONO,
				color: "inherit",
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
				borderRadius: "6px",
				outline: "none",
			},
			editorFoot: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "10px 14px",
				borderTop: `1px solid ${COLOR.border}`,
				flex: "0 0 auto",
			},
			note: { fontSize: "11.5px", color: COLOR.error, marginRight: "auto", wordBreak: "break-word" },
			okNote: { fontSize: "11.5px", color: COLOR.muted, marginRight: "auto" },
			// ── 专家团 / 智能体（agent）──
			agentAvatar: {
				flex: "0 0 auto",
				borderRadius: "50%",
				objectFit: "cover",
				background: COLOR.layer2,
				border: `1px solid ${COLOR.border}`,
			},
			teamTag: {
				fontSize: "11px",
				padding: "1px 6px",
				borderRadius: "999px",
				whiteSpace: "nowrap",
				color: COLOR.brand,
				background: COLOR.layer2,
				border: `1px solid ${COLOR.border}`,
			},
			chips: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "2px" },
			chip: {
				fontSize: "11px",
				padding: "1px 6px",
				borderRadius: "999px",
				color: COLOR.muted,
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
			},
			agentBody: { display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 },
			agentSections: { display: "flex", flexDirection: "column", gap: "10px" },
			agentProfession: { fontSize: "12px", color: COLOR.muted },
			section: { display: "flex", flexDirection: "column", gap: "6px" },
			sectionTitle: { fontSize: "12px", fontWeight: 600, color: COLOR.text },
			promptItem: {
				fontSize: "12px",
				color: COLOR.muted,
				padding: "6px 8px",
				borderRadius: "6px",
				background: COLOR.layer1,
				border: `1px solid ${COLOR.border}`,
			},
			memberRow: { display: "flex", alignItems: "center", gap: "8px" },
			memberBox: { display: "flex", flexDirection: "column", minWidth: 0 },
			memberName: { fontSize: "12px", color: COLOR.text },
			memberMeta: { fontSize: "11px", color: COLOR.muted },
		};

		/** 侧栏列表图标（线条 list 字形）。 */
		function SkillCenterIcon({ size }) {
			const dimension = typeof size === "number" ? size : 16;
			return jsx("svg", {
				width: dimension,
				height: dimension,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("path", { key: "lines", d: "M6 4h7M6 8h7M6 12h7" }),
					jsx("path", { key: "dots", d: "M3 4h.01M3 8h.01M3 12h.01" }),
				],
			});
		}

		/** 启用/停用开关。 */
		function ToggleSwitch({ on, busy, disabled, label, attribute, onToggle }) {
			const locked = disabled === true;
			const props = {
				type: "button",
				role: "switch",
				"aria-checked": on === true,
				"aria-label": label,
				title: label,
				disabled: locked,
				onClick: (event) => {
					event?.stopPropagation?.();
					if (locked) return;
					onToggle();
				},
				style: {
					width: "34px",
					height: "19px",
					position: "relative",
					flex: "0 0 auto",
					padding: 0,
					borderRadius: "999px",
					border: `1px solid ${on ? "transparent" : COLOR.borderStrong}`,
					background: on ? COLOR.success : COLOR.layer2,
					cursor: locked ? "not-allowed" : busy ? "progress" : "pointer",
					opacity: locked ? 0.45 : busy ? 0.55 : 1,
					transition: "background .12s ease",
				},
				children: jsx("span", {
					style: {
						position: "absolute",
						top: "1px",
						left: on ? "16px" : "1px",
						width: "15px",
						height: "15px",
						borderRadius: "50%",
						background: "#fff",
						boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
						transition: "left .12s ease",
					},
				}),
			};
			if (attribute !== undefined) props[attribute[0]] = attribute[1];
			return jsx("button", props);
		}

		/** 一行菜单项。 */
		function MenuItem({ icon, text, action, onClick }) {
			return jsx("button", {
				type: "button",
				className: "dsc-menuitem",
				"data-dsc-action": action,
				onClick,
				style: styles.menuItem,
				children: [
					jsx("span", { key: "icon", style: { width: "14px", textAlign: "center", opacity: 0.75 }, children: icon }),
					jsx("span", { key: "text", children: text }),
				],
			});
		}

		/** 一张技能卡片（纯展示）。 */
		function SkillCard({ skill, group, busy, onOpen, onToggle, onMenu }) {
			const isAgent = skill.kind === "agent";
			const desc =
				(skill.description && skill.description.trim()) ||
				(skill.whenToUse && skill.whenToUse.trim()) ||
				(isAgent ? "（智能体清单未写描述）" : "（SKILL.md 未写 description）");
			const chips = isAgent && Array.isArray(skill.tags) ? skill.tags : [];
			return jsxs("div", {
				role: "button",
				tabIndex: 0,
				className: "dsc-card",
				title: skill.path,
				"data-dsc-card": skill.id,
				"data-dsc-kind": skill.kind,
				"data-dsc-enabled": skill.enabled !== false,
				"data-dsc-registered": skill.registered !== false,
				onClick: () => onOpen(group, skill),
				onKeyDown: (event) => {
					if (event?.key === "Enter" || event?.key === " ") {
						event?.preventDefault?.();
						onOpen(group, skill);
					}
				},
				style: Object.assign({}, styles.card, skill.enabled === false ? { opacity: 0.78 } : null),
				children: [
					isAgent
						? jsx(AgentAvatar, {
								key: "avatar",
								groupId: group.id,
								agentId: skill.id,
								which: "lead",
								name: skill.name,
								hasAvatar: skill.hasAvatar,
								size: 26,
							})
						: jsx("span", { key: "avatar", style: avatarStyle(skill.name || skill.id), children: initialOf(skill.name || skill.id) }),
					jsxs("span", {
						key: "body",
						style: styles.cardBody,
						children: [
							jsxs("span", {
								key: "top",
								style: styles.cardTop,
								children: [
									jsx("span", { style: styles.cardName, children: skill.name }),
									skill.enabled === false
										? jsx("span", { style: styles.offTag, children: "已停用" })
										: skill.registered === false
											? jsx("span", {
													style: styles.warnTag,
													title: skill.registerError,
													"data-dsc-unregistered": skill.id,
													children: "未接入",
												})
											: null,
									isAgent
										? jsx("span", {
												key: "team",
												style: styles.teamTag,
												"data-dsc-team": skill.id,
												children: teamBadgeText(skill),
											})
										: null,
								],
							}),
							jsx("span", { key: "desc", style: styles.cardDesc, children: desc }),
							chips.length > 0
								? jsx("span", {
										key: "chips",
										style: Object.assign({}, styles.chips, { flexWrap: "wrap" }),
										"data-dsc-tags": skill.id,
										children: chips.map((tag, index) =>
											jsx("span", { key: `${tag}-${index}`, style: styles.chip, children: tag }),
										),
									})
								: null,
						],
					}),
					jsxs("span", {
						key: "actions",
						style: styles.cardActions,
						children: [
							jsx("button", {
								type: "button",
								className: "dsc-iconbtn",
								"aria-label": `${skill.name} 更多操作`,
								title: "更多操作",
								"data-dsc-menu": skill.id,
								onClick: (event) => {
									event?.stopPropagation?.();
									onMenu(group, skill, event);
								},
								style: styles.iconButton,
								children: "⋯",
							}),
							jsx(ToggleSwitch, {
								on: skill.enabled !== false,
								busy,
								disabled: skill.linked === true,
								label:
									skill.linked === true
										? `${skill.name} 是链接技能，无法启用/停用`
										: skill.enabled === false
											? `启用 ${skill.name}`
											: `停用 ${skill.name}`,
								attribute: ["data-dsc-toggle", skill.id],
								onToggle: () => onToggle(group, skill),
							}),
						],
					}),
				],
			});
		}

		/**
		 * 专家团弹框的信息区块：profession / 标签 / 「团队帮你做」/「团队成员」。
		 * 纯展示、无 hook（hook 全部留在页面组件里）。
		 */
		function AgentSections({ item }) {
			if (item === undefined || item === null || item.kind !== "agent") return null;
			const tags = Array.isArray(item.tags) ? item.tags : [];
			const prompts = Array.isArray(item.quickPrompts) ? item.quickPrompts : [];
			const members = Array.isArray(item.members) ? item.members : [];
			const blocks = [];
			if (Array.isArray(item.agentDocs) && item.agentDocs.length > 0) {
				blocks.push(
					jsx("div", {
						key: "docs",
						style: styles.agentProfession,
						"data-dsc-agent-docs": item.id,
						children: `${item.agentDocs.length} 份提示词`,
					}),
				);
			}
			if (tags.length > 0) {
				blocks.push(
					jsx("div", {
						key: "tags",
						style: styles.chips,
						"data-dsc-agent-tags": item.id,
						children: tags.map((tag, index) => jsx("span", { key: `${tag}-${index}`, style: styles.chip, children: tag })),
					}),
				);
			}
			if (prompts.length > 0) {
				blocks.push(
					jsxs("div", {
						key: "prompts",
						style: styles.section,
						"data-dsc-quick-prompts": item.id,
						children: [
							jsx("div", { key: "title", style: styles.sectionTitle, children: "团队帮你做" }),
							...prompts.map((prompt, index) =>
								jsx("div", { key: `prompt-${index}`, style: styles.promptItem, children: prompt }),
							),
						],
					}),
				);
			}
			if (members.length > 0) {
				blocks.push(
					jsxs("div", {
						key: "members",
						style: styles.section,
						"data-dsc-members": item.id,
						children: [
							jsx("div", { key: "title", style: styles.sectionTitle, children: `团队成员（${members.length}）` }),
							...members.map((member) =>
								jsxs(
									"div",
									{
										key: member.id,
										style: styles.memberRow,
										children: [
											jsx(AgentAvatar, {
												groupId: item.group,
												agentId: item.id,
												which: member.id,
												name: member.name,
												hasAvatar: member.hasAvatar,
												size: 22,
											}),
											jsxs("span", {
												style: styles.memberBox,
												children: [
													jsx("span", { style: styles.memberName, children: member.name }),
													jsx("span", {
														style: styles.memberMeta,
														children: [member.profession, member.role === "lead" ? "主理人" : "成员"]
															.filter(Boolean)
															.join(" · "),
													}),
												],
											}),
										],
									},
								),
							),
						],
					}),
				);
			}
			if (blocks.length === 0) return null;
			return jsx("div", { style: styles.agentSections, children: blocks });
		}

		/** 技能详情弹框（纯展示，无 hook）。 */
		function SkillDetailDialog({ subject, detail, item, onClose, onReveal }) {
			const isAgent = item !== undefined && item !== null && item.kind === "agent";
			return jsx("div", {
				className: "dsc-backdrop",
				style: styles.backdrop,
				"data-dsc-dialog": "",
				onClick: onClose,
				children: jsxs("div", {
					className: "dsc-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": `${subject.name} 技能详情`,
					style: styles.dialog,
					onClick: (event) => event.stopPropagation(),
					children: [
						jsxs("div", {
							key: "head",
							style: styles.dialogHead,
							children: [
								isAgent
									? jsx(AgentAvatar, {
											groupId: subject.group,
											agentId: subject.id,
											which: "lead",
											name: subject.name,
											hasAvatar: item.hasAvatar,
											size: 26,
										})
									: jsx("span", { style: avatarStyle(subject.name || subject.id), children: initialOf(subject.name || subject.id) }),
								jsxs("span", {
									style: styles.dialogTitleBox,
									children: [
										jsx("span", { style: styles.dialogName, children: subject.name }),
										jsx("span", {
											style: styles.dialogMeta,
											// 专家团在头部补上职衔；技能路径/大小文案逐字不变
											children:
												(isAgent && item.profession ? `${item.profession} · ` : "") +
												(detail.status === "ready"
													? `${detail.payload?.path ?? subject.path} · ${formatBytes(detail.payload?.bytes)}${detail.payload?.truncated ? " · 已截断（仅显示前 512KB）" : ""}`
													: subject.path),
										}),
									],
								}),
								jsx("button", {
									key: "reveal",
									type: "button",
									"data-dsc-action": "reveal",
									onClick: () => onReveal(subject),
									style: styles.button,
									children: "打开文件夹",
								}),
								jsx("button", {
									key: "close",
									type: "button",
									className: "dsc-close",
									"aria-label": "关闭",
									title: "关闭（Esc）",
									onClick: onClose,
									style: styles.close,
									children: "✕",
								}),
							],
						}),
						jsx("div", {
							key: "body",
							style: styles.dialogBody,
							children: isAgent
								? jsxs("div", {
										style: styles.agentBody,
										children: [
											jsx(AgentSections, { key: "sections", item }),
											jsx("div", {
												key: "content",
												children:
													detail.status === "ready"
														? jsx("pre", { style: styles.pre, children: detail.payload?.content ?? "" })
														: detail.status === "error"
															? jsx("div", { style: styles.error, children: `读取失败：${detail.error}` })
															: jsx("div", { style: styles.loading, children: "读取中…" }),
											}),
										],
									})
								: detail.status === "ready"
									? jsx("pre", { style: styles.pre, children: detail.payload?.content ?? "" })
									: detail.status === "error"
										? jsx("div", { style: styles.error, children: `读取失败：${detail.error}` })
										: jsx("div", { style: styles.loading, children: "读取中…" }),
						}),
					],
				}),
			});
		}

		/** ⋯ 下拉菜单（纯展示；fixed 定位因此不会被网格滚动裁剪）。 */
		function ActionMenu({ menu, onAction, onClose }) {
			return jsxs("div", {
				children: [
					jsx("div", { key: "backdrop", style: styles.menuBackdrop, onClick: onClose }),
					jsxs("div", {
						key: "menu",
						className: "dsc-menu",
						role: "menu",
						"data-dsc-menu-panel": menu.id,
						style: Object.assign({}, styles.menu, { left: `${menu.x}px`, top: `${menu.y}px` }),
						children: [
							jsx("div", { key: "path", style: styles.menuPath, children: menu.path }),
							jsx(MenuItem, { key: "reveal", icon: "📂", text: "打开文件夹", action: "reveal", onClick: () => onAction("reveal") }),
							jsx(MenuItem, { key: "copy", icon: "⧉", text: "复制路径", action: "copy", onClick: () => onAction("copy") }),
							jsx(MenuItem, {
								key: "toggle",
								icon: menu.enabled ? "⏸" : "▶",
								text: menu.enabled ? "停用技能" : "启用技能",
								action: "toggle",
								onClick: () => onAction("toggle"),
							}),
						],
					}),
				],
			});
		}

		/** 来源目录编辑器（纯展示）。 */
		function GroupsDialog({ draft, note, saving, storePath, onChange, onAdd, onRemove, onReset, onSave, onClose }) {
			const rows = draft.map((group, index) =>
				jsxs(
					"div",
					{
						style: styles.row,
						key: `row-${index}`,
						children: [
							jsx("input", {
								value: group.id,
								placeholder: "id",
								"aria-label": `第 ${index + 1} 个来源目录的 id`,
								"data-dsc-group-id": String(index),
								className: "dsc-input",
								onChange: (event) => onChange(index, "id", event.target.value),
								style: styles.monoInput,
							}),
							jsx("input", {
								value: group.label,
								placeholder: "显示名",
								"aria-label": `第 ${index + 1} 个来源目录的显示名`,
								"data-dsc-group-label": String(index),
								className: "dsc-input",
								onChange: (event) => onChange(index, "label", event.target.value),
								style: styles.input,
							}),
							jsx("input", {
								value: group.root,
								placeholder: "C:\\绝对\\路径",
								"aria-label": `第 ${index + 1} 个来源目录的路径`,
								"data-dsc-group-root": String(index),
								className: "dsc-input",
								onChange: (event) => onChange(index, "root", event.target.value),
								style: styles.monoInput,
							}),
							jsx("button", {
								type: "button",
								"aria-label": `删除第 ${index + 1} 个来源目录`,
								"data-dsc-action": "remove-group",
								onClick: () => onRemove(index),
								style: styles.iconButton,
								children: "✕",
							}),
						],
					},
					`row-${index}`,
				),
			);
			return jsx("div", {
				className: "dsc-backdrop",
				style: styles.backdrop,
				"data-dsc-groups": "",
				onClick: onClose,
				children: jsxs("div", {
					className: "dsc-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "来源目录",
					style: Object.assign({}, styles.dialog, { width: "min(880px, 100%)", maxHeight: "min(76vh, 640px)" }),
					onClick: (event) => event.stopPropagation(),
					children: [
						jsxs("div", {
							key: "head",
							style: styles.dialogHead,
							children: [
								jsxs("span", {
									style: styles.dialogTitleBox,
									children: [
										jsx("span", { style: styles.dialogName, children: "来源目录" }),
										jsx("span", {
											style: styles.dialogMeta,
											children: `保存到 ${storePath ?? "（未知）"}`,
										}),
									],
								}),
								jsx("button", {
									key: "close",
									type: "button",
									className: "dsc-close",
									"aria-label": "关闭",
									onClick: onClose,
									style: styles.close,
									children: "✕",
								}),
							],
						}),
						jsxs("div", {
							key: "body",
							style: styles.dialogBody,
							children: [
								jsx("div", {
									key: "hint",
									style: { fontSize: "11.5px", color: COLOR.muted, marginBottom: "10px" },
									children:
										"每行是一个技能来源目录：id 只允许小写字母/数字/连字符；路径必须是绝对路径。保存后立即生效，并写入上面的 JSON 文件。",
								}),
								...rows,
								jsxs("div", {
									key: "tools",
									style: { display: "flex", gap: "8px", marginTop: "4px" },
									children: [
										jsx("button", {
											type: "button",
											"data-dsc-action": "add-group",
											onClick: onAdd,
											style: styles.button,
											children: "+ 新增目录",
										}),
										jsx("button", {
											type: "button",
											"data-dsc-action": "reset-groups",
											onClick: onReset,
											style: styles.button,
											children: "恢复默认",
										}),
									],
								}),
							],
						}),
						jsxs("div", {
							key: "foot",
							style: styles.editorFoot,
							children: [
								jsx("span", {
									key: "note",
									"data-dsc-note": note === undefined ? "" : note.kind,
									style: note === undefined ? styles.okNote : note.kind === "error" ? styles.note : styles.okNote,
									children: note === undefined ? "" : note.text,
								}),
								jsx("button", {
									key: "cancel",
									type: "button",
									onClick: onClose,
									style: styles.button,
									children: "取消",
								}),
								jsx("button", {
									key: "save",
									type: "button",
									"data-dsc-action": "save-groups",
									onClick: onSave,
									style: styles.primaryButton,
									children: saving ? "保存中…" : "保存",
								}),
							],
						}),
					],
				}),
			});
		}

		/** 中栏页面：顶部两个技能页签 + 卡片网格 + 弹框。 */
		function SkillCenterPage() {
			const [listing, setListing] = useState({ status: "loading", groups: [], error: undefined, source: undefined, storePath: undefined });
			const [query, setQuery] = useState("");
			const [activeGroup, setActiveGroup] = useState(undefined);
			const [subject, setSubject] = useState(undefined);
			const [detail, setDetail] = useState({ status: "idle" });
			const [menu, setMenu] = useState(undefined);
			const [groupsOpen, setGroupsOpen] = useState(false);
			const [draft, setDraft] = useState([]);
			const [note, setNote] = useState(undefined);
			const [pending, setPending] = useState([]);
			const [toast, setToast] = useState(undefined);

			const loadListing = useCallback(() => {
				setListing((previous) => Object.assign({}, previous, { status: "loading", error: undefined }));
				requestJson(API.list)
					.then((payload) =>
						setListing({
							status: "ready",
							groups: payload?.groups ?? [],
							source: payload?.source,
							storePath: payload?.storePath, registry: payload?.registry,
							problems: payload?.problems ?? [],
							error: undefined,
						}),
					)
					.catch((error) =>
						setListing({
							status: "error",
							groups: [],
							error: error instanceof Error ? error.message : String(error),
						}),
					);
			}, []);

			useEffect(() => {
				loadListing();
			}, [loadListing]);

			// Esc 关闭最上层浮层
			useEffect(() => {
				if (typeof document === "undefined") return undefined;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (menu !== undefined) setMenu(undefined);
					else if (groupsOpen) setGroupsOpen(false);
					else if (subject !== undefined) setSubject(undefined);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [menu, groupsOpen, subject]);

			const markPending = useCallback((id, on) => {
				setPending((previous) => (on ? previous.concat(id) : previous.filter((item) => item !== id)));
			}, []);

			const openDetail = useCallback((group, skill) => {
				// item 带上整条扫描结果：专家团弹框要用 tags / quickPrompts / members / 头像
				setSubject({ group: group.id, id: skill.id, name: skill.name, path: skill.path, item: skill });
				setDetail({ status: "loading" });
				const url = `${API.read}?group=${encodeURIComponent(group.id)}&id=${encodeURIComponent(skill.id)}`;
				requestJson(url)
					.then((payload) => setDetail({ status: "ready", payload }))
					.catch((error) =>
						setDetail({ status: "error", error: error instanceof Error ? error.message : String(error) }),
					);
			}, []);

			const closeDetail = useCallback(() => setSubject(undefined), []);

			/** 启用/停用：写 frontmatter 后重新扫描列表。 */
			const toggleEnabled = useCallback(
				(group, skill) => {
					const next = skill.enabled === false;
					markPending(skill.id, true);
					requestJson(API.setEnabled, {
						method: "POST",
						body: { group: group.id, id: skill.id, enabled: next },
					})
						.then((result) => {
							setToast(`${skill.name} 已${next ? "启用" : "停用"}${result?.changed === false ? "（文件无需改动）" : ""}`);
							loadListing();
						})
						.catch((error) => setToast(`操作失败：${error instanceof Error ? error.message : String(error)}`))
						.finally(() => markPending(skill.id, false));
				},
				[loadListing, markPending],
			);

			/** 在系统文件管理器中定位技能文件。 */
			const revealSkill = useCallback((groupRef, skill) => {
				const group = typeof groupRef === "string" ? { id: groupRef } : groupRef;
				setMenu(undefined);
				requestJson(API.reveal, {
					method: "POST",
					body: { group: group.id, id: skill.id },
				})
					.then((result) => setToast(result?.dryRun === true ? `（演练）${result.command} ${result.args?.[0] ?? ""}` : `已在文件管理器中定位 ${skill.name}`))
					.catch((error) => setToast(`打开文件夹失败：${error instanceof Error ? error.message : String(error)}`));
			}, []);

			const copyPath = useCallback((path) => {
				setMenu(undefined);
				try {
					const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
					if (clipboard !== undefined && typeof clipboard.writeText === "function") {
						clipboard.writeText(path);
						setToast("路径已复制");
						return;
					}
				} catch {}
				setToast(`剪贴板不可用，路径：${path}`);
			}, []);

			const openGroups = useCallback(() => {
				setNote(undefined);
				setToast(undefined);
				requestJson(API.groups)
					.then((payload) => {
						setDraft((payload?.groups ?? []).map((group) => Object.assign({}, group)));
						setGroupsOpen(true);
					})
					.catch((error) => setToast(`读取来源目录失败：${error instanceof Error ? error.message : String(error)}`));
			}, []);

			const changeDraft = useCallback((index, field, value) => {
				setDraft((previous) =>
					previous.map((group, position) =>
						position === index ? Object.assign({}, group, { [field]: value }) : group,
					),
				);
			}, []);

			const addDraftRow = useCallback(() => {
				setDraft((previous) => {
					let suffix = previous.length + 1;
					const taken = new Set(previous.map((group) => group.id));
					while (taken.has(`group-${suffix}`)) suffix += 1;
					return previous.concat({ id: `group-${suffix}`, label: "新目录", root: "" });
				});
			}, []);

			const removeDraftRow = useCallback((index) => {
				setDraft((previous) => previous.filter((group, position) => position !== index));
			}, []);

			const saveGroups = useCallback(() => {
				setNote(undefined);
				requestJson(API.groups, { method: "POST", body: { groups: draft } })
					.then((payload) => {
						setGroupsOpen(false);
						setActiveGroup(undefined);
						setToast(`来源目录已保存（${payload?.groups?.length ?? 0} 个）`);
						loadListing();
					})
					.catch((error) =>
						setNote({ kind: "error", text: error instanceof Error ? error.message : String(error) }),
					);
			}, [draft, loadListing]);

			const resetGroups = useCallback(() => {
				requestJson(API.groups, { method: "POST", body: { reset: true } })
					.then(() => {
						setGroupsOpen(false);
						setActiveGroup(undefined);
						setToast("已恢复默认来源目录");
						loadListing();
					})
					.catch((error) =>
						setNote({ kind: "error", text: error instanceof Error ? error.message : String(error) }),
					);
			}, [loadListing]);

			const openMenu = useCallback((group, skill, event) => {
				const rect = event?.currentTarget?.getBoundingClientRect?.();
				const width =
					typeof window === "undefined" || typeof window.innerWidth !== "number"
						? 1200
						: window.innerWidth;
				const x = rect === undefined ? 16 : Math.max(8, Math.min(rect.left, width - 190));
				const y = rect === undefined ? 16 : rect.bottom + 4;
				setMenu({ group: group.id, id: skill.id, name: skill.name, path: skill.path, enabled: skill.enabled !== false, x, y });
			}, []);

			const onMenuAction = useCallback(
				(action) => {
					if (menu === undefined) return;
					const group = groupsRef();
					const skill = skillsRef().find((candidate) => candidate.id === menu.id);
					if (action === "reveal") {
						revealSkill(menu.group, skill ?? { id: menu.id, name: menu.name });
						return;
					}
					if (action === "copy") {
						copyPath(menu.path);
						return;
					}
					const fallback = skill ?? { id: menu.id, name: menu.name, enabled: menu.enabled };
					setMenu(undefined);
					toggleEnabled({ id: group?.id ?? menu.group }, fallback);
				},
				[menu, revealSkill, copyPath, toggleEnabled],
			);

			const groups = listing.groups;
			const current = groups.find((group) => group.id === activeGroup) ?? groups[0] ?? undefined;
			const total = groups.reduce((sum, group) => sum + (group.skills?.length ?? 0), 0);
			/** 启用中的技能数：与「已接入会话」对比，差出来的就是没进技能表的。 */
			const enabledTotal = groups.reduce(
				(sum, group) => sum + (group.skills?.filter((skill) => skill.enabled !== false).length ?? 0),
				0,
			);

			// 供菜单动作闭包读取当前渲染的数据（不参与 hook 顺序）
			const groupsRef = () => groups;
			const skillsRef = () => (Array.isArray(current?.skills) ? current.skills : []);

			const keyword = query.trim().toLowerCase();
			const matches = (skill) =>
				keyword === "" ||
				String(skill.id).toLowerCase().includes(keyword) ||
				String(skill.name).toLowerCase().includes(keyword) ||
				String(skill.description ?? "").toLowerCase().includes(keyword) ||
				String(skill.whenToUse ?? "").toLowerCase().includes(keyword) ||
				// 专家团的标签也参与搜索（技能没有 tags，行为不变）
				(Array.isArray(skill.tags) && skill.tags.some((tag) => String(tag).toLowerCase().includes(keyword)));

			const skills = Array.isArray(current?.skills) ? current.skills.filter(matches) : [];

			const header = jsxs("div", {
				style: styles.header,
				children: [
					jsx("h2", { key: "title", style: styles.title, children: LABEL }),
					jsx("span", {
						key: "count",
						style: styles.count,
						children: listing.status === "loading" && total === 0 ? "加载中…" : `共 ${total} 个技能`,
					}),
					jsx("span", {
						key: "registry",
						"data-dsc-registry": listing.registry === undefined ? "" : String(listing.registry.registered),
						title:
							listing.registry === undefined
								? undefined
								: listing.registry.errors.length > 0
									? `未接入：${listing.registry.errors.map((item) => `${item.name}（${item.reason}）`).join("；")}`
									: "启用中的技能都已进入 DSH 会话的技能表",
						style:
							listing.registry !== undefined && listing.registry.failed > 0
								? styles.warnBadge
								: styles.badge,
						children:
							listing.registry === undefined
								? "会话识别中…"
								: `已接入会话 ${listing.registry.registered}/${enabledTotal}`,
					}),
					jsx("input", {
						key: "search",
						value: query,
						placeholder: "搜索技能名 / 描述",
						"aria-label": "搜索技能",
						className: "dsc-input",
						onChange: (event) => setQuery(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Escape") setQuery("");
						},
						style: styles.search,
					}),
					jsx("button", {
						key: "groups",
						type: "button",
						"data-dsc-action": "open-groups",
						onClick: openGroups,
						style: styles.button,
						children: "来源目录",
					}),
					jsx("button", {
						key: "refresh",
						type: "button",
						"data-dsc-action": "refresh",
						onClick: loadListing,
						style: styles.button,
						children: listing.status === "loading" ? "刷新中…" : "刷新",
					}),
				],
			});

			const tabs = jsxs("div", {
				style: styles.tabs,
				role: "tablist",
				children: [
					...groups.map((group) =>
						jsxs(
							"button",
							{
								key: group.id,
								type: "button",
								role: "tab",
								className: "dsc-tab",
								"aria-selected": group.id === current?.id,
								"data-dsc-tab": group.id,
								onClick: () => setActiveGroup(group.id),
								style: styles.tab(group.id === current?.id),
								children: [
									jsx("span", { children: group.label }),
									jsx("span", { style: styles.tabBadge, children: String(group.skills?.length ?? 0) }),
								],
							},
							group.id,
						),
					),
					jsxs("span", {
						key: "meta",
						style: styles.meta,
						children: [
							jsx("span", {
								key: "root",
								style: styles.rootPath,
								title: current?.root,
								children: current?.root ?? "",
							}),
							jsx("span", {
								key: "source",
								style: styles.badge,
								title: `来源目录保存于 ${listing.storePath ?? "?"}`,
								children: sourceLabel(listing.source),
							}),
						],
					}),
				],
			});

			const gridChildren = [];
			if (current === undefined) {
				gridChildren.push(
					jsx("div", {
						key: "none",
						style: styles.hint,
						children: listing.status === "error" ? `加载失败：${listing.error}` : "加载中…",
					}),
				);
			} else if (current.exists === false) {
				gridChildren.push(
					jsx("div", { key: "missing", style: styles.hint, children: `目录不可用：${current.error ?? "not found"}` }),
				);
			} else if (skills.length === 0) {
				gridChildren.push(
					jsx("div", {
						key: "empty",
						style: styles.hint,
						children: (current.skills?.length ?? 0) === 0 ? "（未发现技能）" : "无匹配结果",
					}),
				);
			} else {
				for (const skill of skills) {
					gridChildren.push(
						jsx(
							SkillCard,
							{
								key: skill.id,
								skill,
								group: current,
								busy: pending.includes(skill.id),
								onOpen: openDetail,
								onToggle: toggleEnabled,
								onMenu: openMenu,
							},
							skill.id,
						),
					);
				}
			}

			const overlays = [];
			if (menu !== undefined) {
				overlays.push(jsx(ActionMenu, { key: "menu", menu, onAction: onMenuAction, onClose: () => setMenu(undefined) }));
			}
			if (subject !== undefined) {
				overlays.push(
					jsx(
						SkillDetailDialog,
						{
							key: "dialog",
							subject,
							detail,
							item: subject.item,
							onClose: closeDetail,
							onReveal: (picked) => revealSkill(picked.group, { id: picked.id, name: picked.name }),
						},
						"dialog",
					),
				);
			}
			if (groupsOpen) {
				overlays.push(
					jsx(
						GroupsDialog,
						{
							key: "groups",
							draft,
							note,
							saving: false,
							storePath: listing.storePath,
							onChange: changeDraft,
							onAdd: addDraftRow,
							onRemove: removeDraftRow,
							onReset: resetGroups,
							onSave: saveGroups,
							onClose: () => setGroupsOpen(false),
						},
						"groups",
					),
				);
			}

			return jsxs("div", {
				style: styles.view,
				"data-dsh-plugin": "skill-center",
				"data-dsh-skill-center-view": "",
				children: [
					jsx("style", { key: "css", children: CSS }),
					header,
					tabs,
					jsx("div", { key: "grid", style: styles.grid, "data-dsc-grid": "", children: gridChildren }),
					toast === undefined
						? null
						: jsx("div", {
								key: "toast",
								"data-dsc-toast": "",
								style: {
									position: "fixed",
									left: "50%",
									bottom: "28px",
									transform: "translateX(-50%)",
									zIndex: 1200,
									maxWidth: "70vw",
									padding: "7px 14px",
									fontSize: "12px",
									color: COLOR.text,
									background: COLOR.overlay,
									border: `1px solid ${COLOR.borderStrong}`,
									borderRadius: "999px",
									boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
								},
								children: toast,
							}),
					...overlays,
				],
			});
		}

		/** 注册侧栏行与中栏页。 */
		function registerSkillCenterPanel(ctx) {
			const slots = ctx.slots;
			const disposers = [];
			disposers.push(
				slots.inject("sidebar.panellist", () =>
					slots.register(
						{ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => LABEL },
						SkillCenterIcon,
					),
				),
			);
			disposers.push(
				slots.inject("main", () => slots.register({ name: "main", key: PANEL_ID }, SkillCenterPage)),
			);
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}

		/** 挂载技能中心界面。 @param ctx - 客户端根上下文（slots）。 */
		function apply(ctx) {
			let release;
			try {
				release = registerSkillCenterPanel(ctx);
			} catch (error) {
				console.warn("[skill-center] panel registration failed:", error);
				release = () => {};
			}
			ctx.effect(() => () => release(), "skill-center: ui mounts");
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
