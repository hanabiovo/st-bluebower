/**
 * Bluebower storage & ST-BaiBai-Tools compatibility layer.
 * Stores preset-scoped grouping metadata in `extensions.bluebower`,
 * and global preferences / global-regex grouping in `extensionSettings.bluebower`.
 */

export const EXT_KEY = 'bluebower';
export const BAIBAI_KEY = 'baibaiToolkit';
export const BAIBAI_SETTINGS_KEY = 'baiBaiToolkit';
export const SCHEMA_VERSION = 1;

const BAIBAI_UNGROUPED_IDS = new Set(['__ungrouped', '__pending_assignment']);

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
    if (!store.scopedRegexByChar || typeof store.scopedRegexByChar !== 'object') {
        store.scopedRegexByChar = {};
    }
    normalizeGroupStore(store.globalRegexGroups);
    normalizeGroupStore(store.scopedRegexGroups);

    // One-time auto-migration of Global Regex groups from ST-BaiBai-Tools (`extensionSettings.baiBaiToolkit.regexListGroups.scopes.global`)
    if (!store.globalRegexMigrated && store.globalRegexGroups.groups.length === 0) {
        const rawGlobalBaibai = ctx.extensionSettings?.[BAIBAI_SETTINGS_KEY]?.regexListGroups?.scopes?.global;
        if (rawGlobalBaibai && Array.isArray(rawGlobalBaibai.groups) && rawGlobalBaibai.groups.length > 0) {
            store.globalRegexGroups = convertRegexFromBaibai(rawGlobalBaibai);
            store.globalRegexMigrated = true;
            ctx.saveSettingsDebounced?.();
        }
    }

    return store;
}

/**
 * Returns the Character-Scoped Regex group store for the currently active character,
 * auto-migrating from ST-BaiBai-Tools (`scopes["scoped:" + avatar]`) if present.
 * @returns {Object}
 */
export function getScopedRegexStore() {
    const gs = getGlobalSettings();
    const ctx = window.SillyTavern?.getContext?.();
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar || '__default__';

    if (!gs.scopedRegexByChar) {
        return gs.scopedRegexGroups;
    }

    if (!gs.scopedRegexByChar[avatar] || typeof gs.scopedRegexByChar[avatar] !== 'object') {
        let initial = createEmptyGroupStore();
        const rawScopedBaibai = avatar !== '__default__'
            ? ctx?.extensionSettings?.[BAIBAI_SETTINGS_KEY]?.regexListGroups?.scopes?.[`scoped:${avatar}`]
            : null;

        if (rawScopedBaibai && Array.isArray(rawScopedBaibai.groups) && rawScopedBaibai.groups.length > 0) {
            initial = convertRegexFromBaibai(rawScopedBaibai);
        } else if (!gs.legacyScopedMigrated && gs.scopedRegexGroups?.groups?.length > 0) {
            initial = structuredClone(gs.scopedRegexGroups);
            gs.legacyScopedMigrated = true;
        }
        gs.scopedRegexByChar[avatar] = initial;
    }

    return normalizeGroupStore(gs.scopedRegexByChar[avatar]);
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
        const entry = {
            groupId: meta.groupId ? String(meta.groupId) : null,
            starred: Boolean(meta.starred),
            note: typeof meta.note === 'string' ? meta.note : '',
        };
        if (typeof meta.order === 'number' && Number.isFinite(meta.order)) {
            entry.order = meta.order;
        }
        store.items[id] = entry;
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
 * Converts `baibaiToolkit.regexGroups` (or `baiBaiToolkit.regexListGroups.scopes[...]`)
 * into Bluebower's `regexGroups` store format.
 * @param {Object} baibaiRegexGroups
 * @returns {Object}
 */
export function convertRegexFromBaibai(baibaiRegexGroups) {
    const store = createEmptyGroupStore();
    if (!baibaiRegexGroups || typeof baibaiRegexGroups !== 'object') return store;

    if (Array.isArray(baibaiRegexGroups.groups)) {
        store.groups = baibaiRegexGroups.groups
            .filter(g => g && g.id && !BAIBAI_UNGROUPED_IDS.has(String(g.id)))
            .map((g, idx) => ({
                id: String(g.id),
                name: String(g.name ?? '未命名分组'),
                order: Number.isFinite(Number(g.order)) ? Number(g.order) : idx,
                collapsed: Boolean(g.collapsed),
                enabled: true,
                exclusive: false,
                note: '',
            }))
            .sort((a, b) => a.order - b.order);
    }

    const validIds = new Set(store.groups.map(g => g.id));
    if (baibaiRegexGroups.scripts && typeof baibaiRegexGroups.scripts === 'object') {
        for (const [scriptId, meta] of Object.entries(baibaiRegexGroups.scripts)) {
            const gid = meta?.groupId ? String(meta.groupId) : null;
            if (gid && !BAIBAI_UNGROUPED_IDS.has(gid) && validIds.has(gid)) {
                const entry = {
                    groupId: gid,
                    starred: false,
                    note: '',
                };
                if (Number.isFinite(Number(meta.order))) {
                    entry.order = Number(meta.order);
                }
                store.items[scriptId] = entry;
            }
        }
    }

    // Keep ungrouped "默认" group collapsed by default for a clean view
    store.defaultCollapsed = true;
    return normalizeGroupStore(store);
}

/**
 * Converts Bluebower's `regexGroups` back to `baibaiToolkit.regexGroups` portable format.
 * @param {Object} regexGroups
 * @returns {Object}
 */
export function convertRegexToBaibai(regexGroups) {
    const normalized = normalizeGroupStore(structuredClone(regexGroups));
    const scripts = {};
    let idx = 0;
    for (const [scriptId, meta] of Object.entries(normalized.items)) {
        if (meta.groupId) {
            scripts[scriptId] = {
                groupId: meta.groupId,
                order: typeof meta.order === 'number' ? meta.order : idx++,
            };
        }
    }
    return {
        version: 1,
        groups: normalized.groups.map((g, i) => ({
            id: g.id,
            name: g.name,
            order: i,
            collapsed: Boolean(g.collapsed),
        })),
        scripts,
        ungrouped: {
            name: '默认分组',
            collapsed: Boolean(normalized.defaultCollapsed),
        },
    };
}

function readRawBaibaiPresetRegex(ctx, pm, presetName) {
    return pm?.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.regexGroups` })
        ?? ctx?.chatCompletionSettings?.extensions?.[BAIBAI_KEY]?.regexGroups
        ?? (presetName ? ctx?.extensionSettings?.[BAIBAI_SETTINGS_KEY]?.regexListGroups?.scopes?.[`preset:openai:${presetName}`] : null)
        ?? null;
}

let cachedPresetName = undefined;
let cachedPresetData = null;

/**
 * Clears the in-memory preset cache so the next `loadPresetData()` reads fresh data.
 */
export function invalidatePresetCache() {
    cachedPresetName = undefined;
    cachedPresetData = null;
}

/**
 * Reads the current preset's Bluebower data, auto-migrating from `baibaiToolkit` if needed.
 * Shares a single live object per active preset so Prompt & Regex enhancers never overwrite each other.
 * @param {{ force?: boolean }} [opts]
 * @returns {{ data: Object, migratedFromBaibai: boolean, hasBaibaiData: boolean, presetName: string | null }}
 */
export function loadPresetData(opts = {}) {
    const ctx = window.SillyTavern?.getContext?.();
    const pm = ctx?.getPresetManager?.();
    const presetName = pm?.getSelectedPresetName?.() ?? null;
    const rawBaibaiPrompts = pm?.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.presetPromptGroups` })
        ?? ctx?.chatCompletionSettings?.extensions?.[BAIBAI_KEY]?.presetPromptGroups
        ?? null;
    const rawBaibaiRegex = readRawBaibaiPresetRegex(ctx, pm, presetName);
    const hasBaibaiData = Boolean(rawBaibaiPrompts || rawBaibaiRegex);

    if (!opts.force && cachedPresetData && cachedPresetName === presetName) {
        return {
            data: cachedPresetData,
            migratedFromBaibai: false,
            hasBaibaiData,
            presetName,
        };
    }

    let rawBluebower = pm?.readPresetExtensionField?.({ path: EXT_KEY }) ?? null;

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

        // Backfill preset regex groups from BaiBai if this preset's regexGroups was still empty
        if (
            data.regexGroups.groups.length === 0
            && Object.keys(data.regexGroups.items).length === 0
            && rawBaibaiRegex
            && Array.isArray(rawBaibaiRegex.groups)
            && rawBaibaiRegex.groups.length > 0
        ) {
            data.regexGroups = convertRegexFromBaibai(rawBaibaiRegex);
            migratedFromBaibai = true;
        }
    } else {
        data = createDefaultPresetData();
        data.settings.lockPromptOrder = getGlobalSettings().lockPromptOrder;
        if (rawBaibaiPrompts && typeof rawBaibaiPrompts === 'object') {
            data.promptGroups = convertFromBaibai(rawBaibaiPrompts);
            migratedFromBaibai = true;
        }
        if (rawBaibaiRegex && typeof rawBaibaiRegex === 'object') {
            data.regexGroups = convertRegexFromBaibai(rawBaibaiRegex);
            migratedFromBaibai = true;
        }
    }

    cachedPresetName = presetName;
    cachedPresetData = data;

    return {
        data,
        migratedFromBaibai,
        hasBaibaiData,
        presetName,
    };
}

function mergePersonalMeta(convertedStore, prevItems) {
    if (!prevItems || typeof prevItems !== 'object') return;
    for (const [id, meta] of Object.entries(convertedStore.items)) {
        if (prevItems[id]) {
            meta.starred = Boolean(prevItems[id].starred);
            meta.note = typeof prevItems[id].note === 'string' ? prevItems[id].note : '';
        }
    }
    for (const [id, prevMeta] of Object.entries(prevItems)) {
        if (!convertedStore.items[id] && (prevMeta?.starred || prevMeta?.note)) {
            convertedStore.items[id] = {
                groupId: null,
                starred: Boolean(prevMeta.starred),
                note: typeof prevMeta.note === 'string' ? prevMeta.note : '',
            };
        }
    }
}

/**
 * Restores grouping from `baibaiToolkit.presetPromptGroups` and `baibaiToolkit.regexGroups`,
 * preserving existing Bluebower item notes and stars where identifiers match.
 * @param {Object} currentData
 * @returns {{ data: Object, imported: boolean }}
 */
export function importFromBaibai(currentData) {
    const ctx = window.SillyTavern?.getContext?.();
    const pm = ctx?.getPresetManager?.();
    const presetName = pm?.getSelectedPresetName?.() ?? null;

    const rawBaibaiPrompts = pm?.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.presetPromptGroups` })
        ?? ctx?.chatCompletionSettings?.extensions?.[BAIBAI_KEY]?.presetPromptGroups
        ?? null;
    const rawBaibaiRegex = readRawBaibaiPresetRegex(ctx, pm, presetName);

    let imported = false;

    if (rawBaibaiPrompts && typeof rawBaibaiPrompts === 'object') {
        const convertedPrompts = convertFromBaibai(rawBaibaiPrompts);
        mergePersonalMeta(convertedPrompts, currentData?.promptGroups?.items);
        currentData.promptGroups = convertedPrompts;
        imported = true;
    }

    if (rawBaibaiRegex && typeof rawBaibaiRegex === 'object') {
        const convertedRegex = convertRegexFromBaibai(rawBaibaiRegex);
        mergePersonalMeta(convertedRegex, currentData?.regexGroups?.items);
        currentData.regexGroups = convertedRegex;
        imported = true;
    }

    return { data: currentData, imported };
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
            const existingBaibaiRegex = pm.readPresetExtensionField?.({ path: `${BAIBAI_KEY}.regexGroups` });
            if (payload.regexGroups.groups.length > 0 || existingBaibaiRegex) {
                await pm.writePresetExtensionField({
                    path: `${BAIBAI_KEY}.regexGroups`,
                    value: convertRegexToBaibai(payload.regexGroups),
                });
            }
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
            if (payload.regexGroups.groups.length > 0 || ctx.chatCompletionSettings.extensions[BAIBAI_KEY].regexGroups) {
                ctx.chatCompletionSettings.extensions[BAIBAI_KEY].regexGroups = convertRegexToBaibai(payload.regexGroups);
            }
        }
        ctx.saveSettingsDebounced?.();
    }
}

let savePresetTimer = null;
let pendingPresetData = null;
let pendingPresetName = null;

/**
 * Updates live `chatCompletionSettings.extensions` immediately in memory (0ms)
 * and debounces the heavy network preset save so UI taps have zero lag.
 * @param {Object} data
 * @param {number} [delayMs=500]
 */
export function savePresetDataDebounced(data, delayMs = 500) {
    const ctx = window.SillyTavern?.getContext?.();
    const currentName = ctx?.getPresetManager?.()?.getSelectedPresetName?.() ?? null;
    if (ctx?.chatCompletionSettings) {
        if (!ctx.chatCompletionSettings.extensions || typeof ctx.chatCompletionSettings.extensions !== 'object') {
            ctx.chatCompletionSettings.extensions = {};
        }
        ctx.chatCompletionSettings.extensions[EXT_KEY] = structuredClone(data);
        if (getGlobalSettings().syncBaibai) {
            if (!ctx.chatCompletionSettings.extensions[BAIBAI_KEY]) {
                ctx.chatCompletionSettings.extensions[BAIBAI_KEY] = {};
            }
            ctx.chatCompletionSettings.extensions[BAIBAI_KEY].presetPromptGroups = convertToBaibai(data.promptGroups);
            if (data.regexGroups?.groups?.length > 0 || ctx.chatCompletionSettings.extensions[BAIBAI_KEY].regexGroups) {
                ctx.chatCompletionSettings.extensions[BAIBAI_KEY].regexGroups = convertRegexToBaibai(data.regexGroups);
            }
        }
    }

    pendingPresetData = data;
    pendingPresetName = currentName;
    clearTimeout(savePresetTimer);
    savePresetTimer = setTimeout(() => {
        const toSave = pendingPresetData;
        const targetName = pendingPresetName;
        pendingPresetData = null;
        pendingPresetName = null;
        const activeName = window.SillyTavern?.getContext?.()?.getPresetManager?.()?.getSelectedPresetName?.() ?? null;
        if (toSave && activeName === targetName) {
            savePresetData(toSave);
        }
    }, delayMs);
}

/**
 * Persists global settings (including global regex grouping).
 */
export function saveGlobalSettings() {
    const ctx = window.SillyTavern?.getContext?.();
    ctx?.saveSettingsDebounced?.();
}
