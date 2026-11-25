/**
 * 1. Dedicated Bluebower settings drawer in SillyTavern's Extensions tab (`#extensions_settings2`)
 *    + quick entry in the Extensions wand menu (`#extensionsMenu`).
 * 2. Non-destructive folding of OpenAI preset miscellaneous parameters (`| 预设设置 ⌄`).
 */

import {
    getGlobalSettings,
    importFromBaibai,
    loadPresetData,
    saveGlobalSettings,
    savePresetData,
} from './storage.js';
import { onPromptPresetChanged } from './prompt-enhancer.js';

let miscExpanded = false;

/**
 * Applies or removes the `预设设置` collapsible header on `#range_block_openai` & `#openai_settings`.
 */
export function syncPresetMiscFolding() {
    const gs = getGlobalSettings();
    const rangeBlock = document.getElementById('range_block_openai');
    if (!rangeBlock) return;

    let toggleBar = document.getElementById('bb_preset_misc_toggle');

    if (!gs.collapsePresetMisc) {
        document.body.classList.remove('bb-preset-misc-collapsed');
        if (toggleBar) toggleBar.remove();
        return;
    }

    if (!toggleBar) {
        toggleBar = document.createElement('div');
        toggleBar.id = 'bb_preset_misc_toggle';
        toggleBar.className = 'inline-drawer-header bb-preset-misc-header';
        toggleBar.innerHTML = `
            <b>预设设置</b>
            <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
        `;
        toggleBar.addEventListener('click', () => {
            miscExpanded = !miscExpanded;
            updateMiscFoldDOM(toggleBar);
        });
        rangeBlock.prepend(toggleBar);
    } else if (rangeBlock.firstElementChild !== toggleBar) {
        rangeBlock.prepend(toggleBar);
    }

    updateMiscFoldDOM(toggleBar);
}

function updateMiscFoldDOM(toggleBar) {
    document.body.classList.toggle('bb-preset-misc-collapsed', !miscExpanded);
    const icon = toggleBar?.querySelector('.inline-drawer-icon');
    if (icon) {
        icon.classList.toggle('down', !miscExpanded);
        icon.classList.toggle('up', miscExpanded);
    }
}

/**
 * Opens a lightweight settings modal when clicked from the `#extensionsMenu` wand menu.
 */
function openQuickSettingsModal() {
    const existing = document.getElementById('bb_quick_settings_modal');
    if (existing) existing.remove();

    const gs = getGlobalSettings();
    const backdrop = document.createElement('div');
    backdrop.id = 'bb_quick_settings_modal';
    backdrop.className = 'bb-dialog-backdrop';
    backdrop.innerHTML = `
        <div class="bb-dialog-card">
            <div class="bb-dialog-title"><i class="fa-solid fa-dove bb-bird-icon" style="margin-right:6px;"></i>园丁鸟设置 (Bluebower)</div>
            <label class="bb-field-check">
                <input type="checkbox" class="bb-qs-collapse" ${gs.collapsePresetMisc ? 'checked' : ''} />
                <span>折叠预设页参数杂项（收纳温度、上下文、偏置等设置）</span>
            </label>
            <label class="bb-field-check">
                <input type="checkbox" class="bb-qs-sync" ${gs.syncBaibai ? 'checked' : ''} />
                <span>双向同步柏宝箱（ST-BaiBai-Tools）预设分组格式</span>
            </label>
            <div class="bb-ext-settings-actions">
                <button type="button" class="menu_button bb-btn-sm bb-drawer-btn bb-qs-reimport">
                    <i class="fa-solid fa-file-import"></i>
                    <span>从柏宝箱重新导入当前预设分组</span>
                </button>
                <span class="bb-ext-status"></span>
            </div>
            <div class="bb-dialog-footer">
                <button type="button" class="menu_button bb-qs-close">关闭</button>
            </div>
        </div>
    `;

    const syncDrawerCheckboxes = () => {
        const s = getGlobalSettings();
        const c1 = document.getElementById('bb_cfg_collapse_misc');
        const c2 = document.getElementById('bb_cfg_sync_baibai');
        if (c1) c1.checked = s.collapsePresetMisc;
        if (c2) c2.checked = s.syncBaibai;
    };

    const statusEl = backdrop.querySelector('.bb-ext-status');
    backdrop.querySelector('.bb-qs-collapse').addEventListener('change', (e) => {
        const s = getGlobalSettings();
        s.collapsePresetMisc = Boolean(e.target.checked);
        saveGlobalSettings();
        syncPresetMiscFolding();
        syncDrawerCheckboxes();
    });

    backdrop.querySelector('.bb-qs-sync').addEventListener('change', (e) => {
        const s = getGlobalSettings();
        s.syncBaibai = Boolean(e.target.checked);
        saveGlobalSettings();
        syncDrawerCheckboxes();
    });

    backdrop.querySelector('.bb-qs-reimport').addEventListener('click', async () => {
        const loaded = loadPresetData();
        const res = importFromBaibai(loaded.data);
        if (res.imported) {
            await savePresetData(res.data);
            onPromptPresetChanged();
            statusEl.textContent = '重新导入成功';
        } else {
            statusEl.textContent = '未检测到柏宝箱数据';
        }
    });

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.closest('.bb-qs-close')) close();
    });
    document.body.appendChild(backdrop);
}

/**
 * Mounts Bluebower's settings panel inside `#extensions_settings2` and `#extensionsMenu`.
 */
export function initExtensionSettingsPanel() {
    // 1. Extensions Menu (magic wand) entry
    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu && !document.getElementById('bb_wand_menu_entry')) {
        const item = document.createElement('div');
        item.id = 'bb_wand_menu_entry';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `
            <span class="fa-solid fa-dove bb-bird-icon"></span>
            <span>园丁鸟设置 (Bluebower)</span>
        `;
        item.addEventListener('click', openQuickSettingsModal);
        extMenu.appendChild(item);
    }

    // 2. Extensions Settings drawer (#extensions_settings2)
    if (document.getElementById('bb_extension_settings_block')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const gs = getGlobalSettings();
    const wrapper = document.createElement('div');
    wrapper.id = 'bb_extension_settings_block';
    wrapper.className = 'extension_container';
    wrapper.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-dove bb-bird-icon" style="margin-right:6px;"></i>园丁鸟分组 (Bluebower)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content bb-ext-settings-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="bb_cfg_collapse_misc" ${gs.collapsePresetMisc ? 'checked' : ''} />
                    <span>折叠预设页参数杂项（收纳温度、上下文、偏置等设置）</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="bb_cfg_sync_baibai" ${gs.syncBaibai ? 'checked' : ''} />
                    <span>双向同步柏宝箱（ST-BaiBai-Tools）预设分组格式</span>
                </label>
                <div class="bb-ext-settings-actions">
                    <button type="button" id="bb_cfg_reimport_baibai" class="menu_button bb-btn-sm bb-drawer-btn">
                        <i class="fa-solid fa-file-import"></i>
                        <span>从柏宝箱重新导入当前预设分组</span>
                    </button>
                    <span id="bb_cfg_status" class="bb-ext-status"></span>
                </div>
            </div>
        </div>
    `;

    const showStatus = (msg) => {
        const el = wrapper.querySelector('#bb_cfg_status');
        if (!el) return;
        el.textContent = msg;
        setTimeout(() => {
            if (el.textContent === msg) el.textContent = '';
        }, 2500);
    };

    wrapper.querySelector('#bb_cfg_collapse_misc').addEventListener('change', (e) => {
        const store = getGlobalSettings();
        store.collapsePresetMisc = Boolean(e.target.checked);
        saveGlobalSettings();
        syncPresetMiscFolding();
        showStatus(store.collapsePresetMisc ? '已折叠预设参数杂项' : '已展开全部预设参数');
    });

    wrapper.querySelector('#bb_cfg_sync_baibai').addEventListener('change', (e) => {
        const store = getGlobalSettings();
        store.syncBaibai = Boolean(e.target.checked);
        saveGlobalSettings();
        showStatus(store.syncBaibai ? '已开启柏宝箱同步' : '已关闭柏宝箱同步');
    });

    wrapper.querySelector('#bb_cfg_reimport_baibai').addEventListener('click', async () => {
        const loaded = loadPresetData();
        const res = importFromBaibai(loaded.data);
        if (res.imported) {
            await savePresetData(res.data);
            onPromptPresetChanged();
            showStatus('重新导入成功');
        } else {
            showStatus('当前预设未检测到柏宝箱分组数据');
        }
    });

    host.appendChild(wrapper);
}
