import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

async function resolveResourcesDirectory(context) {
  if (context.electronPlatformName !== 'darwin') {
    return join(context.appOutDir, 'resources');
  }

  const entries = await readdir(context.appOutDir, { withFileTypes: true });
  const appBundle = entries.find(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!appBundle) {
    throw new Error(`Could not find a macOS application bundle in ${context.appOutDir}.`);
  }
  return join(context.appOutDir, appBundle.name, 'Contents', 'Resources');
}

export default async function copyServerDependencies(context) {
  const source = join(context.packager.projectDir, '.stage', 'server', 'node_modules');
  if (!existsSync(source)) {
    throw new Error('Desktop server dependencies have not been staged. Run the stage script before packaging.');
  }

  const resourcesDirectory = await resolveResourcesDirectory(context);
  const destination = join(resourcesDirectory, 'server', 'node_modules');
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}
