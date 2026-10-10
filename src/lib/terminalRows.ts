/** Keep unchanged row groups stable as a bounded terminal window advances. */
export class TerminalRowGroups<T extends object> {
  private readonly blocks = new WeakMap<T, readonly T[]>();
  constructor(private readonly size = 32) {}

  group(rows: readonly T[]): readonly (readonly T[])[] {
    const output: (readonly T[])[] = [];
    let cursor = 0;
    const cachedAt = (index: number) => {
      const block = this.blocks.get(rows[index]);
      return block && block.length <= rows.length - index
        && block.every((row, offset) => row === rows[index + offset]) ? block : undefined;
    };
    while (cursor < rows.length) {
      const cached = cachedAt(cursor);
      if (cached) { output.push(cached); cursor += cached.length; continue; }
      let end = cursor + 1;
      while (end < rows.length && end - cursor < this.size && !cachedAt(end)) end++;
      const block = Object.freeze(rows.slice(cursor, end));
      if (block.length === this.size) this.blocks.set(rows[cursor], block);
      output.push(block);
      cursor = end;
    }
    return output;
  }
}
