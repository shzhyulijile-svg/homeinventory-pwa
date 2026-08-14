(function () {
  const capacitor = window.Capacitor;
  if (capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform()) return;

  const originalExport = window.exportData;

  async function shareBackupFile(payload) {
    if (typeof File !== 'function' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
      return false;
    }
    const file = new File([payload.text], payload.filename, { type: payload.mimeType });
    if (!navigator.canShare({ files: [file] })) return false;
    await navigator.share({
      title: '全屋收纳' + payload.label + '备份',
      text: '全屋收纳 ' + payload.label + ' 备份',
      files: [file]
    });
    return true;
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function showIOSInstallHint() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    if (!isIOS || isStandalone() || sessionStorage.getItem('pwa_install_tip_dismissed') === '1') return;
    const header = document.querySelector('.header');
    if (!header || document.querySelector('.pwa-install-tip')) return;
    const tip = document.createElement('div');
    tip.className = 'pwa-install-tip';
    tip.innerHTML = '<div><strong>安装到 iPhone</strong><span>点 Safari 的“分享” → “添加到主屏幕”，并打开“作为网页 App 打开”。</span></div><button type="button" aria-label="关闭安装提示">知道了</button>';
    tip.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem('pwa_install_tip_dismissed', '1');
      tip.remove();
    });
    header.insertAdjacentElement('afterend', tip);
  }

  window.exportData = async function (format) {
    let payload;
    if (typeof window.getExportPayload === 'function') {
      payload = window.getExportPayload(format === 'json' ? 'json' : 'txt');
    } else if (typeof window.getExportText === 'function') {
      payload = Object.assign({ label: 'TXT', mimeType: 'text/plain;charset=utf-8', extension: '.txt' }, window.getExportText());
    } else {
      return originalExport.apply(window, arguments);
    }
    try {
      if (await shareBackupFile(payload)) return;
      return originalExport.apply(window, arguments);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      alert('导出失败：' + (error && error.message ? error.message : '无法分享备份文件'));
    }
  };

  window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
    showIOSInstallHint();
  });
})();
