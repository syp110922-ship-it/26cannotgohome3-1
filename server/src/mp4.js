'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

function readBoxHeader(fd, offset, fileSize) {
  if (offset + 8 > fileSize) return null;
  const header = Buffer.alloc(16);
  const bytesRead = fs.readSync(fd, header, 0, 16, offset);
  if (bytesRead < 8) return null;

  const size32 = header.readUInt32BE(0);
  const type = header.toString('ascii', 4, 8);

  if (size32 === 1) {
    if (bytesRead < 16) return null;
    const size64 = Number(header.readBigUInt64BE(8));
    if (!Number.isSafeInteger(size64) || size64 < 16) return null;
    return { type, size: size64, headerSize: 16 };
  }

  if (size32 === 0) {
    return { type, size: fileSize - offset, headerSize: 8 };
  }

  if (size32 < 8) return null;
  return { type, size: size32, headerSize: 8 };
}

function hasValidFtypHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const boxSize = buf.readUInt32BE(0);
  const boxType = buf.toString('ascii', 4, 8);
  if (boxType !== 'ftyp') return false;
  if (boxSize < 12 || boxSize > 4096) return false;
  // Major brand must be printable ASCII (4 bytes)
  for (let i = 8; i < 12; i++) {
    const code = buf[i];
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function parseMvhdDurationFromFile(fd, startOffset, endOffset) {
  const size = endOffset - startOffset;
  if (size < 20) return null;
  const buf = Buffer.alloc(Math.min(128, size));
  const read = fs.readSync(fd, buf, 0, buf.length, startOffset);
  if (read < 20) return null;

  const version = buf[0];
  if (version === 0) {
    if (read < 20) return null;
    const timescale = buf.readUInt32BE(12);
    const duration = buf.readUInt32BE(16);
    if (!timescale || !Number.isFinite(duration / timescale)) return null;
    return duration / timescale;
  }
  if (version === 1) {
    if (read < 32) return null;
    const timescale = buf.readUInt32BE(20);
    const durationBig = buf.readBigUInt64BE(24);
    const duration = Number(durationBig);
    if (!timescale || !Number.isFinite(duration / timescale)) return null;
    return duration / timescale;
  }
  return null;
}

function inspectMp4FileSync(filePath) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (fileSize < 24) {
    return { valid: false, reason: 'file_too_small' };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(64, fileSize));
    fs.readSync(fd, head, 0, head.length, 0);
    if (!hasValidFtypHeader(head)) {
      return { valid: false, reason: 'invalid_mp4_header' };
    }

    let offset = 0;
    let boxCount = 0;
    let moovRange = null;

    while (offset + 8 <= fileSize && boxCount < 10000) {
      boxCount += 1;
      const box = readBoxHeader(fd, offset, fileSize);
      if (!box || offset + box.size > fileSize) {
        return { valid: false, reason: 'corrupt_mp4_box' };
      }
      if (box.type === 'moov') {
        moovRange = { start: offset + box.headerSize, end: offset + box.size };
        break;
      }
      offset += box.size;
    }

    if (!moovRange) {
      return { valid: false, reason: 'missing_moov_box' };
    }

    let duration = null;
    let hasTrack = false;
    let childOffset = moovRange.start;
    let childCount = 0;

    while (childOffset + 8 <= moovRange.end && childCount < 2048) {
      childCount += 1;
      const child = readBoxHeader(fd, childOffset, moovRange.end);
      if (!child || childOffset + child.size > moovRange.end) {
        break;
      }
      if (child.type === 'mvhd') {
        duration = parseMvhdDurationFromFile(
          fd,
          childOffset + child.headerSize,
          childOffset + child.size
        );
      } else if (child.type === 'trak') {
        hasTrack = true;
      }
      childOffset += child.size;
    }

    if (!hasTrack) {
      return { valid: false, reason: 'missing_media_track' };
    }

    return {
      valid: true,
      duration: duration && duration > 0 ? Number(duration.toFixed(3)) : 0
    };
  } finally {
    fs.closeSync(fd);
  }
}

function probeDurationWithFfprobe(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath
      ],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) {
          resolve(0);
          return;
        }
        const parsed = Number.parseFloat(String(stdout || '').trim());
        resolve(Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(3)) : 0);
      }
    );
  });
}

async function inspectUploadedMp4(filePath) {
  const result = inspectMp4FileSync(filePath);
  if (!result.valid) {
    return result;
  }
  if (result.duration > 0) {
    return result;
  }
  const ffDuration = await probeDurationWithFfprobe(filePath);
  if (ffDuration > 0) {
    return { valid: true, duration: ffDuration };
  }
  return { valid: false, reason: 'invalid_mp4_duration' };
}

module.exports = {
  hasValidFtypHeader,
  inspectMp4FileSync,
  inspectUploadedMp4
};
