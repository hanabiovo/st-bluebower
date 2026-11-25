/**
 * Lightweight inline modal dialog for creating/editing groups and item settings.
 */

let dialogBackdrop = null;

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Opens a small centered dialog for creating or editing a group.
 * @param {{ mode: 'create' | 'edit', group?: Object, scopeOptions?: Array<{ value: string, label: string }>, defaultScope?: string }} options
 * @returns {Promise<{ name: string, note: string, exclusive: boolean, scope: string } | null>}
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
 * @param {{ itemName: string, note?: string, groupId?: string | null, groups?: Array }} options
 * @returns {Promise<{ note: string, groupId: string | null } | null>}
 */
export function openItemDialog({ itemName, note = '', groupId = null, groups = [] }) {
    const groupOptions = [
        `<option value="" ${!groupId ? 'selected' : ''}>未分组</option>`,
        ...groups.map(g => `<option value="${esc(g.id)}" ${groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`),
    ].join('');

    return openFormDialog(`
        <form class="bb-dialog-card">
            <div class="bb-dialog-title">条目设置 · ${esc(itemName)}</div>
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
        if (dialogBackdrop) {
            dialogBackdrop.remove();
            dialogBackdrop = null;
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'bb-dialog-backdrop';
        backdrop.innerHTML = html;
        dialogBackdrop = backdrop;

        const close = (result) => {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
            if (dialogBackdrop === backdrop) dialogBackdrop = null;
            resolve(result);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
        };

        backdrop.addEventListener('click', (e) => {
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
