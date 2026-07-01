export type TemperatureUnit = "C" | "F" | "K";

const ABSOLUTE_ZERO: Record<TemperatureUnit, number> = {
  C: -273.15,
  F: -459.67,
  K: 0,
};

function roundToTwoDecimals(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeUnit(unit: string): TemperatureUnit {
  const normalized = unit.trim().toUpperCase();

  if (normalized === "C" || normalized === "F" || normalized === "K") {
    return normalized;
  }

  throw new TypeError(`Invalid temperature unit: ${unit}`);
}

function assertAboveAbsoluteZero(value: number, unit: TemperatureUnit): void {
  if (value < ABSOLUTE_ZERO[unit]) {
    throw new RangeError(`Temperature below absolute zero for ${unit}: ${value}`);
  }
}

function toCelsius(value: number, from: TemperatureUnit): number {
  switch (from) {
    case "C":
      return value;
    case "F":
      return (value - 32) * (5 / 9);
    case "K":
      return value - 273.15;
  }
}

function fromCelsius(valueInCelsius: number, to: TemperatureUnit): number {
  switch (to) {
    case "C":
      return valueInCelsius;
    case "F":
      return valueInCelsius * (9 / 5) + 32;
    case "K":
      return valueInCelsius + 273.15;
  }
}

export function convert(value: number, from: TemperatureUnit, to: TemperatureUnit): number {
  assertAboveAbsoluteZero(value, from);

  if (from === to) {
    return roundToTwoDecimals(value);
  }

  const valueInCelsius = toCelsius(value, from);
  const convertedValue = fromCelsius(valueInCelsius, to);

  return roundToTwoDecimals(convertedValue);
}

function getHelpText(): string {
  return [
    "Usage: tempconvert <value> <from> <to>",
    "",
    "Convert temperatures between Celsius (C), Fahrenheit (F), and Kelvin (K).",
    "Units are case-insensitive.",
  ].join("\n");
}

function runCli(argv: string[]): number {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(getHelpText());
    return 0;
  }

  if (argv.length !== 3) {
    console.error("Error: expected arguments <value> <from> <to>");
    return 1;
  }

  const [rawValue, rawFrom, rawTo] = argv;
  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    console.error(`Error: invalid numeric value: ${rawValue}`);
    return 1;
  }

  try {
    const from = normalizeUnit(rawFrom);
    const to = normalizeUnit(rawTo);
    const result = convert(value, from, to);
    console.log(String(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

export { getHelpText, runCli, normalizeUnit };
