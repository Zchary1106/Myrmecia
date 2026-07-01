export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

function parseNumericIdentifier(value: string, label: 'major' | 'minor' | 'patch'): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`Invalid ${label} version segment`);
  }

  return parsed;
}

function parsePrerelease(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.split('.');
}

function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(a);
  const bIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(b);

  if (aIsNumeric && bIsNumeric) {
    const aValue = Number(a);
    const bValue = Number(b);

    if (aValue < bValue) {
      return -1;
    }

    if (aValue > bValue) {
      return 1;
    }

    return 0;
  }

  if (aIsNumeric && !bIsNumeric) {
    return -1;
  }

  if (!aIsNumeric && bIsNumeric) {
    return 1;
  }

  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

export function parse(version: string): SemVer {
  if (typeof version !== 'string') {
    throw new TypeError('Version must be a string');
  }

  const match = SEMVER_PATTERN.exec(version);

  if (!match) {
    throw new TypeError(`Invalid semantic version: ${version}`);
  }

  const [, major, minor, patch, prerelease] = match;

  return {
    major: parseNumericIdentifier(major, 'major'),
    minor: parseNumericIdentifier(minor, 'minor'),
    patch: parseNumericIdentifier(patch, 'patch'),
    prerelease: parsePrerelease(prerelease),
  };
}

export function isValid(version: string): boolean {
  try {
    parse(version);
    return true;
  } catch {
    return false;
  }
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);

  if (left.major < right.major) {
    return -1;
  }

  if (left.major > right.major) {
    return 1;
  }

  if (left.minor < right.minor) {
    return -1;
  }

  if (left.minor > right.minor) {
    return 1;
  }

  if (left.patch < right.patch) {
    return -1;
  }

  if (left.patch > right.patch) {
    return 1;
  }

  const leftHasPrerelease = left.prerelease.length > 0;
  const rightHasPrerelease = right.prerelease.length > 0;

  if (!leftHasPrerelease && !rightHasPrerelease) {
    return 0;
  }

  if (leftHasPrerelease && !rightHasPrerelease) {
    return -1;
  }

  if (!leftHasPrerelease && rightHasPrerelease) {
    return 1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const identifierComparison = compareIdentifiers(leftIdentifier, rightIdentifier);

    if (identifierComparison !== 0) {
      return identifierComparison;
    }
  }

  return 0;
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) === 1;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) === -1;
}

export function eq(a: string, b: string): boolean {
  return compare(a, b) === 0;
}
