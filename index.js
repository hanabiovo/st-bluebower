import { initPromptEnhancer, onPromptPresetChanged } from './src/prompt-enhancer.js';
import { initRegexEnhancer, onRegexPresetChanged } from './src/regex-enhancer.js';
import { initExtensionSettingsPanel, syncPresetMiscFolding } from './src/settings-panel.js';
import { invalidatePresetCache } from './src/storage.js';

(() => {
    'use strict';

    function tryInitAll() {
        syncPresetMiscFolding();
        initExtensionSettingsPanel();
        initPromptEnhancer();
        initRegexEnhancer();
    }

    function bindEvents() {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx?.eventSource || !ctx?.eventTypes) return;

        const { eventSource, eventTypes } = ctx;
        const onChange = () => {
            invalidatePresetCache();
            syncPresetMiscFolding();
            onPromptPresetChanged();
            onRegexPresetChanged();
        };

        if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
            eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, onChange);
        }
        if (eventTypes.PRESET_CHANGED) {
            eventSource.on(eventTypes.PRESET_CHANGED, onChange);
        }
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, onChange);
        }
    }

    function init() {
        tryInitAll();
        bindEvents();

        // Retry after async extension panels mount
        setTimeout(tryInitAll, 1200);
        setTimeout(tryInitAll, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
