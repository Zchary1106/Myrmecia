import { describe, expect, it } from 'vitest';
import express from 'express';
import { createTask } from '../src/db/models/task.js';
import { getDb } from '../src/db/database.js';
import { createSessionDocumentRoutes } from '../src/routes/session-documents.js';
import { MAX_DOCUMENT_BYTES, parseSessionDocument } from '../src/knowledge/session-document-parser.js';
import { documentSessionKey, isDocumentSession, listSessionDocuments, sessionDocumentContext, storeSessionDocument } from '../src/knowledge/session-documents.js';

function fixtureTask(workspaceId = 'default', parentTaskId?: string) {
  return createTask({ title: 'Document test', description: 'Question', input: 'Question', mode: 'direct', workspaceId, parentTaskId });
}

function pdf(text: string) {
  const stream = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const offset = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(content);
}

// Minimal ZIP with stored entries, sufficient for a genuine DOCX fixture.
function docx() {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX knowledge fixture</w:t></w:r></w:p></w:body></w:document>',
  };
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename); offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(3, 8); end.writeUInt16LE(3, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

describe('session knowledge files', () => {
  it('parses text, Markdown, real PDF and DOCX with source locations', async () => {
    expect(await parseSessionDocument('notes.txt', Buffer.from('第一段\n\n第二段'))).toEqual([
      { locator: 'Paragraph 1', text: '第一段' }, { locator: 'Paragraph 2', text: '第二段' },
    ]);
    expect((await parseSessionDocument('notes.md', Buffer.from('# Knowledge')))[0].text).toBe('# Knowledge');
    expect((await parseSessionDocument('notes.pdf', pdf('PDF knowledge fixture')))[0]).toMatchObject({ locator: 'Page 1', text: expect.stringContaining('PDF knowledge fixture') });
    expect((await parseSessionDocument('notes.docx', docx()))[0].text).toContain('DOCX knowledge fixture');
  }, 30000);

  it('rejects oversized, empty, unsupported and corrupt files', async () => {
    await expect(parseSessionDocument('notes.txt', Buffer.alloc(MAX_DOCUMENT_BYTES + 1))).rejects.toThrow('5 MB');
    await expect(parseSessionDocument('notes.txt', Buffer.from('   '))).rejects.toThrow('No extractable text');
    await expect(parseSessionDocument('notes.exe', Buffer.from('abc'))).rejects.toThrow('Supported formats');
    await expect(parseSessionDocument('notes.pdf', Buffer.from('not a PDF'))).rejects.toThrow('signature');
    await expect(parseSessionDocument('notes.docx', Buffer.from('not a ZIP'))).rejects.toThrow('archive');
  });

  it('isolates knowledge by session/workspace and inherits it for follow-up tasks', () => {
    const task = fixtureTask();
    const other = fixtureTask();
    const followUp = fixtureTask('default', task.id);
    const foreign = fixtureTask('different-workspace', task.id);
    const doc = storeSessionDocument(task, 'private.md', Buffer.from('Private fact'), [{ locator: 'Paragraph 1', text: 'Private fact' }]);
    expect(documentSessionKey(followUp)).toBe(documentSessionKey(task));
    expect(listSessionDocuments(followUp)[0].id).toBe(doc.id);
    expect(sessionDocumentContext(followUp, 'fact')).toContain('private.md / Paragraph 1');
    expect(sessionDocumentContext(other, 'fact')).toBe('');
    expect(sessionDocumentContext(foreign, 'fact')).toBe('');
    expect(isDocumentSession(followUp)).toBe(true);
    getDb().run('DELETE FROM session_documents WHERE id = ?', doc.id);
    expect(listSessionDocuments(task)).toEqual([]);
    expect(isDocumentSession(task)).toBe(true);
  });

  it('serves parsed text only inside the permitted session and requires confirmation to remove', async () => {
    const task = fixtureTask();
    const other = fixtureTask();
    const app = express();
    app.use(express.json());
    app.use('/tasks', createSessionDocumentRoutes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/tasks`;
    try {
      const response = await fetch(`${base}/${task.id}/documents`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent('资料.md') },
        body: '# User knowledge\n\nOnly for this session',
      });
      expect(response.status).toBe(201);
      const doc = await response.json() as { id: string };
      const parsed = await (await fetch(`${base}/${task.id}/documents/${doc.id}`)).json() as { passages: unknown[]; original?: unknown };
      expect(parsed.passages).toHaveLength(2);
      expect(parsed.original).toBeUndefined();
      expect((await fetch(`${base}/${other.id}/documents/${doc.id}`)).status).toBe(404);
      expect((await fetch(`${base}/${task.id}/documents/${doc.id}`, { method: 'DELETE' })).status).toBe(409);
      expect((await fetch(`${base}/${task.id}/documents/${doc.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}',
      })).status).toBe(200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
