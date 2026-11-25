import { openGroupDialog, openItemDialog } from './dialog.js';
import {
    getGlobalSettings,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetDataDebounced,
} from './storage.js';
import { batchSetRegexEnabled, getRegexScopeInfo } from './st-bridge.js';

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
};

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
        if (!rState.presetData) rState.presetData = loadPresetData().data;
        return rState.presetData.regexGroups;
    }
    if (storeScope === 'scoped') {
        return getGlobalSettings().scopedRegexGroups;
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
            scheduleEnhanceRegexLists();
        } else if (action === 'select-all') {
            for (const cfg of CONTAINERS) {
                const listEl = document.getElementById(cfg.id);
                listEl?.querySelectorAll('.regex-script-label:not(.bb-collapsed-hidden):not(.bb-filter-hidden)').forEach(row => {
                    if (row.id) rState.selectedItems.set(row.id, { origin: cfg.origin, storeScope: cfg.storeScope });
                });
            }
            scheduleEnhanceRegexLists();
        } else if (action === 'apply') {
            const targetVal = toolbar.querySelector('.bb-batch-target')?.value || '';
            const [targetScope, targetGid] = targetVal ? targetVal.split(':') : ['', ''];
            const dirtyScopes = new Set();
            let movedCount = 0;

            for (const [id, info] of rState.selectedItems.entries()) {
                const itemScope = info.storeScope;
                const store = getStore(itemScope);
                if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
                if (!targetGid) {
                    store.items[id].groupId = null;
                    dirtyScopes.add(itemScope);
                    movedCount++;
                } else if (targetScope === itemScope) {
                    store.items[id].groupId = targetGid;
                    dirtyScopes.add(itemScope);
                    movedCount++;
                }
            }

            rState.selectedItems.clear();
            rState.batchMode = false;
            for (const s of dirtyScopes) await persistStore(s);
            scheduleEnhanceRegexLists();
            showNotice(movedCount > 0 ? `已移动 ${movedCount} 项正则` : '所选正则与目标分组不在同一范围');
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

    const globalGroups = getStore('global').groups;
    const presetGroups = getStore('preset').groups;
    const scopedGroups = getStore('scoped').groups;
    const options = [
        '<option value="">移入：默认（取消分组）</option>',
        ...globalGroups.map(g => `<option value="global:${esc(g.id)}">全局组：${esc(g.name)}</option>`),
        ...presetGroups.map(g => `<option value="preset:${esc(g.id)}">预设组：${esc(g.name)}</option>`),
        ...scopedGroups.map(g => `<option value="scoped:${esc(g.id)}">角色组：${esc(g.name)}</option>`),
    ].join('');

    el.classList.add('is-open');
    el.innerHTML = `
        <span class="bb-batch-count" title="直接点击下方正则条目即可选中（支持 Shift 连选）">已选 <strong>${rState.selectedItems.size}</strong> 项</span>
        <select class="bb-batch-target text_pole">${options}</select>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-btn-primary" data-batch-action="apply" ${rState.selectedItems.size ? '' : 'disabled'}>移动</button>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="select-all">全选</button>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="clear">清空</button>
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

        const rec = { row, id, enabled, matchFilter, group };
        itemRecords.push(rec);
        if (group) {
            itemsByGroup.get(group.id).push(rec);
        } else {
            ungroupedEntries.push(rec);
        }
    }

    const frag = document.createDocumentFragment();
    const hiddenTail = [];
    const placedGroups = new Set();
    let placedDefaultGroup = false;

    const appendGroupBlock = (group) => {
        placedGroups.add(group.id);
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
        placedDefaultGroup = true;
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

    for (const group of store.groups) {
        if ((itemsByGroup.get(group.id) || []).length === 0) {
            appendGroupBlock(group);
        }
    }

    for (const rec of itemRecords) {
        if (rec.group) {
            if (!placedGroups.has(rec.group.id)) {
                appendGroupBlock(rec.group);
            }
        } else if (!placedDefaultGroup) {
            appendDefaultGroupBlock();
        }
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
        const nextSelected = !rState.selectedItems.has(id);

        if (e.shiftKey && rState.lastBatchId && rState.lastBatchId !== id) {
            const visibleRows = Array.from(regexContainer.querySelectorAll('.regex-script-label:not(.bb-collapsed-hidden):not(.bb-filter-hidden)'));
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
                    await persistStore(storeScope);
                    scheduleEnhanceRegexLists();
                }
            }
            return;
        }

        if (e.target.closest('.regex-toggle-off')) {
            const row = e.target.closest('.regex-script-label');
            const listEl = row?.parentElement;
            const cfg = CONTAINERS.find(c => c.id === listEl?.id);
            if (!row || !cfg) return;
            const store = getStore(cfg.storeScope);
            const gid = store.items[row.id]?.groupId;
            const group = gid ? store.groups.find(g => g.id === gid) : null;
            if (group?.exclusive) {
                setTimeout(async () => {
                    const siblings = Array.from(listEl.querySelectorAll('.regex-script-label'))
                        .filter(el => el.id && el.id !== row.id && store.items[el.id]?.groupId === gid);
                    if (siblings.length) {
                        await batchSetRegexEnabled(siblings.map(el => ({
                            id: el.id,
                            origin: cfg.origin,
                            enabled: false,
                        })));
                        siblings.forEach(el => {
                            const chk = el.querySelector('.disable_regex');
                            if (chk) chk.checked = true;
                        });
                        scheduleEnhanceRegexLists();
                    }
                }, 40);
            }
        }
    });
}

export function initRegexEnhancer() {
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
    rState.presetData = loadPresetData().data;
    initRegexEnhancer();
}
