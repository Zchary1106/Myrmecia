import { Worker } from 'worker_threads';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);
export type DocumentPassage = { locator: string; text: string };
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// Parsing is off the API event loop, with a bounded heap and wall clock.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const bytes = Buffer.from(workerData.bytes);
  let passages;
  if (workerData.extension === '.pdf') {
    const { PDFParse } = require(workerData.pdfModule);
    const parser = new PDFParse({data: bytes});
    try {
      const info = await parser.getInfo();
      if (info.total > 200) throw new Error('PDF exceeds the 200-page limit');
      const result = await parser.getText();
      passages = result.pages.map((page, index) => ({locator: 'Page ' + (index + 1), text: page.text.trim()}));
    } finally { await parser.destroy(); }
  } else {
    const text = workerData.extension === '.docx'
      ? (await require(workerData.docxModule).extractRawText({buffer: bytes})).value
      : new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    passages = text.split(/\\n\\s*\\n/).map((text, index) => ({locator:'Paragraph ' + (index + 1), text:text.trim()}));
  }
  passages = passages.filter(p => p.text);
  if (!passages.length) throw new Error('No extractable text. Scanned PDFs require OCR, which is not enabled.');
  if (passages.reduce((n, p) => n + p.text.length, 0) > 120000) throw new Error('Document exceeds 120,000 extracted characters; split it into smaller files.');
  const chunks = passages.flatMap(p => {
    const items = [];
    for (let i=0; i<p.text.length; i+=3000) items.push({locator:p.locator + (p.text.length>3000 ? ', part ' + (i/3000+1) : ''), text:p.text.slice(i,i+3000)});
    return items;
  });
  parentPort.postMessage({passages:chunks});
})().catch(e => parentPort.postMessage({error:e.message}));
`;

/** Reject ZIP64 and large expanded DOCX archives before decompressing. */
function validateDocxZip(bytes: Buffer): void {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw new Error('Invalid DOCX archive');
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2000) throw new Error('DOCX contains too many archive entries');
  let offset = bytes.readUInt32LE(end + 16);
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid DOCX archive');
    expanded += bytes.readUInt32LE(offset + 24);
    if (expanded > 32 * 1024 * 1024) throw new Error('DOCX expanded content exceeds 32 MB');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}

export async function parseSessionDocument(name: string, bytes: Buffer): Promise<DocumentPassage[]> {
  const extension = extname(name).toLowerCase();
  if (!['.txt', '.md', '.markdown', '.pdf', '.docx'].includes(extension)) throw new Error('Supported formats: TXT, Markdown, PDF, DOCX');
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('File must be non-empty and no larger than 5 MB');
  if (extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF signature');
  if (extension === '.docx') validateDocxZip(bytes);
  if (['.txt', '.md', '.markdown'].includes(extension) && bytes.includes(0)) throw new Error('Text files must use UTF-8 encoding');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { extension, bytes, pdfModule: require.resolve('pdf-parse'), docxModule: require.resolve('mammoth') },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (error?: Error, passages?: DocumentPassage[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(passages!);
    };
    const timer = setTimeout(() => finish(new Error('Document parsing timed out; use a smaller file')), 20_000);
    worker.once('message', result => finish(result.error ? new Error(result.error) : undefined, result.passages));
    worker.once('error', () => finish(new Error('Document could not be parsed safely')));
    worker.once('exit', code => { if (!settled) finish(new Error(`Document parser exited (${code})`)); });
  });
}
