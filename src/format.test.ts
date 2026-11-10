import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormatters } from '@kiosko/sdk';
import { elapsed, gigabytes, shortId } from './format.ts';

test('elapsed: minute granularity through ctx.fmt, localized "now"', () => {
  const en = createFormatters({ locale: 'en', now: 0 });
  const es = createFormatters({ locale: 'es', now: 0 });
  assert.equal(elapsed(en, 0, 'now'), 'now');
  assert.equal(elapsed(es, 45 * 1000, 'ahora'), 'ahora');
  assert.equal(elapsed(en, 90 * 1000, 'now'), '1 min');
  assert.equal(elapsed(en, 15 * 60 * 1000, 'now'), '15 min');
  assert.equal(elapsed(en, 3 * 3600 * 1000 + 4 * 60 * 1000, 'now'), '3 h 04');
  assert.equal(elapsed(es, 2 * 24 * 3600 * 1000 + 5 * 3600 * 1000, 'ahora'), '2 d 5 h');
  assert.equal(elapsed(en, -5000, 'now'), 'now', 'a clock skew never shows a negative time');
});

test('shortId', () => {
  assert.equal(shortId('a1b2c3d4-1111-2222-3333-444455556666'), 'A1B2C3');
  assert.equal(shortId('abc-def-ghi'), 'ABCDEF');
});

test('gigabytes', () => {
  assert.equal(gigabytes(44 * 1024 ** 3), '44GB');
});
