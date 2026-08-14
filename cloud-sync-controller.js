(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeInventoryCloudSyncController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const META_KEY = 'home_inventory_sync_v1';

  function userIdOf(user) {
    const value = user && (user.id || user.uid || user.sub || user._id);
    return value ? String(value) : '';
  }

  function createSyncController(options) {
    const settings = options || {};
    const client = settings.client;
    const core = settings.core;
    const storage = settings.storage;
    if (!client || !core || !storage) throw new Error('云同步控制器配置不完整');

    const readData = settings.readData;
    const writeData = settings.writeData;
    const hasLocalData = settings.hasLocalData;
    const deviceId = settings.deviceId || 'unknown-device';
    const isOnline = settings.isOnline || (() => true);
    const now = settings.now || (() => new Date().toISOString());
    const setTimeoutFn = settings.setTimeoutFn || setTimeout;
    const clearTimeoutFn = settings.clearTimeoutFn || clearTimeout;
    const onStatus = settings.onStatus || (() => {});
    const onConflict = settings.onConflict || (() => {});

    let user = null;
    let timer = null;
    let syncingPromise = null;
    let conflict = null;
    let meta = loadMeta();

    function loadMeta() {
      try {
        const raw = storage.getItem(META_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') throw new Error('empty');
        return {
          userId: typeof parsed.userId === 'string' ? parsed.userId : '',
          baseRevision: Number.isInteger(parsed.baseRevision) && parsed.baseRevision >= 0 ? parsed.baseRevision : 0,
          dirty: parsed.dirty === true,
          lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : '',
        };
      } catch (_) {
        return {
          userId: '',
          baseRevision: 0,
          dirty: typeof hasLocalData === 'function' ? hasLocalData() : false,
          lastSyncedAt: '',
        };
      }
    }

    function persistMeta() {
      storage.setItem(META_KEY, JSON.stringify(meta));
    }

    function emit(kind, message, detail) {
      const status = { kind, message: message || '', detail: detail || null };
      onStatus(status);
      return status;
    }

    function setUser(nextUser) {
      user = nextUser || null;
      const id = userIdOf(user);
      if (id && meta.userId !== id) {
        meta = {
          userId: id,
          baseRevision: 0,
          dirty: typeof hasLocalData === 'function' ? hasLocalData() : false,
          lastSyncedAt: '',
        };
        persistMeta();
      }
    }

    async function initialize(initOptions) {
      try {
        const session = await client.getSession();
        setUser(session && session.user);
        if (!user) {
          emit('signed-out', '未登录');
          return { action: 'signed-out' };
        }
        emit('ready', '已登录，等待同步');
        if (initOptions && initOptions.skipSync) return { action: 'ready' };
        return sync();
      } catch (error) {
        emit('error', error.message || '检查登录状态失败', error);
        return { action: 'error', error };
      }
    }

    async function login(email, password, loginOptions) {
      emit('syncing', '正在登录…');
      const result = await client.signIn(email, password);
      setUser(result && result.user);
      if (!user) {
        const session = await client.getSession();
        setUser(session && session.user);
      }
      emit('ready', '登录成功');
      if (loginOptions && loginOptions.skipSync) return result;
      await sync();
      return result;
    }

    async function beginRegistration(email, password) {
      emit('syncing', '正在发送邮箱验证码…');
      const result = await client.beginRegistration(email, password);
      emit('verification', '验证码已发送，请查看邮箱');
      return result;
    }

    async function completeRegistration(code, registerOptions) {
      emit('syncing', '正在验证邮箱…');
      const result = await client.completeRegistration(code);
      setUser(result && result.user);
      if (!user) {
        const session = await client.getSession();
        setUser(session && session.user);
      }
      emit('ready', '注册并登录成功');
      if (registerOptions && registerOptions.skipSync) return result;
      await sync();
      return result;
    }

    async function logout() {
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      await client.signOut();
      user = null;
      conflict = null;
      emit('signed-out', '已退出登录');
    }

    function markLocalChange() {
      meta.dirty = true;
      persistMeta();
      if (!user) {
        emit('pending', '本地已保存，登录后同步');
        return;
      }
      emit(isOnline() ? 'pending' : 'offline', isOnline() ? '等待同步' : '离线，联网后自动同步');
      if (timer !== null) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        timer = null;
        return sync();
      }, 1200);
    }

    async function performSync() {
      if (!user) {
        emit('signed-out', '请先登录');
        return { action: 'signed-out' };
      }
      if (!isOnline()) {
        emit('offline', '离线，联网后自动同步');
        return { action: 'offline' };
      }

      emit('syncing', '正在同步…');
      const rawRemote = await client.getSnapshot();
      const remote = rawRemote ? core.normalizeSnapshot(rawRemote) : null;
      const decision = core.decideSync({
        hasLocalData: typeof hasLocalData === 'function' ? hasLocalData() : true,
        dirty: meta.dirty,
        baseRevision: meta.baseRevision,
      }, remote);

      if (decision.action === 'upload') {
        const snapshot = core.nextLocalSnapshot(readData(), decision.nextRevision, {
          deviceId,
          now: now(),
        });
        try {
          await client.putSnapshot(snapshot, { expectedRevision: remote ? remote.revision : 0 });
        } catch (error) {
          if (error && error.code === 'SYNC_CONFLICT') {
            const latest = await client.getSnapshot();
            conflict = {
              localData: readData(),
              remote: core.normalizeSnapshot(latest),
            };
            emit('conflict', '电脑和手机都修改过，请选择保留版本', conflict);
            onConflict(conflict);
            return { action: 'conflict' };
          }
          throw error;
        }
        meta.baseRevision = snapshot.revision;
        meta.dirty = false;
        meta.lastSyncedAt = snapshot.updatedAt;
        persistMeta();
        emit('synced', '已同步');
        return { action: 'upload', revision: snapshot.revision };
      }

      if (decision.action === 'download') {
        writeData(remote.data, { fromSync: true });
        meta.baseRevision = remote.revision;
        meta.dirty = false;
        meta.lastSyncedAt = remote.updatedAt || now();
        persistMeta();
        emit('synced', '已下载云端数据');
        return { action: 'download', revision: remote.revision };
      }

      if (decision.action === 'conflict') {
        conflict = { localData: readData(), remote };
        emit('conflict', '电脑和手机都修改过，请选择保留版本', conflict);
        onConflict(conflict);
        return { action: 'conflict' };
      }

      if (remote) meta.baseRevision = remote.revision;
      meta.dirty = false;
      meta.lastSyncedAt = now();
      persistMeta();
      emit('synced', '已是最新');
      return { action: 'noop', revision: meta.baseRevision };
    }

    function sync() {
      if (syncingPromise) return syncingPromise;
      syncingPromise = performSync()
        .catch((error) => {
          emit(isOnline() ? 'error' : 'offline', error.message || '同步失败', error);
          throw error;
        })
        .finally(() => { syncingPromise = null; });
      return syncingPromise;
    }

    async function resolveConflict(choice) {
      if (!conflict) throw new Error('当前没有待处理的同步冲突');
      const active = conflict;
      if (choice === 'remote') {
        writeData(active.remote.data, { fromSync: true });
        meta.baseRevision = active.remote.revision;
        meta.dirty = false;
        meta.lastSyncedAt = active.remote.updatedAt || now();
        conflict = null;
        persistMeta();
        emit('synced', '已保留云端版本');
        return { action: 'download', revision: meta.baseRevision };
      }
      if (choice === 'local') {
        const snapshot = core.nextLocalSnapshot(readData(), active.remote.revision + 1, {
          deviceId,
          now: now(),
        });
        await client.putSnapshot(snapshot, { expectedRevision: active.remote.revision });
        meta.baseRevision = snapshot.revision;
        meta.dirty = false;
        meta.lastSyncedAt = snapshot.updatedAt;
        conflict = null;
        persistMeta();
        emit('synced', '已保留本机版本');
        return { action: 'upload', revision: snapshot.revision };
      }
      throw new Error('未知的冲突处理方式');
    }

    function getState() {
      return {
        user,
        userId: userIdOf(user),
        baseRevision: meta.baseRevision,
        dirty: meta.dirty,
        lastSyncedAt: meta.lastSyncedAt,
        conflict: Boolean(conflict),
      };
    }

    return {
      initialize,
      login,
      beginRegistration,
      completeRegistration,
      logout,
      markLocalChange,
      sync,
      resolveConflict,
      getState,
    };
  }

  return { createSyncController };
});
