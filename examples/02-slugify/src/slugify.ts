export interface SlugifyOptions {
  separator?: string;
  lower?: boolean;
  maxLength?: number;
}

const SPECIAL_CHARACTER_MAP: Record<string, string> = {
  ß: 'ss',
  Æ: 'AE',
  æ: 'ae',
  Ø: 'O',
  ø: 'o',
  Å: 'A',
  å: 'a',
  Þ: 'TH',
  þ: 'th',
  Ð: 'D',
  ð: 'd',
  Ł: 'L',
  ł: 'l',
  Œ: 'OE',
  œ: 'oe',
};

const escapeForCharacterClass = (value: string): string => value.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');

const replaceSpecialCharacters = (value: string): string =>
  Array.from(value, (character) => SPECIAL_CHARACTER_MAP[character] ?? character).join('');

const transliterateLatinCharacters = (value: string): string =>
  replaceSpecialCharacters(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

export function slugify(input: string, options: SlugifyOptions = {}): string {
  const trimmedInput = input.trim();

  if (trimmedInput === '') {
    return '';
  }

  const separator = options.separator && options.separator.length > 0 ? options.separator : '-';
  const shouldLowercase = options.lower !== false;
  const escapedSeparator = escapeForCharacterClass(separator);

  let slug = transliterateLatinCharacters(trimmedInput);

  if (shouldLowercase) {
    slug = slug.toLowerCase();
  }

  slug = slug
    .replace(/[\s_]+/g, separator)
    .replace(new RegExp(`[^A-Za-z0-9${escapedSeparator}]+`, 'g'), '')
    .replace(new RegExp(`${escapedSeparator}+`, 'g'), separator)
    .replace(new RegExp(`^${escapedSeparator}+|${escapedSeparator}+$`, 'g'), '');

  if (typeof options.maxLength === 'number' && options.maxLength >= 0) {
    slug = slug.slice(0, options.maxLength);
    slug = slug.replace(new RegExp(`${escapedSeparator}+$`, 'g'), '');
  }

  return slug;
}
