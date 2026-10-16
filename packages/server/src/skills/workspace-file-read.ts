import { createHash } from 'node:crypto';

/** Lossless bounded source pages, small enough not to be re-archived by the loop. */
export function workspaceFileReadOutput(content: string, path: string, input: Record<string, unknown>, maxOutputChars: number): string {
  const explicit = input.offset !== undefined || input.maxChars !== undefined || input.expectedSha256 !== undefined;
  if (!explicit && content.length <= 1600) return content.slice(0, maxOutputChars);
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? 1200;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > content.length
    || !Number.isSafeInteger(maxChars) || Number(maxChars) < 1 || Number(maxChars) > 1600) {
    throw new Error('FILE_READ_PAGE_RANGE_INVALID');
  }
  const lowSurrogate = (index: number) => content.charCodeAt(index) >= 0xdc00 && content.charCodeAt(index) <= 0xdfff;
  const highSurrogate = (index: number) => content.charCodeAt(index) >= 0xd800 && content.charCodeAt(index) <= 0xdbff;
  if (Number(offset) > 0 && lowSurrogate(Number(offset)) && highSurrogate(Number(offset) - 1)) {
    throw new Error('FILE_READ_PAGE_RANGE_INVALID');
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) throw new Error('FILE_READ_SOURCE_CHANGED');
  const limit = Math.min(1900, maxOutputChars);
  let end = Math.min(content.length, Number(offset) + Number(maxChars));
  while (true) {
    if (end < content.length && end > Number(offset) && highSurrogate(end - 1) && lowSurrogate(end)) {
      end = end - 1 === Number(offset) ? end + 1 : end - 1;
    }
    if (end <= Number(offset) && Number(offset) < content.length) throw new Error('FILE_READ_PAGE_OUTPUT_QUOTA');
    const packet = JSON.stringify({ kind: 'workspace_file_page', path, offset, nextOffset: end < content.length ? end : null,
      totalChars: content.length, sha256, eof: end === content.length, content: content.slice(Number(offset), end),
      instruction: 'Read nextOffset using file_read with the same path and expectedSha256; do not repeat the first page.' });
    if (packet.length <= limit) return packet;
    if (end <= Number(offset)) throw new Error('FILE_READ_PAGE_OUTPUT_QUOTA');
    end = Number(offset) + Math.floor((end - Number(offset)) / 2);
    if (end > Number(offset) && highSurrogate(end - 1) && lowSurrogate(end)) end--;
  }
}
