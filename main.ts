// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

type FileLines = { lines: string[]; br: string; final: boolean };
type ReplacementLine = { text: string; context: boolean };
type Chunk = { anchor: string | null; eof: boolean; old: ReplacementLine[]; next: ReplacementLine[] };

function fileLines(text: string): FileLines {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(value: FileLines): string {
  return value.lines.length === 0 ? '' : value.lines.join(value.br) + (value.final ? value.br : '');
}

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimSpaceTab = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const indent = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

function findOccurrences(file: string[], old: string[], strict: boolean, accept: (at: number) => boolean = () => true): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const normalize = tier === 0 ? (s: string) => s : tier === 1 ? trimRight : trimSpaceTab;
    const positions: number[] = [];
    if (old.length === 0) return { tier, positions: [0].filter(accept) };
    for (let i = 0; i + old.length <= file.length; i += 1) {
      if (accept(i) && old.every((line, j) => normalize(file[i + j]!) === normalize(line))) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function occurrences(file: string[], old: string[], strict: boolean): { tier: number; positions: number[] } | null {
  return findOccurrences(file, old, strict);
}

function replacedLines(file: string[], at: number, old: ReplacementLine[], next: ReplacementLine[], tier: number): string[] {
  const matched = file.slice(at, at + old.length);
  const prefixIndent = indent(matched[0] ?? '');
  const patchIndent = indent(old[0]?.text ?? '');
  const out = next.map((line, i) => {
    if (line.context) {
      const oldIndex = old.findIndex((candidate, j) => candidate.context && candidate.text === line.text && j >= 0);
      // Context lines are paired in order, even when their text repeats.
      let seen = 0;
      for (let j = 0; j < i; j += 1) {
        if (next[j]!.context && next[j]!.text === line.text) seen += 1;
      }
      let found = -1;
      let count = 0;
      for (let j = 0; j < old.length; j += 1) {
        if (old[j]!.context && old[j]!.text === line.text) {
          if (count === seen) { found = j; break; }
          count += 1;
        }
      }
      return matched[found >= 0 ? found : oldIndex] ?? line.text;
    }
    if (tier === 2 && line.text !== '' && !/^[ \t]+$/.test(line.text) && line.text.startsWith(patchIndent)) {
      return prefixIndent + line.text.slice(patchIndent.length);
    }
    return line.text;
  });
  return [...file.slice(0, at), ...out, ...file.slice(at + old.length)];
}

function patchPath(value: string, prefix: string | null = null): string {
  let p = value.split('\t', 1)[0]!.trim();
  if (prefix !== null && p.startsWith(prefix)) p = p.slice(prefix.length);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Hunk = { line: number; a: number; old: ReplacementLine[]; next: ReplacementLine[]; noFinal: boolean; noFinalPlus: boolean };
  type Section = { line: number; oldPath: string | null; newPath: string | null; diffOld: string | null; diffNew: string | null; renameOld: string | null; renameNew: string | null; create: boolean; delete: boolean; hunks: Hunk[] };
  const sections: Section[] = [];
  let section: Section | null = null;
  let i = 0;
  const diffHeader = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    return m ? [m[1]!, m[2]!] : null;
  };
  const isPairedHeader = (at: number): boolean => lines[at]!.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = diffHeader(line);
      if (!paths) throw new Exit2(`error: parse ${i + 1}`);
      section = { line: i + 1, oldPath: null, newPath: null, diffOld: paths[0], diffNew: paths[1], renameOld: null, renameNew: null, create: false, delete: false, hunks: [] };
      sections.push(section);
      i += 1;
      continue;
    }
    if (isPairedHeader(i) && (section === null || section.hunks.length > 0 || section.oldPath !== null || section.newPath !== null)) {
      section = { line: i + 1, oldPath: null, newPath: null, diffOld: null, diffNew: null, renameOld: null, renameNew: null, create: false, delete: false, hunks: [] };
      sections.push(section);
    }
    if (line.startsWith('@@')) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      if (!section) throw new Exit2(`error: parse ${i + 1}`);
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)!;
      const hunk: Hunk = { line: i + 1, a: Number(match[1]), old: [], next: [], noFinal: false, noFinalPlus: false };
      section.hunks.push(hunk);
      i += 1;
      let last: 'context' | 'old' | 'new' | null = null;
      let pendingEmpty = 0;
      while (i < lines.length) {
        const body = lines[i]!;
        if (body.startsWith('diff --git ') || (body.startsWith('--- ') && isPairedHeader(i))) break;
        if (body === '') {
          pendingEmpty += 1;
          i += 1;
          continue;
        }
        if (body[0] === ' ' || body[0] === '-' || body[0] === '+') {
          while (pendingEmpty > 0) {
            hunk.old.push({ text: '', context: true });
            hunk.next.push({ text: '', context: true });
            last = 'context'; hunk.noFinal = false; hunk.noFinalPlus = false; pendingEmpty -= 1;
          }
          hunk.noFinal = false;
          hunk.noFinalPlus = false;
          const text = body.slice(1);
          if (body[0] === ' ') { hunk.old.push({ text, context: true }); hunk.next.push({ text, context: true }); last = 'context'; }
          else if (body[0] === '-') { hunk.old.push({ text, context: false }); last = 'old'; }
          else { hunk.next.push({ text, context: false }); last = 'new'; }
          i += 1; continue;
        }
        if (body.startsWith('\\')) {
          while (pendingEmpty > 0) {
            hunk.old.push({ text: '', context: true });
            hunk.next.push({ text: '', context: true });
            last = 'context'; hunk.noFinal = false; hunk.noFinalPlus = false; pendingEmpty -= 1;
          }
          if (last === 'context' || last === 'new') {
            hunk.noFinal = true;
            hunk.noFinalPlus = last === 'new';
          }
          last = null; i += 1; continue;
        }
        break;
      }
      continue;
    }
    if (section && section.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if (!lines[i + 1]?.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        section.oldPath = patchPath(line.slice(4), 'a/');
        section.newPath = patchPath(lines[i + 1]!.slice(4), 'b/');
        i += 2; continue;
      }
      if (line.startsWith('rename from ')) { section.renameOld = line.slice(12).trim(); i += 1; continue; }
      if (line.startsWith('rename to ')) { section.renameNew = line.slice(10).trim(); i += 1; continue; }
      if (line.startsWith('new file mode ')) section.create = true;
      if (line.startsWith('deleted file mode ')) section.delete = true;
    }
    i += 1;
  }
  if (sections.length === 0 || sections.every((s) => s.hunks.length === 0 && !s.create && !s.delete)) throw new Exit2('error: parse 1');
  const edits: Edit[] = sections.map((s) => {
    const oldPath = s.oldPath ?? s.renameOld ?? s.diffOld;
    const newPath = s.newPath ?? s.renameNew ?? s.diffNew;
    const oldNull = oldPath === '/dev/null';
    const newNull = newPath === '/dev/null';
    const from = oldNull ? null : oldPath;
    const to = newNull ? null : newPath;
    if (from === null && to === null) throw new Exit2(`error: parse ${s.line}`);
    return (tree) => {
      for (const p of [from, to]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
      if (s.delete || to === null) {
        if (from === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(from) === null) throw new Fail('missing', from);
        tree.now.set(from, null);
        return;
      }
      if (s.create || from === null) {
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const out: string[] = [];
        let noFinal = false;
        for (const h of s.hunks) {
          let hasAddition = false;
          for (const line of h.next) if (!line.context) { out.push(line.text); hasAddition = true; }
          if (hasAddition) noFinal = h.noFinalPlus;
        }
        tree.now.set(to, out.length === 0 ? '' : out.join('\n') + (noFinal ? '' : '\n'));
        return;
      }
      const source = tree.get(from);
      if (source === null) throw new Fail('missing', from);
      if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
      const value = fileLines(source);
      let delta = 0;
      for (const h of s.hunks) {
        const oldText = h.old.map((x) => x.text);
        let at: number;
        let tier: number;
        if (oldText.length === 0) {
          at = Math.max(0, Math.min(value.lines.length, h.a + delta));
          tier = 0;
        } else {
          const found = occurrences(value.lines, oldText, strict);
          if (!found) throw new Fail('no-match', from);
          tier = found.tier;
          const target = h.a - 1 + delta;
          at = found.positions.reduce((best, p) => Math.abs(p - target) < Math.abs(best - target) ? p : best, found.positions[0]!);
        }
        const endsAtFile = at + h.old.length === value.lines.length || (h.old.length === 0 && at === value.lines.length);
        value.lines = replacedLines(value.lines, at, h.old, h.next, tier);
        if (endsAtFile) value.final = value.lines.length > 0 && !h.noFinal;
        delta += h.next.length - h.old.length;
      }
      const result = writeLines(value);
      tree.now.set(to, result);
      if (to !== from) {
        tree.now.set(from, null);
        tree.moves.push({ from, to });
      }
    };
  });
  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let after = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let split = i + 1;
    while (split < lines.length && lines[split]!.trimEnd() !== '=======') split += 1;
    let end = split + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (split >= lines.length || end >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= after; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) { path = candidate; break; }
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    previousPath = path;
    const old = lines.slice(i + 1, split);
    const next = lines.slice(split + 1, end);
    edits.push((tree) => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (old.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, next.length === 0 ? '' : next.join('\n') + '\n');
        return;
      }
      const source = tree.get(path!);
      if (source === null) throw new Fail('missing', path!);
      const value = fileLines(source);
      const found = occurrences(value.lines, old, strict);
      if (!found) throw new Fail('no-match', path!);
      if (found.positions.length > 1) throw new Fail('ambiguous', path!);
      value.lines = replacedLines(value.lines, found.positions[0]!, old.map((text) => ({ text, context: false })), next.map((text) => ({ text, context: false })), found.tier);
      tree.now.set(path!, writeLines(value));
    });
    i = end;
    after = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  type SectionV = { kind: 'add' | 'delete' | 'update'; path: string; line: number; add: string[]; move: string | null; chunks: Chunk[] };
  const sections: SectionV[] = [];
  let current: SectionV | null = null;
  let chunk: Chunk | null = null;
  const finishChunk = () => { if (chunk && current) current.chunks.push(chunk); chunk = null; };
  const trimSectionEnd = () => {
    if (!current) return;
    if (current.kind === 'add') {
      while (current.add.at(-1) === '') current.add.pop();
    } else if (current.kind === 'update' && chunk) {
      while (chunk.old.at(-1)?.context && chunk.old.at(-1)?.text === '' && chunk.next.at(-1)?.context && chunk.next.at(-1)?.text === '') {
        chunk.old.pop();
        chunk.next.pop();
      }
      if (chunk.anchor === null && !chunk.eof && chunk.old.length === 0 && chunk.next.length === 0) chunk = null;
    }
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      trimSectionEnd();
      finishChunk();
      current = {
        kind: line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update',
        path: line.slice(line.indexOf(':') + 1).trim(), line: i + 1, add: [], move: null, chunks: []
      };
      sections.push(current);
      continue;
    }
    if (current === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to: ')) {
      if (current.kind !== 'update' || current.move !== null || current.chunks.length > 0 || chunk !== null) throw new Exit2(`error: parse ${i + 1}`);
      current.move = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (current.kind === 'add') {
      if (line === '') current.add.push('');
      else if (line.startsWith('+')) current.add.push(line.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (current.kind === 'delete') {
      if (!blank(line)) throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (line.startsWith('@@')) {
      finishChunk();
      chunk = { anchor: line.slice(2).trim(), eof: false, old: [], next: [] };
      continue;
    }
    if (line === '*** End of File') {
      if (!chunk) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      finishChunk();
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (!chunk) {
        if (current.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        chunk = { anchor: null, eof: false, old: [], next: [] };
      }
      if (line === '' || line[0] === ' ') {
        const text = line === '' ? '' : line.slice(1);
        chunk.old.push({ text, context: true }); chunk.next.push({ text, context: true });
      } else if (line[0] === '-') chunk.old.push({ text: line.slice(1), context: false });
      else chunk.next.push({ text: line.slice(1), context: false });
      continue;
    }
    if (blank(line)) continue;
    throw new Exit2(`error: parse ${i + 1}`);
  }
  trimSectionEnd();
  finishChunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) if (s.kind === 'update' && s.chunks.length === 0 && s.move === null) throw new Exit2(`error: parse ${s.line}`);
  return sections.map((s) => (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'update' && s.move !== null && !safe(s.move)) throw new Fail('unsafe', s.move);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.add.length === 0 ? '' : s.add.join('\n') + '\n');
      return;
    }
    const source = tree.get(s.path);
    if (source === null) throw new Fail('missing', s.path);
    if (s.kind === 'delete') { tree.now.set(s.path, null); return; }
    if (s.move !== null) {
      if (tree.get(s.move) !== null) throw new Fail('exists', s.move);
    }
    const value = fileLines(source);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        const foundAnchor = occurrences(value.lines.slice(cursor), [c.anchor], strict);
        if (!foundAnchor) throw new Fail('no-match', s.path);
        cursor += foundAnchor.positions[0]! + 1;
      }
      const oldText = c.old.map((x) => x.text);
      let at: number;
      let tier: number;
      if (oldText.length === 0) {
        at = c.eof ? value.lines.length : cursor;
        tier = 0;
      } else {
        const found = findOccurrences(value.lines, oldText, strict, (p) => p >= cursor && (!c.eof || p + oldText.length === value.lines.length));
        if (!found) throw new Fail('no-match', s.path);
        at = found.positions[0]!;
        tier = found.tier;
      }
      value.lines = replacedLines(value.lines, at, c.old, c.next, tier);
      cursor = at + c.next.length;
    }
    const to = s.move ?? s.path;
    tree.now.set(to, writeLines(value));
    if (to !== s.path) {
      tree.now.set(s.path, null);
      tree.moves.push({ from: s.path, to });
    }
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : kind === 'v4a' ? v4aEdits(lines, strict)
      : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string; paths: string[] }[] = [];
  const renamed = new Set<string>();
  for (const move of tree.moves) {
    if (tree.original(move.from) !== null && tree.get(move.from) === null && tree.original(move.to) === null && tree.get(move.to) !== null) {
      renamed.add(move.from);
      renamed.add(move.to);
      rows.push({ key: move.to, line: `R ${move.from} -> ${move.to}`, paths: [move.from, move.to] });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (renamed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  for (const row of rows) {
    if (check) continue;
    for (const p of row.paths) {
      const now = tree.get(p);
      if (now === null) rmSync(p, { force: true });
      else if (tree.now.has(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
