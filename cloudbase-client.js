(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeInventoryCloudBaseClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLLECTION = 'home_inventory_snapshots';

  // iOS 主屏幕 PWA（独立窗口）对带凭证的跨域 XHR 会直接报 "Load failed"，
  // 而 CloudBase 邮箱登录流程不依赖 cookie（令牌在请求体/header 里），
  // 因此对 CloudBase API 域名强制关闭 withCredentials。
  function installCloudBaseCredentialStrip() {
    if (typeof window === 'undefined' || typeof window.XMLHttpRequest !== 'function') return;
    if (window.XMLHttpRequest.__homeInventoryCredStrip) return;
    const proto = window.XMLHttpRequest.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'withCredentials');
    if (!desc || !desc.set || !desc.configurable) return;
    const origOpen = proto.open;
    proto.open = function (method, url) {
      this.__homeInventoryStripCred = typeof url === 'string' && url.indexOf('tcb-api.tencentcloudapi.com') >= 0;
      return origOpen.apply(this, arguments);
    };
    Object.defineProperty(proto, 'withCredentials', {
      configurable: true,
      get: desc.get,
      set: function (value) { desc.set.call(this, this.__homeInventoryStripCred ? false : value); },
    });
    window.XMLHttpRequest.__homeInventoryCredStrip = true;
  }

  function asError(error, fallback) {
    const message = error && error.message ? error.message : fallback;
    const wrapped = new Error(message || 'CloudBase 请求失败');
    if (error && error.code) wrapped.code = error.code;
    wrapped.cause = error || null;
    return wrapped;
  }

  function unwrap(result, fallback) {
    if (result && result.error) throw asError(result.error, fallback);
    return result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result;
  }

  function getAuth(app) {
    if (app.auth && typeof app.auth.signInWithPassword === 'function') return app.auth;
    if (typeof app.auth === 'function') return app.auth({ persistence: 'local' });
    throw new Error('CloudBase 身份认证模块不可用');
  }

  function getUserId(user) {
    const value = user && (user.id || user.uid || user.sub || user._id);
    if (!value) throw new Error('未获取到 CloudBase 用户标识');
    return String(value);
  }

  function documentIdForUser(user) {
    const safe = getUserId(user)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (!safe) throw new Error('CloudBase 用户标识无法生成文档 ID');
    return 'inventory-' + safe;
  }

  function cleanSnapshot(record) {
    if (!record) return null;
    return {
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      data: record.data,
    };
  }

  function createCloudBaseClient(options) {
    const settings = options || {};
    const cloudbase = settings.cloudbase;
    const config = settings.config || {};
    if (!cloudbase || typeof cloudbase.init !== 'function') throw new Error('缺少 CloudBase SDK');
    if (!config.env) throw new Error('缺少 CloudBase 环境 ID');

    installCloudBaseCredentialStrip();
    const app = cloudbase.init(config);
    const auth = getAuth(app);
    const db = app.database();
    let pendingRegistrationVerifier = null;

    async function getSession() {
      const data = unwrap(await auth.getSession(), '检查登录状态失败') || {};
      return { user: data.user || null, session: data.session || null };
    }

    async function requireUser() {
      const session = await getSession();
      if (!session.user) {
        const error = new Error('请先登录再同步');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      return session.user;
    }

    async function signIn(email, password) {
      return unwrap(await auth.signInWithPassword({ email, password }), '登录失败');
    }

    async function beginRegistration(email, password) {
      const data = unwrap(await auth.signUp({ email, password }), '发送注册验证码失败') || {};
      if (typeof data.verifyOtp !== 'function') throw new Error('CloudBase 未返回验证码确认流程');
      pendingRegistrationVerifier = data.verifyOtp;
      return true;
    }

    async function completeRegistration(code) {
      if (!pendingRegistrationVerifier) throw new Error('请先发送注册验证码');
      const verifier = pendingRegistrationVerifier;
      const data = unwrap(await verifier({ token: code }), '验证码确认失败');
      pendingRegistrationVerifier = null;
      return data;
    }

    async function signOut() {
      const result = await auth.signOut();
      return unwrap(result, '退出登录失败');
    }

    async function getDocumentContext() {
      const user = await requireUser();
      const documentId = documentIdForUser(user);
      const collection = db.collection(COLLECTION);
      return { user, documentId, collection, document: collection.doc(documentId) };
    }

    async function getRowsByDocumentId(context) {
      const result = await context.collection.where({ _id: context.documentId }).get();
      if (result && result.code) throw asError(result, '读取云端数据失败');
      return result && Array.isArray(result.data) ? result.data : [];
    }

    async function getSnapshot() {
      const context = await getDocumentContext();
      const rows = await getRowsByDocumentId(context);
      return rows.length ? cleanSnapshot(rows[0]) : null;
    }

    async function putSnapshot(snapshot, putOptions) {
      const context = await getDocumentContext();
      const expectedRevision = putOptions && Number.isInteger(putOptions.expectedRevision)
        ? putOptions.expectedRevision
        : 0;

      if (expectedRevision === 0) {
        const existingRows = await getRowsByDocumentId(context);
        if (existingRows.length) {
          const conflict = new Error('云端数据已被其他设备更新');
          conflict.code = 'SYNC_CONFLICT';
          throw conflict;
        }
        const result = await context.document.set(cleanSnapshot(snapshot));
        if (result && result.code) throw asError(result, '创建云端数据失败');
        return result;
      }

      const result = await context.collection.where({
        _id: context.documentId,
        revision: expectedRevision,
      }).update(cleanSnapshot(snapshot));
      if (result && result.code) throw asError(result, '更新云端数据失败');
      if (!result || result.updated !== 1) {
        const conflict = new Error('云端数据已被其他设备更新');
        conflict.code = 'SYNC_CONFLICT';
        throw conflict;
      }
      return result;
    }

    return {
      getSession,
      signIn,
      beginRegistration,
      completeRegistration,
      signOut,
      getSnapshot,
      putSnapshot,
      documentIdForUser,
    };
  }

  return { createCloudBaseClient, documentIdForUser };
});
