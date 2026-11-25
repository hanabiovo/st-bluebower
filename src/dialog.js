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

        const close = (result) => {
            document.removeEventListener('keydown', onKey);
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

        const input = backdrop.querySelector('input[type="text"]');
        if (input) setTimeout(() => input.focus(), 20);
    });
}
