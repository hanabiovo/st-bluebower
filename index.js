import { openBluebower, refreshData } from './src/ui.js';

(() => {
    'use strict';

    const MENU_ITEM_ID = 'bluebower_menu_entry';
    const PROMPT_BTN_ID = 'bluebower_open_prompts_btn';
    const REGEX_BTN_ID = 'bluebower_open_regex_btn';

    /**
     * Injects a lightweight entry button into SillyTavern's Extensions menu.
     */
    function ensureExtensionsMenuEntry() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById(MENU_ITEM_ID)) return;

        const item = document.createElement('div');
        item.id = MENU_ITEM_ID;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `
            <span class="fa-solid fa-feather-pointed"></span>
            <span>园丁鸟分组 (Bluebower)</span>
        `;
        item.addEventListener('click', () => openBluebower('prompts'));
        menu.appendChild(item);
    }

    /**
     * Injects compact trigger buttons into native Prompt Manager and Regex panels when present.
     */
    function ensureInlineTriggers() {
        const promptManager = document.getElementById('completion_prompt_manager');
        if (promptManager && !document.getElementById(PROMPT_BTN_ID)) {
            const header = promptManager.querySelector('.completion_prompt_manager_header') || promptManager;
            const btn = document.createElement('button');
            btn.id = PROMPT_BTN_ID;
            btn.type = 'button';
            btn.className = 'menu_button bb-inline-trigger';
            btn.title = '打开园丁鸟分组视图';
            btn.textContent = '🐦 分组视图';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBluebower('prompts');
            });
            header.appendChild(btn);
        }

        const regexContainer = document.getElementById('regex_container');
        if (regexContainer && !document.getElementById(REGEX_BTN_ID)) {
            const header = regexContainer.querySelector('.inline-drawer-header') || regexContainer;
            const btn = document.createElement('button');
            btn.id = REGEX_BTN_ID;
            btn.type = 'button';
            btn.className = 'menu_button bb-inline-trigger';
            btn.title = '打开园丁鸟正则分组视图';
            btn.textContent = '🐦 正则分组';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBluebower('regex');
            });
            header.appendChild(btn);
        }
    }

    function bindSillyTavernEvents() {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx?.eventSource || !ctx?.eventTypes) return;

        const { eventSource, eventTypes } = ctx;
        const onPresetOrChatChange = () => {
            ensureInlineTriggers();
            refreshData();
        };

        if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
            eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, onPresetOrChatChange);
        }
        if (eventTypes.PRESET_CHANGED) {
            eventSource.on(eventTypes.PRESET_CHANGED, onPresetOrChatChange);
        }
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, onPresetOrChatChange);
        }
    }

    function init() {
        ensureExtensionsMenuEntry();
        ensureInlineTriggers();
        bindSillyTavernEvents();

        // Retry once after delayed panel mounts (e.g. regex extension loads asynchronously)
        setTimeout(() => {
            ensureExtensionsMenuEntry();
            ensureInlineTriggers();
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
