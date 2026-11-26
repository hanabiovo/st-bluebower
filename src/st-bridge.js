/**
 * Bridge between Bluebower UI and SillyTavern's live Prompt / Regex state.
 */

const GLOBAL_ORDER_IDS = [100001, 100000];
const tokenCache = new Map();

/**
 * Resolves the active prompt_order list from `chatCompletionSettings`.
 * OpenAI Chat Completion in SillyTavern uses global strategy (`dummyId: 100001`) by default.
 * @returns {{ character_id: string | number, order: Array<{ identifier: string, enabled: boolean }> } | null}
 */
export function getActivePromptOrderEntry() {
    const ctx = window.SillyTavern?.getContext?.();
    const settings = ctx?.chatCompletionSettings;
    if (!settings || !Array.isArray(settings.prompt_order)) return null;

    for (const dummyId of GLOBAL_ORDER_IDS) {
        const globalOrder = settings.prompt_order.find(o => Number(o.character_id) === dummyId);
        if (globalOrder && Array.isArray(globalOrder.order)) return globalOrder;
    }

    const charId = ctx.characterId;
    if (charId !== undefined && charId !== null) {
        const charOrder = settings.prompt_order.find(o => String(o.character_id) === String(charId));
        if (charOrder && Array.isArray(charOrder.order)) return charOrder;
    }

    return settings.prompt_order.find(o => Array.isArray(o?.order)) ?? null;
}

/**
 * Returns normalized prompt items in their current prompt_order sequence.
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   content: string,
 *   role: string,
 *   marker: boolean,
 *   enabled: boolean,
 *   orderIndex: number
 * }>}
 */
export function getPromptItems() {
    const ctx = window.SillyTavern?.getContext?.();
    const settings = ctx?.chatCompletionSettings;
    if (!settings || !Array.isArray(settings.prompts)) return [];

    const promptMap = new Map();
    for (const p of settings.prompts) {
        if (p && p.identifier) {
            promptMap.set(String(p.identifier), p);
        }
    }

    const orderContainer = getActivePromptOrderEntry();
    const orderList = Array.isArray(orderContainer?.order) ? orderContainer.order : [];
    const seen = new Set();
    const result = [];

    orderList.forEach((entry, idx) => {
        if (!entry?.identifier) return;
        const id = String(entry.identifier);
        seen.add(id);
        const prompt = promptMap.get(id);
        if (!prompt) return;

        result.push({
            id,
            name: String(prompt.name || id),
            content: typeof prompt.content === 'string' ? prompt.content : '',
            role: String(prompt.role || 'system'),
            marker: Boolean(prompt.marker),
            enabled: entry.enabled !== false,
            orderIndex: idx,
        });
    });

    // Include any prompts not yet present in prompt_order so nothing is hidden
    for (const [id, prompt] of promptMap.entries()) {
        if (seen.has(id)) continue;
        result.push({
            id,
            name: String(prompt.name || id),
            content: typeof prompt.content === 'string' ? prompt.content : '',
            role: String(prompt.role || 'system'),
            marker: Boolean(prompt.marker),
            enabled: false,
            orderIndex: result.length,
        });
    }

    return result;
}

/**
 * Checks whether a prompt entry is currently enabled in `prompt_order` (with DOM fallback).
 * @param {string} identifier
 * @returns {boolean}
 */
export function isPromptEnabled(identifier) {
    const orderContainer = getActivePromptOrderEntry();
    if (orderContainer && Array.isArray(orderContainer.order)) {
        const entry = orderContainer.order.find(e => String(e?.identifier) === String(identifier));
        if (entry) return Boolean(entry.enabled);
    }
    const row = document.querySelector(`#completion_prompt_manager_list .completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(identifier)}"]`);
    if (row) return !row.classList.contains('completion_prompt_manager_prompt_disabled');
    return false;
}

/**
 * Toggles a prompt entry's enabled state and syncs native DOM if visible.
 * @param {string} identifier
 * @param {boolean} enabled
 * @param {{ save?: boolean }} [options]
 */
export function setPromptEnabled(identifier, enabled, { save = true } = {}) {
    const ctx = window.SillyTavern?.getContext?.();
    const orderContainer = getActivePromptOrderEntry();
    if (!orderContainer) return false;

    let entry = orderContainer.order.find(e => String(e.identifier) === String(identifier));
    if (!entry) {
        entry = { identifier: String(identifier), enabled: Boolean(enabled) };
        orderContainer.order.push(entry);
    } else {
        entry.enabled = Boolean(enabled);
    }

    syncNativePromptToggleDom(identifier, Boolean(enabled));
    if (save) {
        ctx?.saveSettingsDebounced?.();
    }
    return true;
}

/**
 * Batch-updates multiple prompt entries' enabled states with a single save.
 * @param {Array<{ id: string, enabled: boolean }>} updates
 */
export function batchSetPromptsEnabled(updates) {
    const ctx = window.SillyTavern?.getContext?.();
    for (const item of updates) {
        setPromptEnabled(item.id, item.enabled, { save: false });
    }
    ctx?.saveSettingsDebounced?.();
}

/**
 * Persists a new `prompt_order` sequence from an ordered array of prompt identifiers,
 * preserving each entry's `enabled` state and keeping any unrendered tail entries intact.
 * @param {string[]} orderedIds
 * @returns {boolean}
 */
export function syncPromptOrderFromIds(orderedIds) {
    const ctx = window.SillyTavern?.getContext?.();
    const orderContainer = getActivePromptOrderEntry();
    if (!orderContainer || !Array.isArray(orderContainer.order) || !Array.isArray(orderedIds) || !orderedIds.length) {
        return false;
    }

    const existingMap = new Map();
    for (const entry of orderContainer.order) {
        if (entry && entry.identifier !== undefined && entry.identifier !== null) {
            existingMap.set(String(entry.identifier), entry);
        }
    }

    const seen = new Set();
    const nextOrder = [];
    for (const rawId of orderedIds) {
        const id = String(rawId ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const existing = existingMap.get(id);
        if (existing) {
            nextOrder.push(existing);
        } else {
            const row = document.querySelector(`#completion_prompt_manager_list .completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(id)}"]`);
            const enabled = row ? !row.classList.contains('completion_prompt_manager_prompt_disabled') : true;
            nextOrder.push({ identifier: id, enabled });
        }
    }

    for (const entry of orderContainer.order) {
        const id = String(entry?.identifier ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        nextOrder.push(entry);
    }

    orderContainer.order.splice(0, orderContainer.order.length, ...nextOrder);
    ctx?.saveSettingsDebounced?.();
    return true;
}

/**
 * Moves a prompt entry up or down in `prompt_order`.
 * @param {string} identifier
 * @param {-1 | 1} direction
 * @returns {boolean}
 */
export function movePromptInOrder(identifier, direction) {
    const ctx = window.SillyTavern?.getContext?.();
    const orderContainer = getActivePromptOrderEntry();
    if (!orderContainer || !Array.isArray(orderContainer.order)) return false;

    const idx = orderContainer.order.findIndex(e => String(e.identifier) === String(identifier));
    if (idx === -1) return false;

    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= orderContainer.order.length) return false;

    const [moved] = orderContainer.order.splice(idx, 1);
    orderContainer.order.splice(targetIdx, 0, moved);
    ctx?.saveSettingsDebounced?.();
    return true;
}

/**
 * Syncs the native SillyTavern prompt list toggle state if currently rendered in DOM.
 * @param {string} identifier
 * @param {boolean} enabled
 */
function syncNativePromptToggleDom(identifier, enabled) {
    const row = document.querySelector(`#completion_prompt_manager_list .completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(identifier)}"]`);
    if (!row) return;
    row.classList.toggle('completion_prompt_manager_prompt_disabled', !enabled);
    const toggle = row.querySelector('.prompt-manager-toggle-action');
    if (toggle) {
        toggle.classList.toggle('fa-toggle-on', enabled);
        toggle.classList.toggle('fa-toggle-off', !enabled);
    }
}

/**
 * Computes regex scope label (`仅渲染` | `仅发送` | `双向` | `未启用范围`).
 * @param {Object} script
 * @returns {{ label: string, key: 'render' | 'prompt' | 'both' | 'none' }}
 */
export function getRegexScopeInfo(script) {
    const md = Boolean(script?.markdownOnly);
    const pr = Boolean(script?.promptOnly);
    if (md && pr) return { label: '双向', key: 'both' };
    if (md) return { label: '仅渲染', key: 'render' };
    if (pr) return { label: '仅发送', key: 'prompt' };
    return { label: '常规', key: 'none' };
}

/**
 * Reads all regex scripts across Preset, Character-Scoped, and Global sources.
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   enabled: boolean,
 *   origin: 'preset' | 'scoped' | 'global',
 *   originLabel: string,
 *   scopeInfo: { label: string, key: string },
 *   findRegex: string
 * }>}
 */
export function getRegexItems() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return [];

    const pm = ctx.getPresetManager?.();
    const presetScripts = pm?.readPresetExtensionField?.({ path: 'regex_scripts' });
    const scopedScripts = ctx.characters?.[ctx.characterId]?.data?.extensions?.regex_scripts;
    const globalScripts = ctx.extensionSettings?.regex;

    const list = [];
    const pushScripts = (arr, origin, originLabel) => {
        if (!Array.isArray(arr)) return;
        for (const s of arr) {
            if (!s || !s.id) continue;
            list.push({
                id: String(s.id),
                name: String(s.scriptName || s.id),
                enabled: !s.disabled,
                origin,
                originLabel,
                scopeInfo: getRegexScopeInfo(s),
                findRegex: typeof s.findRegex === 'string' ? s.findRegex : '',
            });
        }
    };

    pushScripts(presetScripts, 'preset', '预设');
    pushScripts(scopedScripts, 'scoped', '角色');
    pushScripts(globalScripts, 'global', '全局');

    return list;
}

/**
 * Updates enabled state of one or more regex scripts grouped by origin.
 * @param {Array<{ id: string, origin: 'preset' | 'scoped' | 'global', enabled: boolean }>} updates
 * @returns {Promise<void>}
 */
export async function batchSetRegexEnabled(updates) {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx || !updates.length) return;

    const byOrigin = { preset: [], scoped: [], global: [] };
    for (const u of updates) {
        if (byOrigin[u.origin]) byOrigin[u.origin].push(u);
    }

    if (byOrigin.preset.length) {
        const pm = ctx.getPresetManager?.();
        const scripts = structuredClone(pm?.readPresetExtensionField?.({ path: 'regex_scripts' }) || []);
        if (Array.isArray(scripts)) {
            for (const u of byOrigin.preset) {
                const target = scripts.find(s => String(s?.id) === String(u.id));
                if (target) target.disabled = !u.enabled;
            }
            await pm?.writePresetExtensionField?.({ path: 'regex_scripts', value: scripts });
        }
    }

    if (byOrigin.scoped.length && ctx.characterId !== undefined && ctx.characterId !== null) {
        const char = ctx.characters?.[ctx.characterId];
        const scripts = structuredClone(char?.data?.extensions?.regex_scripts || []);
        if (Array.isArray(scripts)) {
            for (const u of byOrigin.scoped) {
                const target = scripts.find(s => String(s?.id) === String(u.id));
                if (target) target.disabled = !u.enabled;
            }
            await ctx.writeExtensionField?.(ctx.characterId, 'regex_scripts', scripts);
        }
    }

    if (byOrigin.global.length && Array.isArray(ctx.extensionSettings?.regex)) {
        for (const u of byOrigin.global) {
            const target = ctx.extensionSettings.regex.find(s => String(s?.id) === String(u.id));
            if (target) target.disabled = !u.enabled;
        }
        ctx.saveSettingsDebounced?.();
    }
}

/**
 * Persists a new regex script array sequence for a given origin ('global' | 'scoped' | 'preset'),
 * preserving all script properties and any unrendered scripts.
 * @param {'global' | 'scoped' | 'preset'} origin
 * @param {string[]} orderedIds
 * @returns {Promise<boolean>}
 */
export async function syncRegexOrderFromIds(origin, orderedIds) {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx || !Array.isArray(orderedIds) || !orderedIds.length) return false;

    const reorderArray = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return null;
        const map = new Map();
        for (const s of arr) {
            if (s && s.id !== undefined && s.id !== null) {
                map.set(String(s.id), s);
            }
        }
        const seen = new Set();
        const next = [];
        for (const rawId of orderedIds) {
            const id = String(rawId ?? '');
            if (!id || seen.has(id)) continue;
            const item = map.get(id);
            if (item) {
                seen.add(id);
                next.push(item);
            }
        }
        for (const s of arr) {
            const id = String(s?.id ?? '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            next.push(s);
        }
        return next;
    };

    if (origin === 'global' && Array.isArray(ctx.extensionSettings?.regex)) {
        const next = reorderArray(ctx.extensionSettings.regex);
        if (!next) return false;
        ctx.extensionSettings.regex.splice(0, ctx.extensionSettings.regex.length, ...next);
        ctx.saveSettingsDebounced?.();
        return true;
    }

    if (origin === 'scoped' && ctx.characterId !== undefined && ctx.characterId !== null) {
        const char = ctx.characters?.[ctx.characterId];
        const liveArr = char?.data?.extensions?.regex_scripts;
        const next = reorderArray(liveArr || []);
        if (!next) return false;
        if (Array.isArray(liveArr)) {
            liveArr.splice(0, liveArr.length, ...next);
        }
        await ctx.writeExtensionField?.(ctx.characterId, 'regex_scripts', structuredClone(next));
        ctx.saveSettingsDebounced?.();
        return true;
    }

    if (origin === 'preset') {
        const pm = ctx.getPresetManager?.();
        const liveArr = pm?.readPresetExtensionField?.({ path: 'regex_scripts' });
        const next = reorderArray(liveArr || []);
        if (!next) return false;
        if (Array.isArray(liveArr)) {
            liveArr.splice(0, liveArr.length, ...next);
        }
        await pm?.writePresetExtensionField?.({ path: 'regex_scripts', value: structuredClone(next) });
        ctx.saveSettingsDebounced?.();
        return true;
    }

    return false;
}

/**
 * Fast cached token estimator. Uses SillyTavern's async tokenizer when available,
 * with a lightweight heuristic fallback so UI rendering never blocks.
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function estimateTokensCached(text) {
    if (!text) return 0;
    const key = `${text.length}:${text.slice(0, 32)}:${text.slice(-16)}`;
    if (tokenCache.has(key)) return tokenCache.get(key);

    let count = Math.ceil(text.length / 3);
    const ctx = window.SillyTavern?.getContext?.();
    if (typeof ctx?.getTokenCountAsync === 'function') {
        try {
            count = await ctx.getTokenCountAsync(text);
        } catch {
            // Keep heuristic fallback
        }
    }

    if (tokenCache.size > 600) {
        tokenCache.clear();
    }
    tokenCache.set(key, count);
    return count;
}
