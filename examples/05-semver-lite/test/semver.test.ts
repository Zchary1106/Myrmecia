import test from 'node:test';
import assert from 'node:assert/strict';

import { compare, eq, gt, isValid, lt, parse } from '../src/semver.ts';

test('parse parses a basic semantic version', () => {
  assert.deepEqual(parse('1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
  });
});

test('parse accepts a leading v', () => {
  assert.deepEqual(parse('v2.4.6'), {
    major: 2,
    minor: 4,
    patch: 6,
    prerelease: [],
  });
});

test('parse parses prerelease identifiers', () => {
  assert.deepEqual(parse('1.2.3-alpha.1'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['alpha', '1'],
  });
});

test('parse throws TypeError for invalid versions', () => {
  assert.throws(() => parse('1.2'), TypeError);
  assert.throws(() => parse('1.2.03'), TypeError);
  assert.throws(() => parse('foo'), TypeError);
});

test('isValid returns true for valid versions and false for invalid ones', () => {
  assert.equal(isValid('1.0.0'), true);
  assert.equal(isValid('v1.0.0-beta'), true);
  assert.equal(isValid('1'), false);
  assert.equal(isValid('1.0.00'), false);
});

test('compare orders major, minor, and patch numerically', () => {
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.3.0', '1.2.9'), 1);
  assert.equal(compare('1.2.4', '1.2.3'), 1);
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.equal(compare('1.2.3', '1.2.4'), -1);
});

test('compare treats prerelease as lower precedence than the same release', () => {
  assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compare('1.0.0', '1.0.0-alpha'), 1);
});

test('compare orders numeric prerelease identifiers numerically and lexical identifiers lexically', () => {
  assert.equal(compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compare('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compare('1.0.0-beta', '1.0.0-alpha'), 1);
});

test('gt, lt, and eq provide boolean comparison helpers', () => {
  assert.equal(gt('2.0.0', '1.0.0'), true);
  assert.equal(lt('1.0.0-alpha', '1.0.0'), true);
  assert.equal(eq('1.2.3', '1.2.3'), true);
  assert.equal(eq('1.2.3', '1.2.4'), false);
});
