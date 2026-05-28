export interface ParamConstraint {
  /** Allowed domain patterns (glob/wildcard) for URL parameters */
  allowedDomains?: string[];
  /** Maximum string length for a parameter value */
  maxLength?: number;
  /** Minimum string length for a parameter value */
  minLength?: number;
  /** Regex pattern the value must match */
  pattern?: string;
  /** Blocked values (exact match, case-insensitive) */
  blockedValues?: string[];
  /** Maximum file size in bytes */
  maxBytes?: number;
}

export interface ParamConstraints {
  [paramName: string]: ParamConstraint;
}

export interface ConstraintViolation {
  param: string;
  value: string;
  constraint: string;
  message: string;
}

/**
 * Validate tool call parameters against constraints.
 * Returns an array of violations (empty if valid).
 */
export function validateParamConstraints(
  params: Record<string, unknown>,
  constraints: ParamConstraints,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const [paramName, constraint] of Object.entries(constraints)) {
    const value = params[paramName];
    if (value === undefined || value === null) {
      // Check if param is required — handled by inputSchema validation
      continue;
    }

    const strValue = String(value);

    if (constraint.maxLength !== undefined && strValue.length > constraint.maxLength) {
      violations.push({
        param: paramName,
        value: strValue.slice(0, 100),
        constraint: `maxLength: ${constraint.maxLength}`,
        message: `"${paramName}" exceeds maximum length of ${constraint.maxLength} (got ${strValue.length})`,
      });
    }

    if (constraint.minLength !== undefined && strValue.length < constraint.minLength) {
      violations.push({
        param: paramName,
        value: strValue.slice(0, 100),
        constraint: `minLength: ${constraint.minLength}`,
        message: `"${paramName}" is shorter than minimum length of ${constraint.minLength} (got ${strValue.length})`,
      });
    }

    if (constraint.pattern) {
      const regex = new RegExp(constraint.pattern);
      if (!regex.test(strValue)) {
        violations.push({
          param: paramName,
          value: strValue.slice(0, 100),
          constraint: `pattern: ${constraint.pattern}`,
          message: `"${paramName}" does not match required pattern "${constraint.pattern}"`,
        });
      }
    }

    if (constraint.blockedValues) {
      const lower = strValue.toLowerCase();
      if (constraint.blockedValues.some(b => b.toLowerCase() === lower)) {
        violations.push({
          param: paramName,
          value: strValue.slice(0, 100),
          constraint: `blockedValues: [${constraint.blockedValues.join(', ')}]`,
          message: `"${paramName}" value is blocked`,
        });
      }
    }

    if (constraint.allowedDomains) {
      const url = extractHostname(strValue);
      if (url) {
        const allowed = constraint.allowedDomains.some(domain =>
          matchDomain(url, domain),
        );
        if (!allowed) {
          violations.push({
            param: paramName,
            value: strValue.slice(0, 100),
            constraint: `allowedDomains: [${constraint.allowedDomains.join(', ')}]`,
            message: `"${paramName}" domain "${url}" is not in the allowed domain list`,
          });
        }
      }
    }

    if (constraint.maxBytes !== undefined) {
      // For parameters that represent data size (base64, etc.)
      if (typeof value === 'string') {
        const byteLen = Buffer.byteLength(value, 'utf-8');
        if (byteLen > constraint.maxBytes) {
          violations.push({
            param: paramName,
            value: `(${byteLen} bytes)`,
            constraint: `maxBytes: ${constraint.maxBytes}`,
            message: `"${paramName}" size ${byteLen} bytes exceeds maximum of ${constraint.maxBytes} bytes`,
          });
        }
      }
    }
  }

  return violations;
}

function extractHostname(value: string): string | null {
  try {
    const url = new URL(value);
    return url.hostname;
  } catch {
    // Maybe it's just a hostname (no protocol)
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) {
      return value;
    }
    return null;
  }
}

function matchDomain(hostname: string, pattern: string): boolean {
  // Support wildcard patterns like *.example.com
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .example.com
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}
