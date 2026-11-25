import {
    getGlobalSettings,
    importFromBaibai,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetData,
} from './storage.js';
import {
    batchSetPromptsEnabled,
    batchSetRegexEnabled,
    estimateTokensCached,
    getPromptItems,
    getRegexItems,
    movePromptInOrder,
    setPromptEnabled,
} from './st-bridge.js';

const state = {
    isOpen: false,
    activeTab: 'prompts', // 'prompts' | 'regex'
    filter: 'all',        // 'all' | 'enabled' | 'starred'
    query: '',
    batchMode: false,
    selectedIds: new Set(),
    settingsOpen: false,
    ungroupedCollapsed: false,
    starredCollapsed: false,
    presetName: null,
    presetData: null,
    hasBaibaiData: false,
    promptItems: [],
    regexItems: [],
    tokenMap: new Map(),
    tokenComputeSeq: 0,
    noticeTimer: null,
    searchTimer: null,
    dialog: null, // { type: 'group' | 'note', mode?: 'create' | 'edit', groupId?: string, itemId?: string }
};

let rootEl = null;

/**
 * Escapes HTML special characters for safe template rendering.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Formats token count compactly (e.g. 1250 -> 1.3k).
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

/**
 * Returns the active group store for the current tab.
 * Note: for regex tab, we store preset/scoped regex groups in `presetData.regexGroups`
 * unless the user only has global regexes; unified per-preset + global fallback keeps UX simple.
 * @returns {Object}
 */
function getActiveStore() {
    if (state.activeTab === 'prompts') {
        return state.presetData.promptGroups;
    }
    return state.presetData.regexGroups;
}

/**
 * Returns the items list for the current tab.
 * @returns {Array}
 */
function getActiveItems() {
    return state.activeTab === 'prompts' ? state.promptItems : state.regexItems;
}

/**
 * Persists changes to the current preset (and global settings if needed).
 * @returns {Promise<void>}
 */
async function persistCurrent() {
    await savePresetData(state.presetData);
}

/**
 * Shows a brief non-blocking notice inside the modal header.
 * @param {string} text
 */
function showNotice(text) {
    if (!rootEl) return;
    const el = rootEl.querySelector('.bb-notice');
    if (!el) return;
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => {
        el.classList.remove('is-visible');
    }, 2400);
}

/**
 * Reloads live SillyTavern items and preset grouping data.
 */
export function refreshData() {
    const loaded = loadPresetData();
    state.presetData = loaded.data;
    state.presetName = loaded.presetName;
    state.hasBaibaiData = loaded.hasBaibaiData;
    state.promptItems = getPromptItems();
    state.regexItems = getRegexItems();

    if (loaded.migratedFromBaibai) {
        persistCurrent().then(() => {
            showNotice('已自动迁移柏宝箱预设分组');
        });
    }

    if (state.isOpen) {
        renderBody();
        scheduleTokenCalculation();
    }
}

/**
 * Opens the Bluebower modal on the specified tab.
 * @param {'prompts' | 'regex'} [tab]
 */
export function openBluebower(tab) {
    if (tab === 'prompts' || tab === 'regex') {
        state.activeTab = tab;
    }
    state.isOpen = true;
    state.batchMode = false;
    state.selectedIds.clear();
    ensureRoot();
    refreshData();
    renderAll();
    rootEl.classList.add('is-open');
    document.body.classList.add('bb-modal-open');
}

/**
 * Closes the Bluebower modal.
 */
export function closeBluebower() {
    state.isOpen = false;
    state.dialog = null;
    if (rootEl) {
        rootEl.classList.remove('is-open');
    }
    document.body.classList.remove('bb-modal-open');
}

/**
 * Lazily creates the root modal DOM once.
 */
function ensureRoot() {
    if (rootEl) return;
    rootEl = document.createElement('div');
    rootEl.id = 'bluebower_backdrop';
    rootEl.className = 'bb-backdrop';
    rootEl.innerHTML = `
        <div class="bb-modal" role="dialog" aria-modal="true" aria-label="园丁鸟分组管理器">
            <div class="bb-header">
                <div class="bb-title-wrap">
                    <span class="bb-logo" aria-hidden="true">🐦</span>
                    <span class="bb-title">园丁鸟</span>
                    <span class="bb-preset-badge" title="当前预设"></span>
                    <span class="bb-notice" role="status" aria-live="polite"></span>
                </div>
                <div class="bb-tabs" role="tablist">
                    <button type="button" class="bb-tab" data-tab="prompts" role="tab">预设条目</button>
                    <button type="button" class="bb-tab" data-tab="regex" role="tab">正则条目</button>
                </div>
                <button type="button" class="bb-icon-btn bb-close-btn" title="关闭" aria-label="关闭">✕</button>
            </div>

            <div class="bb-toolbar">
                <div class="bb-search-wrap">
                    <input type="search" class="bb-search text_pole" placeholder="搜索条目、分组或备注..." />
                </div>
                <div class="bb-filter-pills">
                    <button type="button" class="bb-pill" data-filter="all">全部</button>
                    <button type="button" class="bb-pill" data-filter="enabled">仅已启用</button>
                    <button type="button" class="bb-pill" data-filter="starred">★ 星标</button>
                </div>
                <div class="bb-actions">
                    <button type="button" class="bb-btn bb-new-group-btn" title="新建分组">+ 分组</button>
                    <button type="button" class="bb-btn bb-batch-btn" title="批量移动条目到分组">批量整理</button>
                    <button type="button" class="bb-btn bb-lock-btn" title="锁定/解锁预设条目顺序"></button>
                    <button type="button" class="bb-icon-btn bb-settings-btn" title="兼容与同步设置">⚙</button>
                </div>
            </div>

            <div class="bb-settings-bar"></div>
            <div class="bb-body"></div>
            <div class="bb-batch-bar"></div>
            <div class="bb-dialog-layer"></div>
        </div>
    `;

    bindRootEvents(rootEl);
    document.body.appendChild(rootEl);
}

/**
 * Binds delegated event listeners to the modal root.
 * @param {HTMLElement} root
 */
function bindRootEvents(root) {
    root.addEventListener('click', (e) => {
        if (e.target === root) {
            closeBluebower();
        }
    });

    root.querySelector('.bb-close-btn').addEventListener('click', closeBluebower);

    root.querySelectorAll('.bb-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab === state.activeTab) return;
            state.activeTab = tab;
            state.batchMode = false;
            state.selectedIds.clear();
            renderAll();
            if (tab === 'prompts') scheduleTokenCalculation();
        });
    });

    const searchInput = root.querySelector('.bb-search');
    searchInput.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            state.query = searchInput.value.trim().toLowerCase();
            renderBody();
        }, 110);
    });

    root.querySelectorAll('.bb-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            state.filter = pill.dataset.filter;
            renderToolbar();
            renderBody();
        });
    });

    root.querySelector('.bb-new-group-btn').addEventListener('click', () => {
        state.dialog = { type: 'group', mode: 'create' };
        renderDialog();
    });

    root.querySelector('.bb-batch-btn').addEventListener('click', () => {
        state.batchMode = !state.batchMode;
        if (!state.batchMode) state.selectedIds.clear();
        renderToolbar();
        renderBody();
        renderBatchBar();
    });

    root.querySelector('.bb-lock-btn').addEventListener('click', async () => {
        const locked = !state.presetData.settings.lockPromptOrder;
        state.presetData.settings.lockPromptOrder = locked;
        const gs = getGlobalSettings();
        gs.lockPromptOrder = locked;
        saveGlobalSettings();
        await persistCurrent();
        renderToolbar();
        renderBody();
        showNotice(locked ? '已锁定预设条目排序' : '已解锁排序，可上下微调顺序');
    });

    root.querySelector('.bb-settings-btn').addEventListener('click', () => {
        state.settingsOpen = !state.settingsOpen;
        renderSettingsBar();
    });

    // Delegated body events
    const body = root.querySelector('.bb-body');
    body.addEventListener('click', handleBodyClick);
    body.addEventListener('change', handleBodyChange);

    // Delegated settings bar events
    root.querySelector('.bb-settings-bar').addEventListener('click', handleSettingsClick);
    root.querySelector('.bb-settings-bar').addEventListener('change', handleSettingsChange);

    // Delegated batch bar events
    root.querySelector('.bb-batch-bar').addEventListener('click', handleBatchClick);

    // Delegated dialog events
    root.querySelector('.bb-dialog-layer').addEventListener('click', handleDialogClick);
    root.querySelector('.bb-dialog-layer').addEventListener('submit', handleDialogSubmit);

    document.addEventListener('keydown', (e) => {
        if (!state.isOpen) return;
        if (e.key === 'Escape') {
            if (state.dialog) {
                state.dialog = null;
                renderDialog();
            } else {
                closeBluebower();
            }
        }
    });
}

/**
 * Renders the full modal state.
 */
function renderAll() {
    if (!rootEl || !state.presetData) return;
    rootEl.querySelector('.bb-preset-badge').textContent = state.presetName || '未命名预设';
    rootEl.querySelectorAll('.bb-tab').forEach(btn => {
        const active = btn.dataset.tab === state.activeTab;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    renderToolbar();
    renderSettingsBar();
    renderBody();
    renderBatchBar();
    renderDialog();
}

function renderToolbar() {
    if (!rootEl || !state.presetData) return;
    rootEl.querySelectorAll('.bb-pill').forEach(p => {
        p.classList.toggle('is-active', p.dataset.filter === state.filter);
    });

    rootEl.querySelector('.bb-batch-btn').classList.toggle('is-active', state.batchMode);
    rootEl.querySelector('.bb-settings-btn').classList.toggle('is-active', state.settingsOpen);

    const lockBtn = rootEl.querySelector('.bb-lock-btn');
    if (state.activeTab === 'prompts') {
        lockBtn.style.display = '';
        const locked = Boolean(state.presetData.settings?.lockPromptOrder);
        lockBtn.classList.toggle('is-active', locked);
        lockBtn.textContent = locked ? '🔒 已锁序' : '🔓 可调序';
    } else {
        lockBtn.style.display = 'none';
    }
}

function renderSettingsBar() {
    if (!rootEl) return;
    const bar = rootEl.querySelector('.bb-settings-bar');
    if (!state.settingsOpen) {
        bar.classList.remove('is-open');
        bar.innerHTML = '';
        return;
    }

    const gs = getGlobalSettings();
    bar.classList.add('is-open');
    bar.innerHTML = `
        <label class="bb-setting-check" title="开启后，修改预设分组时会同步写回 baibaiToolkit.presetPromptGroups，方便在两个插件间切换">
            <input type="checkbox" class="bb-sync-baibai-chk" ${gs.syncBaibai ? 'checked' : ''} />
            <span>双向同步柏宝箱分组格式（兼容切换）</span>
        </label>
        <div class="bb-setting-actions">
            <button type="button" class="bb-btn bb-reimport-baibai-btn" ${state.hasBaibaiData ? '' : 'disabled title="当前预设未检测到柏宝箱分组数据"'}>
                从柏宝箱重新导入分组
            </button>
        </div>
    `;
}

/**
 * Checks whether an item matches current search query and filter pill.
 * @param {Object} item
 * @param {Object} meta
 * @param {string} groupName
 * @returns {boolean}
 */
function itemMatchesFilter(item, meta, groupName = '') {
    if (state.filter === 'enabled' && !item.enabled) return false;
    if (state.filter === 'starred' && !meta?.starred) return false;

    if (state.query) {
        const q = state.query;
        const hitName = item.name.toLowerCase().includes(q);
        const hitNote = (meta?.note || '').toLowerCase().includes(q);
        const hitGroup = groupName.toLowerCase().includes(q);
        if (!hitName && !hitNote && !hitGroup) return false;
    }
    return true;
}

/**
 * Renders the main grouped list body.
 */
function renderBody() {
    if (!rootEl || !state.presetData) return;
    const body = rootEl.querySelector('.bb-body');
    const store = getActiveStore();
    const items = getActiveItems();

    if (!items.length) {
        body.innerHTML = `<div class="bb-empty">当前没有可显示的${state.activeTab === 'prompts' ? '预设条目' : '正则脚本'}。</div>`;
        return;
    }

    const groupMap = new Map(store.groups.map(g => [g.id, g]));
    const itemsByGroup = new Map();
    for (const g of store.groups) itemsByGroup.set(g.id, []);
    const ungrouped = [];
    const starred = [];

    for (const item of items) {
        const meta = store.items[item.id] || { groupId: null, starred: false, note: '' };
        const group = meta.groupId && groupMap.has(meta.groupId) ? groupMap.get(meta.groupId) : null;

        if (!itemMatchesFilter(item, meta, group?.name || '')) continue;

        if (meta.starred) starred.push({ item, meta, group });
        if (group) {
            itemsByGroup.get(group.id).push({ item, meta });
        } else {
            ungrouped.push({ item, meta });
        }
    }

    const forceExpand = Boolean(state.query) || state.filter !== 'all';
    const chunks = [];

    // 1. Starred pinned section
    if (starred.length) {
        chunks.push(`
            <section class="bb-group bb-starred-group">
                <div class="bb-group-header" data-action="toggle-starred-collapse">
                    <span class="bb-chevron">${state.starredCollapsed && !forceExpand ? '▸' : '▾'}</span>
                    <span class="bb-group-name">★ 常用置顶</span>
                    <span class="bb-count-badge">${starred.length}</span>
                </div>
                ${state.starredCollapsed && !forceExpand ? '' : `
                    <div class="bb-group-items">
                        ${starred.map(({ item, meta }) => renderItemRow(item, meta, store.groups, { inStarred: true })).join('')}
                    </div>
                `}
            </section>
        `);
    }

    // 2. User-defined / migrated groups
    store.groups.forEach((group, idx) => {
        const entries = itemsByGroup.get(group.id) || [];
        // When filtering/searching, hide empty groups unless group name itself matches query
        if (forceExpand && !entries.length && (!state.query || !group.name.toLowerCase().includes(state.query))) {
            return;
        }

        const enabledCount = entries.filter(e => e.item.enabled).length;
        const isCollapsed = group.collapsed && !forceExpand;
        const tokenSum = state.activeTab === 'prompts' ? computeGroupTokenSum(entries) : 0;

        chunks.push(`
            <section class="bb-group ${group.enabled ? '' : 'is-group-disabled'}" data-group-id="${esc(group.id)}">
                <div class="bb-group-header" data-action="toggle-collapse" data-group-id="${esc(group.id)}">
                    <span class="bb-chevron">${isCollapsed ? '▸' : '▾'}</span>
                    <span class="bb-group-name">${esc(group.name)}</span>
                    ${group.exclusive ? '<span class="bb-tag bb-tag-exclusive" title="互斥单选组：开启一项会自动关闭同组其他项">互斥</span>' : ''}
                    <span class="bb-count-badge" title="已启用 / 总数">${enabledCount}/${entries.length}</span>
                    ${state.activeTab === 'prompts' && tokenSum > 0 ? `<span class="bb-token-badge" title="已启用条目估算 Token">~${formatTokens(tokenSum)} tok</span>` : ''}
                    <div class="bb-group-controls" data-stop-collapse="1">
                        <button type="button" class="bb-mini-btn" data-action="move-group-up" data-group-id="${esc(group.id)}" ${idx === 0 ? 'disabled' : ''} title="上移分组">↑</button>
                        <button type="button" class="bb-mini-btn" data-action="move-group-down" data-group-id="${esc(group.id)}" ${idx === store.groups.length - 1 ? 'disabled' : ''} title="下移分组">↓</button>
                        <button type="button" class="bb-mini-btn" data-action="edit-group" data-group-id="${esc(group.id)}" title="编辑分组 / 互斥 / 备注">✎</button>
                        <button type="button" class="bb-mini-btn bb-danger-btn" data-action="delete-group" data-group-id="${esc(group.id)}" title="删除分组（条目会保留在未分组）">✕</button>
                        <label class="bb-switch-wrap" title="分组总开关">
                            <input type="checkbox" class="bb-switch bb-group-toggle" data-group-id="${esc(group.id)}" ${enabledCount > 0 ? 'checked' : ''} />
                            <span class="bb-switch-slider"></span>
                        </label>
                    </div>
                </div>
                ${group.note ? `<div class="bb-group-note">${esc(group.note)}</div>` : ''}
                ${isCollapsed ? '' : `
                    <div class="bb-group-items">
                        ${entries.length
                            ? entries.map(({ item, meta }) => renderItemRow(item, meta, store.groups)).join('')
                            : '<div class="bb-group-empty">暂无条目，可通过“批量整理”或条目右侧下拉框移入</div>'
                        }
                    </div>
                `}
            </section>
        `);
    });

    // 3. Ungrouped section
    if (ungrouped.length) {
        const enabledCount = ungrouped.filter(e => e.item.enabled).length;
        const isCollapsed = state.ungroupedCollapsed && !forceExpand;
        chunks.push(`
            <section class="bb-group bb-ungrouped">
                <div class="bb-group-header" data-action="toggle-ungrouped-collapse">
                    <span class="bb-chevron">${isCollapsed ? '▸' : '▾'}</span>
                    <span class="bb-group-name">未分组</span>
                    <span class="bb-count-badge">${enabledCount}/${ungrouped.length}</span>
                </div>
                ${isCollapsed ? '' : `
                    <div class="bb-group-items">
                        ${ungrouped.map(({ item, meta }) => renderItemRow(item, meta, store.groups)).join('')}
                    </div>
                `}
            </section>
        `);
    }

    if (!chunks.length) {
        body.innerHTML = '<div class="bb-empty">没有符合当前筛选条件的条目。</div>';
        return;
    }

    body.innerHTML = chunks.join('');
}

/**
 * Renders a single prompt or regex row.
 */
function renderItemRow(item, meta, groups, { inStarred = false } = {}) {
    const canReorder = state.activeTab === 'prompts' && !state.presetData.settings?.lockPromptOrder && !inStarred && !state.query && state.filter === 'all';
    const isSelected = state.selectedIds.has(item.id);
    const tokens = state.activeTab === 'prompts' ? state.tokenMap.get(item.id) : null;

    let badges = '';
    if (state.activeTab === 'prompts') {
        const roleLabel = item.marker ? '标记' : item.role;
        badges += `<span class="bb-tag">${esc(roleLabel)}</span>`;
        if (typeof tokens === 'number' && tokens > 0) {
            badges += `<span class="bb-token-mini">${formatTokens(tokens)}</span>`;
        }
    } else {
        badges += `<span class="bb-tag">${esc(item.originLabel)}</span>`;
        badges += `<span class="bb-tag bb-tag-scope-${esc(item.scopeInfo.key)}">${esc(item.scopeInfo.label)}</span>`;
    }

    const groupOptions = [
        `<option value="" ${!meta?.groupId ? 'selected' : ''}>未分组</option>`,
        ...groups.map(g => `<option value="${esc(g.id)}" ${meta?.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`),
    ].join('');

    return `
        <div class="bb-item ${item.enabled ? '' : 'is-disabled'}" data-item-id="${esc(item.id)}">
            ${state.batchMode && !inStarred ? `
                <input type="checkbox" class="bb-batch-chk" data-item-id="${esc(item.id)}" ${isSelected ? 'checked' : ''} />
            ` : ''}
            <button type="button" class="bb-star-btn ${meta?.starred ? 'is-starred' : ''}" data-action="toggle-star" data-item-id="${esc(item.id)}" title="星标置顶">
                ${meta?.starred ? '★' : '☆'}
            </button>
            <div class="bb-item-main">
                <div class="bb-item-title-row">
                    <span class="bb-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
                    <span class="bb-item-badges">${badges}</span>
                </div>
                ${meta?.note ? `<div class="bb-item-note">${esc(meta.note)}</div>` : ''}
            </div>
            <div class="bb-item-controls">
                ${canReorder ? `
                    <button type="button" class="bb-mini-btn" data-action="move-item-up" data-item-id="${esc(item.id)}" title="上移顺序">↑</button>
                    <button type="button" class="bb-mini-btn" data-action="move-item-down" data-item-id="${esc(item.id)}" title="下移顺序">↓</button>
                ` : ''}
                <button type="button" class="bb-mini-btn" data-action="edit-note" data-item-id="${esc(item.id)}" title="添加/编辑备注">✎</button>
                ${!inStarred && !state.batchMode ? `
                    <select class="bb-move-select" data-item-id="${esc(item.id)}" title="移动到分组">
                        ${groupOptions}
                    </select>
                ` : ''}
                <label class="bb-switch-wrap">
                    <input type="checkbox" class="bb-switch bb-item-toggle" data-item-id="${esc(item.id)}" ${item.enabled ? 'checked' : ''} />
                    <span class="bb-switch-slider"></span>
                </label>
            </div>
        </div>
    `;
}

function renderBatchBar() {
    if (!rootEl) return;
    const bar = rootEl.querySelector('.bb-batch-bar');
    if (!state.batchMode) {
        bar.classList.remove('is-open');
        bar.innerHTML = '';
        return;
    }

    const groups = getActiveStore().groups;
    const options = [
        '<option value="">移入：未分组</option>',
        ...groups.map(g => `<option value="${esc(g.id)}">移入：${esc(g.name)}</option>`),
    ].join('');

    bar.classList.add('is-open');
    bar.innerHTML = `
        <span class="bb-batch-count">已选 <strong>${state.selectedIds.size}</strong> 项</span>
        <select class="bb-batch-target text_pole">${options}</select>
        <button type="button" class="bb-btn bb-btn-primary" data-batch-action="apply" ${state.selectedIds.size ? '' : 'disabled'}>确认移动</button>
        <button type="button" class="bb-btn" data-batch-action="select-all">全选当前</button>
        <button type="button" class="bb-btn" data-batch-action="clear">清空</button>
    `;
}

function renderDialog() {
    if (!rootEl) return;
    const layer = rootEl.querySelector('.bb-dialog-layer');
    if (!state.dialog) {
        layer.classList.remove('is-open');
        layer.innerHTML = '';
        return;
    }

    const store = getActiveStore();
    layer.classList.add('is-open');

    if (state.dialog.type === 'group') {
        const isEdit = state.dialog.mode === 'edit';
        const group = isEdit ? store.groups.find(g => g.id === state.dialog.groupId) : null;
        layer.innerHTML = `
            <form class="bb-dialog-card">
                <div class="bb-dialog-title">${isEdit ? '编辑分组' : '新建分组'}</div>
                <label class="bb-field">
                    <span>分组名称</span>
                    <input type="text" name="name" class="text_pole" required maxlength="40" value="${esc(group?.name || '')}" placeholder="例如：思维链 / 文风 / 状态栏" autofocus />
                </label>
                <label class="bb-field">
                    <span>个人备注（可选）</span>
                    <input type="text" name="note" class="text_pole" maxlength="100" value="${esc(group?.note || '')}" placeholder="例如：默认必开，别和 XX 一起开" />
                </label>
                <label class="bb-field-check">
                    <input type="checkbox" name="exclusive" ${group?.exclusive ? 'checked' : ''} />
                    <span>设为互斥单选组（开启组内一项时自动关闭同组其他项）</span>
                </label>
                <div class="bb-dialog-footer">
                    <button type="button" class="bb-btn" data-dialog-cancel>取消</button>
                    <button type="submit" class="bb-btn bb-btn-primary">保存</button>
                </div>
            </form>
        `;
    } else if (state.dialog.type === 'note') {
        const item = getActiveItems().find(i => i.id === state.dialog.itemId);
        const meta = store.items[state.dialog.itemId] || {};
        layer.innerHTML = `
            <form class="bb-dialog-card">
                <div class="bb-dialog-title">条目备注 · ${esc(item?.name || state.dialog.itemId)}</div>
                <label class="bb-field">
                    <span>备注内容（留空则清除）</span>
                    <input type="text" name="note" class="text_pole" maxlength="120" value="${esc(meta.note || '')}" placeholder="写点方便自己识别的说明..." autofocus />
                </label>
                <div class="bb-dialog-footer">
                    <button type="button" class="bb-btn" data-dialog-cancel>取消</button>
                    <button type="submit" class="bb-btn bb-btn-primary">保存</button>
                </div>
            </form>
        `;
    }

    const firstInput = layer.querySelector('input[type="text"]');
    if (firstInput) setTimeout(() => firstInput.focus(), 20);
}

/**
 * Computes cached token sum for enabled prompt entries in a group.
 */
function computeGroupTokenSum(entries) {
    let sum = 0;
    for (const { item } of entries) {
        if (!item.enabled) continue;
        const t = state.tokenMap.get(item.id);
        if (typeof t === 'number') sum += t;
    }
    return sum;
}

/**
 * Lazily calculates prompt token counts in small async chunks without blocking UI.
 */
async function scheduleTokenCalculation() {
    if (state.activeTab !== 'prompts' || !state.isOpen) return;
    const seq = ++state.tokenComputeSeq;
    const missing = state.promptItems.filter(p => p.content && !state.tokenMap.has(p.id));
    if (!missing.length) return;

    for (let i = 0; i < missing.length; i += 8) {
        if (seq !== state.tokenComputeSeq || !state.isOpen) return;
        const batch = missing.slice(i, i + 8);
        await Promise.all(batch.map(async (p) => {
            const count = await estimateTokensCached(p.content);
            state.tokenMap.set(p.id, count);
        }));
        // Yield to UI frame
        await new Promise(r => setTimeout(r, 16));
    }

    if (seq === state.tokenComputeSeq && state.isOpen && state.activeTab === 'prompts') {
        renderBody();
    }
}

async function handleBodyClick(e) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    // Prevent group header collapse when clicking action buttons inside controls
    if (e.target.closest('[data-stop-collapse]') && actionEl.dataset.action === 'toggle-collapse') {
        return;
    }

    const action = actionEl.dataset.action;
    const store = getActiveStore();

    if (action === 'toggle-starred-collapse') {
        state.starredCollapsed = !state.starredCollapsed;
        renderBody();
        return;
    }

    if (action === 'toggle-ungrouped-collapse') {
        state.ungroupedCollapsed = !state.ungroupedCollapsed;
        renderBody();
        return;
    }

    if (action === 'toggle-collapse') {
        const g = store.groups.find(x => x.id === actionEl.dataset.groupId);
        if (!g) return;
        g.collapsed = !g.collapsed;
        renderBody();
        await persistCurrent();
        return;
    }

    if (action === 'move-group-up' || action === 'move-group-down') {
        const idx = store.groups.findIndex(x => x.id === actionEl.dataset.groupId);
        if (idx === -1) return;
        const target = action === 'move-group-up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= store.groups.length) return;
        const [moved] = store.groups.splice(idx, 1);
        store.groups.splice(target, 0, moved);
        store.groups.forEach((g, i) => { g.order = i; });
        renderBody();
        await persistCurrent();
        return;
    }

    if (action === 'edit-group') {
        state.dialog = { type: 'group', mode: 'edit', groupId: actionEl.dataset.groupId };
        renderDialog();
        return;
    }

    if (action === 'delete-group') {
        const gid = actionEl.dataset.groupId;
        store.groups = store.groups.filter(g => g.id !== gid);
        store.groups.forEach((g, i) => { g.order = i; });
        for (const meta of Object.values(store.items)) {
            if (meta.groupId === gid) meta.groupId = null;
        }
        renderBody();
        renderBatchBar();
        await persistCurrent();
        showNotice('已删除分组，条目已移至未分组');
        return;
    }

    if (action === 'toggle-star') {
        const id = actionEl.dataset.itemId;
        if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
        store.items[id].starred = !store.items[id].starred;
        renderBody();
        await persistCurrent();
        return;
    }

    if (action === 'edit-note') {
        state.dialog = { type: 'note', itemId: actionEl.dataset.itemId };
        renderDialog();
        return;
    }

    if (action === 'move-item-up' || action === 'move-item-down') {
        const dir = action === 'move-item-up' ? -1 : 1;
        if (movePromptInOrder(actionEl.dataset.itemId, dir)) {
            state.promptItems = getPromptItems();
            renderBody();
        }
    }
}

async function handleBodyChange(e) {
    const target = e.target;
    const store = getActiveStore();

    if (target.classList.contains('bb-batch-chk')) {
        const id = target.dataset.itemId;
        if (target.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        renderBatchBar();
        return;
    }

    if (target.classList.contains('bb-move-select')) {
        const id = target.dataset.itemId;
        const newGroupId = target.value || null;
        if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
        store.items[id].groupId = newGroupId;
        renderBody();
        await persistCurrent();
        return;
    }

    if (target.classList.contains('bb-item-toggle')) {
        const id = target.dataset.itemId;
        const nextEnabled = Boolean(target.checked);
        const meta = store.items[id];
        const group = meta?.groupId ? store.groups.find(g => g.id === meta.groupId) : null;

        await applyItemToggle(id, nextEnabled, group);
        return;
    }

    if (target.classList.contains('bb-group-toggle')) {
        const gid = target.dataset.groupId;
        const nextEnabled = Boolean(target.checked);
        const group = store.groups.find(g => g.id === gid);
        if (!group) return;

        group.enabled = nextEnabled;
        const members = getActiveItems().filter(item => store.items[item.id]?.groupId === gid);
        let targets = members;

        if (nextEnabled && group.exclusive && members.length > 1) {
            const alreadyOn = members.find(m => m.enabled);
            const keep = alreadyOn || members[0];
            targets = members.map(m => ({ ...m, _targetEnabled: m.id === keep.id }));
        } else {
            targets = members.map(m => ({ ...m, _targetEnabled: nextEnabled }));
        }

        if (state.activeTab === 'prompts') {
            batchSetPromptsEnabled(targets.map(t => ({ id: t.id, enabled: t._targetEnabled })));
            state.promptItems = getPromptItems();
        } else {
            await batchSetRegexEnabled(targets.map(t => ({ id: t.id, origin: t.origin, enabled: t._targetEnabled })));
            state.regexItems = getRegexItems();
        }

        renderBody();
        await persistCurrent();
    }
}

/**
 * Toggles a single item, enforcing exclusive-group mutual exclusion when enabled.
 */
async function applyItemToggle(itemId, nextEnabled, group) {
    const store = getActiveStore();
    const items = getActiveItems();

    if (nextEnabled && group?.exclusive) {
        const siblings = items.filter(it => store.items[it.id]?.groupId === group.id);
        if (state.activeTab === 'prompts') {
            batchSetPromptsEnabled(siblings.map(s => ({ id: s.id, enabled: s.id === itemId })));
            state.promptItems = getPromptItems();
        } else {
            await batchSetRegexEnabled(siblings.map(s => ({ id: s.id, origin: s.origin, enabled: s.id === itemId })));
            state.regexItems = getRegexItems();
        }
        group.enabled = true;
        renderBody();
        await persistCurrent();
        return;
    }

    if (state.activeTab === 'prompts') {
        setPromptEnabled(itemId, nextEnabled);
        state.promptItems = getPromptItems();
    } else {
        const targetItem = items.find(i => i.id === itemId);
        if (targetItem) {
            await batchSetRegexEnabled([{ id: targetItem.id, origin: targetItem.origin, enabled: nextEnabled }]);
            state.regexItems = getRegexItems();
        }
    }

    if (group) {
        const anyOn = getActiveItems().some(it => store.items[it.id]?.groupId === group.id && it.enabled);
        group.enabled = anyOn;
        await persistCurrent();
    }
    renderBody();
}

function handleSettingsChange(e) {
    if (e.target.classList.contains('bb-sync-baibai-chk')) {
        const gs = getGlobalSettings();
        gs.syncBaibai = Boolean(e.target.checked);
        saveGlobalSettings();
        showNotice(gs.syncBaibai ? '已开启柏宝箱双向同步' : '已关闭柏宝箱同步，仅写入 Bluebower');
    }
}

async function handleSettingsClick(e) {
    if (e.target.closest('.bb-reimport-baibai-btn')) {
        const res = importFromBaibai(state.presetData);
        if (res.imported) {
            state.presetData = res.data;
            await persistCurrent();
            renderBody();
            showNotice('已从柏宝箱重新导入分组（保留现有星标与备注）');
        } else {
            showNotice('当前预设未找到柏宝箱分组数据');
        }
    }
}

async function handleBatchClick(e) {
    const btn = e.target.closest('[data-batch-action]');
    if (!btn) return;

    const action = btn.dataset.batchAction;
    const store = getActiveStore();

    if (action === 'clear') {
        state.selectedIds.clear();
        renderBody();
        renderBatchBar();
        return;
    }

    if (action === 'select-all') {
        const items = getActiveItems();
        const groupMap = new Map(store.groups.map(g => [g.id, g]));
        for (const item of items) {
            const meta = store.items[item.id];
            const group = meta?.groupId ? groupMap.get(meta.groupId) : null;
            if (itemMatchesFilter(item, meta, group?.name || '')) {
                state.selectedIds.add(item.id);
            }
        }
        renderBody();
        renderBatchBar();
        return;
    }

    if (action === 'apply') {
        const targetGroupId = rootEl.querySelector('.bb-batch-target')?.value || null;
        for (const id of state.selectedIds) {
            if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
            store.items[id].groupId = targetGroupId;
        }
        state.selectedIds.clear();
        state.batchMode = false;
        renderToolbar();
        renderBody();
        renderBatchBar();
        await persistCurrent();
        showNotice('批量移动完成');
    }
}

function handleDialogClick(e) {
    if (e.target.closest('[data-dialog-cancel]') || e.target === rootEl.querySelector('.bb-dialog-layer')) {
        state.dialog = null;
        renderDialog();
    }
}

async function handleDialogSubmit(e) {
    e.preventDefault();
    if (!state.dialog) return;
    const form = e.target;
    const fd = new FormData(form);
    const store = getActiveStore();

    if (state.dialog.type === 'group') {
        const name = String(fd.get('name') || '').trim();
        if (!name) return;
        const note = String(fd.get('note') || '').trim();
        const exclusive = Boolean(fd.get('exclusive'));

        if (state.dialog.mode === 'create') {
            store.groups.push({
                id: makeId(),
                name,
                order: store.groups.length,
                collapsed: false,
                enabled: true,
                exclusive,
                note,
            });
        } else {
            const group = store.groups.find(g => g.id === state.dialog.groupId);
            if (group) {
                group.name = name;
                group.note = note;
                group.exclusive = exclusive;
            }
        }
        normalizeGroupStore(store);
    } else if (state.dialog.type === 'note') {
        const id = state.dialog.itemId;
        const note = String(fd.get('note') || '').trim();
        if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
        store.items[id].note = note;
    }

    state.dialog = null;
    renderDialog();
    renderBody();
    renderBatchBar();
    await persistCurrent();
}
