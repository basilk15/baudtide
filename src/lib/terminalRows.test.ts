import { describe, expect, it } from 'vitest';
import { TerminalRowGroups } from './terminalRows';

const rows = Array.from({ length: 600 }, (_, id) => ({ id: String(id), text: `line ${id}` }));

describe('stable terminal row groups', () => {
  it('reuses unchanged groups when a full terminal drops old rows and appends new ones', () => {
    const groups = new TerminalRowGroups<(typeof rows)[number]>();
    const first = groups.group(rows.slice(0, 500));
    const second = groups.group(rows.slice(1, 501));
    expect(second.flat()).toEqual(rows.slice(1, 501));
    expect(second.find((block) => block[0] === rows[32])).toBe(first[1]);
    for (let offset = 2; offset < 100; offset++) {
      const window = rows.slice(offset, offset + 500);
      const rendered = groups.group(window);
      expect(rendered.flat()).toEqual(window);
      expect(rendered.every((block) => block.length <= 32)).toBe(true);
    }
  });

  it('updates partial-line replacements and filters without dropping, duplicating, or reordering rows', () => {
    const groups = new TerminalRowGroups<(typeof rows)[number]>();
    const first = groups.group(rows.slice(0, 100));
    const replacement = { ...rows[40], text: 'continued line' };
    const changed = rows.slice(0, 100).map((row) => row === rows[40] ? replacement : row);
    const second = groups.group(changed);
    expect(second.flat()).toEqual(changed);
    expect(second[0]).toBe(first[0]);
    expect(second.flat()[40]).toBe(replacement);
    const filtered = changed.filter((row) => Number(row.id) % 2 === 0);
    expect(groups.group(filtered).flat()).toEqual(filtered);
    expect(groups.group(changed).flat()).toEqual(changed);
    expect(groups.group([])).toEqual([]);
  });
});
