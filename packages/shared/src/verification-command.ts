/** Operator-submitted validation, never arbitrary shell source or install/deploy. */
export interface VerificationCommand {
  executable: string;
  args: string[];
  shellCommand: string;
  kind: 'test' | 'build' | 'lint' | 'typecheck';
}

const pathArg = (value: string) => /^[A-Za-z0-9_./@+-]+$/.test(value)
  && !value.startsWith('-') && !value.startsWith('/')
  && !value.split('/').includes('..');
const identifier = (value: string) => /^[A-Za-z0-9_@/.-]+$/.test(value) && !value.startsWith('-')
  && !value.split('/').includes('..');
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function parseVerificationCommand(command: string): VerificationCommand | undefined {
  if (typeof command !== 'string' || !command.trim() || command.length > 500
    || /[\r\n"'`$;&|<>\\\0]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length > 25) return undefined;
  const [executable, ...args] = tokens;
  let valid = false;
  let kind: VerificationCommand['kind'] = 'test';
  if (['npm', 'pnpm', 'yarn'].includes(executable)) {
    let rest = [...args];
    if (executable === 'pnpm' && rest[0] === '--filter') {
      if (!identifier(rest[1] || '')) return undefined;
      rest = rest.slice(2);
    }
    if (rest[0] === 'run') rest = rest.slice(1);
    const operation = rest.shift();
    if (['test', 'build', 'lint', 'typecheck'].includes(operation || '')) kind = operation as VerificationCommand['kind'];
    valid = ['test', 'build', 'lint', 'typecheck'].includes(operation || '')
      && rest.every(arg => arg === '--' || ['--run', '--runInBand', '--coverage', '--bail', '--watch=false'].includes(arg) || pathArg(arg));
  } else if (executable === 'pytest' || executable === 'python' || executable === 'python3') {
    const rest = executable === 'pytest' ? args : args[0] === '-m' && args[1] === 'pytest' ? args.slice(2) : undefined;
    valid = !!rest && rest.every(arg => ['-q', '-v', '-x', '--disable-warnings'].includes(arg)
      || /^--maxfail=[1-9]\d{0,2}$/.test(arg) || pathArg(arg));
  } else if (executable === 'go' && args[0] === 'test') {
    valid = args.slice(1).every(arg => arg === './...' || arg === '-race'
      || /^-count=[1-9]\d{0,2}$/.test(arg) || pathArg(arg));
  } else if (executable === 'cargo' && args[0] === 'test') {
    const rest = args.slice(1);
    valid = rest.every((arg, index) => arg === '--workspace' || arg === '--all-targets'
      || ['--package', '--test', '--lib'].includes(arg)
      || identifier(arg) && ['--package', '--test'].includes(rest[index - 1]));
    if (rest.at(-1) === '--package' || rest.at(-1) === '--test') valid = false;
  } else if (executable === 'node' && args[0] === '--test') {
    valid = args.slice(1).every(pathArg);
  }
  return valid ? { executable, args, kind, shellCommand: tokens.map(quote).join(' ') } : undefined;
}
