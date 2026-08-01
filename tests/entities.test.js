import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'client', 'src');

function jsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsxFiles(full));
    else if (/\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

// JSX decodes HTML entities in literal JSX text, but NOT inside JavaScript
// string literals - `{cond ? ' &middot; x' : ''}` renders the raw characters
// "&middot;" to the user. This scan catches that whole class of bug.
const ENTITY_IN_STRING = [
  /'[^'\n]*&[a-zA-Z]+;[^'\n]*'/,
  /"[^"\n]*&[a-zA-Z]+;[^"\n]*"/,
  /`[^`\n]*&[a-zA-Z]+;[^`\n]*`/,
];

describe('no HTML entities inside JS string literals', () => {
  it('finds none under client/src', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (ENTITY_IN_STRING.some((re) => re.test(line))) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
