/**
 * Independent read-only acceptance assertion over sanitized, persisted MCP
 * results. This proves returned source/title identity, not truth of UGC claims.
 */
export function verifyXiaohongshuSources(notes: unknown, output: string, limit = 3) {
  const sources = new Map<string, string>();
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (note && typeof note === 'object' && typeof note.source_url === 'string'
        && /^https:\/\/www\.xiaohongshu\.com\/explore\/[A-Za-z0-9_-]+$/.test(note.source_url)
        && typeof note.title === 'string' && !sources.has(note.source_url)) {
        sources.set(note.source_url, note.title);
      }
    }
  }
  const expected = [...sources.entries()].slice(0, Math.max(1, Math.min(12, limit)));
  const matchedLinks = expected.filter(([url]) => output.includes(url));
  const matchedTitles = expected.filter(([, title]) => title.trim().length > 0 && output.includes(title));
  const citedLinks = [...new Set(output.match(/https:\/\/www\.xiaohongshu\.com\/explore\/[A-Za-z0-9_-]+/g) || [])];
  const unreturnedLinks = citedLinks.filter(url => !sources.has(url));
  return {
    returnedNoteCount: sources.size,
    expectedLinkCount: expected.length,
    matchedReturnedLinkCount: matchedLinks.length,
    matchedOriginalTitleCount: matchedTitles.length,
    unreturnedLinkCount: unreturnedLinks.length,
    passed: expected.length > 0 && matchedLinks.length === expected.length
      && matchedTitles.length === expected.length && unreturnedLinks.length === 0,
  };
}
