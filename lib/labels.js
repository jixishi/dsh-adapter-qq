/**
 * Shared human labels for Agent presets and permission presets.
 * Used by the session list, /status image and settings defaults.
 *
 * IMPORTANT: `agentPresets.list()` returns `{ id, name?, description?, order?, broken? }`
 * (see the Host `agentPresets` service contract). There is **no** `trust` field, and the
 * four built-in presets ship without a display name — so a raw id must never be shown to
 * the user on its own.
 */

const PRESET_DISPLAY_NAMES = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
};

const PRESET_DESCRIPTIONS = {
  standard: '完整编码 Agent，支持文件、Shell、检索、工作流等全量能力',
  ptc: '完整编码 Agent，通过 TypeScript 程序组合多步操作',
  minimal: '轻量极简，仅持久 bash + str_replace_editor 双工具',
  cordis: '用于自定义预设与插件创作，具备运行时检查指导',
};

const PERMISSION_DISPLAY_NAMES = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '全系统',
  custom: '自定义',
  unknown: '未知',
};

/**
 * Resolve the display label of one Agent preset id.
 * @param {string} id
 * @param {Array<{id:string,name?:string}>} [presets]
 * @returns {string}
 */
export function resolvePresetLabel(id, presets = []) {
  const key = String(id ?? '').trim();
  if (!key) return '默认';
  const known = PRESET_DISPLAY_NAMES[key.toLowerCase()];
  const match = Array.isArray(presets) ? presets.find((item) => item && item.id === key) : undefined;
  // The built-in four keep their product label; anything else shows the name the
  // Host reports, and finally the raw id when the Host reports nothing.
  return known || match?.name || key;
}

/**
 * Resolve the one-line description of an Agent preset id.
 * @param {string} id
 * @param {Array<{id:string,description?:string}>} [presets]
 * @returns {string}
 */
export function resolvePresetDescription(id, presets = []) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  const match = Array.isArray(presets) ? presets.find((item) => item && item.id === key) : undefined;
  return match?.description || PRESET_DESCRIPTIONS[key.toLowerCase()] || '';
}

/**
 * Whether this id is one of the presets shipped with DSH.
 * @param {string} id
 * @returns {boolean}
 */
export function isBuiltinPreset(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return Boolean(PRESET_DISPLAY_NAMES[key]);
}

/**
 * Resolve the display label of one permission preset id.
 * @param {string} id
 * @param {Array<{id:string,name?:string}>} [permissions]
 * @returns {string}
 */
export function resolvePermissionLabel(id, permissions = []) {
  const key = String(id ?? '').trim();
  if (!key) return '默认';
  const known = PERMISSION_DISPLAY_NAMES[key.toLowerCase()];
  if (known) return known;
  const match = Array.isArray(permissions) ? permissions.find((item) => item && item.id === key) : undefined;
  return match?.name || key;
}

export { PRESET_DISPLAY_NAMES, PRESET_DESCRIPTIONS, PERMISSION_DISPLAY_NAMES };
