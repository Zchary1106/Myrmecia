import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from '../src/slugify';

test('converts a basic sentence into a slug', () => {
  assert.equal(slugify('Hello World from TypeScript'), 'hello-world-from-typescript');
});

test('supports a custom separator', () => {
  assert.equal(slugify('Hello World_test case', { separator: '_' }), 'hello_world_test_case');
});

test('preserves case when lower is false', () => {
  assert.equal(slugify('Hello World', { lower: false }), 'Hello-World');
});

test('transliterates accented latin letters to ASCII', () => {
  assert.equal(slugify('Crème Brûlée jalapeño über'), 'creme-brulee-jalapeno-uber');
});

test('collapses repeated separators and trims them from the ends', () => {
  assert.equal(slugify('  hello___world -- test  '), 'hello-world-test');
});

test('truncates to maxLength without leaving a trailing separator', () => {
  assert.equal(slugify('One two three four', { maxLength: 13 }), 'one-two-three');
});

test('returns an empty string for empty or whitespace-only input', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('     '), '');
});
