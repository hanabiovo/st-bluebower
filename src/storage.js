/**
 * Bluebower storage & ST-BaiBai-Tools compatibility layer.
 * Stores preset-scoped grouping metadata in `extensions.bluebower`,
 * and global preferences / global-regex grouping in `extensionSettings.bluebower`.
 */

export const EXT_KEY = 'bluebower';
export const BAIBAI_KEY = 'baibaiToolkit';
export const SCHEMA_VERSION = 1;

/**
 * Generates a UUID v4 using SillyTavern's helper or Web Crypto fallback.
 * @returns {string}
 */
export function makeId() {
    const ctx = window.SillyTavern?.getContext?.();
    if (typeof ctx?.uuidv4 === 'function') {
        return ctx.uuidv4();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'bb-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

/**
 * Creates an empty group store structure.
 * @returns {{ version: number, groups: Array, items: Object }}
 */
export function createEmptyGroupStore() {
    return {
        version: SCHEMA_VERSION,
        defaultCollapsed: true,
        groups: [],
        items: {},
    };
}

/**
 * Creates a default Bluebower preset extension payload.
 * @returns {Object}
 */
export function createDefaultPresetData() {
    return {
        version: SCHEMA_VERSION,
        settings: {
            lockPromptOrder: true,
        },
        promptGroups: createEmptyGroupStore(),
        regexGroups: createEmptyGroupStore(),
    };
}

/**
 * Ensures global extension settings exist and returns them.
 * @returns {{ syncBaibai: boolean, lockPromptOrder: boolean, collapsePresetMisc: boolean, globalRegexGroups: Object, scopedRegexGroups: Object }}
 */
export function getGlobalSettings() {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx?.extensionSettings) {
        return {
            syncBaibai: true,
            lockPromptOrder: true,
            collapsePresetMisc: true,
            globalRegexGroups: createEmptyGroupStore(),
            scopedRegexGroups: createEmptyGroupStore(),
        };
    }

    if (!ctx.extensionSettings[EXT_KEY] || typeof ctx.extensionSettings[EXT_KEY] !== 'object') {
        ctx.extensionSettings[EXT_KEY] = {};
    }
    const store = ctx.extensionSettings[EXT_KEY];
    if (typeof store.syncBaibai !== 'boolean') store.syncBaibai = true;
    if (typeof store.lockPromptOrder !== 'boolean') store.lockPromptOrder = true;
    if (typeof store.collapsePresetMisc !== 'boolean') store.collapsePresetMisc = true;
    if (!store.globalRegexGroups || typeof store.globalRegexGroups !== 'object') {
        store.globalRegexGroups = createEmptyGroupStore();
    }
    if (!store.scopedRegexGroups || typeof store.scopedRegexGroups !== 'object') {
        store.scopedRegexGroups = createEmptyGroupStore();
    }
    normalizeGroupStore(store.globalRegexGroups);
    normalizeGroupStore(store.scopedRegexGroups);
    return store;
}

/**
 * Normalizes a group store in-place to guarantee valid arrays/objects and defaults.
 * @param {Object} store
 * @returns {Object}
 */
export function normalizeGroupStore(store) {
    if (!store || typeof store !== 'object') return createEmptyGroupStore();
    if (!Array.isArray(store.groups)) store.groups = [];
    if (!store.items || typeof store.items !== 'object') store.items = {};
    if (typeof store.defaultCollapsed !== 'boolean') store.defaultCollapsed = true;
    store.version = SCHEMA_VERSION;

    store.groups = store.groups
        .filter(g => g && typeof g === 'object' && g.id)
        .map((g, idx) => ({
            id: String(g.id),
            name: String(g.name ?? '未命名分组'),
            order: typeof g.order === 'number' ? g.order : idx,
            collapsed: Boolean(g.collapsed),
            enabled: g.enabled !== false,
            exclusive: Boolean(g.exclusive),
            note: typeof g.note === 'string' ? g.note : '',
        }))
        .sort((a, b) => a.order - b.order);

    for (const [id, meta] of Object.entries(store.items)) {
        if (!meta || typeof meta !== 'object') {
            delete store.items[id];
            continue;
        }
        store.items[id] = {
            groupId: meta.groupId ? String(meta.groupId) : null,
            starred: Boolean(meta.starred),
            note: typeof meta.note === 'string' ? meta.note : '',
        };
    }
    return store;
}

/**
 * Converts `baibaiToolkit.presetPromptGroups` into Bluebower's `promptGroups` format.
 * @param {Object} baibaiPromptGroups
 * @returns {Object}
 */
export function convertFromBaibai(baibaiPromptGroups) {
    const store = createEmptyGroupStore();
    if (!baibaiPromptGroups || typeof baibaiPromptGroups !== 'object') return store;

    if (Array.isArray(baibaiPromptGroups.groups)) {
        store.groups = baibaiPromptGroups.groups
            .filter(g => g && g.id)
            .map((g, idx) => ({
                id: String(g.id),
                name: String(g.name ?? '未命名分组'),
                order: typeof g.order === 'number' ? g.order : idx,
                collapsed: Boolean(g.collapsed),
                enabled: g.enabled !== false,
                exclusive: false,
                note: '',
            }))
            .sort((a, b) => a.order - b.order);
    }

    if (baibaiPromptGroups.prompts && typeof baibaiPromptGroups.prompts === 'object') {
        for (const [identifier, meta] of Object.entries(baibaiPromptGroups.prompts)) {
            if (meta && meta.groupId) {
                store.items[identifier] = {
                    groupId: String(meta.groupId),
                    starred: false,
                    note: '',
                };
            }
        }
    }

    return normalizeGroupStore(store);
}

/**
 * Converts Bluebower's `promptGroups` back to `baibaiToolkit.presetPromptGroups` format
 * so both extensions stay interoperable without losing Bluebower-only fields.
 * @param {Object} promptGroups
 * @returns {Object}
 */
export function convertToBaibai(promptGroups) {
    const normalized = normalizeGroupStore(structuredClone(promptGroups));
    const prompts = {};
    for (const [identifier, meta] of Object.entries(normalized.items)) {
        if (meta.groupId) {
            prompts[identifier] = { groupId: meta.groupId };
        }
    }
    return {
        version: 1,
        groups: normalized.groups.map((g, idx) => ({
            id: g.id,
            name: g.name,
            order: idx,
            collapsed: Boolean(g.collapsed),
            enabled: Boolean(g.enabled),
        })),
        prompts,
    };
}

/**
 * Reads the current preset's Bluebower data, auto-migrating from `baibaiToolkit` if needed.
 * @returns {{ data: Object, migratedFromBaibai: boolean, hasBaibaiData: boolean, presetName: string | null }}
 */
export function loadPresetData() {
    const ctx = window.SillyTavern?.getContext?.();
    const pm = ctx?.getPresetManager?.();
    const presetName = pm?.getSelectedPresetName?.() ?? null;

    let rawBluebower = pm?.readPresetExtensionField?.({ path: EXT_KEY }) ?? null;
    const rawBaibai = pm?.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.presetPromptGroups` }) ?? null;

    if (!rawBluebower && ctx?.chatCompletionSettings?.extensions) {
        rawBluebower = ctx.chatCompletionSettings.extensions[EXT_KEY] ?? null;
    }

    let migratedFromBaibai = false;
    let data;

    if (rawBluebower && typeof rawBluebower === 'object') {
        data = structuredClone(rawBluebower);
        if (!data.settings || typeof data.settings !== 'object') {
            data.settings = { lockPromptOrder: getGlobalSettings().lockPromptOrder };
        }
        data.promptGroups = normalizeGroupStore(data.promptGroups);
        data.regexGroups = normalizeGroupStore(data.regexGroups);
    } else {
        data = createDefaultPresetData();
        data.settings.lockPromptOrder = getGlobalSettings().lockPromptOrder;
        if (rawBaibai && typeof rawBaibai === 'object') {
            data.promptGroups = convertFromBaibai(rawBaibai);
            migratedFromBaibai = true;
        }
    }

    return {
        data,
        migratedFromBaibai,
        hasBaibaiData: Boolean(rawBaibai),
        presetName,
    };
}

/**
 * Re-imports grouping from `baibaiToolkit.presetPromptGroups` into `promptGroups`,
 * preserving existing Bluebower item notes and stars where identifiers match.
 * @param {Object} currentData
 * @returns {{ data: Object, imported: boolean }}
 */
export function importFromBaibai(currentData) {
    const ctx = window.SillyTavern?.getContext?.();
    const pm = ctx?.getPresetManager?.();
    const rawBaibai = pm?.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.presetPromptGroups` })
        ?? ctx?.chatCompletionSettings?.extensions?.[BAIBAI_KEY]?.presetPromptGroups
        ?? null;

    if (!rawBaibai || typeof rawBaibai !== 'object') {
        return { data: currentData, imported: false };
    }

    const converted = convertFromBaibai(rawBaibai);
    const prevItems = currentData?.promptGroups?.items || {};
    for (const [id, meta] of Object.entries(converted.items)) {
        if (prevItems[id]) {
            meta.starred = Boolean(prevItems[id].starred);
            meta.note = typeof prevItems[id].note === 'string' ? prevItems[id].note : '';
        }
    }
    // Keep starred/noted items even if they were ungrouped in Baibai
    for (const [id, prevMeta] of Object.entries(prevItems)) {
        if (!converted.items[id] && (prevMeta.starred || prevMeta.note)) {
            converted.items[id] = {
                groupId: null,
                starred: Boolean(prevMeta.starred),
                note: typeof prevMeta.note === 'string' ? prevMeta.note : '',
            };
        }
    }

    currentData.promptGroups = converted;
    return { data: currentData, imported: true };
}

/**
 * Persists Bluebower preset data (and optionally syncs back to `baibaiToolkit.presetPromptGroups`).
 * Non-destructive: only writes targeted extension paths.
 * @param {Object} data
 * @returns {Promise<void>}
 */
export async function savePresetData(data) {
    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) return;

    const payload = {
        version: SCHEMA_VERSION,
        settings: {
            lockPromptOrder: Boolean(data?.settings?.lockPromptOrder ?? true),
        },
        promptGroups: normalizeGroupStore(structuredClone(data.promptGroups || createEmptyGroupStore())),
        regexGroups: normalizeGroupStore(structuredClone(data.regexGroups || createEmptyGroupStore())),
    };

    const pm = ctx.getPresetManager?.();
    const globalSettings = getGlobalSettings();

    if (pm?.writePresetExtensionField) {
        await pm.writePresetExtensionField({ path: EXT_KEY, value: payload });
        if (globalSettings.syncBaibai) {
            await pm.writePresetExtensionField({
                path: `${BAIBAI_KEY}.presetPromptGroups`,
                value: convertToBaibai(payload.promptGroups),
            });
        }
        return;
    }

    // Fallback if preset manager is unavailable
    if (ctx.chatCompletionSettings) {
        if (!ctx.chatCompletionSettings.extensions || typeof ctx.chatCompletionSettings.extensions !== 'object') {
            ctx.chatCompletionSettings.extensions = {};
        }
        ctx.chatCompletionSettings.extensions[EXT_KEY] = payload;
        if (globalSettings.syncBaibai) {
            if (!ctx.chatCompletionSettings.extensions[BAIBAI_KEY]) {
                ctx.chatCompletionSettings.extensions[BAIBAI_KEY] = {};
            }
            ctx.chatCompletionSettings.extensions[BAIBAI_KEY].presetPromptGroups = convertToBaibai(payload.promptGroups);
        }
        ctx.saveSettingsDebounced?.();
    }
}

/**
 * Persists global settings (including global regex grouping).
 */
export function saveGlobalSettings() {
    const ctx = window.SillyTavern?.getContext?.();
    ctx?.saveSettingsDebounced?.();
}
