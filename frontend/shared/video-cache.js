(function (root) {
  'use strict';

  var DB_NAME = 'ghost_video_cache';
  var DB_VERSION = 1;
  var STORE_VIDEOS = 'videos';
  var STORE_CHUNKS = 'chunks';
  var CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB chunks for multi-GB stability
  var MAX_CACHED_VIDEOS = 2;

  var SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function Sha256() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.w = new Uint32Array(64);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.bytesHashed = 0;
  }

  Sha256.prototype._compress = function (block, offset) {
    var w = this.w;
    var h = this.h;
    var i;
    for (i = 0; i < 16; i++) {
      var j = offset + i * 4;
      w[i] =
        ((block[j] << 24) |
          (block[j + 1] << 16) |
          (block[j + 2] << 8) |
          block[j + 3]) >>>
        0;
    }
    for (i = 16; i < 64; i++) {
      var w15 = w[i - 15];
      var w2 = w[i - 2];
      var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    var a = h[0];
    var b = h[1];
    var c = h[2];
    var d = h[3];
    var e = h[4];
    var f = h[5];
    var g = h[6];
    var hh = h[7];

    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  };

  Sha256.prototype.update = function (data) {
    var input = data instanceof Uint8Array ? data : new Uint8Array(data);
    var len = input.length;
    if (len === 0) return this;
    this.bytesHashed += len;

    var pos = 0;
    if (this.blockLen > 0) {
      var fill = Math.min(64 - this.blockLen, len);
      this.block.set(input.subarray(0, fill), this.blockLen);
      this.blockLen += fill;
      pos += fill;
      if (this.blockLen === 64) {
        this._compress(this.block, 0);
        this.blockLen = 0;
      }
    }

    while (pos + 64 <= len) {
      this._compress(input, pos);
      pos += 64;
    }

    if (pos < len) {
      var rem = len - pos;
      this.block.set(input.subarray(pos), 0);
      this.blockLen = rem;
    }
    return this;
  };

  Sha256.prototype.digestHex = function () {
    var bitLen = this.bytesHashed * 8;
    var pad = new Uint8Array(64);
    pad[0] = 0x80;

    var rem = this.blockLen;
    var padLen = rem < 56 ? 56 - rem : 120 - rem;
    var tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;

    // 64-bit big-endian bit length
    var high = Math.floor(bitLen / 0x100000000);
    var low = bitLen >>> 0;
    tail[padLen] = (high >>> 24) & 0xff;
    tail[padLen + 1] = (high >>> 16) & 0xff;
    tail[padLen + 2] = (high >>> 8) & 0xff;
    tail[padLen + 3] = high & 0xff;
    tail[padLen + 4] = (low >>> 24) & 0xff;
    tail[padLen + 5] = (low >>> 16) & 0xff;
    tail[padLen + 6] = (low >>> 8) & 0xff;
    tail[padLen + 7] = low & 0xff;

    // Preserve state copy via feed into block buffer
    var idx = 0;
    while (idx < tail.length) {
      var take = Math.min(64 - this.blockLen, tail.length - idx);
      this.block.set(tail.subarray(idx, idx + take), this.blockLen);
      this.blockLen += take;
      idx += take;
      if (this.blockLen === 64) {
        this._compress(this.block, 0);
        this.blockLen = 0;
      }
    }

    var out = '';
    for (var i = 0; i < 8; i++) {
      var v = this.h[i];
      out += ('00000000' + v.toString(16)).slice(-8);
    }
    return out;
  };

  function openDb() {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (event) {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
            db.createObjectStore(STORE_VIDEOS, { keyPath: 'videoId' });
          }
          if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
            var chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
            chunkStore.createIndex('byVideoId', 'videoId', { unique: false });
          }
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (_err) {
        resolve(null);
      }
    });
  }

  function idbGetVideo(db, videoId) {
    if (!db) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE_VIDEOS, 'readonly');
      var req = tx.objectStore(STORE_VIDEOS).get(videoId);
      req.onsuccess = function () {
        resolve(req.result || null);
      };
      req.onerror = function () {
        resolve(null);
      };
    });
  }

  function idbListVideos(db) {
    if (!db) return Promise.resolve([]);
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE_VIDEOS, 'readonly');
      var req = tx.objectStore(STORE_VIDEOS).getAll();
      req.onsuccess = function () {
        resolve(Array.isArray(req.result) ? req.result : []);
      };
      req.onerror = function () {
        resolve([]);
      };
    });
  }

  function idbPutVideo(db, record) {
    if (!db) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_VIDEOS, 'readwrite');
      tx.objectStore(STORE_VIDEOS).put(record);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error('idb_put_video_failed'));
      };
    });
  }

  function idbGetChunk(db, videoId, index) {
    if (!db) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE_CHUNKS, 'readonly');
      var req = tx.objectStore(STORE_CHUNKS).get(videoId + ':' + index);
      req.onsuccess = function () {
        resolve(req.result || null);
      };
      req.onerror = function () {
        resolve(null);
      };
    });
  }

  function idbPutChunk(db, videoId, index, blob) {
    if (!db) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_CHUNKS, 'readwrite');
      tx.objectStore(STORE_CHUNKS).put({
        key: videoId + ':' + index,
        videoId: videoId,
        index: index,
        blob: blob
      });
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error('idb_put_chunk_failed'));
      };
    });
  }

  function idbDeleteVideo(db, videoId) {
    if (!db) return Promise.resolve();
    return new Promise(function (resolve) {
      var tx = db.transaction([STORE_VIDEOS, STORE_CHUNKS], 'readwrite');
      tx.objectStore(STORE_VIDEOS).delete(videoId);
      var index = tx.objectStore(STORE_CHUNKS).index('byVideoId');
      var range = IDBKeyRange.only(videoId);
      var cursorReq = index.openKeyCursor(range);
      cursorReq.onsuccess = function () {
        var cursor = cursorReq.result;
        if (cursor) {
          tx.objectStore(STORE_CHUNKS).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        resolve();
      };
    });
  }

  async function pruneOtherVideos(db, keepVideoId, maxKeep) {
    if (!db) return;
    var all = await idbListVideos(db);
    var others = all
      .filter(function (v) {
        return v.videoId !== keepVideoId;
      })
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    var allowedOthers = Math.max(0, maxKeep - 1);
    for (var i = allowedOthers; i < others.length; i++) {
      await idbDeleteVideo(db, others[i].videoId);
    }
  }

  async function hashBlobInto(blob, hasher) {
    var ab = await blob.arrayBuffer();
    hasher.update(new Uint8Array(ab));
    return ab.byteLength;
  }

  function joinBuffers(parts, totalBytes) {
    var out = new Uint8Array(totalBytes);
    var pos = 0;
    for (var i = 0; i < parts.length; i++) {
      out.set(parts[i], pos);
      pos += parts[i].length;
    }
    return out;
  }

  async function ensureCached(options) {
    var meta = options.meta;
    var apiBase = String(options.apiBase || '').replace(/\/+$/, '');
    var getToken = options.getToken;
    var forceResync = Boolean(options.forceResync);
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    var signal = options.signal;

    if (!meta || !meta.videoId) {
      throw new Error('missing_video_meta');
    }

    var videoId = meta.videoId;
    var expectedSize = Number(meta.size || 0);
    var expectedSha = meta.sha256 ? String(meta.sha256).toLowerCase() : '';
    var videoUrl = meta.url
      ? meta.url.startsWith('http')
        ? meta.url
        : apiBase + meta.url
      : apiBase + '/video/' + encodeURIComponent(videoId);

    var db = await openDb();
    if (db && forceResync) {
      await idbDeleteVideo(db, videoId);
    }

    var record = db ? await idbGetVideo(db, videoId) : null;
    var sameMeta =
      record &&
      (!expectedSize || record.size === expectedSize) &&
      (!expectedSha || !record.sha256 || record.sha256 === expectedSha);

    if (db && sameMeta && record.completed && record.chunkCount > 0) {
      var cachedBlobs = [];
      var cachedBytes = 0;
      var missing = false;
      for (var c = 0; c < record.chunkCount; c++) {
        var row = await idbGetChunk(db, videoId, c);
        if (!row || !row.blob) {
          missing = true;
          break;
        }
        cachedBlobs.push(row.blob);
        cachedBytes += row.blob.size;
      }
      if (!missing && (!expectedSize || cachedBytes === expectedSize)) {
        await idbPutVideo(db, Object.assign({}, record, { updatedAt: Date.now() }));
        onProgress(100);
        return URL.createObjectURL(new Blob(cachedBlobs, { type: 'video/mp4' }));
      }
      await idbDeleteVideo(db, videoId);
    }

    var hasher = new Sha256();
    var offset = 0;
    var chunkIndex = 0;
    var chunkBlobs = [];
    var useIdb = Boolean(db);

    if (db && sameMeta && !record.completed) {
      while (true) {
        var partial = await idbGetChunk(db, videoId, chunkIndex);
        if (!partial || !partial.blob) break;
        if (partial.blob.size !== CHUNK_SIZE) break;
        await hashBlobInto(partial.blob, hasher);
        chunkBlobs.push(partial.blob);
        offset += partial.blob.size;
        chunkIndex += 1;
      }
      if (offset > 0 && expectedSize > 0) {
        onProgress(Math.min(99, Math.floor((offset / expectedSize) * 100)));
      }
    } else if (db) {
      await idbDeleteVideo(db, videoId);
    }

    if (useIdb) {
      await idbPutVideo(db, {
        videoId: videoId,
        size: expectedSize,
        sha256: expectedSha,
        chunkSize: CHUNK_SIZE,
        chunkCount: chunkIndex,
        completed: false,
        updatedAt: Date.now()
      }).catch(function () {
        useIdb = false;
      });
    }

    var fetchHeaders = {
      Authorization: 'Bearer ' + String(getToken ? getToken() : '')
    };
    if (offset > 0) {
      fetchHeaders.Range = 'bytes=' + offset + '-';
    }

    var res = await fetch(videoUrl, { headers: fetchHeaders, signal: signal });
    if (offset > 0 && res.status === 200) {
      // Server ignored Range or restarted from byte 0
      offset = 0;
      chunkIndex = 0;
      chunkBlobs = [];
      hasher = new Sha256();
      if (useIdb) await idbDeleteVideo(db, videoId);
    } else if (offset > 0 && res.status === 416) {
      // Partial state mismatched server size; restart cleanly from 0
      offset = 0;
      chunkIndex = 0;
      chunkBlobs = [];
      hasher = new Sha256();
      if (useIdb) await idbDeleteVideo(db, videoId);
      res = await fetch(videoUrl, {
        headers: { Authorization: 'Bearer ' + String(getToken ? getToken() : '') },
        signal: signal
      });
    }

    if (!res.ok || !res.body) {
      throw new Error('video_http_' + res.status);
    }

    var totalBytes = expectedSize;
    if (!totalBytes) {
      var lenHeader = Number(res.headers.get('Content-Length') || 0);
      if (lenHeader > 0) totalBytes = offset + lenHeader;
    }

    var reader = res.body.getReader();
    var pendingParts = [];
    var pendingLen = 0;
    var lastProgressAt = 0;
    var lastProgressPct = -1;

    async function flushChunk(bytesToFlush) {
      var blob = new Blob([bytesToFlush], { type: 'video/mp4' });
      if (useIdb) {
        try {
          await idbPutChunk(db, videoId, chunkIndex, blob);
        } catch (_err) {
          await pruneOtherVideos(db, videoId, 1);
          try {
            await idbPutChunk(db, videoId, chunkIndex, blob);
          } catch (_err2) {
            useIdb = false;
          }
        }
      }
      chunkBlobs.push(blob);
      chunkIndex += 1;
    }

    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var value = step.value;
      if (!value || value.length === 0) continue;

      hasher.update(value);
      offset += value.length;

      var viewPos = 0;
      while (viewPos < value.length) {
        var room = CHUNK_SIZE - pendingLen;
        var take = Math.min(room, value.length - viewPos);
        pendingParts.push(value.subarray(viewPos, viewPos + take));
        pendingLen += take;
        viewPos += take;

        if (pendingLen === CHUNK_SIZE) {
          await flushChunk(joinBuffers(pendingParts, pendingLen));
          pendingParts = [];
          pendingLen = 0;
        }
      }

      if (totalBytes > 0) {
        var pct = Math.min(99, Math.floor((offset / totalBytes) * 100));
        var now = Date.now();
        if (pct !== lastProgressPct && (now - lastProgressAt >= 200 || pct === 99)) {
          lastProgressAt = now;
          lastProgressPct = pct;
          onProgress(pct);
        }
      }
    }

    if (pendingLen > 0) {
      await flushChunk(joinBuffers(pendingParts, pendingLen));
      pendingParts = [];
      pendingLen = 0;
    }

    if (expectedSize > 0 && offset !== expectedSize) {
      if (useIdb) await idbDeleteVideo(db, videoId);
      throw new Error('video_size_mismatch');
    }

    var actualSha = hasher.digestHex();
    if (expectedSha && actualSha !== expectedSha) {
      if (useIdb) await idbDeleteVideo(db, videoId);
      throw new Error('sha256_mismatch');
    }

    if (useIdb) {
      await idbPutVideo(db, {
        videoId: videoId,
        size: offset,
        sha256: actualSha,
        chunkSize: CHUNK_SIZE,
        chunkCount: chunkIndex,
        completed: true,
        updatedAt: Date.now()
      }).catch(function () {});
      await pruneOtherVideos(db, videoId, MAX_CACHED_VIDEOS).catch(function () {});
    }

    onProgress(100);
    return URL.createObjectURL(new Blob(chunkBlobs, { type: 'video/mp4' }));
  }

  var exported = {
    Sha256: Sha256,
    ensureCached: ensureCached,
    CHUNK_SIZE: CHUNK_SIZE
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.GhostVideoCache = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
