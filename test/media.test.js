import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_MEDIA_TYPES,
  formatBytes,
  imageMediaTypeFromName,
  inferAttachmentMediaType,
  isImageMediaType,
  qqFileTypeFor,
  sanitizeFilename,
  sniffImageMediaType,
} from '../lib/qq/media.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF87_BYTES = Buffer.from('GIF87a-still-image', 'latin1');
const GIF89_BYTES = Buffer.from('GIF89a-animated', 'latin1');
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from('VP8 ', 'latin1'),
]);

describe('sniffImageMediaType', () => {
  it('detects PNG', () => {
    assert.equal(sniffImageMediaType(PNG_BYTES), 'image/png');
  });

  it('detects JPEG', () => {
    assert.equal(sniffImageMediaType(JPEG_BYTES), 'image/jpeg');
  });

  it('detects both GIF signatures', () => {
    assert.equal(sniffImageMediaType(GIF87_BYTES), 'image/gif');
    assert.equal(sniffImageMediaType(GIF89_BYTES), 'image/gif');
  });

  it('detects WEBP after a RIFF header', () => {
    assert.equal(sniffImageMediaType(WEBP_BYTES), 'image/webp');
  });

  it('accepts a plain Uint8Array', () => {
    const view = new Uint8Array(PNG_BYTES);
    assert.equal(sniffImageMediaType(view), 'image/png');
  });

  it('rejects non-image bytes', () => {
    assert.equal(sniffImageMediaType(Buffer.from('plain text, not an image')), null);
    assert.equal(sniffImageMediaType(Buffer.from([0x42, 0x4d, 0x00, 0x00])), null); // BMP
  });

  it('rejects truncated magic numbers', () => {
    assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e])), null);
    assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8])), null);
    assert.equal(sniffImageMediaType(Buffer.from('GIF8', 'latin1')), null);
    assert.equal(sniffImageMediaType(Buffer.alloc(0)), null);
  });

  it('rejects a RIFF container that is not WEBP', () => {
    const wave = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
    ]);
    assert.equal(sniffImageMediaType(wave), null);
  });

  it('returns null for unsupported input values', () => {
    assert.equal(sniffImageMediaType(null), null);
    assert.equal(sniffImageMediaType(undefined), null);
    assert.equal(sniffImageMediaType('not bytes'), null);
  });
});

describe('imageMediaTypeFromName', () => {
  it('maps known image extensions', () => {
    assert.equal(imageMediaTypeFromName('photo.png'), 'image/png');
    assert.equal(imageMediaTypeFromName('photo.jpg'), 'image/jpeg');
    assert.equal(imageMediaTypeFromName('photo.jpeg'), 'image/jpeg');
    assert.equal(imageMediaTypeFromName('photo.gif'), 'image/gif');
    assert.equal(imageMediaTypeFromName('photo.webp'), 'image/webp');
  });

  it('is case-insensitive and ignores directories', () => {
    assert.equal(imageMediaTypeFromName('C:\\tmp\\dir\\PHOTO.JPG'), 'image/jpeg');
    assert.equal(imageMediaTypeFromName('dir/sub/anim.GIF'), 'image/gif');
  });

  it('ignores query strings and fragments', () => {
    assert.equal(imageMediaTypeFromName('https://x.test/a.png?sign=1'), 'image/png');
    assert.equal(imageMediaTypeFromName('a.webp#frag'), 'image/webp');
  });

  it('returns null for unknown extensions or missing names', () => {
    assert.equal(imageMediaTypeFromName('archive.zip'), null);
    assert.equal(imageMediaTypeFromName('photo.bmp'), null);
    assert.equal(imageMediaTypeFromName('no-extension'), null);
    assert.equal(imageMediaTypeFromName(''), null);
    assert.equal(imageMediaTypeFromName(null), null);
  });
});

describe('isImageMediaType', () => {
  it('accepts every supported DSH image type', () => {
    for (const mediaType of IMAGE_MEDIA_TYPES) {
      assert.equal(isImageMediaType(mediaType), true);
    }
    assert.equal(isImageMediaType('image/jpg'), true);
  });

  it('rejects other or missing types', () => {
    assert.equal(isImageMediaType('application/pdf'), false);
    assert.equal(isImageMediaType('text/plain'), false);
    assert.equal(isImageMediaType(''), false);
    assert.equal(isImageMediaType(null), false);
  });
});

describe('inferAttachmentMediaType', () => {
  it('prefers the real bytes over a lying content type and extension', () => {
    assert.deepEqual(
      inferAttachmentMediaType({
        contentType: 'image/png',
        filename: 'photo.png',
        bytes: JPEG_BYTES,
      }),
      { mediaType: 'image/jpeg', isImage: true },
    );
  });

  it('prefers the real bytes over the extension alone', () => {
    assert.deepEqual(
      inferAttachmentMediaType({ filename: 'photo.png', bytes: GIF89_BYTES }),
      { mediaType: 'image/gif', isImage: true },
    );
  });

  it('falls back to an image/* content type when bytes are unrecognized', () => {
    assert.deepEqual(
      inferAttachmentMediaType({
        contentType: 'image/png; charset=binary',
        bytes: Buffer.from('not really a png'),
      }),
      { mediaType: 'image/png', isImage: true },
    );
  });

  it('falls back to the extension when nothing else is available', () => {
    assert.deepEqual(
      inferAttachmentMediaType({ contentType: '', filename: 'x.webp' }),
      { mediaType: 'image/webp', isImage: true },
    );
  });

  it('keeps non-image content types', () => {
    assert.deepEqual(
      inferAttachmentMediaType({
        contentType: 'application/pdf',
        filename: 'a.pdf',
        bytes: Buffer.from('%PDF-1.7'),
      }),
      { mediaType: 'application/pdf', isImage: false },
    );
  });

  it('returns empty mediaType for empty input', () => {
    assert.deepEqual(inferAttachmentMediaType({}), { mediaType: '', isImage: false });
    assert.deepEqual(inferAttachmentMediaType(), { mediaType: '', isImage: false });
  });
});

describe('sanitizeFilename', () => {
  it('strips directories on both Windows and POSIX paths', () => {
    assert.equal(sanitizeFilename('C:\\tmp\\dir\\photo.png'), 'photo.png');
    assert.equal(sanitizeFilename('/var/tmp/photo.png'), 'photo.png');
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  });

  it('removes control characters', () => {
    assert.equal(sanitizeFilename('a\u0000b\nc\td.txt'), 'abcd.txt');
    assert.equal(sanitizeFilename('bad\u007fname.bin'), 'badname.bin');
  });

  it('caps the name at 120 code points', () => {
    const long = 'a'.repeat(200) + '.png';
    assert.equal(Array.from(sanitizeFilename(long)).length, 120);
  });

  it('does not split emoji when truncating', () => {
    const long = '🍎'.repeat(150);
    const safe = sanitizeFilename(long);
    assert.equal(Array.from(safe).length, 120);
    assert.equal(safe, '🍎'.repeat(120));
  });

  it('falls back for empty, blank or dot-only names', () => {
    assert.equal(sanitizeFilename(''), 'file');
    assert.equal(sanitizeFilename('   '), 'file');
    assert.equal(sanitizeFilename('..'), 'file');
    assert.equal(sanitizeFilename(null), 'file');
    assert.equal(sanitizeFilename('', 'fallback.bin'), 'fallback.bin');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeFilename('  spaced name.txt  '), 'spaced name.txt');
  });
});

describe('formatBytes', () => {
  it('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1229), '1.2 KB');
  });

  it('formats larger units', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(3.4 * 1024 * 1024), '3.4 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  });

  it('handles invalid or negative input', () => {
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes('nope'), '0 B');
    assert.equal(formatBytes(undefined), '0 B');
  });
});

describe('qqFileTypeFor', () => {
  it('maps images to file_type 1', () => {
    assert.equal(qqFileTypeFor({ filename: 'photo.png' }), 1);
    assert.equal(qqFileTypeFor({ filename: 'photo.webp' }), 1);
    assert.equal(qqFileTypeFor({ mediaType: 'image/jpeg' }), 1);
  });

  it('maps video to file_type 2', () => {
    assert.equal(qqFileTypeFor({ filename: 'clip.mp4' }), 2);
    assert.equal(qqFileTypeFor({ filename: 'clip.unknown', mediaType: 'video/mp4' }), 2);
  });

  it('maps voice/audio to file_type 3', () => {
    assert.equal(qqFileTypeFor({ filename: 'voice.silk' }), 3);
    assert.equal(qqFileTypeFor({ filename: 'song.mp3' }), 3);
    assert.equal(qqFileTypeFor({ mediaType: 'audio/wav' }), 3);
  });

  it('falls back to file_type 4', () => {
    assert.equal(qqFileTypeFor({ filename: 'archive.zip', mediaType: 'application/zip' }), 4);
    assert.equal(qqFileTypeFor({ filename: 'notes.txt' }), 4);
    assert.equal(qqFileTypeFor({}), 4);
    assert.equal(qqFileTypeFor(), 4);
  });

  it('lets an explicit media type win over the extension', () => {
    assert.equal(qqFileTypeFor({ filename: 'blob.bin', mediaType: 'audio/silk' }), 3);
    assert.equal(qqFileTypeFor({ filename: 'blob.mp4', mediaType: 'application/pdf' }), 2);
  });
});
