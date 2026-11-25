import { initPromptEnhancer, onPromptPresetChanged } from './src/prompt-enhancer.js';
import { initRegexEnhancer, onRegexPresetChanged } from './src/regex-enhancer.js';

(() => {
    'use strict';

    function tryInitEnhancers() {
        initPromptEnhancer();
        initRegexEnhancer();
    }

    function bindEvents() {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx?.eventSource || !ctx?.eventTypes) return;

        const { eventSource, eventTypes } = ctx;
        const onChange = () => {
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
        tryInitEnhancers();
        bindEvents();

        // Regex extension templates can mount slightly after initial load
        setTimeout(tryInitEnhancers, 1200);
        setTimeout(tryInitEnhancers, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
