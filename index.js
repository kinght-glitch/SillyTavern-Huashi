/**
 * 画师 v1.0.1 —— 剧情生图插件（纯前端扩展）
 * 点 AI 回复的 🎨 按钮 → 采集三层上下文（数据库/世界书/聊天）→ LLM 翻译成 danbooru 标签 → 本地 SD 出图 → 回贴聊天。
 * 网络请求全部走酒馆服务端代理：/api/backends/chat-completions/generate（LLM）与 /api/sd/generate（SD）。
 * 密钥由酒馆 API 连接配置读取，不进入本插件。
 */
import {
    chat_metadata,
    characters,
    this_chid,
    event_types,
    eventSource,
    getCurrentChatId,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
} from '../../../../scripts/extensions.js';
import { saveBase64AsFile } from '../../../../scripts/utils.js';
import { oai_settings } from '../../../../scripts/openai.js';

const TAG = '[画师]';

// NSFW 档位 identifier（M1 已确认）
const NSFW_IDS = {
    normal: 'd6fa9105-b1ec-4079-a3be-a608388a4812',
    softer: 'b0930f00-156e-428a-8247-4977549ca41f',
    nsfw: '9f6fb39c-5373-47a0-a3d9-dc6fcbbe83de',
    off: '18e1bcb1-c329-4aba-957a-c22fb77712be',
};

const QUALITY_PREFIX = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, ';
const DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry, deformed, malformed';

const SYSTEM_PROMPT = [
    'You convert story context into Stable Diffusion danbooru tags.',
    'Output ONLY one JSON object: {"positive":"...","negative":"..."}.',
    'Never explain, never reason out loud. Your very first character must be "{" and your very last must be "}".',
    'English danbooru tags, comma separated, no sentences, no explanations.',
    'Name every present character by appearance tags taken from the data (hair, eyes, outfit); the protagonist in the center.',
    'Scene tags from location/time.',
    'If recent_events conflicts with chat_context, follow chat_context.',
    'Keep positive under 75 tokens; when many characters are present, keep characters and drop minor scene details.',
].join(' ');

const DEFAULTS = {
    llm_url: 'https://api.jiuzhan.top/v1',
    llm_model: 'deepseek-v4.1-flash',
    llm_timeout: 120,
    temperature: 0.4,
    sd_url: 'http://127.0.0.1:7860',
    width: 512,
    height: 768,
    steps: 20,
    cfg_scale: 7,
    sampler: 'DPM++ 2M',
    scheduler: 'Karras',
    clip_skip: 2,
    vae: '',
    chat_count: 3,
    token_budget: 6000,
    layer_db: true,
    layer_world: true,
    layer_chat: true,
    nsfw_link: true,
    jailbreak_inherit: true,
};

let busy = false;          // 全局单例锁：同时只出一张图
let lastWorldInfo = null;  // 最近一次 WORLD_INFO_ACTIVATED 激活条目

function ensureSettings() {
    if (!extension_settings.huashi) {
        extension_settings.huashi = { ...DEFAULTS };
        saveSettingsDebounced();
    } else {
        extension_settings.huashi = { ...DEFAULTS, ...extension_settings.huashi };
    }
    return extension_settings.huashi;
}

/* ============ 模块 2：按钮注入与点击 ============ */

function injectButtons() {
    $('#chat .mes').each(function () {
        const $mes = $(this);
        if ($mes.attr('is_user') === 'true' || $mes.attr('is_system') === 'true') return;
        let $box = $mes.find('.extraMesButtons');
        if (!$box.length) {
            const $parent = $mes.find('.mes_buttons');
            if (!$parent.length) return; // 无按钮区的消息跳过
            $box = $('<div class="extraMesButtons"></div>').appendTo($parent); // 降级：自建容器
        }
        if ($box.find('.huashi_gen').length) return;
        $box.get(0).style.setProperty('display', 'inherit'); // 1.19 默认 display:none，需显式显示
        $box.append('<button type="button" class="mes_button huashi_gen fa-solid fa-palette" title="用画师生成插画" aria-label="用画师生成插画"></button>');
    });
}

function bindChatEvents() {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => injectButtons());
    eventSource.on(event_types.CHAT_CHANGED, () => { lastWorldInfo = null; injectButtons(); });
    eventSource.on(event_types.MESSAGE_UPDATED, () => injectButtons());
    eventSource.on(event_types.MESSAGE_SWIPED, () => injectButtons());
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => { lastWorldInfo = entries; });
    $(document).on('click', '.huashi_gen', onPaintClick);
}

async function onPaintClick(e) {
    const $btn = $(e.currentTarget);
    const mesId = Number($btn.closest('.mes').attr('mesid'));
    if (!Number.isFinite(mesId)) return;
    if (busy) { toastr.warning('正在出图，请稍候'); return; }
    busy = true;
    const chatId = getCurrentChatId();
    $btn.removeClass('fa-palette').addClass('fa-spinner fa-spin');
    try {
        await generateAndPost(mesId, chatId);
    } catch (err) {
        console.error(TAG, '出图失败', err);
        toastr.error('出图失败：' + (err?.message ?? err));
    } finally {
        $btn.removeClass('fa-spinner fa-spin').addClass('fa-palette');
        busy = false;
    }
}

/* ============ 模块 3：三层上下文采集 ============ */

function stripMarkup(text) {
    if (typeof text !== 'string') return '';
    return String(text)
        .replace(/<think_nya>[^]*?<[/]think_nya>/gi, '')
        .replace(/<game>[^]*?<[/]game>/gi, '')
        .replace(/<summary>[^]*?<[/]summary>/gi, '')
        .replace(/<options>[^]*?<[/]options>/gi, '')
        .replace(/<comment>[^]*?<[/]comment>/gi, '')
        .replace(/[<][^>]*[>]/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, String.fromCharCode(39))
        .trim();
}

function collectChat(mesId, count) {
    const chat = getContext().chat ?? [];
    const out = [];
    for (let i = mesId; i >= 0 && out.length < count; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.extra && ((m.extra.media && m.extra.media.length) || m.extra.image)) continue; // 跳过带图消息
        let text = stripMarkup(m.mes ?? '');
        if (!text) continue;
        if (text.length > 2000) text = text.slice(-2000); // 单条超长截头留尾
        out.push({ name: m.name || '?', text });
    }
    return out.reverse(); // 时间正序
}

function collectWorld() {
    const ctx = getContext();
    if (lastWorldInfo) {
        const texts = (Array.isArray(lastWorldInfo) ? lastWorldInfo : [lastWorldInfo])
            .map(e => (typeof e === 'string' ? e : (e?.content ?? '')))
            .filter(Boolean);
        if (texts.length) return texts.join(String.fromCharCode(10) + '---' + String.fromCharCode(10));
    }
    const ch = ctx.characters?.[ctx.characterId];
    if (ch?.description) return ch.description; // 角色卡描述兜底
    return '';
}

// 玄黄数据库（龙血玄黄·数据库 v1.3.7）三路读取：
// ① localStorage shujuku* 键（菜单状态等）
// ② 酒馆 settings 命名空间 extension_settings.__userscripts.shujuku_v120__userscript_settings_v1
//    （template=12张表schema+content数据行、globalMeta、settings=LLM配置）
// ③ 表行数组按列头映射（12表真实列名，见 画师插件-M1探针记录.md 玄黄数据库破解章节）
function collectDb() {
    const db = { location: '', time: '', state: '', characters: [], notes: [] };
    const seen = new Set();
    try {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('shujuku')) continue;
            const raw = localStorage.getItem(key) || '';
            if (!raw || seen.has(key)) continue;
            seen.add(key);
            try { scanDb(JSON.parse(raw), db, 0); } catch { /* 忽略非 JSON */ }
        }
    } catch { /* localStorage 不可用 */ }
    try {
        const ns = extension_settings?.__userscripts?.['shujuku_v120__userscript_settings_v1'];
        if (ns && typeof ns === 'object') {
            for (const [k, v] of Object.entries(ns)) {
                if (typeof v !== 'string' || seen.has(k)) continue;
                seen.add(k);
                try { scanDb(JSON.parse(v), db, 0); } catch { /* 忽略坏 JSON */ }
            }
        }
    } catch { /* extension_settings 不可用 */ }
    return (db.location || db.time || db.state || db.characters.length || db.notes.length) ? db : null;
}

function scanDb(node, db, depth) {
    if (depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(x => scanDb(x, db, depth + 1)); return; }
    const content = node.content;
    if (Array.isArray(content) && content.length > 1 && Array.isArray(content[0]) && content[0].every(x => typeof x === 'string')) {
        scanSheet(content[0], content.slice(1), db); // 列头 + 数据行
    }
    for (const [k, v] of Object.entries(node)) {
        if (v == null || k === 'content') continue;
        const kl = String(k).toLowerCase();
        if (typeof v === 'string' || typeof v === 'number') {
            if (!db.location && (kl.includes('地点') || kl.includes('地区') || kl.includes('location') || kl.includes('place'))) db.location = String(v);
            else if (!db.time && (kl.includes('时间') || kl.includes('time') || kl.includes('date'))) db.time = String(v);
            else if (!db.state && kl.includes('全局状态')) db.state = String(v);
            else if (kl.includes('纪要') || kl.includes('概览') || kl.includes('note') || kl.includes('summary') || kl.includes('事件')) db.notes.push(String(v));
            continue;
        }
        if (typeof v === 'object' && !Array.isArray(v)) {
            const hasName = ('姓名' in v || '人物名称' in v || 'name' in v || '角色名' in v);
            const hasLook = ('外貌' in v || '外貌特征' in v || '穿着' in v || '穿着打扮' in v || 'appearance' in v || 'outfit' in v || '在场状态' in v);
            if (hasName && hasLook) { db.characters.push(v); continue; }
        }
        scanDb(v, db, depth + 1);
    }
}

// 按 12 表真实列名映射数据行（列头数组 + 行数组）
function scanSheet(columns, rows, db) {
    const idx = {};
    columns.forEach((c, i) => { idx[String(c)] = i; });
    const get = c => (c in idx && idx[c] < rows[0]?.length ? rows[0][idx[c]] : undefined);
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const grab = c => (c in idx && idx[c] < row.length ? row[idx[c]] : undefined);
        const name = grab('姓名') ?? grab('人物名称');
        if (name) {
            db.characters.push({
                name,
                appearance: grab('外貌特征') ?? '',
                outfit: grab('穿着打扮') ?? grab('随身财物') ?? '',
                status: grab('在场状态') ?? grab('是否离场') ?? '',
            });
        }
        if (!db.location) db.location = grab('当前详细地点') ?? grab('主角当前所在地点') ?? '';
        if (!db.time) db.time = grab('当前时间') ?? grab('上轮场景时间') ?? '';
        if (!db.state) db.state = grab('全局状态') ?? '';
        const mem = grab('纪要') ?? grab('概览');
        if (mem) db.notes.push(String(mem));
    }
}

function packCharacters(db) {
    return (db.characters ?? []).map(c => ({
        name: c.name ?? c.character_name ?? c.角色名 ?? c.姓名 ?? c.人物名称 ?? '',
        appearance: c.appearance ?? c.appearance_text ?? c.外貌 ?? c.外貌特征 ?? '',
        outfit: c.outfit_text ?? c.outfit ?? c.穿着 ?? c.穿着打扮 ?? '',
        status: c.presence_status ?? c.在场状态 ?? c.状态 ?? '',
    })).filter(c => c.name);
}

function collectContext(mesId, s) {
    const pack = {
        scene: { location: '', time: '', present_characters: [] },
        appearances: {},
        recent_events: [],
        chat_context: [],
    };
    if (s.layer_chat) pack.chat_context = collectChat(mesId, s.chat_count);
    if (s.layer_world) {
        const w = collectWorld();
        if (w) pack.world_info = w;
    }
    if (s.layer_db) {
        const db = collectDb();
        if (db) {
            if (db.location) pack.scene.location = db.location;
            if (db.time) pack.scene.time = db.time;
            for (const c of packCharacters(db)) {
                if (c.name && !pack.scene.present_characters.includes(c.name)) pack.scene.present_characters.push(c.name);
                const desc = [c.appearance, c.outfit, c.status].filter(Boolean).join(', ');
                if (c.name && desc && !(c.name in pack.appearances)) pack.appearances[c.name] = desc;
            }
            if (db.notes?.length) pack.recent_events = db.notes.slice(-3);
        }
    }
    return applyBudget(pack, s.token_budget);
}

function estSize(x) { return typeof x === 'string' ? x.length : JSON.stringify(x ?? '').length; }
function packSize(p) {
    return estSize(p.scene) + estSize(p.appearances) + estSize(p.recent_events)
        + estSize(p.chat_context) + estSize(p.world_info ?? '');
}
// 超预算：先截聊天（丢最旧），再截纪要（丢最新），最后截世界书兜底
function applyBudget(pack, budget) {
    if (packSize(pack) <= budget) return pack;
    while (pack.chat_context.length && packSize(pack) > budget) pack.chat_context.shift();
    while (pack.recent_events.length && packSize(pack) > budget) pack.recent_events.pop();
    if (packSize(pack) > budget) pack.world_info = (pack.world_info ?? '').slice(0, Math.floor(budget * 0.3));
    return pack;
}

/* ============ 模块 4：LLM 翻译 ============ */

function getNsfwLevel() {
    const s = ensureSettings();
    if (!s.nsfw_link) return 'mild';
    try {
        const orders = oai_settings?.prompt_order ?? [];
        const item = orders.find(x => x && x.character_id === 100001);
        if (item && Array.isArray(item.order)) {
            const on = id => item.order.some(o => o && o.identifier === id && o.enabled);
            if (on(NSFW_IDS.off)) return 'mild';          // 关闭NSFW 开 → 温和
            if (on(NSFW_IDS.nsfw)) return 'explicit';     // 色色！开 → 全开
            if (on(NSFW_IDS.softer)) return 'suggestive'; // 更舒缓开 → 擦边
            if (on(NSFW_IDS.normal)) return 'mild';       // 正常开 → 温和
        }
    } catch (e) { console.warn(TAG, 'NSFW 档位读取失败', e); }
    return 'mild'; // 读取失败按温和，不打扰用户
}

function nsfwLine(level) {
    if (level === 'explicit') return 'NSFW policy: explicit tags allowed. No negative restrictions for nsfw.';
    if (level === 'suggestive') return 'NSFW policy: suggestive only. Keep the scene suggestive, no explicit acts.';
    return 'NSFW policy: mild. Light nsfw tags allowed. Keep the style soft.';
}

function getJailbreakContent() {
    if (!ensureSettings().jailbreak_inherit) return null;
    try {
        const prompts = oai_settings?.prompts ?? [];
        const p = prompts.find(x => x && x.identifier === 'enhanceDefinitions');
        if (p && p.enabled && p.content) return p.content;
    } catch (e) { console.warn(TAG, '破甲预设读取失败', e); }
    return null;
}

async function callLLM(messages, maxTokens, s) {
    const body = {
        chat_completion_source: 'custom',
        custom_url: s.llm_url,
        model: s.llm_model,
        messages,
        max_tokens: maxTokens,
        temperature: s.temperature,
        stream: false,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (s.llm_timeout ?? 120) * 1000);
    try {
        const r = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); if (j?.error?.message) msg = j.error.message; } catch { /* 保持 HTTP 码 */ }
            throw new Error(msg);
        }
        const j = await r.json();
        const content = j?.choices?.[0]?.message?.content;
        if (!content) throw new Error('LLM 返回无内容');
        return content;
    } finally { clearTimeout(timer); }
}

function tryParseTags(raw) {
    const s = String(raw);
    try {
        const j = JSON.parse(s);
        if (j && typeof j.positive === 'string') return j;
    } catch { /* 非纯 JSON，走平衡扫描 */ }
    // 平衡括号扫描：从每个 '{' 出发找配对的 '}'，逐个 parse（跳过字符串内部）
    const BS = String.fromCharCode(92);
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '{') continue;
        let depth = 0, inStr = false, esc = false;
        for (let k = i; k < s.length; k++) {
            const c = s[k];
            if (esc) { esc = false; continue; }
            if (c === BS) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        const j = JSON.parse(s.slice(i, k + 1));
                        if (j && typeof j.positive === 'string') return j;
                    } catch { /* 试下一个候选 */ }
                    break;
                }
            }
        }
    }
    // 代码围栏剥离后重试一次（三个反引号拆分，零转义写法）
    const parts = s.split(String.fromCharCode(96));
    if (parts.length >= 3) {
        const inner = parts[1].replace(/^json/i, '');
        if (inner && inner !== s) return tryParseTags(inner);
    }
    return null;
}

async function translateToTags(pack, s) {
    const nsfw = getNsfwLevel();
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT + ' ' + nsfwLine(nsfw) },
    ];
    const jb = getJailbreakContent();
    if (jb) messages.push({ role: 'system', content: jb });
    messages.push({ role: 'user', content: JSON.stringify(pack) });

    let raw = await callLLM(messages, 1600, s);
    let parsed = tryParseTags(raw);
    if (!parsed) {
        messages.push({ role: 'user', content: 'Your previous reply was not valid JSON. Output ONLY the JSON object, nothing else.' });
        raw = await callLLM(messages, 1600, s); // 解析失败重试 1 次
        parsed = tryParseTags(raw);
    }
    if (!parsed) {
        console.warn(TAG, 'LLM 两次返回都无法解析，整段当正向标签', raw?.slice(0, 200));
        return { positive: String(raw).slice(0, 500), negative: '' };
    }
    return {
        positive: (parsed.positive ?? '').trim(),
        negative: (parsed.negative ?? '').trim(),
    };
}

/* ============ 模块 5：SD 出图与回贴 ============ */

function rawLastPrompt(sourceMsg) {
    let text = stripMarkup(sourceMsg?.mes ?? '');
    text = text.slice(0, 300);
    return { positive: text || '1girl, solo', negative: '' };
}

function finalNegative(negative, level) {
    let neg = DEFAULT_NEGATIVE;
    if (negative) neg += ', ' + negative;
    if (level === 'suggestive') neg += ', nsfw, explicit, nipples, pussy'; // 擦边：负面追加
    return neg;
}

function parseSeed(info) {
    if (!info) return -1;
    try {
        const p = typeof info === 'string' ? JSON.parse(info) : info;
        return Number.isFinite(p?.seed) ? p.seed : -1;
    } catch { return -1; }
}

async function generateImage(positive, negative, s, nsfwLevel) {
    const override_settings = { CLIP_stop_at_last_layers: s.clip_skip };
    if (s.vae) override_settings.sd_vae = s.vae;
    const body = {
        prompt: QUALITY_PREFIX + positive,
        negative_prompt: finalNegative(negative, nsfwLevel),
        width: s.width,
        height: s.height,
        steps: s.steps,
        cfg_scale: s.cfg_scale,
        sampler_name: s.sampler,
        scheduler: s.scheduler,
        seed: -1,
        override_settings,
        save_images: true, // A1111 v1.10 API 默认 save_images=false，不传永不落盘
        url: s.sd_url,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000); // SD 超时 180s
    try {
        const r = await fetch('/api/sd/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            if (r.status >= 500) throw new Error('SD 未启动，请运行 启动API.bat');
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); if (j?.error?.message) msg = j.error.message; } catch { /* 保持 */ }
            throw new Error(msg);
        }
        const j = await r.json();
        const image = j?.images?.[0];
        if (!image) throw new Error('SD 未返回图片');
        return { image, seed: parseSeed(j?.info) };
    } finally { clearTimeout(timer); }
}

function addPromptDetails(messageId, positive, negative, usedRaw) {
    const $mes = $('#chat .mes').eq(messageId);
    if (!$mes.length) return;
    const $d = $('<details class="huashi_details"><summary>提示词</summary><div class="huashi_prompt_box"></div></details>');
    const $box = $d.find('.huashi_prompt_box');
    $box.append($('<div class="huashi_p"></div>').text('正向：' + (QUALITY_PREFIX + positive)));
    $box.append($('<div class="huashi_n"></div>').text('负向：' + negative));
    if (usedRaw) $box.append($('<div class="huashi_raw"></div>').text('（LLM 翻译失败，本次为原文降级出图）'));
    $mes.find('.mes_block').append($d);
}

// 持久化：直连 POST /api/chats/save，绕开 saveChatConditional 的静默失败分支
// （integrity 弹窗/异常吞掉/fileName 缺失 return）。force=false 保留完整性保护，
// 冲突时自动升级 force=true（等价于酒馆的 OVERWRITE 确认）。
async function persistChat(ctx, chatId) {
    if (this_chid !== undefined && characters[this_chid]) {
        characters[this_chid].date_last_chat = Date.now();
    }
    const header = { chat_metadata: chat_metadata || {}, user_name: 'unused', character_name: 'unused' };
    const payload = {
        ch_name: (this_chid !== undefined && characters[this_chid]) ? characters[this_chid].name : ctx.name2,
        file_name: chatId,
        chat: [header, ...ctx.chat],
        avatar_url: (this_chid !== undefined && characters[this_chid]) ? (characters[this_chid].avatar || '') : '',
        force: false,
    };
    let res;
    try {
        res = await fetch('/api/chats/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
            cache: 'no-cache',
        });
    } catch (e) {
        throw new Error('存档请求失败（网络或服务端异常）：' + (e && e.message ? e.message : e));
    }
    if (res.ok) {
        console.log(TAG, '聊天已存档：', chatId);
        return;
    }
    let errData = null;
    try { errData = await res.json(); } catch (e) { errData = null; }
    if (errData && errData.error === 'integrity') {
        console.warn(TAG, '聊天完整性检查冲突，自动强制保存本页内容');
        toastr.warning('检测到聊天文件被外部改动，已自动强制保存本页内容');
        payload.force = true;
        const res2 = await fetch('/api/chats/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
            cache: 'no-cache',
        });
        if (res2.ok) {
            console.log(TAG, '聊天已强制存档：', chatId);
            return;
        }
        throw new Error('强制存档失败：HTTP ' + res2.status);
    }
    throw new Error('存档失败：HTTP ' + res.status + (errData && errData.error ? '（' + errData.error + '）' : ''));
}

async function generateAndPost(mesId, chatId) {
    const s = ensureSettings();
    const ctx = getContext();
    const sourceMsg = ctx.chat[mesId];
    if (!sourceMsg) throw new Error('找不到被点的消息');

    // 1. 采集三层上下文
    const pack = collectContext(mesId, s);

    // 2. LLM 翻译；失败走 RAW_LAST 降级
    const nsfwLevel = getNsfwLevel();
    let positive, negative, usedRaw = false;
    try {
        const tags = await translateToTags(pack, s);
        positive = tags.positive;
        negative = tags.negative;
    } catch (err) {
        console.warn(TAG, 'LLM 翻译失败，走 RAW_LAST 降级', err);
        const raw = rawLastPrompt(sourceMsg);
        positive = raw.positive;
        negative = raw.negative;
        usedRaw = true;
        toastr.warning('LLM 翻译失败，已用原文直接出图');
    }

    // 3. SD 出图
    const { image, seed } = await generateImage(positive, negative, s, nsfwLevel);

    // 4. 保存图片
    const filePath = await saveBase64AsFile(image, ctx.name2, 'huashi_' + Date.now(), 'png');

    // 5. 一致性：聊天已切换则只存图不回贴
    if (getCurrentChatId() !== chatId) {
        toastr.info('图已生成，聊天已切换，未回贴');
        return;
    }

    // 6. 回贴（在被点消息之后插入新消息）
    const params = { width: s.width, height: s.height, steps: s.steps, cfg_scale: s.cfg_scale, sampler: s.sampler, scheduler: s.scheduler };
    const message = {
        name: ctx.name2,
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: '', // 绝不写标签串
        extra: {
            media: [{ url: filePath, type: 'image', title: positive }],
            media_display: 'gallery',
            media_index: 0,
            inline_image: false,
            huashi: { positive, negative, seed, params, source_mes_id: mesId, used_raw: usedRaw },
        },
    };
    ctx.chat.push(message);
    const messageId = ctx.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    ctx.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await persistChat(ctx, chatId);
    addPromptDetails(messageId, positive, negative, usedRaw);
}

/* ============ 设置面板 ============ */

async function testLlm() {
    const $btn = $('#huashi_test_llm');
    $btn.prop('disabled', true);
    try {
        await callLLM([{ role: 'user', content: 'hi' }], 1, ensureSettings());
        toastr.success('LLM 连接正常（本次约 ¥0.02）');
    } catch (err) {
        toastr.error('LLM 连接失败：' + (err?.message ?? err));
    } finally {
        $btn.prop('disabled', false);
    }
}

async function testSd() {
    const $btn = $('#huashi_test_sd');
    $btn.prop('disabled', true);
    try {
        const s = ensureSettings();
        const r = await fetch('/api/sd/ping', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ url: s.sd_url }) });
        if (r.ok) toastr.success('SD 连接正常');
        else toastr.error('SD 连接失败：HTTP ' + r.status + '（请运行 启动API.bat）');
    } catch (err) {
        toastr.error('SD 连接失败：' + (err?.message ?? err));
    } finally {
        $btn.prop('disabled', false);
    }
}

function bindSettings() {
    const s = ensureSettings();
    const textFields = { llm_url: '#huashi_llm_url', llm_model: '#huashi_llm_model', sd_url: '#huashi_sd_url', sampler: '#huashi_sampler', scheduler: '#huashi_scheduler', vae: '#huashi_vae' };
    const numFields = { temperature: '#huashi_temperature', llm_timeout: '#huashi_llm_timeout', width: '#huashi_width', height: '#huashi_height', steps: '#huashi_steps', cfg_scale: '#huashi_cfg_scale', clip_skip: '#huashi_clip_skip', chat_count: '#huashi_chat_count', token_budget: '#huashi_token_budget' };
    const checkFields = { layer_db: '#huashi_layer_db', layer_world: '#huashi_layer_world', layer_chat: '#huashi_layer_chat', nsfw_link: '#huashi_nsfw_link', jailbreak_inherit: '#huashi_jailbreak_inherit' };

    for (const [key, sel] of Object.entries(textFields)) {
        const $el = $(sel);
        if (!$el.length) continue;
        $el.val(s[key]);
        $el.off('input').on('input', function () { s[key] = String($el.val() ?? ''); saveSettingsDebounced(); });
    }
    for (const [key, sel] of Object.entries(numFields)) {
        const $el = $(sel);
        if (!$el.length) continue;
        $el.val(s[key]);
        $el.off('input').on('input', function () { const n = parseFloat($el.val()); if (Number.isFinite(n)) s[key] = n; saveSettingsDebounced(); });
    }
    for (const [key, sel] of Object.entries(checkFields)) {
        const $el = $(sel);
        if (!$el.length) continue;
        $el.prop('checked', !!s[key]);
        $el.off('input').on('input', function () { s[key] = $el.prop('checked'); saveSettingsDebounced(); });
    }
    $('#huashi_test_llm').off('click').on('click', testLlm);
    $('#huashi_test_sd').off('click').on('click', testSd);
}

/* ============ 设置面板挂载（1.19 不再自动加载 settings.html） ============ */

let settingsMounted = false;

async function mountSettingsPanel() {
    if (settingsMounted) return true;
    if (!$('#extensions_settings').length) return false;
    try {
        const r = await fetch('/scripts/extensions/third-party/画师/settings.html', { cache: 'no-store' });
        if (!r.ok) return false;
        const html = await r.text();
        if (!$('#extensions_settings .huashi_settings').length) {
            $('#extensions_settings').append(html);
        }
        settingsMounted = true;
        bindSettings();
        console.log(TAG, '设置面板已挂载');
        return true;
    } catch (e) {
        console.warn(TAG, '设置面板挂载失败', e);
        return false;
    }
}

function initNow() {
    ensureSettings();
    bindChatEvents();
    injectButtons();
    mountSettingsPanel().then((ok) => {
        if (!ok) setTimeout(() => mountSettingsPanel(), 3000);
    });
    console.log(TAG, '插件已加载 v1.0.1');
}

let initDone = false;

export function init() {
    if (initDone) return;
    initDone = true;
    if (document.readyState === 'loading') {
        jQuery(initNow);
    } else {
        initNow();
    }
}

jQuery(() => init());