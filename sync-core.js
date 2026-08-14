(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeInventorySyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeInventory(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('云端库存格式无效');
    }
    if (!Array.isArray(value.rooms) || !Array.isArray(value.spaces) || !Array.isArray(value.items)) {
      throw new Error('云端库存缺少房间、空间或物品列表');
    }
    return clone({ rooms: value.rooms, spaces: value.spaces, items: value.items });
  }

  function normalizeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('云端快照格式无效');
    }
    if (!Number.isInteger(value.revision) || value.revision < 0) {
      throw new Error('云端快照版本无效');
    }
    return {
      schemaVersion: value.schemaVersion === 1 ? 1 : 1,
      revision: value.revision,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
      data: normalizeInventory(value.data),
    };
  }

  function decideSync(localState, remoteSnapshot) {
    const local = localState || {};
    const baseRevision = Number.isInteger(local.baseRevision) && local.baseRevision >= 0
      ? local.baseRevision
      : 0;
    const dirty = local.dirty === true;
    const hasLocalData = local.hasLocalData === true;

    if (!remoteSnapshot) {
      if (!hasLocalData && !dirty) return { action: 'noop', revision: 0 };
      return { action: 'upload', nextRevision: Math.max(1, baseRevision + 1) };
    }

    const remoteRevision = remoteSnapshot.revision;
    if (!Number.isInteger(remoteRevision) || remoteRevision < 0) {
      throw new Error('云端快照版本无效');
    }

    if (!hasLocalData) return { action: 'download', remoteRevision };
    if (dirty && remoteRevision > baseRevision) {
      return { action: 'conflict', baseRevision, remoteRevision };
    }
    if (dirty) {
      return { action: 'upload', nextRevision: Math.max(baseRevision, remoteRevision) + 1 };
    }
    if (remoteRevision > baseRevision) return { action: 'download', remoteRevision };
    if (remoteRevision < baseRevision) return { action: 'upload', nextRevision: baseRevision + 1 };
    return { action: 'noop', revision: remoteRevision };
  }

  function nextLocalSnapshot(data, revision, options) {
    if (!Number.isInteger(revision) || revision < 1) throw new Error('上传版本无效');
    const settings = options || {};
    return {
      schemaVersion: 1,
      revision,
      updatedAt: settings.now || new Date().toISOString(),
      updatedBy: String(settings.deviceId || ''),
      data: normalizeInventory(data),
    };
  }

  return {
    normalizeSnapshot,
    decideSync,
    nextLocalSnapshot,
  };
});
