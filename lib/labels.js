/**
 * Shared human labels for Agent presets and permission presets.
 * Used by the session list, /status image and settings defaults.
 */

const PRESET_DISPLAY_NAMES = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
};

const PERMISSION_DISPLAY_NAMES = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '全系统',
  custom: '自定义',
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
  if (known) return known;
  const match = Array.isArray(presets) ? presets.find((item) => item && item.id === key) : undefined;
  return match?.name || key;
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
