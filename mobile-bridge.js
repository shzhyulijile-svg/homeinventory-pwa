const Capacitor = window.Capacitor;
const Filesystem = Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem;
const Share = Capacitor && Capacitor.Plugins && Capacitor.Plugins.Share;
const Directory = { Cache: 'CACHE' };
const Encoding = { UTF8: 'utf8' };

async function shareBackupFile(payload) {
  const filename = String(payload && payload.filename || '全屋收纳备份.txt');
  const label = String(payload && payload.label || '备份');
  const file = await Filesystem.writeFile({
    path: filename,
    data: String(payload && payload.text || ''),
    directory: Directory.Cache,
    encoding: Encoding.UTF8
  });
  await Share.share({
    title: '全屋收纳' + label + '备份',
    text: '请选择应用保存或分享 ' + label + ' 文件',
    files: [file.uri],
    dialogTitle: '保存或分享 ' + label + ' 文件'
  });
}

function installMobileExportBridge() {
  if (!Capacitor || !Capacitor.isNativePlatform() || !Filesystem || !Share) return;
  const originalExport = window.exportData;
  window.mobileShareFile = shareBackupFile;
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
      await shareBackupFile(payload);
    } catch (error) {
      if (String(error && error.message || error).toLowerCase().includes('cancel')) return;
      alert('导出失败：' + (error && error.message ? error.message : '无法分享备份文件'));
    }
  };
}

installMobileExportBridge();
