(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeInventoryBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BEGIN_MARKER = 'HOME_INVENTORY_BACKUP_V1_BEGIN';
  const END_MARKER = 'HOME_INVENTORY_BACKUP_V1_END';

  function stripBom(text) {
    return String(text == null ? '' : text).replace(/^\ufeff/, '');
  }

  function validateBackup(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('备份文件格式不正确');
    }
    for (const key of ['rooms', 'spaces', 'items']) {
      if (!Array.isArray(data[key]) || data[key].some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
        throw new Error('备份文件格式不正确');
      }
    }
    return data;
  }

  function encodeUtf8Base64(value) {
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(start, start + 8192));
    }
    return btoa(binary);
  }

  function decodeUtf8Base64(value) {
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  function exportJson(data) {
    return JSON.stringify(validateBackup(data), null, 2);
  }

  function exportTxt(data, readableText) {
    const readable = stripBom(readableText).replace(/\s+$/, '');
    const encoded = encodeUtf8Base64(JSON.stringify(validateBackup(data)));
    return '\ufeff' + readable + [
      '',
      '',
      '------------------------------------------------------------',
      '以下内容用于导入恢复，请勿修改',
      BEGIN_MARKER,
      encoded,
      END_MARKER,
      ''
    ].join('\r\n');
  }

  function parseEmbeddedTxt(text) {
    const source = stripBom(text);
    const begin = source.indexOf(BEGIN_MARKER);
    const end = source.indexOf(END_MARKER);
    if (begin < 0 || end <= begin) return null;
    const encoded = source.slice(begin + BEGIN_MARKER.length, end).replace(/\s/g, '');
    if (!encoded) throw new Error('TXT 恢复数据为空');
    try {
      return validateBackup(JSON.parse(decodeUtf8Base64(encoded)));
    } catch (error) {
      if (error && /备份文件格式/.test(error.message || '')) throw error;
      throw new Error('TXT 恢复数据已损坏');
    }
  }

  function splitNameAndNote(value) {
    const match = String(value || '').trim().match(/^(.*)（([\s\S]*)）$/);
    return match ? { name: match[1], note: match[2] } : { name: String(value || '').trim(), note: '' };
  }

  function parseLegacyTxt(text) {
    const source = stripBom(text);
    if (!/^全屋收纳清单(?:\r?\n|$)/.test(source)) throw new Error('无法识别这个 TXT 文件');

    const result = { rooms: [], spaces: [], items: [] };
    let currentRoom = null;
    let currentSpace = null;
    let currentItem = null;

    function ensureUnplacedSpace() {
      if (currentSpace) return;
      currentRoom = { id: 'r' + (result.rooms.length + 1), name: '未分类', note: '' };
      result.rooms.push(currentRoom);
      currentSpace = { id: 's' + (result.spaces.length + 1), roomId: currentRoom.id, name: '位置未知', note: '' };
      result.spaces.push(currentSpace);
    }

    for (const rawLine of source.split(/\r?\n/)) {
      let match;
      if ((match = rawLine.match(/^房间：(.+)$/))) {
        const fields = splitNameAndNote(match[1]);
        currentRoom = { id: 'r' + (result.rooms.length + 1), name: fields.name, note: fields.note };
        result.rooms.push(currentRoom);
        currentSpace = null;
        currentItem = null;
        continue;
      }
      if ((match = rawLine.match(/^\s*收纳空间：(.+)$/))) {
        if (!currentRoom) throw new Error('TXT 文件中的收纳空间缺少所属房间');
        const fields = splitNameAndNote(match[1]);
        currentSpace = {
          id: 's' + (result.spaces.length + 1),
          roomId: currentRoom.id,
          name: fields.name,
          note: fields.note
        };
        result.spaces.push(currentSpace);
        currentItem = null;
        continue;
      }
      if (/^位置未知的物品\s*$/.test(rawLine)) {
        currentRoom = null;
        currentSpace = null;
        currentItem = null;
        ensureUnplacedSpace();
        continue;
      }
      if ((match = rawLine.match(/^\s+\d+\.\s+(.+)$/))) {
        ensureUnplacedSpace();
        currentItem = {
          id: 'i' + (result.items.length + 1),
          spaceId: currentSpace.id,
          name: match[1].trim(),
          qty: 1,
          expiry: '',
          tags: '',
          note: ''
        };
        result.items.push(currentItem);
        continue;
      }
      if (!currentItem) continue;
      if ((match = rawLine.match(/^\s*数量：(.+)$/))) {
        currentItem.qty = Math.max(1, parseInt(match[1], 10) || 1);
      } else if ((match = rawLine.match(/^\s*保质期：([^（\s]+)(?:（已过期）)?\s*$/))) {
        currentItem.expiry = match[1];
      } else if ((match = rawLine.match(/^\s*标签：(.*)$/))) {
        currentItem.tags = match[1].trim();
      } else if ((match = rawLine.match(/^\s*备注：(.*)$/))) {
        currentItem.note = match[1];
      } else if (/^\s+\S/.test(rawLine) && !/^\s*=+\s*$/.test(rawLine)) {
        currentItem.note += (currentItem.note ? '\n' : '') + rawLine.trim();
      }
    }

    return validateBackup(result);
  }

  function importBackup(text, filename) {
    const source = stripBom(text).trim();
    const lowerName = String(filename || '').toLowerCase();
    if (!source) throw new Error('备份文件为空');

    if (lowerName.endsWith('.json') || source.charAt(0) === '{') {
      try {
        return validateBackup(JSON.parse(source));
      } catch (error) {
        if (error && /备份文件格式/.test(error.message || '')) throw error;
        throw new Error('JSON 文件格式错误');
      }
    }

    const embedded = parseEmbeddedTxt(source);
    return embedded || parseLegacyTxt(source);
  }

  return {
    exportJson,
    exportTxt,
    importBackup,
    validateBackup
  };
});
