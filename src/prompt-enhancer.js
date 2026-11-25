import { openBatchMoveDialog, openGroupDialog, openItemDialog, openPopMenu } from './dialog.js';
import {
    getGlobalSettings,
    loadPresetData,
    makeId,
    normalizeGroupStore,
    saveGlobalSettings,
    savePresetData,
    savePresetDataDebounced,
} from './storage.js';
import { batchSetPromptsEnabled } from './st-bridge.js';

const CONTEXT_MARKER_IDS = new Set([
    'chatHistory',
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
]);

const pState = {
    initialized: false,
    containerObserver: null,
    listObserver: null,
    boundContainerEl: null,
    boundListEl: null,
    topbarLi: null,
    rafId: null,
    searchOpen: false,
    filter: 'all', // 'all' | 'enabled' | 'starred'
    query: '',
    batchMode: false,
    selectedIds: new Set(),
    lastBatchId: null,
    starredCollapsed: false,
    presetData: null,
    searchTimer: null,
    noticeTimer: null,
    fallbackTokenCache: new Map(),
    fallbackCalcToken: 0,
};

function isContextMarkerItem(li, id) {
    return li.classList.contains('completion_prompt_manager_marker') || CONTEXT_MARKER_IDS.has(id);
}

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
    const el = pState.topbarLi?.querySelector('.bb-inline-notice');
    if (!el) return;
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(pState.noticeTimer);
    pState.noticeTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

function loadCurrentPresetState() {
    const loaded = loadPresetData();
    pState.presetData = loaded.data;
    if (loaded.migratedFromBaibai) {
        savePresetData(pState.presetData).then(() => {
            showNotice('已自动迁移柏宝箱分组');
        });
    }
}

function ensureTopbarLi() {
    if (pState.topbarLi) return pState.topbarLi;

    const li = document.createElement('li');
    li.id = 'bb_prompt_topbar';
    li.className = 'bb-list-topbar';
    li.innerHTML = `
        <div class="bb-topbar-main">
            <div class="bb-topbar-status">
                <i class="fa-solid fa-dove bb-bird-icon" title="园丁鸟 (Bluebower)"></i>
                <span class="bb-status-text">预设分组</span>
                <span class="bb-topbar-tokens" title="仅统计已启用的纯预设提示词 Token（不含聊天记录、世界书、角色卡与人设等上下文槽位）"></span>
                <span class="bb-inline-notice"></span>
            </div>
            <div class="bb-topbar-icons">
                <button type="button" class="bb-head-icon bb-search-toggle" title="搜索与筛选"><i class="fa-solid fa-magnifying-glass"></i></button>
                <button type="button" class="bb-head-icon bb-new-group-btn" title="新建分组"><i class="fa-solid fa-folder-plus"></i></button>
                <button type="button" class="bb-head-icon bb-batch-btn" title="批量移动条目"><i class="fa-solid fa-list-check"></i></button>
                <button type="button" class="bb-head-icon bb-lock-btn" title="切换分组折叠 / 原始顺序拖拽"><i class="fa-solid fa-lock"></i></button>
            </div>
        </div>
        <div class="bb-search-drawer">
            <input type="search" class="bb-search text_pole" placeholder="搜索条目、分组或备注..." />
            <div class="bb-filter-pills">
                <button type="button" class="bb-pill is-active" data-filter="all">全部</button>
                <button type="button" class="bb-pill" data-filter="enabled">已启用</button>
                <button type="button" class="bb-pill" data-filter="starred" title="仅看星标"><i class="fa-solid fa-star"></i></button>
            </div>
        </div>
        <div class="bb-batch-drawer" id="bb_prompt_batch"></div>
        <div class="bb-starred-mirror" id="bb_prompt_starred"></div>
    `;

    li.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    bindTopbarEvents(li);
    pState.topbarLi = li;
    return li;
}

function bindTopbarEvents(topbar) {
    const getListEl = () => document.getElementById('completion_prompt_manager_list');
    const searchInput = topbar.querySelector('.bb-search');

    topbar.querySelector('.bb-search-toggle').addEventListener('click', () => {
        pState.searchOpen = !pState.searchOpen;
        if (!pState.searchOpen && (pState.query || pState.filter !== 'all')) {
            pState.query = '';
            pState.filter = 'all';
            searchInput.value = '';
        }
        scheduleEnhancePromptList();
        if (pState.searchOpen && !window.matchMedia?.('(pointer: coarse)').matches) {
            setTimeout(() => searchInput.focus({ preventScroll: true }), 20);
        }
    });

    searchInput.addEventListener('input', () => {
        clearTimeout(pState.searchTimer);
        pState.searchTimer = setTimeout(() => {
            pState.query = searchInput.value.trim().toLowerCase();
            scheduleEnhancePromptList();
        }, 100);
    });

    topbar.querySelectorAll('.bb-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            pState.filter = pill.dataset.filter;
            scheduleEnhancePromptList();
        });
    });

    topbar.querySelector('.bb-new-group-btn').addEventListener('click', async () => {
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
        savePresetDataDebounced(pState.presetData);
        scheduleEnhancePromptList();
    });

    topbar.querySelector('.bb-batch-btn').addEventListener('click', () => {
        pState.batchMode = !pState.batchMode;
        if (!pState.batchMode) {
            pState.selectedIds.clear();
            pState.lastBatchId = null;
        }
        scheduleEnhancePromptList();
    });

    topbar.querySelector('.bb-lock-btn').addEventListener('click', () => {
        const locked = !pState.presetData.settings.lockPromptOrder;
        pState.presetData.settings.lockPromptOrder = locked;
        const gs = getGlobalSettings();
        gs.lockPromptOrder = locked;
        saveGlobalSettings();
        savePresetDataDebounced(pState.presetData);
        scheduleEnhancePromptList();
        showNotice(locked ? '已开启分组折叠' : '已切换为原序拖拽模式');
    });

    topbar.querySelector('#bb_prompt_batch').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-batch-action]');
        if (!btn) return;
        const action = btn.dataset.batchAction;
        if (action === 'clear') {
            pState.selectedIds.clear();
            pState.lastBatchId = null;
            scheduleEnhancePromptList();
        } else if (action === 'exit') {
            pState.selectedIds.clear();
            pState.lastBatchId = null;
            pState.batchMode = false;
            scheduleEnhancePromptList();
        } else if (action === 'choose-dest') {
            const count = pState.selectedIds.size;
            if (!count) return;
            const store = pState.presetData.promptGroups;
            const dest = await openBatchMoveDialog({
                count,
                groups: store.groups,
                ungroupLabel: '移出分组（设为未分组）',
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
                noticeMsg = `已新建「${dest.name}」并移入 ${count} 项`;
            } else if (dest.type === 'group') {
                targetGid = dest.groupId;
                noticeMsg = `已将 ${count} 项移入「${dest.groupName}」`;
            } else {
                targetGid = null;
                noticeMsg = `已将 ${count} 项移出分组`;
            }

            for (const id of pState.selectedIds) {
                if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
                store.items[id].groupId = targetGid;
            }
            pState.selectedIds.clear();
            pState.lastBatchId = null;
            pState.batchMode = false;
            savePresetDataDebounced(pState.presetData);
            scheduleEnhancePromptList();
            showNotice(noticeMsg);
        }
    });

    topbar.querySelector('#bb_prompt_starred').addEventListener('click', (e) => {
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
            savePresetDataDebounced(pState.presetData);
            scheduleEnhancePromptList();
            return;
        }
        const toggleBtn = e.target.closest('.bb-mirror-toggle');
        if (toggleBtn) {
            const id = toggleBtn.dataset.id;
            const realLi = getListEl()?.querySelector(`.completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(id)}"]`);
            realLi?.querySelector('.prompt-manager-toggle-action')?.click();
        }
    });
}

function syncTopbarControls(enabledTotal, totalCount, presetTokenSum = 0) {
    const topbar = pState.topbarLi;
    if (!topbar || !pState.presetData) return;

    const locked = Boolean(pState.presetData.settings?.lockPromptOrder ?? true);
    if (totalCount > 0) {
        topbar.querySelector('.bb-status-text').textContent = locked
            ? `已启用 ${enabledTotal}/${totalCount}`
            : `原序 (${enabledTotal}/${totalCount})`;
    }
    const tokEl = topbar.querySelector('.bb-topbar-tokens');
    if (tokEl) {
        tokEl.textContent = presetTokenSum > 0 ? `· ${presetTokenSum} Token` : '';
    }

    const hasSearchOrFilter = pState.searchOpen || Boolean(pState.query) || pState.filter !== 'all';
    topbar.querySelector('.bb-search-toggle').classList.toggle('is-active', hasSearchOrFilter);
    topbar.querySelector('.bb-search-drawer').classList.toggle('is-open', hasSearchOrFilter);
    topbar.querySelectorAll('.bb-pill').forEach(p => {
        p.classList.toggle('is-active', p.dataset.filter === pState.filter);
    });
    topbar.classList.toggle('is-batch-active', pState.batchMode);
    topbar.querySelector('.bb-batch-btn').classList.toggle('is-active', pState.batchMode);

    const lockBtn = topbar.querySelector('.bb-lock-btn');
    lockBtn.classList.toggle('is-active', !locked);
    lockBtn.innerHTML = locked
        ? '<i class="fa-solid fa-lock"></i>'
        : '<i class="fa-solid fa-lock-open"></i>';
    lockBtn.title = locked ? '当前：分组折叠（点击切换为原序拖拽）' : '当前：原序拖拽（点击返回分组折叠）';

    renderBatchDrawer();
}

function applyLockOrderState(listEl, locked) {
    listEl.classList.toggle('bb-order-locked', locked);
    // CRITICAL: Never use sortable('disable') because jQuery UI adds `.ui-state-disabled`
    // which sets `pointer-events: none` on the entire list in jquery-ui.min.css, breaking mobile taps!
    listEl.classList.remove('ui-state-disabled', 'ui-sortable-disabled');
    const $ = window.jQuery;
    if ($ && typeof $(listEl).sortable === 'function') {
        try {
            if ($(listEl).sortable('instance') || $(listEl).data('ui-sortable')) {
                $(listEl).sortable('option', 'disabled', false);
                $(listEl).sortable('option', 'items', locked ? '.bb-no-drag-items' : '.completion_prompt_manager_prompt_draggable');
            }
        } catch {
            // Ignore if sortable is not initialized yet
        }
    }
}

function renderBatchDrawer() {
    const el = pState.topbarLi?.querySelector('#bb_prompt_batch');
    if (!el) return;
    if (!pState.batchMode) {
        el.innerHTML = '';
        el.classList.remove('is-open');
        return;
    }
    const count = pState.selectedIds.size;
    el.classList.add('is-open');
    el.innerHTML = `
        <span class="bb-batch-count ${count ? '' : 'is-empty'}">${count ? `已选 <strong>${count}</strong> 项` : '点击下方条目即可多选'}</span>
        <div class="bb-batch-actions">
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-btn-primary" data-batch-action="choose-dest" ${count ? '' : 'disabled'}>移入分组…</button>
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="clear" ${count ? '' : 'disabled'}>重选</button>
            <button type="button" class="menu_button bb-btn-sm bb-drawer-btn" data-batch-action="exit">完成</button>
        </div>
    `;
}

function getCleanPromptName(li, fallbackId) {
    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (nameEl?.dataset?.pmName) return nameEl.dataset.pmName.trim();
    const inspectLink = nameEl?.querySelector('.prompt-manager-inspect-action');
    if (inspectLink?.textContent) return inspectLink.textContent.trim();
    return fallbackId;
}

function computeFallbackPresetTokensAsync(missingPrompts) {
    const ctx = window.SillyTavern?.getContext?.();
    if (typeof ctx?.getTokenCountAsync !== 'function' || !missingPrompts.length) return;

    const runId = ++pState.fallbackCalcToken;
    (async () => {
        let updated = false;
        for (const item of missingPrompts) {
            if (runId !== pState.fallbackCalcToken) return;
            try {
                // Strip ST comment macros `{{// ... }}` when estimating outside of a chat
                const cleaned = String(item.content || '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '').trim();
                const count = cleaned ? await ctx.getTokenCountAsync(cleaned) : 0;
                pState.fallbackTokenCache.set(item.cacheKey, Number.isFinite(count) && count > 0 ? count : 0);
                updated = true;
            } catch {
                pState.fallbackTokenCache.set(item.cacheKey, 0);
            }
        }
        if (updated && runId === pState.fallbackCalcToken) {
            scheduleEnhancePromptList();
        }
    })();
}

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
    bindListIfNeeded(listEl);

    const topbarLi = ensureTopbarLi();
    const locked = Boolean(pState.presetData.settings?.lockPromptOrder ?? true);
    applyLockOrderState(listEl, locked);
    listEl.classList.toggle('bb-batch-mode', pState.batchMode);

    const nativeItems = Array.from(listEl.children).filter(el => el.classList.contains('completion_prompt_manager_prompt'));

    pState.listObserver?.disconnect();
    try {
        const headLi = listEl.querySelector('.completion_prompt_manager_list_head');
        const sepLi = listEl.querySelector('.completion_prompt_manager_list_separator');
        if (headLi) headLi.classList.add('bb-native-head-hidden');
        if (sepLi) sepLi.classList.add('bb-native-head-hidden');

        listEl.querySelectorAll('.bb-group-header, .bb-group-note-li').forEach(el => el.remove());

        if (!nativeItems.length) {
            if (listEl.firstElementChild !== topbarLi) {
                listEl.prepend(topbarLi);
            }
            syncTopbarControls(0, 0, 0);
            renderStarredMirror([], false);
            return;
        }

        nativeItems.forEach((li, idx) => {
            if (li.dataset.bbOrigIdx === undefined) {
                li.dataset.bbOrigIdx = String(idx);
            }
        });
        nativeItems.sort((a, b) => Number(a.dataset.bbOrigIdx) - Number(b.dataset.bbOrigIdx));

        const ctx = window.SillyTavern?.getContext?.();
        const rawPromptsArr = Array.isArray(ctx?.chatCompletionSettings?.prompts) ? ctx.chatCompletionSettings.prompts : [];
        const rawPromptMap = new Map(rawPromptsArr.filter(Boolean).map(p => [p.identifier, p]));
        const tokenizerName = String(ctx?.getTokenizerModel?.() || 'default');
        const hasLiveDomTokens = nativeItems.some(
            el => Number.parseInt(el.querySelector('.prompt_manager_prompt_tokens')?.dataset?.pmTokens || '', 10) > 0,
        );
        const missingFallbackPrompts = [];

        const store = pState.presetData.promptGroups;
        const groupMap = new Map(store.groups.map(g => [g.id, g]));
        const itemsByGroup = new Map(store.groups.map(g => [g.id, []]));
        const itemRecords = [];
        const starred = [];
        const forceExpand = Boolean(pState.query) || pState.filter !== 'all';
        let enabledTotal = 0;
        let presetTokenSum = 0;

        for (const li of nativeItems) {
            const id = li.dataset.pmIdentifier;
            if (!id) continue;
            const meta = store.items[id] || { groupId: null, starred: false, note: '' };
            const enabled = !li.classList.contains('completion_prompt_manager_prompt_disabled');
            if (enabled) enabledTotal++;

            const isMarker = isContextMarkerItem(li, id);
            const nameText = getCleanPromptName(li, id);
            const rawTok = Number.parseInt(li.querySelector('.prompt_manager_prompt_tokens')?.dataset?.pmTokens || '', 10);
            let tokenVal = Number.isFinite(rawTok) && rawTok > 0 ? rawTok : 0;

            // Outside a chat (`总 Token 数量：0`), use cached tokenizer fallback for enabled non-marker preset prompts
            if (!hasLiveDomTokens && !isMarker && enabled) {
                const pObj = rawPromptMap.get(id);
                const content = typeof pObj?.content === 'string' ? pObj.content : '';
                if (content) {
                    const cacheKey = `${tokenizerName}::${id}::${content.length}::${content.slice(0, 24)}`;
                    if (pState.fallbackTokenCache.has(cacheKey)) {
                        tokenVal = pState.fallbackTokenCache.get(cacheKey) || 0;
                    } else {
                        missingFallbackPrompts.push({ id, cacheKey, content });
                    }
                }
            }

            // Pure preset prompt token count (excludes chatHistory, worldInfo, charCard, persona, etc.)
            const presetTokVal = isMarker ? 0 : tokenVal;
            if (enabled) {
                presetTokenSum += presetTokVal;
            }

            const group = meta.groupId && groupMap.has(meta.groupId) ? groupMap.get(meta.groupId) : null;

            const matchFilter = (pState.filter !== 'enabled' || enabled)
                && (pState.filter !== 'starred' || meta.starred)
                && (!pState.query
                    || nameText.toLowerCase().includes(pState.query)
                    || (meta.note || '').toLowerCase().includes(pState.query)
                    || (group?.name || '').toLowerCase().includes(pState.query));

            li.classList.toggle('bb-filter-hidden', !matchFilter);
            li.classList.toggle('bb-batch-selected', pState.batchMode && pState.selectedIds.has(id));
            li.classList.remove('bb-collapsed-hidden', 'bb-grouped-child');
            delete li.dataset.bbMemberOf;

            decoratePromptItem(li, id, meta, group, locked);

            if (matchFilter && meta.starred) {
                starred.push({ id, name: nameText, enabled, tokenVal: presetTokVal, note: meta.note });
            }

            const rec = { li, id, enabled, tokenVal: presetTokVal, matchFilter, group };
            itemRecords.push(rec);
            if (group) {
                itemsByGroup.get(group.id).push(rec);
            }
        }

        if (missingFallbackPrompts.length > 0) {
            computeFallbackPresetTokensAsync(missingFallbackPrompts);
        }

        syncTopbarControls(enabledTotal, itemRecords.length, presetTokenSum);
        renderStarredMirror(starred, forceExpand);

        const frag = document.createDocumentFragment();
        frag.appendChild(topbarLi);
        if (headLi) frag.appendChild(headLi);
        if (sepLi) frag.appendChild(sepLi);

        if (!locked) {
            for (const rec of itemRecords) {
                frag.appendChild(rec.li);
            }
            listEl.appendChild(frag);
            return;
        }

        const hiddenTail = [];
        const placedGroups = new Set();

        const appendGroupBlock = (group) => {
            placedGroups.add(group.id);
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
            gHeader.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
            gHeader.innerHTML = `
                <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
                <span class="bb-group-name">${esc(group.name)}</span>
                <span class="bb-group-meta">(${enabledCount}/${entries.length})</span>
                ${tokenSum > 0 ? `<span class="bb-group-tokens" title="组内已启用纯预设词条 Token（不含世界书、聊天记录等上下文槽位）">~${formatTokens(tokenSum)}</span>` : ''}
                ${group.exclusive ? '<span class="bb-tag bb-tag-exclusive" title="互斥单选组">互斥</span>' : ''}
                <span class="bb-group-controls">
                    <span class="bb-group-toggle-icon fa-solid ${enabledCount > 0 ? 'fa-toggle-on is-on' : 'fa-toggle-off'}" data-bb-act="toggle" title="整组开关"></span>
                    <button type="button" class="bb-row-icon" data-bb-act="edit" title="编辑分组 / 互斥 / 备注"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="bb-row-icon bb-danger-icon" data-bb-act="del" title="删除分组"><i class="fa-solid fa-trash"></i></button>
                </span>
            `;
            frag.appendChild(gHeader);

            if (group.note) {
                const noteLi = document.createElement('li');
                noteLi.className = `bb-group-note-li ${isCollapsed ? 'bb-collapsed-hidden' : ''}`;
                noteLi.dataset.bbNoteOf = group.id;
                noteLi.textContent = group.note;
                frag.appendChild(noteLi);
            }

            for (const entry of entries) {
                entry.li.classList.add('bb-grouped-child');
                entry.li.dataset.bbMemberOf = group.id;
                if (isCollapsed) entry.li.classList.add('bb-collapsed-hidden');
                frag.appendChild(entry.li);
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
            } else {
                frag.appendChild(rec.li);
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
    const box = pState.topbarLi?.querySelector('#bb_prompt_starred');
    if (!box) return;
    if (!starred.length) {
        box.innerHTML = '';
        return;
    }
    const isCollapsed = pState.starredCollapsed && !forceExpand;
    box.innerHTML = `
        <div class="bb-starred-header">
            <span class="bb-chevron"><i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></span>
            <span class="bb-group-name"><i class="fa-solid fa-star bb-star-icon"></i> 收藏置顶</span>
            <span class="bb-group-meta">(${starred.length})</span>
        </div>
        ${isCollapsed ? '' : `
            <div class="bb-starred-items">
                ${starred.map(s => `
                    <div class="bb-starred-row ${s.enabled ? '' : 'is-disabled'}">
                        <button type="button" class="bb-star-mirror-unstar" data-id="${esc(s.id)}" title="取消星标"><i class="fa-solid fa-star"></i></button>
                        <span class="bb-starred-name" title="${esc(s.name)}">${esc(s.name)}</span>
                        ${s.note ? `<span class="bb-starred-note">${esc(s.note)}</span>` : ''}
                        ${s.tokenVal > 0 ? `<span class="bb-group-tokens">${formatTokens(s.tokenVal)}</span>` : ''}
                        <span class="bb-mirror-toggle bb-group-toggle-icon fa-solid ${s.enabled ? 'fa-toggle-on is-on' : 'fa-toggle-off'}" data-id="${esc(s.id)}" title="切换启用"></span>
                    </div>
                `).join('')}
            </div>
        `}
    `;
}

/**
 * Keeps only `[...]` + native `[pencil]` + native `[toggle]` on each prompt row!
 * Star, Group/Note (`fa-sliders`), and native Detach (`fa-link-slash`) are folded into `[...]`.
 */
function decoratePromptItem(li, id, meta, group, locked) {
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

    const hasMetaIndicator = Boolean(meta?.starred || meta?.note);
    extras.innerHTML = `
        <button type="button" class="bb-icon-action bb-more-btn ${hasMetaIndicator ? 'has-meta' : ''}" data-bb-item-act="more" data-id="${esc(id)}" title="更多操作"><i class="fa-solid fa-ellipsis"></i></button>
    `;

    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (nameEl) {
        let starMark = nameEl.querySelector('.bb-inline-star-mark');
        if (meta?.starred) {
            if (!starMark) {
                starMark = document.createElement('i');
                starMark.className = 'fa-solid fa-star bb-inline-star-mark';
                starMark.title = '已星标置顶';
                nameEl.appendChild(starMark);
            }
        } else if (starMark) {
            starMark.remove();
        }

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

    const $ = window.jQuery;
    if ($) {
        $(listEl).on('sortstop.bluebower', () => {
            if (pState.presetData?.settings?.lockPromptOrder) return;
            Array.from(listEl.children)
                .filter(el => el.classList.contains('completion_prompt_manager_prompt'))
                .forEach((li, i) => { li.dataset.bbOrigIdx = String(i); });
        });
    }

    // Capture-phase row click in batchMode: click anywhere on the item row to toggle selection!
    listEl.addEventListener('click', (e) => {
        if (!pState.batchMode) return;
        const li = e.target.closest('.completion_prompt_manager_prompt');
        if (!li || !li.dataset.pmIdentifier) return;
        // Still allow clicking controls if user explicitly clicked toggle/edit? No, clicking the row itself selects cleanly!
        e.preventDefault();
        e.stopPropagation();

        const id = li.dataset.pmIdentifier;
        const nextSelected = !pState.selectedIds.has(id);

        if (e.shiftKey && pState.lastBatchId && pState.lastBatchId !== id) {
            const visibleLis = Array.from(listEl.querySelectorAll('.completion_prompt_manager_prompt:not(.bb-collapsed-hidden):not(.bb-filter-hidden)'));
            const i1 = visibleLis.findIndex(el => el.dataset.pmIdentifier === pState.lastBatchId);
            const i2 = visibleLis.findIndex(el => el.dataset.pmIdentifier === id);
            if (i1 !== -1 && i2 !== -1) {
                const [start, end] = i1 < i2 ? [i1, i2] : [i2, i1];
                for (let i = start; i <= end; i++) {
                    const rowId = visibleLis[i].dataset.pmIdentifier;
                    if (!rowId) continue;
                    if (nextSelected) pState.selectedIds.add(rowId);
                    else pState.selectedIds.delete(rowId);
                    visibleLis[i].classList.toggle('bb-batch-selected', nextSelected);
                }
                pState.lastBatchId = id;
                renderBatchDrawer();
                return;
            }
        }

        if (nextSelected) pState.selectedIds.add(id);
        else pState.selectedIds.delete(id);
        li.classList.toggle('bb-batch-selected', nextSelected);
        pState.lastBatchId = id;
        renderBatchDrawer();
    }, true);

    const togglePromptGroupHeader = (groupHeader) => {
        const gid = groupHeader.dataset.bbGroupId;
        const store = pState.presetData?.promptGroups;
        const group = store?.groups?.find(g => g.id === gid);
        if (!group) return;

        const forceExpand = Boolean(pState.query) || pState.filter !== 'all';
        group.collapsed = !group.collapsed;
        if (!forceExpand) {
            const isCollapsed = group.collapsed;
            const icon = groupHeader.querySelector('.bb-chevron i');
            if (icon) {
                icon.classList.toggle('fa-chevron-right', isCollapsed);
                icon.classList.toggle('fa-chevron-down', !isCollapsed);
            }
            listEl.querySelectorAll(`[data-bb-member-of="${CSS.escape(gid)}"], [data-bb-note-of="${CSS.escape(gid)}"]`).forEach(el => {
                el.classList.toggle('bb-collapsed-hidden', isCollapsed);
            });
        }
        savePresetDataDebounced(pState.presetData);
    };

    // Fast mobile tap handler (`pointerdown` -> `pointerup`) so slight 2-8px finger roll never drops group fold taps
    let tapGesture = null;
    let lastTouchToggleAt = 0;

    listEl.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || e.isPrimary === false) return;
        if (e.target.closest('#bb_prompt_topbar, [data-bb-act]')) return;
        const groupHeader = e.target.closest('.bb-group-header');
        if (!groupHeader) return;
        tapGesture = {
            pointerId: e.pointerId,
            header: groupHeader,
            x: e.clientX,
            y: e.clientY,
            moved: false,
        };
    });

    listEl.addEventListener('pointermove', (e) => {
        if (!tapGesture || e.pointerId !== tapGesture.pointerId) return;
        if (Math.hypot(e.clientX - tapGesture.x, e.clientY - tapGesture.y) > 10) {
            tapGesture.moved = true;
        }
    });

    listEl.addEventListener('pointercancel', () => {
        tapGesture = null;
    });

    listEl.addEventListener('pointerup', (e) => {
        if (!tapGesture || e.pointerId !== tapGesture.pointerId) return;
        const g = tapGesture;
        tapGesture = null;
        if (g.moved || e.target.closest('[data-bb-act]')) return;
        if (e.target.closest('.bb-group-header') !== g.header) return;
        lastTouchToggleAt = Date.now();
        togglePromptGroupHeader(g.header);
    });

    listEl.addEventListener('click', async (e) => {
        if (e.target.closest('#bb_prompt_topbar')) return;

        const groupHeader = e.target.closest('.bb-group-header');
        if (groupHeader) {
            const gid = groupHeader.dataset.bbGroupId;
            const store = pState.presetData.promptGroups;
            const group = store.groups.find(g => g.id === gid);
            if (!group) return;

            const actEl = e.target.closest('[data-bb-act]');
            if (actEl) {
                e.stopPropagation();
                const act = actEl.dataset.bbAct;
                if (act === 'toggle') {
                    const memberLis = Array.from(listEl.querySelectorAll('.completion_prompt_manager_prompt'))
                        .filter(li => store.items[li.dataset.pmIdentifier]?.groupId === gid);
                    const anyEnabled = memberLis.some(li => !li.classList.contains('completion_prompt_manager_prompt_disabled'));
                    const nextEnabled = !anyEnabled;
                    group.enabled = nextEnabled;

                    let updates;
                    if (nextEnabled && group.exclusive && memberLis.length > 1) {
                        const keepId = memberLis[0].dataset.pmIdentifier;
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
                    savePresetDataDebounced(pState.presetData);
                    scheduleEnhancePromptList();
                } else if (act === 'edit') {
                    const res = await openGroupDialog({ mode: 'edit', group });
                    if (res) {
                        group.name = res.name;
                        group.note = res.note;
                        group.exclusive = res.exclusive;
                        savePresetDataDebounced(pState.presetData);
                        scheduleEnhancePromptList();
                    }
                } else if (act === 'del') {
                    store.groups = store.groups.filter(g => g.id !== gid);
                    store.groups.forEach((g, i) => { g.order = i; });
                    for (const meta of Object.values(store.items)) {
                        if (meta.groupId === gid) meta.groupId = null;
                    }
                    savePresetDataDebounced(pState.presetData);
                    scheduleEnhancePromptList();
                    showNotice('已删除分组');
                }
                return;
            }

            if (Date.now() - lastTouchToggleAt < 450) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            togglePromptGroupHeader(groupHeader);
            return;
        }

        const itemActBtn = e.target.closest('[data-bb-item-act="more"]');
        if (itemActBtn) {
            e.stopPropagation();
            const id = itemActBtn.dataset.id;
            const li = itemActBtn.closest('.completion_prompt_manager_prompt');
            const store = pState.presetData.promptGroups;
            if (!store.items[id]) store.items[id] = { groupId: null, starred: false, note: '' };
            const isStarred = Boolean(store.items[id].starred);
            const detachEl = li?.querySelector('.prompt-manager-detach-action');

            const actions = [
                {
                    key: 'star',
                    icon: isStarred ? 'fa-solid fa-star' : 'fa-regular fa-star',
                    label: isStarred ? '取消星标置顶' : '设为星标置顶',
                },
                {
                    key: 'edit-item',
                    icon: 'fa-solid fa-sliders',
                    label: '分组与备注',
                },
            ];
            if (detachEl) {
                actions.push({
                    key: 'detach',
                    icon: 'fa-solid fa-link-slash',
                    label: '从列表移除',
                    danger: true,
                });
            }

            openPopMenu(itemActBtn, actions, async (key) => {
                if (key === 'star') {
                    store.items[id].starred = !store.items[id].starred;
                    savePresetDataDebounced(pState.presetData);
                    scheduleEnhancePromptList();
                } else if (key === 'edit-item') {
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
                        savePresetDataDebounced(pState.presetData);
                        scheduleEnhancePromptList();
                    }
                } else if (key === 'detach') {
                    detachEl?.click();
                }
            });
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
