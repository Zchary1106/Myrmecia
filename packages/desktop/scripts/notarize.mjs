import { notarize } from '@electron/notarize';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

export default async function notarizeMacApplication(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const missing = required.filter(name => !process.env[name]);
  const mustNotarize = process.env.MYRMECIA_REQUIRE_RELEASE_SIGNING === 'true';
  if (missing.length) {
    if (mustNotarize) throw new Error(`Release notarization requires: ${missing.join(', ')}`);
    console.info('Skipping macOS notarization for non-release build; missing:', missing.join(', '));
    return;
  }
  const bundle = (await readdir(context.appOutDir, { withFileTypes: true }))
    .find(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!bundle) throw new Error(`No macOS application bundle found in ${context.appOutDir}`);
  await notarize({
    appPath: join(context.appOutDir, bundle.name),
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
}
