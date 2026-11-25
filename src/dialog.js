/**
 * Lightweight inline modal dialog for creating/editing groups and item notes.
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
 * @param {{ mode: 'create' | 'edit', group?: Object }} options
 * @returns {Promise<{ name: string, note: string, exclusive: boolean } | null>}
 */
export function openGroupDialog({ mode, group = null }) {
    return openFormDialog(`
        <form class="bb-dialog-card">
            <div class="bb-dialog-title">${mode === 'edit' ? '编辑分组' : '新建分组'}</div>
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
        };
    });
}

/**
 * Opens a small centered dialog for editing an item's personal note.
 * @param {{ itemName: string, note?: string }} options
 * @returns {Promise<string | null>}
 */
export function openNoteDialog({ itemName, note = '' }) {
    return openFormDialog(`
        <form class="bb-dialog-card">
            <div class="bb-dialog-title">条目备注 · ${esc(itemName)}</div>
            <label class="bb-field">
                <span>备注内容（留空则清除）</span>
                <input type="text" name="note" class="text_pole" maxlength="120" value="${esc(note)}" placeholder="写点方便自己识别的说明..." />
            </label>
            <div class="bb-dialog-footer">
                <button type="button" class="menu_button bb-dialog-cancel">取消</button>
                <button type="submit" class="menu_button bb-btn-primary">保存</button>
            </div>
        </form>
    `, (fd) => String(fd.get('note') || '').trim());
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
