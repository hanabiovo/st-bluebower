import { openGroupDialog, openItemDialog } from './dialog.js';
import {
    getGlobalSettings,
    importFromBaibai,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetData,
} from './storage.js';
import { batchSetPromptsEnabled } from './st-bridge.js';

const pState = {
    initialized: false,
    containerObserver: null,
    listObserver: null,
    boundContainerEl: null,
    boundListEl: null,
    toolbarEl: null,
    rafId: null,
    filter: 'all', // 'all' | 'enabled' | 'starred'
    query: '',
    batchMode: false,
    selectedIds: new Set(),
    settingsOpen: false,
    starredCollapsed: false,
    ungroupedCollapsed: false,
    presetData: null,
    hasBaibaiData: false,
    searchTimer: null,
    noticeTimer: null,
};

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTokens(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

function showNotice(text) {
    const el = pState.toolbarEl?.querySelector('.bb-inline-notice');
    if (!el) return;
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(pState.noticeTimer);
    pState.noticeTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
}

function loadCurrentPresetState() {
    const loaded = loadPresetData();
    pState.presetData = loaded.data;
    pState.hasBaibaiData = loaded.hasBaibaiData;
    if (loaded.migratedFromBaibai) {
        savePresetData(pState.presetData).then(() => {
            showNotice('已自动迁移柏宝箱分组');
        });
    }
}

/**
 * Ensures the cached Bluebower toolbar is mounted right before `#completion_prompt_manager_list`
 * inside `.range-block` (below the native header/footer controls).
 * @param {HTMLElement} listEl `#completion_prompt_manager_list`
 */
function ensurePromptToolbar(listEl) {
    if (!pState.toolbarEl) {
        const toolbar = document.createElement('div');
        toolbar.id = 'bb_prompt_toolbar';
        toolbar.className = 'bb-native-toolbar';
        toolbar.innerHTML = `
            <div class="bb-toolbar-row">
                <span class="bb-brand-badge" title="园丁鸟 (Bluebower)"><i class="fa-solid fa-dove"></i></span>
                <input type="search" class="bb-search text_pole" placeholder="搜索预设条目、分组或备注..." />
                <div class="bb-pill-group">
                    <button type="button" class="bb-pill is-active" data-filter="all">全部</button>
                    <button type="button" class="bb-pill" data-filter="enabled">已启用</button>
                    <button type="button" class="bb-pill" data-filter="starred" title="仅看星标"><i class="fa-solid fa-star"></i></button>
                </div>
            </div>
            <div class="bb-toolbar-row bb-toolbar-actions">
                <button type="button" class="menu_button bb-btn-sm bb-new-group-btn" title="新建分组"><i class="fa-solid fa-plus"></i><span>分组</span></button>
                <button type="button" class="menu_button bb-btn-sm bb-batch-btn" title="批量移动条目到分组"><i class="fa-solid fa-list-check"></i><span>批量整理</span></button>
                <button type="button" class="menu_button bb-btn-sm bb-lock-btn" title="切换分组折叠视图 / 原始发送顺序拖拽"><i class="fa-solid fa-lock"></i><span>分组锁序</span></button>
                <button type="button" class="menu_button bb-btn-sm bb-settings-btn" title="柏宝箱兼容设置"><i class="fa-solid fa-gear"></i></button>
            </div>
            <div class="bb-inline-notice"></div>
            <div class="bb-settings-drawer" id="bb_prompt_settings"></div>
            <div class="bb-batch-drawer" id="bb_prompt_batch"></div>
            <div class="bb-starred-mirror" id="bb_prompt_starred"></div>
        `;
        bindToolbarEvents(toolbar);
        pState.toolbarEl = toolbar;
    }

    if (pState.toolbarEl.nextElementSibling !== listEl) {
        listEl.parentNode.insertBefore(pState.toolbarEl, listEl);
    }
}

function bindToolbarEvents(toolbar) {
    const getListEl = () => document.getElementById('completion_prompt_manager_list');

    const searchInput = toolbar.querySelector('.bb-search');
    searchInput.addEventListener('input', () => {
        clearTimeout(pState.searchTimer);
        pState.searchTimer = setTimeout(() => {
            pState.query = searchInput.value.trim().toLowerCase();
            scheduleEnhancePromptList();
        }, 100);
    });

    toolbar.querySelectorAll('.bb-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            pState.filter = pill.dataset.filter;
            toolbar.querySelectorAll('.bb-pill').forEach(p => p.classList.toggle('is-active', p === pill));
            scheduleEnhancePromptList();
        });
    });

    toolbar.querySelector('.bb-new-group-btn').addEventListener('click', async () => {
        const res = await openGroupDialog({ mode: 'create' });
        if (!res) return;
        const store = pState.presetData.promptGroups;
        store.groups.push({
            id: makeId(),
            name: res.name,
            order: store.groups.length,
            collapsed: false,
            enabled: true,
            exclusive: res.exclusive,
            note: res.note,
        });
        normalizeGroupStore(store);
        await savePresetData(pState.presetData);
        scheduleEnhancePromptList();
    });

    toolbar.querySelector('.bb-batch-btn').addEventListener('click', () => {
        pState.batchMode = !pState.batchMode;
        if (!pState.batchMode) pState.selectedIds.clear();
        toolbar.querySelector('.bb-batch-btn').classList.toggle('is-active', pState.batchMode);
        scheduleEnhancePromptList();
    });

    toolbar.querySelector('.bb-lock-btn').addEventListener('click', async () => {
        const locked = !pState.presetData.settings.lockPromptOrder;
        pState.presetData.settings.lockPromptOrder = locked;
        const gs = getGlobalSettings();
        gs.lockPromptOrder = locked;
        saveGlobalSettings();
        await savePresetData(pState.presetData);
        scheduleEnhancePromptList();
        showNotice(locked ? '已恢复分组折叠并锁定顺序' : '已切换为原始发送顺序，可安全拖拽调序');
    });

    toolbar.querySelector('.bb-settings-btn').addEventListener('click', () => {
        pState.settingsOpen = !pState.settingsOpen;
        toolbar.querySelector('.bb-settings-btn').classList.toggle('is-active', pState.settingsOpen);
        renderSettingsDrawer();
    });

    toolbar.querySelector('#bb_prompt_settings').addEventListener('change', (e) => {
        if (e.target.classList.contains('bb-sync-baibai-chk')) {
            const gs = getGlobalSettings();
            gs.syncBaibai = Boolean(e.target.checked);
            saveGlobalSettings();
            showNotice(gs.syncBaibai ? '已开启柏宝箱双向同步' : '已关闭柏宝箱同步');
        }
    });

    toolbar.querySelector('#bb_prompt_settings').addEventListener('click', async (e) => {
        if (e.target.closest('.bb-reimport-baibai-btn')) {
            const res = importFromBaibai(pState.presetData);
            if (res.imported) {
                pState.presetData = res.data;
                await savePresetData(pState.presetData);
                scheduleEnhancePromptList();
                showNotice('已从柏宝箱重新导入分组');
            } else {
                showNotice('当前预设未检测到柏宝箱分组');
            }
        }
    });

    toolbar.querySelector('#bb_prompt_batch').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-batch-action]');
        if (!btn) return;
        const action = btn.dataset.batchAction;
        if (action === 'clear') {
            pState.selectedIds.clear();
            scheduleEnhancePromptList();
        } else if (action === 'select-all') {
            getListEl()?.querySelectorAll('.completion_prompt_manager_prompt:not(.bb-collapsed-hidden):not(.bb-filter-hidden)').forEach(li => {
                if (li.dataset.pmIdentifier) pState.selectedIds.add(li.dataset.pmIdentifier);
            });
            scheduleEnhancePromptList();
        } else if (action === 'apply') {
            const targetGid = toolbar.querySelector('.bb-batch-target')?.value || null;
            const store = pState.presetData.promptGroups;
            for (const id of pState.selectedIds) {
                if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
                store.items[id].groupId = targetGid;
            }
            pState.selectedIds.clear();
            pState.batchMode = false;
            toolbar.querySelector('.bb-batch-btn').classList.remove('is-active');
            await savePresetData(pState.presetData);
            scheduleEnhancePromptList();
            showNotice('批量移动完成');
        }
    });

    toolbar.querySelector('#bb_prompt_starred').addEventListener('click', (e) => {
        if (e.target.closest('.bb-starred-header')) {
            pState.starredCollapsed = !pState.starredCollapsed;
            scheduleEnhancePromptList();
            return;
        }
        const starBtn = e.target.closest('.bb-star-mirror-unstar');
        if (starBtn) {
            const id = starBtn.dataset.id;
            const store = pState.presetData.promptGroups;
            if (store.items[id]) store.items[id].starred = false;
            savePresetData(pState.presetData);
            scheduleEnhancePromptList();
            return;
        }
        const toggleBtn = e.target.closest('.bb-mirror-toggle');
        if (toggleBtn) {
            const id = toggleBtn.dataset.id;
            const realLi = getListEl()?.querySelector(`.completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(id)}"]`);
            const nativeToggle = realLi?.querySelector('.prompt-manager-toggle-action');
            if (nativeToggle) {
                nativeToggle.click();
            }
        }
    });
}

function updateLockButtonUI(toolbar, locked) {
    const btn = toolbar?.querySelector('.bb-lock-btn');
    if (!btn) return;
    btn.classList.toggle('is-active', locked);
    btn.innerHTML = locked
        ? '<i class="fa-solid fa-lock"></i><span>分组锁序</span>'
        : '<i class="fa-solid fa-lock-open"></i><span>原序调序</span>';
}

function applyLockOrderState(listEl, locked) {
    listEl.classList.toggle('bb-order-locked', locked);
    const $ = window.jQuery;
    if ($ && typeof $(listEl).sortable === 'function') {
        try {
            if ($(listEl).data('ui-sortable')) {
                $(listEl).sortable(locked ? 'disable' : 'enable');
            }
        } catch {
            // Ignore if sortable is not initialized yet
        }
    }
}

function renderSettingsDrawer() {
    const el = pState.toolbarEl?.querySelector('#bb_prompt_settings');
    if (!el) return;
    if (!pState.settingsOpen) {
        el.innerHTML = '';
        el.classList.remove('is-open');
        return;
    }
    const gs = getGlobalSettings();
    el.classList.add('is-open');
    el.innerHTML = `
        <label class="bb-setting-check" title="开启后，修改分组会同步写回 baibaiToolkit.presetPromptGroups">
            <input type="checkbox" class="bb-sync-baibai-chk" ${gs.syncBaibai ? 'checked' : ''} />
            <span>双向同步柏宝箱格式</span>
        </label>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-reimport-baibai-btn" ${pState.hasBaibaiData ? '' : 'disabled'}>
            从柏宝箱重导分组
        </button>
    `;
}

function renderBatchDrawer() {
    const el = pState.toolbarEl?.querySelector('#bb_prompt_batch');
    if (!el) return;
    if (!pState.batchMode) {
        el.innerHTML = '';
        el.classList.remove('is-open');
        return;
    }
    const groups = pState.presetData.promptGroups.groups;
    const options = [
        '<option value="">移入：未分组</option>',
        ...groups.map(g => `<option value="${esc(g.id)}">移入：${esc(g.name)}</option>`),
    ].join('');
    el.classList.add('is-open');
    el.innerHTML = `
        <span class="bb-batch-count">已选 <strong>${pState.selectedIds.size}</strong> 项</span>
        <select class="bb-batch-target text_pole">${options}</select>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-btn-primary" data-batch-action="apply" ${pState.selectedIds.size ? '' : 'disabled'}>确认移动</button>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="select-all">全选</button>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="clear">清空</button>
    `;
}

/**
 * Reads clean prompt name from `data-pm-name` so inline note tags never pollute it.
 * @param {HTMLElement} li
 * @param {string} fallbackId
 * @returns {string}
 */
function getCleanPromptName(li, fallbackId) {
    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (nameEl?.dataset?.pmName) {
        return nameEl.dataset.pmName.trim();
    }
    const inspectLink = nameEl?.querySelector('.prompt-manager-inspect-action');
    if (inspectLink?.textContent) {
        return inspectLink.textContent.trim();
    }
    return fallbackId;
}

/**
 *Schedules a single RAF-batched enhancement pass on `#completion_prompt_manager_list`.
 */
export function scheduleEnhancePromptList() {
    if (pState.rafId) cancelAnimationFrame(pState.rafId);
    pState.rafId = requestAnimationFrame(() => {
        pState.rafId = null;
        enhancePromptList();
    });
}

function enhancePromptList() {
    const container = document.getElementById('completion_prompt_manager');
    if (!container) return;
    bindContainerIfNeeded(container);

    if (!pState.presetData) loadCurrentPresetState();

    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl) return;

    ensurePromptToolbar(listEl);
    bindListIfNeeded(listEl);

    const locked = Boolean(pState.presetData.settings?.lockPromptOrder ?? true);
    updateLockButtonUI(pState.toolbarEl, locked);
    applyLockOrderState(listEl, locked);
    renderSettingsDrawer();
    renderBatchDrawer();

    const nativeItems = Array.from(listEl.children).filter(el => el.classList.contains('completion_prompt_manager_prompt'));
    if (!nativeItems.length) {
        renderStarredMirror([], false);
        return;
    }

    // Record original prompt_order DOM index on fresh render before grouping
    nativeItems.forEach((li, idx) => {
        if (li.dataset.bbOrigIdx === undefined) {
            li.dataset.bbOrigIdx = String(idx);
        }
    });

    // Sort back by original index first so intra-group order always reflects true prompt_order
    nativeItems.sort((a, b) => Number(a.dataset.bbOrigIdx) - Number(b.dataset.bbOrigIdx));

    pState.listObserver?.disconnect();
    try {
        listEl.querySelectorAll('.bb-group-header, .bb-group-note-li').forEach(el => el.remove());

        const store = pState.presetData.promptGroups;
        const groupMap = new Map(store.groups.map(g => [g.id, g]));
        const itemsByGroup = new Map(store.groups.map(g => [g.id, []]));
        const ungrouped = [];
        const starred = [];
        const forceExpand = Boolean(pState.query) || pState.filter !== 'all';

        for (const li of nativeItems) {
            const id = li.dataset.pmIdentifier;
            if (!id) continue;
            const meta = store.items[id] || { groupId: null, starred: false, note: '' };
            const enabled = !li.classList.contains('completion_prompt_manager_prompt_disabled');
            const nameText = getCleanPromptName(li, id);
            const rawTok = Number.parseInt(li.querySelector('.prompt_manager_prompt_tokens')?.dataset?.pmTokens || '', 10);
            const tokenVal = Number.isFinite(rawTok) && rawTok > 0 ? rawTok : 0;
            const group = meta.groupId && groupMap.has(meta.groupId) ? groupMap.get(meta.groupId) : null;

            const matchFilter = (pState.filter !== 'enabled' || enabled)
                && (pState.filter !== 'starred' || meta.starred)
                && (!pState.query
                    || nameText.toLowerCase().includes(pState.query)
                    || (meta.note || '').toLowerCase().includes(pState.query)
                    || (group?.name || '').toLowerCase().includes(pState.query));

            li.classList.toggle('bb-filter-hidden', !matchFilter);
            li.classList.remove('bb-collapsed-hidden');

            decoratePromptItem(li, id, meta, group);

            if (matchFilter && meta.starred) {
                starred.push({ id, name: nameText, enabled, tokenVal, note: meta.note });
            }

            if (group) {
                itemsByGroup.get(group.id).push({ li, enabled, tokenVal, matchFilter });
            } else {
                ungrouped.push({ li, enabled, tokenVal, matchFilter });
            }
        }

        renderStarredMirror(starred, forceExpand);

        const frag = document.createDocumentFragment();
        const headLi = listEl.querySelector('.completion_prompt_manager_list_head');
        const sepLi = listEl.querySelector('.completion_prompt_manager_list_separator');
        if (headLi) frag.appendChild(headLi);
        if (sepLi) frag.appendChild(sepLi);

        // Unlocked mode: show items in true original prompt_order sequence for safe native drag-and-drop!
        if (!locked) {
            for (const li of nativeItems) {
                frag.appendChild(li);
            }
            listEl.appendChild(frag);
            return;
        }

        const hiddenTail = [];

        store.groups.forEach((group, idx) => {
            const entries = itemsByGroup.get(group.id) || [];
            const visibleEntries = entries.filter(e => e.matchFilter);
            if (forceExpand && !visibleEntries.length && (!pState.query || !group.name.toLowerCase().includes(pState.query))) {
                for (const e of entries) hiddenTail.push(e.li);
                return;
            }

            const enabledCount = entries.filter(e => e.enabled).length;
            const tokenSum = entries.reduce((acc, e) => acc + (e.enabled ? e.tokenVal : 0), 0);
            const isCollapsed = group.collapsed && !forceExpand;

            const gHeader = document.createElement('li');
            gHeader.className = `bb-group-header ${enabledCount > 0 ? '' : 'is-group-disabled'}`;
            gHeader.dataset.bbGroupId = group.id;
            gHeader.innerHTML = `
                <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
                <span class="bb-group-name">${esc(group.name)}</span>
                ${group.exclusive ? '<span class="bb-tag bb-tag-exclusive" title="互斥单选组">互斥</span>' : ''}
                <span class="bb-count-badge">${enabledCount}/${entries.length}</span>
                ${tokenSum > 0 ? `<span class="bb-token-badge" title="已启用条目 Token 总计">~${formatTokens(tokenSum)}</span>` : ''}
                <span class="bb-group-controls">
                    <button type="button" class="bb-mini-btn" data-bb-act="up" ${idx === 0 ? 'disabled' : ''} title="上移分组"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="bb-mini-btn" data-bb-act="down" ${idx === store.groups.length - 1 ? 'disabled' : ''} title="下移分组"><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="bb-mini-btn" data-bb-act="edit" title="编辑分组 / 互斥 / 备注"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="bb-mini-btn bb-danger-btn" data-bb-act="del" title="删除分组"><i class="fa-solid fa-xmark"></i></button>
                    <label class="bb-switch-wrap" title="分组总开关">
                        <input type="checkbox" class="bb-switch bb-group-toggle" ${enabledCount > 0 ? 'checked' : ''} />
                        <span class="bb-switch-slider"></span>
                    </label>
                </span>
            `;
            frag.appendChild(gHeader);

            if (group.note && !isCollapsed) {
                const noteLi = document.createElement('li');
                noteLi.className = 'bb-group-note-li';
                noteLi.textContent = group.note;
                frag.appendChild(noteLi);
            }

            for (const entry of entries) {
                if (isCollapsed) entry.li.classList.add('bb-collapsed-hidden');
                frag.appendChild(entry.li);
            }
        });

        if (ungrouped.length) {
            const visibleUngrouped = ungrouped.filter(e => e.matchFilter);
            const isCollapsed = pState.ungroupedCollapsed && !forceExpand;
            if (!forceExpand || visibleUngrouped.length) {
                const enabledCount = ungrouped.filter(e => e.enabled).length;
                const uHeader = document.createElement('li');
                uHeader.className = 'bb-group-header bb-ungrouped-header';
                uHeader.innerHTML = `
                    <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
                    <span class="bb-group-name">未分组</span>
                    <span class="bb-count-badge">${enabledCount}/${ungrouped.length}</span>
                `;
                frag.appendChild(uHeader);
            }
            for (const entry of ungrouped) {
                if (isCollapsed) entry.li.classList.add('bb-collapsed-hidden');
                frag.appendChild(entry.li);
            }
        }

        for (const li of hiddenTail) {
            frag.appendChild(li);
        }

        listEl.appendChild(frag);
    } finally {
        pState.listObserver?.observe(listEl, { childList: true });
    }
}

function renderStarredMirror(starred, forceExpand) {
    const box = pState.toolbarEl?.querySelector('#bb_prompt_starred');
    if (!box) return;
    if (!starred.length) {
        box.innerHTML = '';
        return;
    }
    const isCollapsed = pState.starredCollapsed && !forceExpand;
    box.innerHTML = `
        <div class="bb-starred-header">
            <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
            <span class="bb-group-name"><i class="fa-solid fa-star bb-star-icon"></i> 常用置顶</span>
            <span class="bb-count-badge">${starred.length}</span>
        </div>
        ${isCollapsed ? '' : `
            <div class="bb-starred-items">
                ${starred.map(s => `
                    <div class="bb-starred-row ${s.enabled ? '' : 'is-disabled'}">
                        <button type="button" class="bb-star-mirror-unstar" data-id="${esc(s.id)}" title="取消星标"><i class="fa-solid fa-star"></i></button>
                        <span class="bb-starred-name" title="${esc(s.name)}">${esc(s.name)}</span>
                        ${s.note ? `<span class="bb-starred-note">${esc(s.note)}</span>` : ''}
                        ${s.tokenVal > 0 ? `<span class="bb-token-mini">${formatTokens(s.tokenVal)}</span>` : ''}
                        <button type="button" class="bb-mirror-toggle menu_button bb-btn-sm bb-drawer-btn" data-id="${esc(s.id)}">
                            ${s.enabled ? '已开启' : '已关闭'}
                        </button>
                    </div>
                `).join('')}
            </div>
        `}
    `;
}

/**
 * Injects compact star & item-settings icons inside `.prompt_manager_prompt_controls` using `<div>`
 * so SillyTavern's `span span span` CSS rules never crush or distort them.
 */
function decoratePromptItem(li, id, meta, group) {
    const controls = li.querySelector('.prompt_manager_prompt_controls');
    const host = controls || li;
    let extras = host.querySelector(':scope > .bb-item-extras');
    if (!extras) {
        extras = document.createElement('div');
        extras.className = 'bb-item-extras';
        if (controls) {
            controls.prepend(extras);
        } else {
            li.appendChild(extras);
        }
    }

    const locked = Boolean(pState.presetData.settings?.lockPromptOrder ?? true);
    const tipParts = [];
    if (group) tipParts.push(`分组：${group.name}`);
    if (meta?.note) tipParts.push(`备注：${meta.note}`);
    const noteTitle = tipParts.length ? tipParts.join(' | ') : '设置所属分组与备注';

    extras.innerHTML = `
        ${pState.batchMode ? `<input type="checkbox" class="bb-batch-chk" data-id="${esc(id)}" ${pState.selectedIds.has(id) ? 'checked' : ''} />` : ''}
        <button type="button" class="bb-icon-action ${meta?.starred ? 'is-starred' : ''}" data-bb-item-act="star" data-id="${esc(id)}" title="星标置顶"><i class="${meta?.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
        <button type="button" class="bb-icon-action ${meta?.note ? 'has-note' : ''}" data-bb-item-act="edit-item" data-id="${esc(id)}" title="${esc(noteTitle)}"><i class="fa-regular fa-note-sticky"></i></button>
    `;

    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (nameEl) {
        // Show subtle group tag when in unlocked raw-order view, or note tag if present
        let noteTag = nameEl.querySelector('.bb-inline-note-tag');
        const tagText = !locked && group ? `[${group.name}] ${meta?.note || ''}`.trim() : (meta?.note || '');
        if (tagText) {
            if (!noteTag) {
                noteTag = document.createElement('small');
                noteTag.className = 'bb-inline-note-tag';
                nameEl.appendChild(noteTag);
            }
            noteTag.textContent = tagText;
            noteTag.title = tagText;
        } else if (noteTag) {
            noteTag.remove();
        }
    }
}

function bindContainerIfNeeded(container) {
    if (!container || pState.boundContainerEl === container) return;
    pState.boundContainerEl = container;
    pState.containerObserver?.disconnect();
    pState.containerObserver = new MutationObserver(() => {
        scheduleEnhancePromptList();
    });
    pState.containerObserver.observe(container, { childList: true });
}

function bindListIfNeeded(listEl) {
    if (!listEl || pState.boundListEl === listEl) return;
    pState.boundListEl = listEl;

    pState.listObserver?.disconnect();

    // Update cached original indices after user drags in unlocked raw-order mode
    const $ = window.jQuery;
    if ($) {
        $(listEl).on('sortstop.bluebower', () => {
            if (pState.presetData?.settings?.lockPromptOrder) return;
            Array.from(listEl.children)
                .filter(el => el.classList.contains('completion_prompt_manager_prompt'))
                .forEach((li, i) => { li.dataset.bbOrigIdx = String(i); });
        });
    }

    listEl.addEventListener('click', async (e) => {
        const groupHeader = e.target.closest('.bb-group-header');
        if (groupHeader) {
            if (groupHeader.classList.contains('bb-ungrouped-header')) {
                pState.ungroupedCollapsed = !pState.ungroupedCollapsed;
                scheduleEnhancePromptList();
                return;
            }
            const gid = groupHeader.dataset.bbGroupId;
            const store = pState.presetData.promptGroups;
            const group = store.groups.find(g => g.id === gid);
            if (!group) return;

            const actBtn = e.target.closest('[data-bb-act]');
            if (actBtn) {
                e.stopPropagation();
                const act = actBtn.dataset.bbAct;
                if (act === 'up' || act === 'down') {
                    const idx = store.groups.findIndex(g => g.id === gid);
                    const target = act === 'up' ? idx - 1 : idx + 1;
                    if (target >= 0 && target < store.groups.length) {
                        const [m] = store.groups.splice(idx, 1);
                        store.groups.splice(target, 0, m);
                        store.groups.forEach((g, i) => { g.order = i; });
                        await savePresetData(pState.presetData);
                        scheduleEnhancePromptList();
                    }
                } else if (act === 'edit') {
                    const res = await openGroupDialog({ mode: 'edit', group });
                    if (res) {
                        group.name = res.name;
                        group.note = res.note;
                        group.exclusive = res.exclusive;
                        await savePresetData(pState.presetData);
                        scheduleEnhancePromptList();
                    }
                } else if (act === 'del') {
                    store.groups = store.groups.filter(g => g.id !== gid);
                    store.groups.forEach((g, i) => { g.order = i; });
                    for (const meta of Object.values(store.items)) {
                        if (meta.groupId === gid) meta.groupId = null;
                    }
                    await savePresetData(pState.presetData);
                    scheduleEnhancePromptList();
                    showNotice('已删除分组');
                }
                return;
            }

            if (e.target.closest('.bb-switch-wrap')) return;

            group.collapsed = !group.collapsed;
            scheduleEnhancePromptList();
            await savePresetData(pState.presetData);
            return;
        }

        const itemActBtn = e.target.closest('[data-bb-item-act]');
        if (itemActBtn) {
            e.stopPropagation();
            const id = itemActBtn.dataset.id;
            const store = pState.presetData.promptGroups;
            if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
            if (itemActBtn.dataset.bbItemAct === 'star') {
                store.items[id].starred = !store.items[id].starred;
                await savePresetData(pState.presetData);
                scheduleEnhancePromptList();
            } else if (itemActBtn.dataset.bbItemAct === 'edit-item') {
                const li = itemActBtn.closest('.completion_prompt_manager_prompt');
                const itemName = li ? getCleanPromptName(li, id) : id;
                const res = await openItemDialog({
                    itemName,
                    note: store.items[id].note,
                    groupId: store.items[id].groupId,
                    groups: store.groups,
                });
                if (res !== null) {
                    store.items[id].note = res.note;
                    store.items[id].groupId = res.groupId;
                    await savePresetData(pState.presetData);
                    scheduleEnhancePromptList();
                }
            }
            return;
        }

        const nativeToggle = e.target.closest('.prompt-manager-toggle-action');
        if (nativeToggle) {
            const li = nativeToggle.closest('.completion_prompt_manager_prompt');
            const id = li?.dataset?.pmIdentifier;
            if (!id) return;
            const wasDisabled = li.classList.contains('completion_prompt_manager_prompt_disabled');
            if (wasDisabled) {
                const store = pState.presetData.promptGroups;
                const gid = store.items[id]?.groupId;
                const group = gid ? store.groups.find(g => g.id === gid) : null;
                if (group?.exclusive) {
                    setTimeout(() => {
                        const siblings = Array.from(listEl.querySelectorAll('.completion_prompt_manager_prompt'))
                            .map(el => el.dataset.pmIdentifier)
                            .filter(sid => sid && sid !== id && store.items[sid]?.groupId === gid);
                        if (siblings.length) {
                            batchSetPromptsEnabled(siblings.map(sid => ({ id: sid, enabled: false })));
                            scheduleEnhancePromptList();
                        }
                    }, 30);
                }
            }
        }
    });

    listEl.addEventListener('change', async (e) => {
        const target = e.target;
        const store = pState.presetData.promptGroups;

        if (target.classList.contains('bb-batch-chk')) {
            const id = target.dataset.id;
            if (target.checked) pState.selectedIds.add(id);
            else pState.selectedIds.delete(id);
            renderBatchDrawer();
            return;
        }

        if (target.classList.contains('bb-group-toggle')) {
            const gid = target.closest('.bb-group-header')?.dataset?.bbGroupId;
            const group = store.groups.find(g => g.id === gid);
            if (!group) return;
            const nextEnabled = Boolean(target.checked);
            group.enabled = nextEnabled;

            const memberLis = Array.from(listEl.querySelectorAll('.completion_prompt_manager_prompt'))
                .filter(li => store.items[li.dataset.pmIdentifier]?.groupId === gid);

            let updates;
            if (nextEnabled && group.exclusive && memberLis.length > 1) {
                const alreadyOn = memberLis.find(li => !li.classList.contains('completion_prompt_manager_prompt_disabled'));
                const keepId = (alreadyOn || memberLis[0]).dataset.pmIdentifier;
                updates = memberLis.map(li => ({
                    id: li.dataset.pmIdentifier,
                    enabled: li.dataset.pmIdentifier === keepId,
                }));
            } else {
                updates = memberLis.map(li => ({
                    id: li.dataset.pmIdentifier,
                    enabled: nextEnabled,
                }));
            }

            batchSetPromptsEnabled(updates);
            await savePresetData(pState.presetData);
            scheduleEnhancePromptList();
        }
    });

    const observer = new MutationObserver(() => {
        scheduleEnhancePromptList();
    });
    pState.listObserver = observer;
    observer.observe(listEl, { childList: true });
}

export function initPromptEnhancer() {
    const container = document.getElementById('completion_prompt_manager');
    if (!container) return;
    if (!pState.initialized) {
        pState.initialized = true;
        loadCurrentPresetState();
    }
    bindContainerIfNeeded(container);
    scheduleEnhancePromptList();
}

export function onPromptPresetChanged() {
    pState.presetData = null;
    loadCurrentPresetState();
    initPromptEnhancer();
}
