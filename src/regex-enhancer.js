import { openGroupDialog, openItemDialog } from './dialog.js';
import {
    getGlobalSettings,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetData,
} from './storage.js';
import { batchSetRegexEnabled, getRegexScopeInfo } from './st-bridge.js';

const CONTAINERS = [
    { id: 'saved_regex_scripts', origin: 'global', storeScope: 'global' },
    { id: 'saved_preset_scripts', origin: 'preset', storeScope: 'preset' },
    { id: 'saved_scoped_scripts', origin: 'scoped', storeScope: 'scoped' },
];

const rState = {
    initialized: false,
    rootObserver: null,
    observers: [],
    boundRootEl: null,
    toolbarEl: null,
    rafId: null,
    filter: 'all', // 'all' | 'enabled' | 'starred'
    query: '',
    batchMode: false,
    selectedItems: new Map(), // id -> { origin, storeScope }
    ungroupedCollapsed: { global: false, preset: false, scoped: false },
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
    rState.noticeTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
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

async function persistStore(storeScope) {
    if (storeScope === 'preset') {
        if (rState.presetData) await savePresetData(rState.presetData);
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

/**
 * Reads clean script name without injected scope/note badges.
 * @param {HTMLElement} row
 * @returns {string}
 */
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
        toolbar.className = 'bb-native-toolbar bb-regex-toolbar';
        toolbar.innerHTML = `
            <div class="bb-toolbar-row">
                <span class="bb-brand-badge" title="园丁鸟 (Bluebower)"><i class="fa-solid fa-dove"></i></span>
                <input type="search" class="bb-search text_pole" placeholder="搜索正则脚本、分组或备注..." />
                <div class="bb-pill-group">
                    <button type="button" class="bb-pill is-active" data-filter="all">全部</button>
                    <button type="button" class="bb-pill" data-filter="enabled">已启用</button>
                    <button type="button" class="bb-pill" data-filter="starred" title="仅看星标"><i class="fa-solid fa-star"></i></button>
                </div>
            </div>
            <div class="bb-toolbar-row bb-toolbar-actions">
                <select class="bb-regex-target-scope text_pole" title="新建分组的归属范围">
                    <option value="global">全局正则组</option>
                    <option value="preset">预设正则组</option>
                    <option value="scoped">角色正则组</option>
                </select>
                <button type="button" class="menu_button bb-btn-sm bb-new-group-btn"><i class="fa-solid fa-plus"></i><span>分组</span></button>
                <button type="button" class="menu_button bb-btn-sm bb-batch-btn"><i class="fa-solid fa-list-check"></i><span>批量整理</span></button>
            </div>
            <div class="bb-inline-notice"></div>
            <div class="bb-batch-drawer" id="bb_regex_batch"></div>
        `;
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
            toolbar.querySelectorAll('.bb-pill').forEach(p => p.classList.toggle('is-active', p === pill));
            scheduleEnhanceRegexLists();
        });
    });

    toolbar.querySelector('.bb-new-group-btn').addEventListener('click', async () => {
        const storeScope = toolbar.querySelector('.bb-regex-target-scope')?.value || 'global';
        const res = await openGroupDialog({ mode: 'create' });
        if (!res) return;
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
        if (!rState.batchMode) rState.selectedItems.clear();
        toolbar.querySelector('.bb-batch-btn').classList.toggle('is-active', rState.batchMode);
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
            toolbar.querySelector('.bb-batch-btn').classList.remove('is-active');
            for (const s of dirtyScopes) await persistStore(s);
            scheduleEnhanceRegexLists();
            showNotice(movedCount > 0 ? `已移动 ${movedCount} 项正则` : '所选正则与目标分组不在同一作用域');
        }
    });
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
        '<option value="">移入：未分组</option>',
        ...globalGroups.map(g => `<option value="global:${esc(g.id)}">全局组：${esc(g.name)}</option>`),
        ...presetGroups.map(g => `<option value="preset:${esc(g.id)}">预设组：${esc(g.name)}</option>`),
        ...scopedGroups.map(g => `<option value="scoped:${esc(g.id)}">角色组：${esc(g.name)}</option>`),
    ].join('');

    el.classList.add('is-open');
    el.innerHTML = `
        <span class="bb-batch-count">已选 <strong>${rState.selectedItems.size}</strong> 项</span>
        <select class="bb-batch-target text_pole">${options}</select>
        <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-btn-primary" data-batch-action="apply" ${rState.selectedItems.size ? '' : 'disabled'}>确认移动</button>
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
    renderBatchDrawer();

    rState.observers.forEach(item => item.observer.disconnect());
    try {
        for (const cfg of CONTAINERS) {
            const listEl = document.getElementById(cfg.id);
            if (!listEl) continue;
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
    const nativeItems = Array.from(listEl.children).filter(el => el.classList.contains('regex-script-label'));
    listEl.querySelectorAll('.bb-group-header, .bb-group-note-li').forEach(el => el.remove());

    const store = getStore(cfg.storeScope);
    if (!nativeItems.length && !store.groups.length) return;

    const groupMap = new Map(store.groups.map(g => [g.id, g]));
    const itemsByGroup = new Map(store.groups.map(g => [g.id, []]));
    const ungrouped = [];
    const forceExpand = Boolean(rState.query) || rState.filter !== 'all';

    for (const row of nativeItems) {
        const id = row.id;
        if (!id) continue;
        // Refresh cached script name if native editor renamed it
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
                || (group?.name || '').toLowerCase().includes(rState.query));

        row.classList.toggle('bb-filter-hidden', !matchFilter);
        row.classList.remove('bb-collapsed-hidden');

        decorateRegexRow(row, id, meta, group, cfg);

        if (group) {
            itemsByGroup.get(group.id).push({ row, enabled, matchFilter });
        } else {
            ungrouped.push({ row, enabled, matchFilter });
        }
    }

    const frag = document.createDocumentFragment();
    const hiddenTail = [];

    store.groups.forEach((group, idx) => {
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
        gHeader.innerHTML = `
            <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
            <span class="bb-group-name">${esc(group.name)}</span>
            ${group.exclusive ? '<span class="bb-tag bb-tag-exclusive" title="互斥单选组">互斥</span>' : ''}
            <span class="bb-count-badge">${enabledCount}/${entries.length}</span>
            <span class="bb-group-controls">
                <button type="button" class="bb-mini-btn" data-bb-act="up" ${idx === 0 ? 'disabled' : ''} title="上移分组"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="bb-mini-btn" data-bb-act="down" ${idx === store.groups.length - 1 ? 'disabled' : ''} title="下移分组"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="bb-mini-btn" data-bb-act="edit" title="编辑分组 / 互斥 / 备注"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="bb-mini-btn bb-danger-btn" data-bb-act="del" title="删除分组"><i class="fa-solid fa-xmark"></i></button>
                <label class="bb-switch-wrap" title="分组总开关">
                    <input type="checkbox" class="bb-switch bb-regex-group-toggle" ${enabledCount > 0 ? 'checked' : ''} />
                    <span class="bb-switch-slider"></span>
                </label>
            </span>
        `;
        frag.appendChild(gHeader);

        if (group.note && !isCollapsed) {
            const noteEl = document.createElement('div');
            noteEl.className = 'bb-group-note-li';
            noteEl.textContent = group.note;
            frag.appendChild(noteEl);
        }

        for (const entry of entries) {
            if (isCollapsed) entry.row.classList.add('bb-collapsed-hidden');
            frag.appendChild(entry.row);
        }
    });

    if (ungrouped.length) {
        const visibleUngrouped = ungrouped.filter(e => e.matchFilter);
        const isCollapsed = rState.ungroupedCollapsed[cfg.origin] && !forceExpand;
        if (!forceExpand || visibleUngrouped.length) {
            const enabledCount = ungrouped.filter(e => e.enabled).length;
            const uHeader = document.createElement('div');
            uHeader.className = 'bb-group-header bb-regex-group-header bb-ungrouped-header';
            uHeader.dataset.bbOrigin = cfg.origin;
            uHeader.innerHTML = `
                <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
                <span class="bb-group-name">未分组</span>
                <span class="bb-count-badge">${enabledCount}/${ungrouped.length}</span>
            `;
            frag.appendChild(uHeader);
        }
        for (const entry of ungrouped) {
            if (isCollapsed) entry.row.classList.add('bb-collapsed-hidden');
            frag.appendChild(entry.row);
        }
    }

    for (const row of hiddenTail) {
        frag.appendChild(row);
    }

    listEl.appendChild(frag);
}

function decorateRegexRow(row, id, meta, group, cfg) {
    const raw = findRawScript(id, cfg.origin);
    const scopeInfo = raw ? getRegexScopeInfo(raw) : null;

    const nameEl = row.querySelector('.regex_script_name');
    if (nameEl) {
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

    let extras = row.querySelector(':scope > .bb-item-extras');
    if (!extras) {
        extras = document.createElement('div');
        extras.className = 'bb-item-extras';
        const btnGroup = row.querySelector(':scope > .flex-container');
        if (btnGroup) {
            row.insertBefore(extras, btnGroup);
        } else {
            row.appendChild(extras);
        }
    }

    const tipParts = [];
    if (group) tipParts.push(`分组：${group.name}`);
    if (meta?.note) tipParts.push(`备注：${meta.note}`);
    const noteTitle = tipParts.length ? tipParts.join(' | ') : '设置所属分组与备注';

    extras.innerHTML = `
        ${rState.batchMode ? `<input type="checkbox" class="bb-batch-chk" data-id="${esc(id)}" data-origin="${cfg.origin}" data-scope="${cfg.storeScope}" ${rState.selectedItems.has(id) ? 'checked' : ''} />` : ''}
        <button type="button" class="bb-icon-action ${meta?.starred ? 'is-starred' : ''}" data-bb-regex-act="star" data-id="${esc(id)}" data-scope="${cfg.storeScope}" title="星标"><i class="${meta?.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
        <button type="button" class="bb-icon-action ${meta?.note ? 'has-note' : ''}" data-bb-regex-act="edit-item" data-id="${esc(id)}" data-scope="${cfg.storeScope}" title="${esc(noteTitle)}"><i class="fa-regular fa-note-sticky"></i></button>
    `;
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

    regexContainer.addEventListener('click', async (e) => {
        const gHeader = e.target.closest('.bb-regex-group-header');
        if (gHeader) {
            if (gHeader.classList.contains('bb-ungrouped-header')) {
                const origin = gHeader.dataset.bbOrigin;
                rState.ungroupedCollapsed[origin] = !rState.ungroupedCollapsed[origin];
                scheduleEnhanceRegexLists();
                return;
            }

            const gid = gHeader.dataset.bbGroupId;
            const storeScope = gHeader.dataset.bbStoreScope;
            const store = getStore(storeScope);
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
                        await persistStore(storeScope);
                        scheduleEnhanceRegexLists();
                    }
                } else if (act === 'edit') {
                    const res = await openGroupDialog({ mode: 'edit', group });
                    if (res) {
                        group.name = res.name;
                        group.note = res.note;
                        group.exclusive = res.exclusive;
                        await persistStore(storeScope);
                        scheduleEnhanceRegexLists();
                    }
                } else if (act === 'del') {
                    store.groups = store.groups.filter(g => g.id !== gid);
                    store.groups.forEach((g, i) => { g.order = i; });
                    for (const meta of Object.values(store.items)) {
                        if (meta.groupId === gid) meta.groupId = null;
                    }
                    await persistStore(storeScope);
                    scheduleEnhanceRegexLists();
                    showNotice('已删除分组');
                }
                return;
            }

            if (e.target.closest('.bb-switch-wrap')) return;
            group.collapsed = !group.collapsed;
            scheduleEnhanceRegexLists();
            await persistStore(storeScope);
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

    regexContainer.addEventListener('change', async (e) => {
        const target = e.target;

        if (target.classList.contains('bb-batch-chk')) {
            const id = target.dataset.id;
            if (target.checked) {
                rState.selectedItems.set(id, { origin: target.dataset.origin, storeScope: target.dataset.scope });
            } else {
                rState.selectedItems.delete(id);
            }
            renderBatchDrawer();
            return;
        }

        if (target.classList.contains('bb-regex-group-toggle')) {
            const gHeader = target.closest('.bb-regex-group-header');
            const gid = gHeader?.dataset?.bbGroupId;
            const storeScope = gHeader?.dataset?.bbStoreScope;
            const origin = gHeader?.dataset?.bbOrigin;
            const listEl = document.getElementById(CONTAINERS.find(c => c.origin === origin)?.id || '');
            const store = getStore(storeScope);
            const group = store.groups.find(g => g.id === gid);
            if (!group || !listEl) return;

            const nextEnabled = Boolean(target.checked);
            group.enabled = nextEnabled;

            const memberRows = Array.from(listEl.querySelectorAll('.regex-script-label'))
                .filter(row => store.items[row.id]?.groupId === gid);

            let updates;
            if (nextEnabled && group.exclusive && memberRows.length > 1) {
                const alreadyOn = memberRows.find(r => !r.querySelector('.disable_regex')?.checked);
                const keepId = (alreadyOn || memberRows[0]).id;
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
            await persistStore(storeScope);
            scheduleEnhanceRegexLists();
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
