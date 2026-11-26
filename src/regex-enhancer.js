import { openBatchMoveDialog, openGroupDialog, openItemDialog } from './dialog.js';
import {
    getGlobalSettings,
    getScopedRegexStore,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetDataDebounced,
} from './storage.js';
import { batchSetRegexEnabled, getRegexScopeInfo, syncRegexOrderFromIds } from './st-bridge.js';

const CONTAINERS = [
    { id: 'saved_regex_scripts', origin: 'global', storeScope: 'global', label: '全局正则' },
    { id: 'saved_preset_scripts', origin: 'preset', storeScope: 'preset', label: '预设正则' },
    { id: 'saved_scoped_scripts', origin: 'scoped', storeScope: 'scoped', label: '角色正则' },
];

const rState = {
    initialized: false,
    rootObserver: null,
    observers: [],
    boundRootEl: null,
    toolbarEl: null,
    rafId: null,
    searchOpen: false,
    filter: 'all', // 'all' | 'enabled' | 'starred'
    query: '',
    batchMode: false,
    selectedItems: new Map(), // id -> { origin, storeScope }
    lastBatchId: null,
    presetData: null,
    searchTimer: null,
    noticeTimer: null,
    globalListenersBound: false,
    dragState: null,
    suppressClickUntil: 0,
};

async function enforceRegexGroupExclusivity(storeScope, origin, gid, preferKeepId = null) {
    if (!gid) return;
    const store = getStore(storeScope);
    const group = store?.groups?.find(g => g.id === gid);
    if (!group?.exclusive) return;

    const listEl = document.getElementById(CONTAINERS.find(c => c.origin === origin)?.id || '');
    if (!listEl) return;

    const memberRows = Array.from(listEl.querySelectorAll('.regex-script-label'))
        .filter(row => row.id && store.items[row.id]?.groupId === gid);
    const enabledRows = memberRows.filter(r => !r.querySelector('.disable_regex')?.checked);
    if (enabledRows.length <= 1) return;

    const keepId = (preferKeepId && enabledRows.some(r => r.id === preferKeepId))
        ? preferKeepId
        : enabledRows[0].id;
    const toDisable = enabledRows.filter(r => r.id !== keepId);
    if (!toDisable.length) return;

    for (const r of toDisable) {
        const chk = r.querySelector('.disable_regex');
        if (chk) chk.checked = true;
    }
    await batchSetRegexEnabled(toDisable.map(r => ({ id: r.id, origin, enabled: false })));
}

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showNotice(text) {
    const el = rState.toolbarEl?.querySelector('.bb-inline-notice');
    if (!el) return;
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(rState.noticeTimer);
    rState.noticeTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

function getStore(storeScope) {
    if (storeScope === 'preset') {
        if (!rState.presetData) {
            const loaded = loadPresetData();
            rState.presetData = loaded.data;
            if (loaded.migratedFromBaibai) {
                savePresetDataDebounced(rState.presetData);
            }
        }
        return rState.presetData.regexGroups;
    }
    if (storeScope === 'scoped') {
        return getScopedRegexStore();
    }
    return getGlobalSettings().globalRegexGroups;
}

function persistStore(storeScope) {
    if (storeScope === 'preset') {
        if (rState.presetData) savePresetDataDebounced(rState.presetData);
    } else {
        saveGlobalSettings();
    }
}

function findRawScript(id, origin) {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return null;
    let arr = null;
    if (origin === 'preset') {
        arr = ctx.getPresetManager?.()?.readPresetExtensionField?.({ path: 'regex_scripts' });
    } else if (origin === 'scoped') {
        arr = ctx.characters?.[ctx.characterId]?.data?.extensions?.regex_scripts;
    } else {
        arr = ctx.extensionSettings?.regex;
    }
    if (!Array.isArray(arr)) return null;
    return arr.find(s => String(s?.id) === String(id)) ?? null;
}

function getCleanRegexName(row) {
    if (row.dataset.bbScriptName) return row.dataset.bbScriptName;
    const nameEl = row.querySelector('.regex_script_name');
    const clean = (nameEl?.getAttribute('title') || nameEl?.textContent || row.id || '').trim();
    row.dataset.bbScriptName = clean;
    return clean;
}

function ensureRegexToolbar(regexContainer) {
    const content = regexContainer.querySelector('.inline-drawer-content') || regexContainer;
    const anchor = content.querySelector('#global_scripts_block') || content.firstElementChild;

    if (!rState.toolbarEl) {
        const toolbar = document.createElement('div');
        toolbar.id = 'bb_regex_toolbar';
        toolbar.className = 'bb-list-topbar bb-regex-toolbar';
        toolbar.innerHTML = `
            <div class="bb-topbar-main">
                <div class="bb-topbar-status">
                    <i class="fa-solid fa-dove bb-bird-icon" title="园丁鸟 (Bluebower)"></i>
                    <span class="bb-status-text">正则分组</span>
                    <span class="bb-inline-notice"></span>
                </div>
                <div class="bb-topbar-icons">
                    <button type="button" class="bb-head-icon bb-search-toggle" title="搜索与筛选"><i class="fa-solid fa-magnifying-glass"></i></button>
                    <button type="button" class="bb-head-icon bb-new-group-btn" title="新建正则分组"><i class="fa-solid fa-folder-plus"></i></button>
                    <button type="button" class="bb-head-icon bb-batch-btn" title="批量移动正则"><i class="fa-solid fa-list-check"></i></button>
                </div>
            </div>
            <div class="bb-search-drawer">
                <input type="search" class="bb-search text_pole" placeholder="搜索正则脚本、分组或备注..." />
                <div class="bb-filter-pills">
                    <button type="button" class="bb-pill is-active" data-filter="all">全部</button>
                    <button type="button" class="bb-pill" data-filter="enabled">已启用</button>
                    <button type="button" class="bb-pill" data-filter="starred" title="仅看星标"><i class="fa-solid fa-star"></i></button>
                </div>
            </div>
            <div class="bb-batch-drawer" id="bb_regex_batch"></div>
        `;
        toolbar.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
        bindRegexToolbarEvents(toolbar);
        rState.toolbarEl = toolbar;
    }

    if (anchor && rState.toolbarEl.nextElementSibling !== anchor) {
        anchor.parentNode.insertBefore(rState.toolbarEl, anchor);
    } else if (!anchor && !rState.toolbarEl.isConnected) {
        content.prepend(rState.toolbarEl);
    }
}

function bindRegexToolbarEvents(toolbar) {
    const searchInput = toolbar.querySelector('.bb-search');

    toolbar.querySelector('.bb-search-toggle').addEventListener('click', () => {
        rState.searchOpen = !rState.searchOpen;
        if (!rState.searchOpen && (rState.query || rState.filter !== 'all')) {
            rState.query = '';
            rState.filter = 'all';
            searchInput.value = '';
        }
        scheduleEnhanceRegexLists();
        if (rState.searchOpen && !window.matchMedia?.('(pointer: coarse)').matches) {
            setTimeout(() => searchInput.focus({ preventScroll: true }), 20);
        }
    });

    searchInput.addEventListener('input', () => {
        clearTimeout(rState.searchTimer);
        rState.searchTimer = setTimeout(() => {
            rState.query = searchInput.value.trim().toLowerCase();
            scheduleEnhanceRegexLists();
        }, 100);
    });

    toolbar.querySelectorAll('.bb-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            rState.filter = pill.dataset.filter;
            scheduleEnhanceRegexLists();
        });
    });

    toolbar.querySelector('.bb-new-group-btn').addEventListener('click', async () => {
        const hasPresetScripts = (document.getElementById('saved_preset_scripts')?.children?.length || 0) > 0;
        const defaultScope = hasPresetScripts ? 'preset' : 'global';
        const res = await openGroupDialog({
            mode: 'create',
            defaultScope,
            scopeOptions: CONTAINERS.map(c => ({ value: c.storeScope, label: c.label })),
        });
        if (!res) return;
        const storeScope = res.scope || defaultScope;
        const store = getStore(storeScope);
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
        await persistStore(storeScope);
        scheduleEnhanceRegexLists();
    });

    toolbar.querySelector('.bb-batch-btn').addEventListener('click', () => {
        rState.batchMode = !rState.batchMode;
        if (!rState.batchMode) {
            rState.selectedItems.clear();
            rState.lastBatchId = null;
        }
        scheduleEnhanceRegexLists();
    });

    toolbar.querySelector('#bb_regex_batch').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-batch-action]');
        if (!btn) return;
        const action = btn.dataset.batchAction;
        if (action === 'clear') {
            rState.selectedItems.clear();
            rState.lastBatchId = null;
            scheduleEnhanceRegexLists();
        } else if (action === 'exit') {
            rState.selectedItems.clear();
            rState.lastBatchId = null;
            rState.batchMode = false;
            scheduleEnhanceRegexLists();
        } else if (action === 'choose-dest') {
            const count = rState.selectedItems.size;
            if (!count) return;
            const firstInfo = rState.selectedItems.values().next().value;
            const itemScope = firstInfo.storeScope;
            const scopeLabel = CONTAINERS.find(c => c.storeScope === itemScope)?.label || '';
            const store = getStore(itemScope);

            const dest = await openBatchMoveDialog({
                count,
                groups: store.groups,
                ungroupLabel: '移入「默认」（取消分组）',
                scopeLabel,
            });
            if (!dest) return; // Cancelled: keep current selection intact!

            let targetGid = null;
            let noticeMsg = '';
            if (dest.type === 'new') {
                targetGid = makeId();
                store.groups.push({
                    id: targetGid,
                    name: dest.name,
                    order: store.groups.length,
                    collapsed: false,
                    enabled: true,
                    exclusive: dest.exclusive,
                    note: '',
                });
                normalizeGroupStore(store);
                noticeMsg = `已新建「${dest.name}」并移入 ${count} 项正则`;
            } else if (dest.type === 'group') {
                targetGid = dest.groupId;
                noticeMsg = `已将 ${count} 项正则移入「${dest.groupName}」`;
            } else {
                targetGid = null;
                noticeMsg = `已将 ${count} 项正则归入默认分组`;
            }

            for (const id of rState.selectedItems.keys()) {
                if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
                store.items[id].groupId = targetGid;
            }
            if (targetGid) {
                const origin = CONTAINERS.find(c => c.storeScope === itemScope)?.origin;
                if (origin) await enforceRegexGroupExclusivity(itemScope, origin, targetGid);
            }

            rState.selectedItems.clear();
            rState.lastBatchId = null;
            rState.batchMode = false;
            persistStore(itemScope);
            scheduleEnhanceRegexLists();
            showNotice(noticeMsg);
        }
    });
}

function syncRegexTopbar() {
    const topbar = rState.toolbarEl;
    if (!topbar) return;
    const hasSearchOrFilter = rState.searchOpen || Boolean(rState.query) || rState.filter !== 'all';
    topbar.querySelector('.bb-search-toggle').classList.toggle('is-active', hasSearchOrFilter);
    topbar.querySelector('.bb-search-drawer').classList.toggle('is-open', hasSearchOrFilter);
    topbar.querySelectorAll('.bb-pill').forEach(p => {
        p.classList.toggle('is-active', p.dataset.filter === rState.filter);
    });
    topbar.classList.toggle('is-batch-active', rState.batchMode);
    topbar.querySelector('.bb-batch-btn').classList.toggle('is-active', rState.batchMode);
    renderBatchDrawer();
}

function renderBatchDrawer() {
    const el = rState.toolbarEl?.querySelector('#bb_regex_batch');
    if (!el) return;
    if (!rState.batchMode) {
        el.innerHTML = '';
        el.classList.remove('is-open');
        return;
    }

    const count = rState.selectedItems.size;
    const firstScope = count ? rState.selectedItems.values().next().value?.storeScope : null;
    const scopeLabel = firstScope ? (CONTAINERS.find(c => c.storeScope === firstScope)?.label || '') : '';

    el.classList.add('is-open');
    el.innerHTML = `
        <span class="bb-batch-count ${count ? '' : 'is-empty'}">${count ? `已选 <strong>${count}</strong> 项${scopeLabel ? ` · ${esc(scopeLabel)}` : ''}` : '点击下方正则即可多选'}</span>
        <div class="bb-batch-actions">
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-btn-primary" data-batch-action="choose-dest" ${count ? '' : 'disabled'}>移入分组…</button>
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="clear" ${count ? '' : 'disabled'}>重选</button>
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="exit">完成</button>
        </div>
    `;
}

export function scheduleEnhanceRegexLists() {
    if (rState.rafId) cancelAnimationFrame(rState.rafId);
    rState.rafId = requestAnimationFrame(() => {
        rState.rafId = null;
        enhanceAllRegexLists();
    });
}

function enhanceAllRegexLists() {
    const regexContainer = document.getElementById('regex_container');
    if (!regexContainer) return;
    bindRegexContainerIfNeeded(regexContainer);

    if (!rState.presetData) rState.presetData = loadPresetData().data;

    ensureRegexToolbar(regexContainer);
    ensureListObservers();
    syncRegexTopbar();

    rState.observers.forEach(item => item.observer.disconnect());
    try {
        for (const cfg of CONTAINERS) {
            const listEl = document.getElementById(cfg.id);
            if (!listEl) continue;
            listEl.classList.toggle('bb-batch-mode', rState.batchMode);
            enhanceSingleRegexContainer(listEl, cfg);
        }
    } finally {
        rState.observers.forEach(item => {
            if (item.el.isConnected) {
                item.observer.observe(item.el, { childList: true });
            }
        });
    }
}

function enhanceSingleRegexContainer(listEl, cfg) {
    listEl.classList.remove('ui-state-disabled', 'ui-sortable-disabled');
    // Disable native jQuery UI sortable items so sortable / touch-punch never fights Bluebower's 60fps pointer drag
    const $ = window.jQuery;
    if ($ && typeof $(listEl).sortable === 'function') {
        try {
            if ($(listEl).sortable('instance') || $(listEl).data('ui-sortable')) {
                $(listEl).sortable('option', 'disabled', false);
                $(listEl).sortable('option', 'items', '.bb-no-drag-items');
            }
        } catch {
            // Ignore if sortable is not initialized yet
        }
    }
    const nativeItems = Array.from(listEl.children).filter(el => el.classList.contains('regex-script-label'));
    listEl.querySelectorAll('.bb-group-header, .bb-group-note-li').forEach(el => el.remove());

    const store = getStore(cfg.storeScope);
    if (!nativeItems.length && !store.groups.length) return;

    nativeItems.forEach((row, idx) => {
        if (row.dataset.bbOrigIdx === undefined) {
            row.dataset.bbOrigIdx = String(idx);
        }
    });
    nativeItems.sort((a, b) => Number(a.dataset.bbOrigIdx) - Number(b.dataset.bbOrigIdx));

    const groupMap = new Map(store.groups.map(g => [g.id, g]));
    const itemsByGroup = new Map(store.groups.map(g => [g.id, []]));
    const ungroupedEntries = [];
    const itemRecords = [];
    const forceExpand = Boolean(rState.query) || rState.filter !== 'all';

    for (const row of nativeItems) {
        const id = row.id;
        if (!id) continue;
        const titleAttr = row.querySelector('.regex_script_name')?.getAttribute('title');
        if (titleAttr) row.dataset.bbScriptName = titleAttr.trim();

        const meta = store.items[id] || { groupId: null, starred: false, note: '' };
        const disableChk = row.querySelector('.disable_regex');
        const enabled = disableChk ? !disableChk.checked : true;
        const nameText = getCleanRegexName(row);
        const group = meta.groupId && groupMap.has(meta.groupId) ? groupMap.get(meta.groupId) : null;

        const matchFilter = (rState.filter !== 'enabled' || enabled)
            && (rState.filter !== 'starred' || meta.starred)
            && (!rState.query
                || nameText.toLowerCase().includes(rState.query)
                || (meta.note || '').toLowerCase().includes(rState.query)
                || (group ? group.name.toLowerCase().includes(rState.query) : '默认'.includes(rState.query)));

        row.classList.toggle('bb-filter-hidden', !matchFilter);
        row.classList.toggle('bb-batch-selected', rState.batchMode && rState.selectedItems.has(id));
        row.classList.remove('bb-collapsed-hidden', 'bb-grouped-child');
        delete row.dataset.bbMemberOf;
        delete row.dataset.bbDefaultMember;

        decorateRegexRow(row, id, meta, group, cfg);

        const rec = {
            row,
            id,
            enabled,
            matchFilter,
            group,
            origIdx: Number(row.dataset.bbOrigIdx) || 0,
            order: typeof meta.order === 'number' ? meta.order : null,
        };
        itemRecords.push(rec);
        if (group) {
            itemsByGroup.get(group.id).push(rec);
        } else {
            ungroupedEntries.push(rec);
        }
    }

    for (const entries of itemsByGroup.values()) {
        entries.sort((a, b) => {
            if (a.order !== null && b.order !== null && a.order !== b.order) {
                return a.order - b.order;
            }
            return a.origIdx - b.origIdx;
        });
    }

    const frag = document.createDocumentFragment();
    const hiddenTail = [];

    const appendGroupBlock = (group) => {
        const entries = itemsByGroup.get(group.id) || [];
        const visibleEntries = entries.filter(e => e.matchFilter);
        if (forceExpand && !visibleEntries.length && (!rState.query || !group.name.toLowerCase().includes(rState.query))) {
            for (const e of entries) hiddenTail.push(e.row);
            return;
        }

        const enabledCount = entries.filter(e => e.enabled).length;
        const isCollapsed = group.collapsed && !forceExpand;

        const gHeader = document.createElement('div');
        gHeader.className = `bb-group-header bb-regex-group-header ${enabledCount > 0 ? '' : 'is-group-disabled'}`;
        gHeader.dataset.bbGroupId = group.id;
        gHeader.dataset.bbStoreScope = cfg.storeScope;
        gHeader.dataset.bbOrigin = cfg.origin;
        gHeader.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
        gHeader.innerHTML = `
            <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
            <span class="bb-group-name">${esc(group.name)}</span>
            <span class="bb-group-meta">(${enabledCount}/${entries.length})</span>
            ${group.exclusive ? '<span class="bb-tag bb-tag-exclusive" title="互斥单选组">互斥</span>' : ''}
            <span class="bb-group-controls">
                <span class="bb-group-toggle-icon fa-solid ${enabledCount > 0 ? 'fa-toggle-on is-on' : 'fa-toggle-off'}" data-bb-act="toggle" title="整组开关"></span>
                <button type="button" class="bb-row-icon" data-bb-act="edit" title="编辑分组 / 互斥 / 备注"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="bb-row-icon bb-danger-icon" data-bb-act="del" title="删除分组"><i class="fa-solid fa-trash"></i></button>
            </span>
        `;
        frag.appendChild(gHeader);

        if (group.note) {
            const noteEl = document.createElement('div');
            noteEl.className = `bb-group-note-li ${isCollapsed ? 'bb-collapsed-hidden' : ''}`;
            noteEl.dataset.bbNoteOf = group.id;
            noteEl.textContent = group.note;
            frag.appendChild(noteEl);
        }

        for (const entry of entries) {
            entry.row.classList.add('bb-grouped-child');
            entry.row.dataset.bbMemberOf = group.id;
            if (isCollapsed) entry.row.classList.add('bb-collapsed-hidden');
            frag.appendChild(entry.row);
        }
    };

    const appendDefaultGroupBlock = () => {
        const visibleEntries = ungroupedEntries.filter(e => e.matchFilter);
        if (forceExpand && !visibleEntries.length && (!rState.query || !'默认'.includes(rState.query))) {
            for (const e of ungroupedEntries) hiddenTail.push(e.row);
            return;
        }

        const enabledCount = ungroupedEntries.filter(e => e.enabled).length;
        const isCollapsed = (store.defaultCollapsed !== false) && !forceExpand;

        const dHeader = document.createElement('div');
        dHeader.className = `bb-group-header bb-regex-group-header bb-default-group-header ${enabledCount > 0 ? '' : 'is-group-disabled'}`;
        dHeader.dataset.bbDefaultGroup = '1';
        dHeader.dataset.bbStoreScope = cfg.storeScope;
        dHeader.dataset.bbOrigin = cfg.origin;
        dHeader.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
        dHeader.innerHTML = `
            <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
            <span class="bb-group-name">默认</span>
            <span class="bb-group-meta">(${enabledCount}/${ungroupedEntries.length})</span>
            <span class="bb-group-controls">
                <span class="bb-group-toggle-icon fa-solid ${enabledCount > 0 ? 'fa-toggle-on is-on' : 'fa-toggle-off'}" data-bb-act="toggle-default" title="默认组开关"></span>
            </span>
        `;
        frag.appendChild(dHeader);

        for (const entry of ungroupedEntries) {
            entry.row.classList.add('bb-grouped-child');
            entry.row.dataset.bbDefaultMember = '1';
            if (isCollapsed) entry.row.classList.add('bb-collapsed-hidden');
            frag.appendChild(entry.row);
        }
    };

    // Match ST-BaiBai-Tools regex group layout: named groups in `group.order`, then default-collapsed `默认` group at the bottom
    for (const group of store.groups) {
        appendGroupBlock(group);
    }
    if (ungroupedEntries.length > 0) {
        appendDefaultGroupBlock();
    }

    for (const row of hiddenTail) {
        frag.appendChild(row);
    }

    listEl.appendChild(frag);
}

/**
 * Folds Star, Group/Note (`fa-sliders`), and native Delete (`delete_regex`) inside
 * SillyTavern's native `.regex_script_buttons` (`...` ellipsis tray).
 */
function decorateRegexRow(row, id, meta, group, cfg) {
    const raw = findRawScript(id, cfg.origin);
    const scopeInfo = raw ? getRegexScopeInfo(raw) : null;

    row.dataset.bbOrigin = cfg.origin;
    row.dataset.bbScope = cfg.storeScope;

    const nameEl = row.querySelector('.regex_script_name');
    if (nameEl) {
        let starMark = nameEl.querySelector('.bb-inline-star-mark');
        if (meta?.starred) {
            if (!starMark) {
                starMark = document.createElement('i');
                starMark.className = 'fa-solid fa-star bb-inline-star-mark';
                starMark.title = '已星标';
                nameEl.appendChild(starMark);
            }
        } else if (starMark) {
            starMark.remove();
        }

        let badge = nameEl.querySelector('.bb-regex-scope-badge');
        if (scopeInfo) {
            if (!badge) {
                badge = document.createElement('small');
                badge.className = 'bb-regex-scope-badge';
                nameEl.appendChild(badge);
            }
            badge.className = `bb-regex-scope-badge bb-tag bb-tag-scope-${scopeInfo.key}`;
            badge.textContent = scopeInfo.label;
        }

        let noteTag = nameEl.querySelector('.bb-inline-note-tag');
        if (meta?.note) {
            if (!noteTag) {
                noteTag = document.createElement('small');
                noteTag.className = 'bb-inline-note-tag';
                nameEl.appendChild(noteTag);
            }
            noteTag.textContent = meta.note;
            noteTag.title = meta.note;
        } else if (noteTag) {
            noteTag.remove();
        }
    }

    const tray = row.querySelector('.regex_script_buttons');
    if (tray) {
        let bbTray = tray.querySelector('.bb-regex-tray-items');
        if (!bbTray) {
            bbTray = document.createElement('div');
            bbTray.className = 'bb-regex-tray-items';
            tray.prepend(bbTray);
        }

        const tipParts = [];
        if (group) tipParts.push(`分组：${group.name}`);
        if (meta?.note) tipParts.push(`备注：${meta.note}`);
        const noteTitle = tipParts.length ? tipParts.join(' | ') : '分组与备注';

        bbTray.innerHTML = `
            <div class="menu_button bb-tray-btn ${meta?.starred ? 'is-starred' : ''}" data-bb-regex-act="star" data-id="${esc(id)}" data-scope="${cfg.storeScope}" title="${meta?.starred ? '取消星标' : '设为星标'}">
                <i class="${meta?.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i>
            </div>
            <div class="menu_button bb-tray-btn" data-bb-regex-act="edit-item" data-id="${esc(id)}" data-scope="${cfg.storeScope}" title="${esc(noteTitle)}">
                <i class="fa-solid fa-sliders"></i>
            </div>
        `;

        const delBtn = row.querySelector(':scope > .flex-container > .delete_regex');
        if (delBtn) {
            tray.appendChild(delBtn);
        }
    }
}

function ensureListObservers() {
    const existingMap = new Map(rState.observers.map(o => [o.el, o]));
    const nextObservers = [];

    for (const cfg of CONTAINERS) {
        const listEl = document.getElementById(cfg.id);
        if (!listEl) continue;
        if (existingMap.has(listEl)) {
            nextObservers.push(existingMap.get(listEl));
        } else {
            const obs = new MutationObserver(() => {
                if (rState.dragState?.active) return;
                scheduleEnhanceRegexLists();
            });
            obs.observe(listEl, { childList: true });
            nextObservers.push({ el: listEl, observer: obs });
        }
    }

    for (const old of rState.observers) {
        if (!nextObservers.includes(old)) {
            old.observer.disconnect();
        }
    }
    rState.observers = nextObservers;
}

function bindRegexContainerIfNeeded(regexContainer) {
    if (!regexContainer || rState.boundRootEl === regexContainer) return;
    rState.boundRootEl = regexContainer;

    rState.rootObserver?.disconnect();
    rState.rootObserver = new MutationObserver(() => {
        if (rState.dragState?.active) return;
        scheduleEnhanceRegexLists();
    });
    rState.rootObserver.observe(regexContainer, { childList: true });

    // Capture-phase row click in batchMode: click anywhere on `.regex-script-label` to select!
    regexContainer.addEventListener('click', (e) => {
        if (!rState.batchMode) return;
        const row = e.target.closest('.regex-script-label');
        if (!row || !row.id) return;
        e.preventDefault();
        e.stopPropagation();

        const id = row.id;
        const rowScope = row.dataset.bbScope;
        const nextSelected = !rState.selectedItems.has(id);

        if (nextSelected && rState.selectedItems.size > 0) {
            const activeScope = rState.selectedItems.values().next().value?.storeScope;
            if (activeScope && activeScope !== rowScope) {
                showNotice('单次多选仅限同一正则范围（全局/预设/角色）');
                return;
            }
        }

        if (e.shiftKey && rState.lastBatchId && rState.lastBatchId !== id) {
            const visibleRows = Array.from(regexContainer.querySelectorAll(`.regex-script-label[data-bb-scope="${CSS.escape(rowScope)}"]:not(.bb-collapsed-hidden):not(.bb-filter-hidden)`));
            const i1 = visibleRows.findIndex(el => el.id === rState.lastBatchId);
            const i2 = visibleRows.findIndex(el => el.id === id);
            if (i1 !== -1 && i2 !== -1) {
                const [start, end] = i1 < i2 ? [i1, i2] : [i2, i1];
                for (let i = start; i <= end; i++) {
                    const r = visibleRows[i];
                    if (!r.id) continue;
                    if (nextSelected) {
                        rState.selectedItems.set(r.id, { origin: r.dataset.bbOrigin, storeScope: r.dataset.bbScope });
                    } else {
                        rState.selectedItems.delete(r.id);
                    }
                    r.classList.toggle('bb-batch-selected', nextSelected);
                }
                rState.lastBatchId = id;
                renderBatchDrawer();
                return;
            }
        }

        if (nextSelected) {
            rState.selectedItems.set(id, { origin: row.dataset.bbOrigin, storeScope: row.dataset.bbScope });
        } else {
            rState.selectedItems.delete(id);
        }
        row.classList.toggle('bb-batch-selected', nextSelected);
        rState.lastBatchId = id;
        renderBatchDrawer();
    }, true);

    const toggleRegexGroupHeader = (gHeader) => {
        const storeScope = gHeader.dataset.bbStoreScope;
        const store = getStore(storeScope);
        const forceExpand = Boolean(rState.query) || rState.filter !== 'all';

        if (gHeader.dataset.bbDefaultGroup === '1') {
            store.defaultCollapsed = !(store.defaultCollapsed !== false);
            if (!forceExpand) {
                const isCollapsed = store.defaultCollapsed;
                const icon = gHeader.querySelector('.bb-chevron i');
                if (icon) {
                    icon.classList.toggle('fa-chevron-right', isCollapsed);
                    icon.classList.toggle('fa-chevron-down', !isCollapsed);
                }
                gHeader.parentElement?.querySelectorAll('[data-bb-default-member="1"]').forEach(el => {
                    el.classList.toggle('bb-collapsed-hidden', isCollapsed);
                });
            }
            persistStore(storeScope);
            return;
        }

        const gid = gHeader.dataset.bbGroupId;
        const group = store.groups.find(g => g.id === gid);
        if (!group) return;
        group.collapsed = !group.collapsed;
        if (!forceExpand) {
            const isCollapsed = group.collapsed;
            const icon = gHeader.querySelector('.bb-chevron i');
            if (icon) {
                icon.classList.toggle('fa-chevron-right', isCollapsed);
                icon.classList.toggle('fa-chevron-down', !isCollapsed);
            }
            gHeader.parentElement?.querySelectorAll(`[data-bb-member-of="${CSS.escape(gid)}"], [data-bb-note-of="${CSS.escape(gid)}"]`).forEach(el => {
                el.classList.toggle('bb-collapsed-hidden', isCollapsed);
            });
        }
        persistStore(storeScope);
    };

    let regexTapGesture = null;
    let lastRegexTouchToggleAt = 0;

    regexContainer.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || e.isPrimary === false) return;
        if (e.target.closest('#bb_regex_toolbar, [data-bb-act]')) return;
        const gHeader = e.target.closest('.bb-regex-group-header');
        if (!gHeader) return;
        regexTapGesture = {
            pointerId: e.pointerId,
            header: gHeader,
            x: e.clientX,
            y: e.clientY,
            moved: false,
        };
    });

    regexContainer.addEventListener('pointermove', (e) => {
        if (!regexTapGesture || e.pointerId !== regexTapGesture.pointerId) return;
        if (Math.hypot(e.clientX - regexTapGesture.x, e.clientY - regexTapGesture.y) > 10) {
            regexTapGesture.moved = true;
        }
    });

    regexContainer.addEventListener('pointercancel', () => {
        regexTapGesture = null;
    });

    regexContainer.addEventListener('pointerup', (e) => {
        if (!regexTapGesture || e.pointerId !== regexTapGesture.pointerId) return;
        const g = regexTapGesture;
        regexTapGesture = null;
        if (g.moved || e.target.closest('[data-bb-act]')) return;
        if (e.target.closest('.bb-regex-group-header') !== g.header) return;
        lastRegexTouchToggleAt = Date.now();
        toggleRegexGroupHeader(g.header);
    });

    regexContainer.addEventListener('click', async (e) => {
        if (e.target.closest('#bb_regex_toolbar')) return;

        const gHeader = e.target.closest('.bb-regex-group-header');
        if (gHeader) {
            const storeScope = gHeader.dataset.bbStoreScope;
            const origin = gHeader.dataset.bbOrigin;
            const store = getStore(storeScope);

            // Virtual "默认" group for ungrouped regex scripts
            if (gHeader.dataset.bbDefaultGroup === '1') {
                const actEl = e.target.closest('[data-bb-act="toggle-default"]');
                if (actEl) {
                    e.stopPropagation();
                    const listEl = document.getElementById(CONTAINERS.find(c => c.origin === origin)?.id || '');
                    if (!listEl) return;
                    const validGroupIds = new Set(store.groups.map(g => g.id));
                    const memberRows = Array.from(listEl.querySelectorAll('.regex-script-label'))
                        .filter(row => {
                            const gid = store.items[row.id]?.groupId;
                            return !gid || !validGroupIds.has(gid);
                        });
                    const anyEnabled = memberRows.some(r => !r.querySelector('.disable_regex')?.checked);
                    const nextEnabled = !anyEnabled;
                    const updates = memberRows.map(r => ({ id: r.id, origin, enabled: nextEnabled }));
                    await batchSetRegexEnabled(updates);
                    for (const u of updates) {
                        const row = document.getElementById(u.id);
                        const chk = row?.querySelector('.disable_regex');
                        if (chk) chk.checked = !u.enabled;
                    }
                    scheduleEnhanceRegexLists();
                    return;
                }

                if (Date.now() - lastRegexTouchToggleAt < 450) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                toggleRegexGroupHeader(gHeader);
                return;
            }

            const gid = gHeader.dataset.bbGroupId;
            const group = store.groups.find(g => g.id === gid);
            if (!group) return;

            const actEl = e.target.closest('[data-bb-act]');
            if (actEl) {
                e.stopPropagation();
                const act = actEl.dataset.bbAct;
                if (act === 'toggle') {
                    const listEl = document.getElementById(CONTAINERS.find(c => c.origin === origin)?.id || '');
                    if (!listEl) return;
                    const memberRows = Array.from(listEl.querySelectorAll('.regex-script-label'))
                        .filter(row => store.items[row.id]?.groupId === gid);
                    const anyEnabled = memberRows.some(r => !r.querySelector('.disable_regex')?.checked);
                    const nextEnabled = !anyEnabled;
                    group.enabled = nextEnabled;

                    let updates;
                    if (nextEnabled && group.exclusive && memberRows.length > 1) {
                        const keepId = memberRows[0].id;
                        updates = memberRows.map(r => ({ id: r.id, origin, enabled: r.id === keepId }));
                    } else {
                        updates = memberRows.map(r => ({ id: r.id, origin, enabled: nextEnabled }));
                    }

                    await batchSetRegexEnabled(updates);
                    for (const u of updates) {
                        const row = document.getElementById(u.id);
                        const chk = row?.querySelector('.disable_regex');
                        if (chk) chk.checked = !u.enabled;
                    }
                    persistStore(storeScope);
                    scheduleEnhanceRegexLists();
                } else if (act === 'edit') {
                    const res = await openGroupDialog({ mode: 'edit', group });
                    if (res) {
                        group.name = res.name;
                        group.note = res.note;
                        group.exclusive = res.exclusive;
                        if (group.exclusive) {
                            await enforceRegexGroupExclusivity(storeScope, origin, gid);
                        }
                        persistStore(storeScope);
                        scheduleEnhanceRegexLists();
                    }
                } else if (act === 'del') {
                    store.groups = store.groups.filter(g => g.id !== gid);
                    store.groups.forEach((g, i) => { g.order = i; });
                    for (const meta of Object.values(store.items)) {
                        if (meta.groupId === gid) meta.groupId = null;
                    }
                    persistStore(storeScope);
                    scheduleEnhanceRegexLists();
                    showNotice('已删除分组，条目已归入默认分组');
                }
                return;
            }

            if (Date.now() - lastRegexTouchToggleAt < 450) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            toggleRegexGroupHeader(gHeader);
            return;
        }

        const itemBtn = e.target.closest('[data-bb-regex-act]');
        if (itemBtn) {
            e.stopPropagation();
            const id = itemBtn.dataset.id;
            const storeScope = itemBtn.dataset.scope;
            const store = getStore(storeScope);
            if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };

            if (itemBtn.dataset.bbRegexAct === 'star') {
                store.items[id].starred = !store.items[id].starred;
                await persistStore(storeScope);
                scheduleEnhanceRegexLists();
            } else if (itemBtn.dataset.bbRegexAct === 'edit-item') {
                const row = itemBtn.closest('.regex-script-label');
                const itemName = row ? getCleanRegexName(row) : id;
                const res = await openItemDialog({
                    itemName,
                    note: store.items[id].note,
                    groupId: store.items[id].groupId,
                    groups: store.groups,
                });
                if (res !== null) {
                    store.items[id].note = res.note;
                    store.items[id].groupId = res.groupId;
                    if (res.groupId) {
                        const origin = CONTAINERS.find(c => c.storeScope === storeScope)?.origin;
                        if (origin) await enforceRegexGroupExclusivity(storeScope, origin, res.groupId, id);
                    }
                    await persistStore(storeScope);
                    scheduleEnhanceRegexLists();
                }
            }
            return;
        }
    });
}

function findRegexScrollContainer(el) {
    let cur = el?.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
        const style = window.getComputedStyle(cur);
        const oy = style.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight) {
            return cur;
        }
        cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
}

function findPrecedingGroupHeader(row) {
    let prev = row?.previousElementSibling;
    while (prev) {
        if (prev.classList.contains('bb-regex-group-header')) return prev;
        prev = prev.previousElementSibling;
    }
    return null;
}

function updateDropHeaderHighlight(listEl, activeHeader) {
    if (!listEl) return;
    for (const h of listEl.querySelectorAll('.bb-regex-group-header')) {
        h.classList.toggle('bb-drop-target-header', h === activeHeader);
    }
}

function repositionDraggedRegexRow(ds) {
    const { listEl, dragRow, clientY } = ds;
    if (!listEl?.isConnected || !dragRow?.isConnected) return;

    const allChildren = Array.from(listEl.children);
    const firstHeader = allChildren.find(el => el.classList.contains('bb-regex-group-header'));

    // Collect visible candidates strictly after the first group header (and its group note)
    // so a dragged script row always stays inside a valid group or `默认`.
    let pastFirstHeaderAnchor = !firstHeader;
    const candidates = [];
    for (const el of allChildren) {
        if (!pastFirstHeaderAnchor) {
            if (el === firstHeader) {
                pastFirstHeaderAnchor = true;
            }
            continue;
        }
        if (el.classList.contains('bb-group-note-li') && el.previousElementSibling === firstHeader) {
            continue;
        }
        if (el === dragRow) continue;
        if (el.classList.contains('bb-group-note-li')) continue;
        if (el.classList.contains('bb-collapsed-hidden') || el.classList.contains('bb-filter-hidden')) continue;
        if (el.classList.contains('regex-script-label') || el.classList.contains('bb-regex-group-header')) {
            candidates.push(el);
        }
    }

    let refNode = null;
    for (const cand of candidates) {
        const rect = cand.getBoundingClientRect();
        if (clientY < rect.top + rect.height * 0.5) {
            refNode = cand;
            break;
        }
    }

    if (refNode) {
        if (dragRow.nextElementSibling !== refNode) {
            listEl.insertBefore(dragRow, refNode);
            ds.reordered = true;
        }
    } else if (candidates.length > 0 || firstHeader) {
        // Place at the end of the last visible section (before any hiddenTail items if filtered)
        const lastVis = candidates[candidates.length - 1] || firstHeader;
        let insertBeforeEl = lastVis.nextElementSibling;
        // Skip group note or collapsed children belonging to `lastVis` if `lastVis` is a group header
        while (
            insertBeforeEl
            && insertBeforeEl !== dragRow
            && (insertBeforeEl.classList.contains('bb-group-note-li') || insertBeforeEl.classList.contains('bb-collapsed-hidden'))
        ) {
            insertBeforeEl = insertBeforeEl.nextElementSibling;
        }
        if (insertBeforeEl !== dragRow && dragRow.nextElementSibling !== insertBeforeEl) {
            listEl.insertBefore(dragRow, insertBeforeEl);
            ds.reordered = true;
        }
    }

    const activeHeader = findPrecedingGroupHeader(dragRow);
    updateDropHeaderHighlight(listEl, activeHeader);
}

function bindGlobalRegexListenersOnce() {
    if (rState.globalListenersBound) return;
    rState.globalListenersBound = true;

    const activateDrag = (ds) => {
        if (ds.active) return;
        ds.active = true;
        if (rState.rafId) {
            cancelAnimationFrame(rState.rafId);
            rState.rafId = null;
        }
        rState.rootObserver?.disconnect();
        rState.observers.forEach(item => item.observer.disconnect());

        ds.listEl.classList.add('bb-dragging-list');
        ds.dragRow.classList.add('bb-dragging-row');
        updateDropHeaderHighlight(ds.listEl, findPrecedingGroupHeader(ds.dragRow));

        if (typeof ds.listEl.setPointerCapture === 'function' && ds.pointerId !== null) {
            try {
                ds.listEl.setPointerCapture(ds.pointerId);
            } catch {
                // Ignore
            }
        }

        const tickAutoScroll = () => {
            if (rState.dragState !== ds || !ds.active) return;
            const sc = ds.scrollEl;
            if (sc) {
                const isRoot = sc === document.scrollingElement || sc === document.documentElement;
                const rect = isRoot ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
                const visTop = Math.max(0, rect.top);
                const visBottom = Math.min(window.innerHeight, rect.bottom);
                const edgeZone = 52;
                const maxSpeed = 14;
                let delta = 0;
                if (ds.clientY < visTop + edgeZone) {
                    const ratio = Math.min(1, Math.max(0.15, (visTop + edgeZone - ds.clientY) / edgeZone));
                    delta = -Math.ceil(ratio * maxSpeed);
                } else if (ds.clientY > visBottom - edgeZone) {
                    const ratio = Math.min(1, Math.max(0.15, (ds.clientY - (visBottom - edgeZone)) / edgeZone));
                    delta = Math.ceil(ratio * maxSpeed);
                }
                if (delta !== 0) {
                    if (isRoot) {
                        const prev = window.scrollY;
                        window.scrollBy(0, delta);
                        if (window.scrollY !== prev) repositionDraggedRegexRow(ds);
                    } else {
                        const prev = sc.scrollTop;
                        sc.scrollTop += delta;
                        if (sc.scrollTop !== prev) repositionDraggedRegexRow(ds);
                    }
                }
            }
            ds.scrollRaf = requestAnimationFrame(tickAutoScroll);
        };
        ds.scrollRaf = requestAnimationFrame(tickAutoScroll);
    };

    const finishDrag = async (cancelled = false) => {
        const ds = rState.dragState;
        if (!ds) return;
        rState.dragState = null;

        if (ds.scrollRaf) cancelAnimationFrame(ds.scrollRaf);
        if (typeof ds.listEl?.releasePointerCapture === 'function' && ds.pointerId !== null) {
            try {
                ds.listEl.releasePointerCapture(ds.pointerId);
            } catch {
                // Ignore
            }
        }

        ds.dragRow?.classList.remove('bb-dragging-row');
        ds.listEl?.classList.remove('bb-dragging-list');
        updateDropHeaderHighlight(ds.listEl, null);

        if (!ds.active) return;
        rState.suppressClickUntil = Date.now() + 260;

        try {
            if (!cancelled && ds.reordered && ds.listEl?.isConnected) {
                const { listEl, dragRow, cfg } = ds;
                const store = getStore(cfg.storeScope);
                const validGroupIds = new Set(store.groups.map(g => g.id));
                const prevRawGid = store.items[dragRow.id]?.groupId || null;
                const prevGroupId = prevRawGid && validGroupIds.has(prevRawGid) ? prevRawGid : null;

                const activeHeader = findPrecedingGroupHeader(dragRow);
                let newGroupId = prevGroupId;
                if (activeHeader) {
                    if (activeHeader.dataset.bbDefaultGroup === '1') {
                        newGroupId = null;
                    } else if (activeHeader.dataset.bbGroupId && validGroupIds.has(activeHeader.dataset.bbGroupId)) {
                        newGroupId = activeHeader.dataset.bbGroupId;
                    }
                }

                if (!store.items[dragRow.id]) {
                    store.items[dragRow.id] = { groupId: null, starred: false, note: '' };
                }
                store.items[dragRow.id].groupId = newGroupId;

                // Recompute intra-group `order` and global script order from current DOM order
                const domRows = Array.from(listEl.children).filter(el => el.classList.contains('regex-script-label') && el.id);
                const buckets = new Map(store.groups.map(g => [g.id, []]));
                const defaultBucket = [];

                for (const r of domRows) {
                    const rawGid = store.items[r.id]?.groupId || null;
                    const gid = rawGid && validGroupIds.has(rawGid) ? rawGid : null;
                    if (gid) {
                        buckets.get(gid).push(r);
                    } else {
                        defaultBucket.push(r);
                    }
                }

                const orderedRows = [];
                for (const g of store.groups) {
                    const list = buckets.get(g.id) || [];
                    list.forEach((r, idx) => {
                        if (!store.items[r.id]) store.items[r.id] = { groupId: g.id, starred: false, note: '' };
                        store.items[r.id].order = idx;
                        orderedRows.push(r);
                    });
                }
                defaultBucket.forEach((r, idx) => {
                    if (store.items[r.id]) {
                        store.items[r.id].order = idx;
                    }
                    orderedRows.push(r);
                });

                orderedRows.forEach((r, idx) => {
                    r.dataset.bbOrigIdx = String(idx);
                });

                const orderedIds = orderedRows.map(r => r.id);
                await syncRegexOrderFromIds(cfg.origin, orderedIds);

                if (newGroupId && newGroupId !== prevGroupId) {
                    await enforceRegexGroupExclusivity(cfg.storeScope, cfg.origin, newGroupId, dragRow.id);
                }
                persistStore(cfg.storeScope);

                if (newGroupId !== prevGroupId) {
                    const targetName = newGroupId
                        ? (store.groups.find(g => g.id === newGroupId)?.name || '分组')
                        : '默认';
                    showNotice(`已移入「${targetName}」`);
                }
            } else if (cancelled && ds.listEl?.isConnected && Array.isArray(ds.initialOrder)) {
                for (const el of ds.initialOrder) {
                    if (el.parentElement === ds.listEl) ds.listEl.appendChild(el);
                }
            }
        } finally {
            if (rState.boundRootEl?.isConnected) {
                rState.rootObserver?.observe(rState.boundRootEl, { childList: true });
            }
            rState.observers.forEach(item => {
                if (item.el.isConnected) item.observer.observe(item.el, { childList: true });
            });
            scheduleEnhanceRegexLists();
        }
    };

    // 1. Window capture click handler: handles regex toggles by `id` (never relying on stale index closures after reorder)
    //    and enforces `exclusive` radio group rules cleanly.
    window.addEventListener('click', async (e) => {
        if (Date.now() < rState.suppressClickUntil && e.target instanceof Element && e.target.closest('#regex_container')) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
        if (rState.batchMode) return;
        const toggleTarget = e.target instanceof Element
            ? e.target.closest('#regex_container .regex-toggle-on, #regex_container .regex-toggle-off, #regex_container input.disable_regex')
            : null;
        if (!toggleTarget) return;

        const row = toggleTarget.closest('.regex-script-label');
        const listEl = row?.parentElement;
        const cfg = CONTAINERS.find(c => c.id === listEl?.id);
        if (!row?.id || !cfg) return;

        const store = getStore(cfg.storeScope);
        const gid = store.items[row.id]?.groupId;
        const group = gid ? store.groups.find(g => g.id === gid) : null;

        const chk = row.querySelector('.disable_regex');
        const wasEnabled = chk ? !chk.checked : true;
        let nextEnabled = !wasEnabled;
        if (toggleTarget.classList.contains('regex-toggle-on')) {
            nextEnabled = false;
        } else if (toggleTarget.classList.contains('regex-toggle-off')) {
            nextEnabled = true;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        let updates;
        if (group?.exclusive && nextEnabled) {
            const siblingIds = new Set();
            for (const el of listEl.querySelectorAll('.regex-script-label')) {
                if (el.id && el.id !== row.id && store.items[el.id]?.groupId === gid) {
                    siblingIds.add(el.id);
                }
            }
            for (const [sid, meta] of Object.entries(store.items)) {
                if (sid !== row.id && meta?.groupId === gid) {
                    siblingIds.add(sid);
                }
            }
            updates = [
                { id: row.id, origin: cfg.origin, enabled: true },
                ...Array.from(siblingIds).map(sid => ({ id: sid, origin: cfg.origin, enabled: false })),
            ];
        } else {
            updates = [{ id: row.id, origin: cfg.origin, enabled: nextEnabled }];
        }

        for (const u of updates) {
            const targetRow = document.getElementById(u.id);
            const targetChk = targetRow?.querySelector('.disable_regex');
            if (targetChk) targetChk.checked = !u.enabled;
        }

        await batchSetRegexEnabled(updates);
        scheduleEnhanceRegexLists();
    }, true);

    // 2. Window capture Pointer Drag for regex script rows (mobile `.drag-handle` + desktop `.drag-handle` / row body)
    window.addEventListener('pointerdown', (e) => {
        if (rState.batchMode || rState.dragState) return;
        if (e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (!(e.target instanceof Element)) return;

        const handleEl = e.target.closest('#regex_container .regex-script-label .drag-handle');
        if (e.pointerType !== 'mouse' && !handleEl) return;

        const dragRow = (handleEl || e.target).closest('#regex_container .regex-script-label');
        const listEl = dragRow?.parentElement;
        const cfg = CONTAINERS.find(c => c.id === listEl?.id);
        if (!dragRow?.id || !listEl || !cfg) return;

        if (!handleEl && e.target.closest(
            'a, button, input, label, select, textarea, .menu_button, .regex_script_buttons, .regex-toggle-on, .regex-toggle-off, .edit_existing_regex, .delete_regex, .regex_bulk_checkbox',
        )) {
            return;
        }

        const ds = {
            pointerId: e.pointerId,
            listEl,
            dragRow,
            cfg,
            scrollEl: findRegexScrollContainer(listEl),
            startX: e.clientX,
            startY: e.clientY,
            clientY: e.clientY,
            active: false,
            reordered: false,
            scrollRaf: 0,
            initialOrder: Array.from(listEl.children),
        };
        rState.dragState = ds;

        if (handleEl) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            activateDrag(ds);
        }
    }, true);

    window.addEventListener('pointermove', (e) => {
        const ds = rState.dragState;
        if (!ds || e.pointerId !== ds.pointerId) return;
        ds.clientY = e.clientY;

        if (!ds.active) {
            if (Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY) < 5) return;
            activateDrag(ds);
        }

        e.preventDefault();
        e.stopPropagation();
        repositionDraggedRegexRow(ds);
    }, true);

    window.addEventListener('pointerup', (e) => {
        const ds = rState.dragState;
        if (!ds || e.pointerId !== ds.pointerId) return;
        if (ds.active) {
            e.preventDefault();
            e.stopPropagation();
        }
        finishDrag(false);
    }, true);

    window.addEventListener('pointercancel', (e) => {
        const ds = rState.dragState;
        if (!ds || e.pointerId !== ds.pointerId) return;
        finishDrag(true);
    }, true);

    window.addEventListener('touchstart', (e) => {
        if (rState.batchMode || !(e.target instanceof Element)) return;
        const handleEl = e.target.closest('#regex_container .regex-script-label .drag-handle');
        if (!handleEl) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }, { capture: true, passive: false });

    window.addEventListener('touchmove', (e) => {
        if (!rState.dragState?.active) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
    }, { capture: true, passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && rState.dragState?.active) {
            e.preventDefault();
            finishDrag(true);
        }
    }, true);
}

export function initRegexEnhancer() {
    bindGlobalRegexListenersOnce();
    const regexContainer = document.getElementById('regex_container');
    if (!regexContainer) return;
    if (!rState.initialized) {
        rState.initialized = true;
        rState.presetData = loadPresetData().data;
    }
    bindRegexContainerIfNeeded(regexContainer);
    scheduleEnhanceRegexLists();
}

export function onRegexPresetChanged() {
    rState.selectedItems.clear();
    rState.lastBatchId = null;
    const loaded = loadPresetData();
    rState.presetData = loaded.data;
    if (loaded.migratedFromBaibai) {
        savePresetDataDebounced(rState.presetData);
    }
    initRegexEnhancer();
}
