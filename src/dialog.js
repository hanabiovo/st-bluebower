/**
 * Lightweight inline modal dialogs & floating ellipsis popover menu.
 */

let dialogBackdrop = null;
let activePopMenu = null;

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Closes any open floating ellipsis menu.
 */
export function closePopMenu() {
    if (activePopMenu) {
        activePopMenu.cleanup();
        activePopMenu = null;
    }
}

/**
 * Opens a compact floating action menu anchored to an ellipsis button.
 * @param {HTMLElement} anchorEl
 * @param {Array<{ key: string, icon: string, label: string, danger?: boolean }>} actions
 * @param {(key: string) => void} onSelect
 */
export function openPopMenu(anchorEl, actions, onSelect) {
    if (activePopMenu && activePopMenu.anchorEl === anchorEl) {
        closePopMenu();
        return;
    }
    closePopMenu();

    const menu = document.createElement('div');
    menu.className = 'bb-pop-menu ui-widget';
    menu.innerHTML = actions.map(a => `
        <button type="button" class="bb-pop-item ${a.danger ? 'is-danger' : ''}" data-key="${esc(a.key)}">
            <i class="${esc(a.icon)}"></i>
            <span>${esc(a.label)}</span>
        </button>
    `).join('');

    // Prevent clicks/taps inside floating menu from bubbling to ST's drawer auto-closer (`$('html').on('touchstart mousedown')`)
    for (const evt of ['touchstart', 'mousedown', 'mouseup', 'touchend']) {
        menu.addEventListener(evt, e => e.stopPropagation());
    }

    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    let left = rect.right - menuRect.width;
    if (top + menuRect.height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - menuRect.height - 4);
    }
    if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
    }
    if (left < 8) left = 8;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;

    const onDocClick = (e) => {
        if (!menu.contains(e.target) && !anchorEl.contains(e.target)) {
            closePopMenu();
        }
    };
    const onScrollOrKey = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        closePopMenu();
    };

    const cleanup = () => {
        document.removeEventListener('pointerdown', onDocClick, true);
        document.removeEventListener('keydown', onScrollOrKey);
        window.removeEventListener('scroll', onScrollOrKey, true);
        setTimeout(() => menu.remove(), 40);
    };

    menu.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.target.closest('.bb-pop-item');
        if (!btn) return;
        const key = btn.dataset.key;
        closePopMenu();
        onSelect(key);
    });

    setTimeout(() => {
        document.addEventListener('pointerdown', onDocClick, true);
        document.addEventListener('keydown', onScrollOrKey);
        window.addEventListener('scroll', onScrollOrKey, true);
    }, 0);

    activePopMenu = { anchorEl, cleanup };
}

/**
 * Opens a small centered dialog for creating or editing a group.
 */
export function openGroupDialog({ mode, group = null, scopeOptions = null, defaultScope = 'preset' }) {
    const scopeFieldHtml = Array.isArray(scopeOptions) && scopeOptions.length ? `
        <label class="bb-field">
            <span>归属范围</span>
            <select name="scope" class="text_pole">
                ${scopeOptions.map(opt => `<option value="${esc(opt.value)}" ${opt.value === defaultScope ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}
            </select>
        </label>
    ` : '';

    return openFormDialog(`
        <form class="bb-dialog-card">
            <div class="bb-dialog-title">${mode === 'edit' ? '编辑分组' : '新建分组'}</div>
            ${scopeFieldHtml}
            <label class="bb-field">
                <span>分组名称</span>
                <input type="text" name="name" class="text_pole" required maxlength="40" value="${esc(group?.name || '')}" placeholder="例如：思维链 / 文风 / 状态栏" />
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
                <button type="button" class="menu_button bb-dialog-cancel">取消</button>
                <button type="submit" class="menu_button bb-btn-primary">保存</button>
            </div>
        </form>
    `, (fd) => {
        const name = String(fd.get('name') || '').trim();
        if (!name) return null;
        return {
            name,
            note: String(fd.get('note') || '').trim(),
            exclusive: Boolean(fd.get('exclusive')),
            scope: String(fd.get('scope') || defaultScope),
        };
    });
}

/**
 * Opens a small centered dialog for editing an item's group assignment and personal note.
 */
export function openItemDialog({ itemName, note = '', groupId = null, groups = [] }) {
    const groupOptions = [
        `<option value="" ${!groupId ? 'selected' : ''}>未分组</option>`,
        ...groups.map(g => `<option value="${esc(g.id)}" ${groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`),
    ].join('');

    return openFormDialog(`
        <form class="bb-dialog-card">
            <div class="bb-dialog-title">分组与备注 · ${esc(itemName)}</div>
            <label class="bb-field">
                <span>所属分组</span>
                <select name="groupId" class="text_pole">${groupOptions}</select>
            </label>
            <label class="bb-field">
                <span>个人备注（留空则清除）</span>
                <input type="text" name="note" class="text_pole" maxlength="120" value="${esc(note)}" placeholder="写点方便自己识别的说明..." />
            </label>
            <div class="bb-dialog-footer">
                <button type="button" class="menu_button bb-dialog-cancel">取消</button>
                <button type="submit" class="menu_button bb-btn-primary">保存</button>
            </div>
        </form>
    `, (fd) => ({
        groupId: String(fd.get('groupId') || '') || null,
        note: String(fd.get('note') || '').trim(),
    }));
}

/**
 * Opens a destination picker dialog after selecting multiple items ("select first, choose group second").
 * Requires an explicit choice before unlocking Confirm so users never move to the wrong group by accident.
 * Also supports creating a brand-new group on the spot and moving selected items into it.
 * @param {{ count: number, groups: Array<{ id: string, name: string }>, ungroupLabel?: string, scopeLabel?: string }} opts
 * @returns {Promise<{ type: 'group', groupId: string, groupName: string } | { type: 'new', name: string, exclusive: boolean } | { type: 'ungroup' } | null>}
 */
export function openBatchMoveDialog({ count, groups = [], ungroupLabel = '移出分组（设为未分组）', scopeLabel = '' }) {
    return new Promise((resolve) => {
        closePopMenu();
        if (dialogBackdrop) {
            dialogBackdrop.remove();
            dialogBackdrop = null;
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'bb-dialog-backdrop ui-widget';
        const scopeTitle = scopeLabel ? `${esc(scopeLabel)} · ` : '';
        const groupButtonsHtml = groups.length
            ? groups.map(g => `
                <button type="button" class="bb-dest-item" data-choice="group:${esc(g.id)}" data-name="${esc(g.name)}">
                    <i class="fa-regular fa-folder bb-dest-icon"></i>
                    <span class="bb-dest-name">${esc(g.name)}</span>
                    <i class="fa-solid fa-check bb-dest-check"></i>
                </button>
            `).join('')
            : '<div class="bb-dest-empty">当前还没有已建分组，可直接下方新建并移入</div>';

        backdrop.innerHTML = `
            <form class="bb-dialog-card bb-batch-dest-card">
                <div class="bb-dialog-title">${scopeTitle}将已选 ${count} 项移入…</div>
                <div class="bb-dest-list" role="listbox">
                    ${groupButtonsHtml}
                </div>
                <div class="bb-dest-extra">
                    <button type="button" class="bb-dest-item bb-dest-new-trigger" data-choice="__new__">
                        <i class="fa-solid fa-folder-plus bb-dest-icon"></i>
                        <span class="bb-dest-name">新建分组并移入…</span>
                        <i class="fa-solid fa-check bb-dest-check"></i>
                    </button>
                    <div class="bb-dest-new-box">
                        <input type="text" class="text_pole bb-dest-new-input" maxlength="40" placeholder="输入新分组名称..." />
                        <label class="bb-field-check">
                            <input type="checkbox" class="bb-dest-new-excl" />
                            <span>设为互斥单选组</span>
                        </label>
                    </div>
                    <button type="button" class="bb-dest-item bb-dest-ungroup" data-choice="__ungroup__">
                        <i class="fa-solid fa-folder-open bb-dest-icon"></i>
                        <span class="bb-dest-name">${esc(ungroupLabel)}</span>
                        <i class="fa-solid fa-check bb-dest-check"></i>
                    </button>
                </div>
                <div class="bb-dialog-footer">
                    <button type="button" class="menu_button bb-dialog-cancel">取消</button>
                    <button type="submit" class="menu_button bb-btn-primary bb-dest-confirm" disabled>确定移入</button>
                </div>
            </form>
        `;
        dialogBackdrop = backdrop;

        for (const evt of ['touchstart', 'mousedown', 'mouseup', 'touchend']) {
            backdrop.addEventListener(evt, e => e.stopPropagation());
        }

        let selectedChoice = null;
        let selectedName = '';
        const newBox = backdrop.querySelector('.bb-dest-new-box');
        const newInput = backdrop.querySelector('.bb-dest-new-input');
        const newExcl = backdrop.querySelector('.bb-dest-new-excl');
        const confirmBtn = backdrop.querySelector('.bb-dest-confirm');

        const syncConfirmState = () => {
            if (!selectedChoice) {
                confirmBtn.disabled = true;
                return;
            }
            if (selectedChoice === '__new__') {
                confirmBtn.disabled = !newInput.value.trim();
                return;
            }
            confirmBtn.disabled = false;
        };

        backdrop.querySelectorAll('.bb-dest-item').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedChoice = btn.dataset.choice;
                selectedName = btn.dataset.name || '';
                backdrop.querySelectorAll('.bb-dest-item').forEach(el => {
                    el.classList.toggle('is-selected', el === btn);
                });
                const isNew = selectedChoice === '__new__';
                newBox.classList.toggle('is-open', isNew);
                syncConfirmState();
                if (isNew && !window.matchMedia?.('(pointer: coarse)').matches) {
                    setTimeout(() => newInput.focus({ preventScroll: true }), 20);
                }
            });
        });

        newInput.addEventListener('input', syncConfirmState);

        let unbindViewport = null;
        const close = (result) => {
            document.removeEventListener('keydown', onKey);
            if (document.activeElement instanceof HTMLElement && backdrop.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            unbindViewport?.();
            if (dialogBackdrop === backdrop) dialogBackdrop = null;
            setTimeout(() => backdrop.remove(), 40);
            resolve(result);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
        };

        backdrop.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === backdrop || e.target.closest('.bb-dialog-cancel')) {
                close(null);
            }
        });

        backdrop.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            if (!selectedChoice) return;
            if (selectedChoice === '__ungroup__') {
                close({ type: 'ungroup' });
            } else if (selectedChoice === '__new__') {
                const name = newInput.value.trim();
                if (!name) return;
                close({ type: 'new', name, exclusive: Boolean(newExcl.checked) });
            } else if (selectedChoice.startsWith('group:')) {
                close({
                    type: 'group',
                    groupId: selectedChoice.slice('group:'.length),
                    groupName: selectedName,
                });
            }
        });

        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
        unbindViewport = bindViewportPin(backdrop);
    });
}

/**
 * Pins a fixed modal backdrop to `window.visualViewport` so mobile virtual keyboard
 * open/close never causes the dialog to drift to the top or get stuck scrolled.
 * @param {HTMLElement} backdropEl
 * @returns {() => void} cleanup function
 */
export function bindViewportPin(backdropEl) {
    let timers = [];
    const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers = [];
    };

    const sync = () => {
        if (!backdropEl.isConnected) return;
        if (window.scrollX !== 0 || window.scrollY !== 0) {
            window.scrollTo(0, 0);
        }
        const vv = window.visualViewport;
        if (vv) {
            backdropEl.style.top = `${Math.round(vv.offsetTop)}px`;
            backdropEl.style.left = `${Math.round(vv.offsetLeft)}px`;
            backdropEl.style.width = `${Math.round(vv.width)}px`;
            backdropEl.style.height = `${Math.round(vv.height)}px`;
            backdropEl.style.right = 'auto';
            backdropEl.style.bottom = 'auto';
        }
    };

    const settleSync = () => {
        clearTimers();
        sync();
        requestAnimationFrame(sync);
        for (const delay of [60, 180, 360]) {
            timers.push(setTimeout(sync, delay));
        }
    };

    sync();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    backdropEl.addEventListener('focusin', settleSync);
    backdropEl.addEventListener('focusout', settleSync);

    return () => {
        clearTimers();
        vv?.removeEventListener('resize', sync);
        vv?.removeEventListener('scroll', sync);
        window.removeEventListener('resize', sync);
        backdropEl.removeEventListener('focusin', settleSync);
        backdropEl.removeEventListener('focusout', settleSync);
        if (window.scrollX !== 0 || window.scrollY !== 0) {
            window.scrollTo(0, 0);
        }
    };
}

function openFormDialog(html, extractor) {
    return new Promise((resolve) => {
        closePopMenu();
        if (dialogBackdrop) {
            dialogBackdrop.remove();
            dialogBackdrop = null;
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'bb-dialog-backdrop ui-widget';
        backdrop.innerHTML = html;
        dialogBackdrop = backdrop;

        // Prevent clicks/taps inside dialog from triggering SillyTavern's unpinned drawer auto-close (`$('html').on('touchstart mousedown')`)
        for (const evt of ['touchstart', 'mousedown', 'mouseup', 'touchend']) {
            backdrop.addEventListener(evt, e => e.stopPropagation());
        }

        let unbindViewport = null;
        const close = (result) => {
            document.removeEventListener('keydown', onKey);
            if (document.activeElement instanceof HTMLElement && backdrop.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            unbindViewport?.();
            if (dialogBackdrop === backdrop) dialogBackdrop = null;
            setTimeout(() => backdrop.remove(), 40);
            resolve(result);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
        };

        backdrop.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === backdrop || e.target.closest('.bb-dialog-cancel')) {
                close(null);
            }
        });

        backdrop.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            close(extractor(fd));
        });

        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
        unbindViewport = bindViewportPin(backdrop);
        // Intentionally do NOT auto-focus inputs so mobile soft keyboard never pops up uninvited
    });
}
