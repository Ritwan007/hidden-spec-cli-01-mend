// mend: applies an AI-written patch to a tree of text files, as SPEC.md v1 says.
// Four patch formats (unified diff, SEARCH/REPLACE, V4A, JSON edits), three
// matching tiers, every change or none. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown when the patch cannot be read in its format; carries the stdout line. */
class ParseFail {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit when it cannot apply; carries the code and the path. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed per line, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file's text, broken into lines with its own break and final-break flag. */
interface FileText {
  lines: string[];
  br: '\r\n' | '\n';
  endBreak: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', endBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endBreak = text.endsWith(br);
  if (endBreak) parts.pop();
  return { lines: parts, br, endBreak };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endBreak ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line of an old/new pair; ctx lines are written as the file's own line. */
interface PairLine {
  text: string;
  ctx: boolean;
}

/** A line compared at a tier: 0 exact, 1 trailing space/tab stripped, 2 both ends stripped. */
function tierForm(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every 0-based position where old lines match the file's lines at a tier, from `from` on. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const want = oldLines.map((l) => tierForm(l, tier));
  const hits: number[] = [];
  for (let i = from; i + want.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (tierForm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** First tier (0, then 1, then 2; only 0 when strict) where old lines occur at least once. */
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, oldLines, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** Tier-2 re-indent of one new line: P (old first line's lead) replaced by F (file's lead). */
function reindent(line: string, pLead: string, fLead: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(pLead)) return line;
  return fLead + line.slice(pLead.length);
}

/** The lines that replace the matched block: context lines from the file, the rest re-indented at tier 2. */
function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: PairLine[],
  newLines: PairLine[],
  tier: number,
): string[] {
  const oldCtxIdx: number[] = [];
  oldLines.forEach((l, i) => {
    if (l.ctx) oldCtxIdx.push(i);
  });
  const fLead = leadWs(fileLines[pos] ?? '');
  const pLead = leadWs(oldLines.length > 0 ? oldLines[0]!.text : '');
  const out: string[] = [];
  let seenCtx = 0;
  for (const nl of newLines) {
    if (nl.ctx) {
      out.push(fileLines[pos + oldCtxIdx[seenCtx]!]!);
      seenCtx += 1;
    } else if (tier === 2) {
      out.push(reindent(nl.text, pLead, fLead));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: paths changed so far in `cur`, the rest read from disk. */
class Tree {
  private readonly base = new Map<string, string | null>();
  readonly cur = new Map<string, string | null>();

  before(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p)!;
  }

  after(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.before(p);
  }
}

type Edit = (tree: Tree) => void;

/** What the parsers share: strict flag, and the move pairs applied so far (for R lines). */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

/** Format detection, SPEC section 4 (auto only; a named format is read as that format). */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One JSON edit object (SPEC section 9), or null when the value is not one. */
function jsonOne(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFail('unsafe', p);
    const t = tree.after(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.after(p) !== null) throw new EditFail('exists', p);
      tree.cur.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.cur.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = parseFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(lineNo, 0, ...add);
      tree.cur.set(p, renderFile(f));
    };
  }

  return null;
}

/** The JSON edits of a patch (SPEC section 9): one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonOne(x);
      if (e === null) throw new ParseFail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonOne(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                     */
/* ------------------------------------------------------------------ */

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface Hunk {
  start: number;
  lines: HunkLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after 4 chars, up to the first tab, spaces trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** Leading a/ or b/ removed from a header path; /dev/null means no file. */
function cleanPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's body: lines after its header, up to the first other line. Returns the body and the next index. */
function collectBody(lines: string[], from: number): { body: HunkLine[]; next: number } {
  const body: HunkLine[] = [];
  let j = from;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '', raw: l });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c as HunkLine['kind'], text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  return { body, next: j };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.lines.length; k += 1) {
    if (h.lines[k]!.kind === ' ' || h.lines[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return h.lines[last + 1]?.kind === '\\';
}

/** A created file ends with a break unless a `\` line follows its last `+` line. */
function creationEndsWithBreak(sec: UniSection): boolean {
  for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
    const h = sec.hunks[hi]!;
    let lastPlus = -1;
    for (let k = 0; k < h.lines.length; k += 1) {
      if (h.lines[k]!.kind === '+') lastPlus = k;
    }
    if (lastPlus < 0) continue;
    return h.lines[lastPlus + 1]?.kind !== '\\';
  }
  return true;
}

/** Apply one section's hunks, in order, to a file's text; throws EditFail on a hunk failure. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const oLines: PairLine[] = [];
    const nLines: PairLine[] = [];
    for (const bl of h.lines) {
      if (bl.kind === ' ') {
        oLines.push({ text: bl.text, ctx: true });
        nLines.push({ text: bl.text, ctx: true });
      } else if (bl.kind === '-') {
        oLines.push({ text: bl.text, ctx: false });
      } else if (bl.kind === '+') {
        nLines.push({ text: bl.text, ctx: false });
      }
    }
    if (oLines.length === 0) {
      const pos = Math.min(h.start + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      const built = buildReplacement(f.lines, pos, [], nLines, 0);
      f.lines.splice(pos, 0, ...built);
      if (atEnd) f.endBreak = !backslashAfterLast(h);
      d += nLines.length;
      continue;
    }
    const found = findTier(
      f.lines,
      oLines.map((l) => l.text),
      strict,
    );
    if (found === null) throw new EditFail('no-match', path);
    const target = h.start - 1 + d;
    let pos = found.at[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const runsToEnd = pos + oLines.length === f.lines.length;
    const built = buildReplacement(f.lines, pos, oLines, nLines, found.tier);
    f.lines.splice(pos, oLines.length, ...built);
    if (runsToEnd) f.endBreak = !backslashAfterLast(h);
    d += nLines.length - oLines.length;
  }
  return renderFile(f);
}

/** Parse a unified patch into sections, then one edit per section. */
function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let sec: UniSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
      sec = { oldPath: null, newPath: null, gitOld: m[1]!, gitNew: m[2]!, createFlag: false, deleteFlag: false, hunks: [] };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, gitOld: null, gitNew: null, createFlag: false, deleteFlag: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new ParseFail(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    let pairSeen = false;
    let inHeader = true;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader && !pairSeen) {
          sec.oldPath = cleanPath(headerPath(l));
          sec.newPath = cleanPath(headerPath(lines[i + 1]!));
          pairSeen = true;
          i += 2;
          continue;
        }
        break;
      }
      if (l.startsWith('@@')) {
        const hm = HUNK_RE.exec(l);
        if (hm === null) throw new ParseFail(`error: parse ${i + 1}`);
        inHeader = false;
        const { body, next } = collectBody(lines, i + 1);
        sec.hunks.push({ start: Number(hm[1]), lines: body });
        i = next;
        continue;
      }
      if (inHeader) {
        if (l.startsWith('--- ')) throw new ParseFail(`error: parse ${i + 2}`);
        if (l.startsWith('+++ ') && sec.newPath === null) sec.newPath = cleanPath(headerPath(l));
        else if (l.startsWith('rename from ')) {
          if (sec.oldPath === null) sec.oldPath = l.slice('rename from '.length).trim();
        } else if (l.startsWith('rename to ')) {
          if (sec.newPath === null) sec.newPath = l.slice('rename to '.length).trim();
        } else if (l.startsWith('new file mode')) sec.createFlag = true;
        else if (l.startsWith('deleted file mode')) sec.deleteFlag = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    sections.push(sec);
  }
  return sections.map((sec) => unifiedSectionEdit(sec, ctx));
}

function unifiedSectionEdit(sec: UniSection, ctx: Ctx): Edit {
  const oldP = sec.oldPath ?? sec.gitOld;
  const newP = sec.newPath ?? sec.gitNew;
  const isCreate = sec.createFlag || oldP === null;
  const isDelete = !isCreate && (sec.deleteFlag || newP === null);
  return (tree) => {
    if (oldP !== null && !isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !isSafePath(newP)) throw new EditFail('unsafe', newP);
    if (isCreate) {
      const target = newP!;
      if (tree.after(target) !== null) throw new EditFail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const bl of h.lines) if (bl.kind === '+') plus.push(bl.text);
      }
      const endBreak = creationEndsWithBreak(sec);
      tree.cur.set(target, plus.length === 0 ? '' : plus.join('\n') + (endBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.after(target) === null) throw new EditFail('missing', target);
      tree.cur.set(target, null);
      return;
    }
    if (oldP !== newP) {
      const from = oldP!;
      const to = newP!;
      const before = tree.after(from);
      if (before === null) throw new EditFail('missing', from);
      if (tree.after(to) !== null) throw new EditFail('exists', to);
      const result = applyHunks(before, sec.hunks, ctx.strict, from);
      tree.cur.set(from, null);
      tree.cur.set(to, result);
      ctx.moves.push([from, to]);
      return;
    }
    const target = oldP!;
    const before = tree.after(target);
    if (before === null) throw new EditFail('missing', target);
    tree.cur.set(target, applyHunks(before, sec.hunks, ctx.strict, target));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let gt = -1;
    for (let j = i + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (eq < 0 || gt < 0) throw new ParseFail(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, gt);
    edits.push(srBlockEdit(path, oldLines, newLines, ctx));
    prevPath = path;
    prevEnd = gt + 1;
    i = gt + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.after(path) !== null) throw new EditFail('exists', path);
      tree.cur.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.after(path);
    if (before === null) throw new EditFail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, ctx.strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.at[0]!;
    const built = buildReplacement(
      f.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...built);
    tree.cur.set(path, renderFile(f));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4Chunk {
  anchor: string | null;
  eof: boolean;
  body: HunkLine[];
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFail(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFail(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFail(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    i += 1;
    const raw: Array<{ no: number; text: string }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push({ no: i + 1, text: l });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new ParseFail(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(path, addLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new ParseFail(`error: parse ${raw[0]!.no}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4Chunk[] = [];
      let cur: V4Chunk | null = null;
      while (idx < raw.length) {
        const r = raw[idx]!;
        if (r.text.startsWith('@@')) {
          cur = { anchor: r.text.slice(2).trim() === '' ? null : r.text.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          idx += 1;
          continue;
        }
        if (r.text.trimEnd() === '*** End of File') {
          if (cur === null) throw new ParseFail(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
          idx += 1;
          continue;
        }
        if (r.text.startsWith('*** Move to: ')) throw new ParseFail(`error: parse ${r.no}`);
        if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          const kind2 = r.text === '' ? ' ' : (r.text[0] as HunkLine['kind']);
          cur.body.push({ kind: kind2, text: r.text === '' ? '' : r.text.slice(1), raw: r.text });
          idx += 1;
          continue;
        }
        throw new ParseFail(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFail(`error: parse ${headLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, ctx));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.after(path) !== null) throw new EditFail('exists', path);
    tree.cur.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.after(path) === null) throw new EditFail('missing', path);
    tree.cur.set(path, null);
  };
}

/** First line at/after `from` equal to a one-line anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = tierForm(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (tierForm(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.after(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.after(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, cursor, ctx.strict);
        if (at === null) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const oLines: PairLine[] = [];
      const nLines: PairLine[] = [];
      for (const bl of ch.body) {
        if (bl.kind === ' ') {
          oLines.push({ text: bl.text, ctx: true });
          nLines.push({ text: bl.text, ctx: true });
        } else if (bl.kind === '-') {
          oLines.push({ text: bl.text, ctx: false });
        } else if (bl.kind === '+') {
          nLines.push({ text: bl.text, ctx: false });
        }
      }
      if (oLines.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const built = buildReplacement(f.lines, pos, [], nLines, 0);
        f.lines.splice(pos, 0, ...built);
        cursor = pos + built.length;
        continue;
      }
      const found = findTier(
        f.lines,
        oLines.map((l) => l.text),
        ctx.strict,
        cursor,
      );
      if (found === null) throw new EditFail('no-match', path);
      let pos = -1;
      for (const p of found.at) {
        if (ch.eof && p + oLines.length !== f.lines.length) continue;
        pos = p;
        break;
      }
      if (pos < 0) throw new EditFail('no-match', path);
      const built = buildReplacement(f.lines, pos, oLines, nLines, found.tier);
      f.lines.splice(pos, oLines.length, ...built);
      cursor = pos + built.length;
    }
    const result = renderFile(f);
    if (moveTo !== null) {
      tree.cur.set(path, null);
      tree.cur.set(moveTo, result);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.cur.set(path, result);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC sections 1, 2, 10)                            */
/* ------------------------------------------------------------------ */

const USAGE: { code: number; out: string[] } = { code: 2, out: ['error: usage'] };

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null || !FORMATS.includes(a.slice(9))) return USAGE;
        format = a.slice(9);
      } else if (a === '--check') {
        if (check) return USAGE;
        check = true;
      } else if (a === '--strict') {
        if (strict) return USAGE;
        strict = true;
      } else {
        return USAGE;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return USAGE;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, ctx);
    else if (kind === 'search-replace') edits = srEdits(lines, ctx);
    else edits = v4aEdits(lines, ctx);
    if (edits.length === 0) throw new ParseFail('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.cur);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.cur.clear();
      for (const [k, v] of before) tree.cur.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.cur.keys()].sort(byteOrder)) {
    const was = tree.before(p);
    const now = tree.cur.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of ctx.moves) {
    const oWas = tree.before(o);
    const oNow = tree.cur.has(o) ? tree.cur.get(o)! : tree.before(o);
    const nWas = tree.before(n);
    const nNow = tree.cur.has(n) ? tree.cur.get(n)! : tree.before(n);
    if (oWas !== null && oNow === null && nWas === null && nNow !== null) {
      const di = rows.findIndex((r) => r.line === `D ${o}`);
      const ai = rows.findIndex((r) => r.line === `A ${n}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: n, line: `R ${o} -> ${n}` });
      }
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  if (!check) {
    for (const p of [...tree.cur.keys()].sort(byteOrder)) {
      const was = tree.before(p);
      const now = tree.cur.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
