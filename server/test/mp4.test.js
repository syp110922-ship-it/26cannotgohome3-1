'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hasValidFtypHeader, inspectUploadedMp4 } = require('../src/mp4');
const { Sha256, ensureCached } = require('../../frontend/shared/video-cache');

function makeBox(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function buildValidMp4({
  durationSec = 12.5,
  timescale = 1000,
  version = 0,
  moovAtEnd = false,
  includeTrak = true,
  mdatBytes = 1024
} = {}) {
  const ftypPayload = Buffer.from('isom\x00\x00\x02\x00isomiso2', 'latin1');
  const ftyp = makeBox('ftyp', ftypPayload);

  let mvhdPayload;
  if (version === 0) {
    mvhdPayload = Buffer.alloc(100);
    mvhdPayload[0] = 0;
    mvhdPayload.writeUInt32BE(timescale, 12);
    mvhdPayload.writeUInt32BE(Math.round(durationSec * timescale), 16);
  } else {
    mvhdPayload = Buffer.alloc(112);
    mvhdPayload[0] = 1;
    mvhdPayload.writeUInt32BE(timescale, 20);
    mvhdPayload.writeBigUInt64BE(BigInt(Math.round(durationSec * timescale)), 24);
  }
  const mvhd = makeBox('mvhd', mvhdPayload);
  const moovChildren = includeTrak ? [mvhd, makeBox('trak', Buffer.alloc(16))] : [mvhd];
  const moov = makeBox('moov', Buffer.concat(moovChildren));
  const mdat = makeBox('mdat', crypto.randomBytes(mdatBytes));

  return moovAtEnd ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

describe('mp4 box inspection', () => {
  it('validates ftyp headers and parses mvhd v0 and v1 durations regardless of moov order', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-mp4-test-'));
    try {
      const fastStartPath = path.join(tmpDir, 'faststart.mp4');
      fs.writeFileSync(fastStartPath, buildValidMp4({ durationSec: 12.5, version: 0, moovAtEnd: false }));
      const r1 = await inspectUploadedMp4(fastStartPath);
      assert.equal(r1.valid, true);
      assert.equal(r1.duration, 12.5);

      const tailMoovPath = path.join(tmpDir, 'tail-moov-v1.mp4');
      fs.writeFileSync(tailMoovPath, buildValidMp4({ durationSec: 95.25, version: 1, moovAtEnd: true }));
      const r2 = await inspectUploadedMp4(tailMoovPath);
      assert.equal(r2.valid, true);
      assert.equal(r2.duration, 95.25);

      const noTrakPath = path.join(tmpDir, 'notrak.mp4');
      fs.writeFileSync(noTrakPath, buildValidMp4({ includeTrak: false }));
      const r3 = await inspectUploadedMp4(noTrakPath);
      assert.equal(r3.valid, false);
      assert.equal(r3.reason, 'missing_media_track');

      const fakePath = path.join(tmpDir, 'fake.mp4');
      fs.writeFileSync(fakePath, Buffer.from('\x89PNG\r\n\x1a\nFAKEIMAGEBODY1234567890'));
      assert.equal(hasValidFtypHeader(fs.readFileSync(fakePath)), false);
      const r4 = await inspectUploadedMp4(fakePath);
      assert.equal(r4.valid, false);
      assert.equal(r4.reason, 'invalid_mp4_header');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('frontend video-cache pure-JS SHA-256 and streaming verification', () => {
  it('matches Node crypto SHA-256 bit-for-bit across split chunks', () => {
    const samples = [
      Buffer.alloc(0),
      Buffer.from('abc'),
      Buffer.from('a'.repeat(55)),
      Buffer.from('b'.repeat(64)),
      Buffer.from('c'.repeat(129)),
      crypto.randomBytes(200000)
    ];

    for (const buf of samples) {
      const expected = crypto.createHash('sha256').update(buf).digest('hex');
      const hasher = new Sha256();
      let offset = 0;
      while (offset < buf.length) {
        const step = Math.min(buf.length - offset, 137);
        hasher.update(buf.subarray(offset, offset + step));
        offset += step;
      }
      assert.equal(hasher.digestHex(), expected);
    }
  });

  it('streams chunks via fetch, checks sha256, and rejects checksum mismatch', async () => {
    const payload = buildValidMp4({ durationSec: 8, mdatBytes: 4096 });
    const goodSha = crypto.createHash('sha256').update(payload).digest('hex');
    const badSha = '0'.repeat(64);

    const origFetch = global.fetch;
    const origCreateObjectURL = URL.createObjectURL;
    const createdBlobs = [];

    URL.createObjectURL = (blob) => {
      createdBlobs.push(blob);
      return `blob:mock-${createdBlobs.length}`;
    };

    const makeMockStreamResponse = (buf) => {
      let sent = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (sent) {
            controller.close();
            return;
          }
          const mid = Math.floor(buf.length / 2);
          controller.enqueue(new Uint8Array(buf.subarray(0, mid)));
          controller.enqueue(new Uint8Array(buf.subarray(mid)));
          sent = true;
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Length': String(buf.length) }
      });
    };

    try {
      global.fetch = async () => makeMockStreamResponse(payload);
      const progressEvents = [];
      const blobUrl = await ensureCached({
        meta: {
          videoId: 'vid_ok',
          url: '/video/vid_ok',
          size: payload.length,
          sha256: goodSha
        },
        apiBase: 'http://localhost:3000',
        getToken: () => 'tok',
        onProgress: (p) => progressEvents.push(p)
      });

      assert.equal(blobUrl, 'blob:mock-1');
      assert.equal(progressEvents[progressEvents.length - 1], 100);
      assert.equal(createdBlobs[0].size, payload.length);

      await assert.rejects(
        () =>
          ensureCached({
            meta: {
              videoId: 'vid_bad',
              url: '/video/vid_bad',
              size: payload.length,
              sha256: badSha
            },
            apiBase: 'http://localhost:3000',
            getToken: () => 'tok'
          }),
        /sha256_mismatch/
      );
    } finally {
      global.fetch = origFetch;
      URL.createObjectURL = origCreateObjectURL;
    }
  });
});
