const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

export default function validateNativeServerTarget(context) {
  if (context.electronPlatformName !== process.platform) {
    throw new Error(
      `The desktop server includes native Node modules and must be packaged on ${context.electronPlatformName}; `
      + `the current host is ${process.platform}.`,
    );
  }

  const targetArch = archNames[context.arch];
  if (!targetArch || targetArch === 'universal' || targetArch !== process.arch) {
    throw new Error(
      `The desktop server includes native Node modules and must be packaged for the host architecture `
      + `${process.arch}; requested architecture is ${targetArch ?? String(context.arch)}.`,
    );
  }
}
