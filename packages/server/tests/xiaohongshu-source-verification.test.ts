import { describe, expect, it } from 'vitest';
import { verifyXiaohongshuSources } from '../src/testing/xiaohongshu-source-verification.js';

const url = (id: number) => `https://www.xiaohongshu.com/explore/note_${id}`;
const notes = [1, 2, 3, 4].map(id => ({ title: `原始标题 ${id}`, source_url: url(id) }));
const answer = (ids: number[]) => ids.map(id => `原始标题 ${id}\n${url(id)}`).join('\n');

describe('independent actual Xiaohongshu source acceptance', () => {
  it('requires the first three original titles and returned source links', () => {
    expect(verifyXiaohongshuSources(notes, answer([1, 2, 3]))).toMatchObject({
      passed: true, returnedNoteCount: 4, matchedReturnedLinkCount: 3, matchedOriginalTitleCount: 3,
    });
  });
  it('does not accept another returned note in place of the requested third note', () => {
    expect(verifyXiaohongshuSources(notes, answer([1, 2, 4]))).toMatchObject({
      passed: false, matchedReturnedLinkCount: 2, matchedOriginalTitleCount: 2,
    });
  });
  it('rejects fabricated or rewritten titles even when source links are real', () => {
    expect(verifyXiaohongshuSources(notes, `改写的标题\n${url(1)}\n${url(2)}\n${url(3)}`)).toMatchObject({
      passed: false, matchedReturnedLinkCount: 3, matchedOriginalTitleCount: 0,
    });
  });
  it('rejects an extra unreturned source rather than trusting a link-shaped string', () => {
    expect(verifyXiaohongshuSources(notes, answer([1, 2, 3, 99]))).toMatchObject({
      passed: false, unreturnedLinkCount: 1,
    });
  });
  it('fails closed when no real source exists', () => {
    expect(verifyXiaohongshuSources([], answer([1, 2, 3])).passed).toBe(false);
    expect(verifyXiaohongshuSources(undefined, answer([1, 2, 3])).passed).toBe(false);
  });
  it('supports fewer than three available notes but does not count duplicate rows', () => {
    expect(verifyXiaohongshuSources([notes[0], notes[0]], answer([1]))).toMatchObject({
      passed: true, returnedNoteCount: 1, expectedLinkCount: 1,
    });
  });
  it('does not treat signed URLs or wrong-host URLs as sanitized source evidence', () => {
    expect(verifyXiaohongshuSources([
      { title: 'unsafe', source_url: `${url(1)}?xsec_token=fixture` },
      { title: 'wrong host', source_url: 'https://example.test/explore/note_1' },
    ], 'unsafe wrong host').passed).toBe(false);
  });
});
