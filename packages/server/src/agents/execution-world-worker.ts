/** Fixed worker source. Tool input arrives on stdin, never interpolated into executable code. */
export const WORLD_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = '/workspace';
function inside(candidate) {
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + '/')) throw new Error('WORLD_PATH_ESCAPE');
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('WORLD_PATH_INVALID');
    ancestor = parent;
  }
  const real = fs.realpathSync(ancestor);
  if (real !== root && !real.startsWith(root + '/')) throw new Error('WORLD_SYMLINK_ESCAPE');
  return resolved;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1000000) process.exit(2);
});
process.stdin.on('end', () => {
  let result;
  try {
    const request = JSON.parse(input);
    let output = '';
    const value = request.input || {};
    if (request.tool === 'file_read') output = fs.readFileSync(inside(String(value.path || value.file_path || '')), 'utf8');
    else if (request.tool === 'file_write') {
      const target = inside(String(value.path || value.file_path || ''));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(value.content || ''), 'utf8');
      output = 'Written: ' + target;
    } else if (request.tool === 'shell_exec') output = cp.execSync(String(value.command || value.cmd || ''), {
      cwd: root, timeout: request.timeoutMs, encoding: 'utf8', maxBuffer: 1000000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scratch', TMPDIR: '/tmp' },
    });
    else throw new Error('WORLD_TOOL_UNSUPPORTED');
    result = { status: 'done', output: String(output).slice(0, request.maxOutputChars) };
  } catch (error) {
    result = { status: 'failed', output: String(error.message || error).slice(0, 4000) };
  }
  process.stdout.write(JSON.stringify(result));
});
`;
