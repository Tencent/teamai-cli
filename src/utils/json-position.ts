/**
 * Where a JSON text stops being valid, without quoting it.
 *
 * `JSON.parse` names the problem by quoting the text around it
 * (`Unexpected token 'g', ..."{"value": ghp_x}}" is not valid JSON`), so its
 * message cannot be shown for a file that holds credentials. This scanner
 * follows the same grammar (RFC 8259) and returns only the offset.
 */

class Stop {
  constructor(readonly at: number) {}
}

/** The offset of the first character that makes `text` invalid JSON, or null when `JSON.parse` accepts it. */
export function jsonSyntaxErrorOffset(text: string): number | null {
  let i = 0;
  const stop = (): never => {
    throw new Stop(i);
  };
  const at = (re: RegExp): boolean => re.test(text.charAt(i));
  const ws = (): void => {
    while (at(/[ \t\n\r]/)) i++;
  };
  const expect = (ch: string): void => {
    if (text.charAt(i) !== ch) stop();
    i++;
  };
  const digits = (): void => {
    if (!at(/[0-9]/)) stop();
    while (at(/[0-9]/)) i++;
  };
  const string = (): void => {
    expect('"');
    for (;;) {
      if (i >= text.length || text.charCodeAt(i) < 0x20) stop();
      const ch = text.charAt(i);
      i++;
      if (ch === '"') return;
      if (ch !== '\\') continue;
      if (text.charAt(i) === 'u') {
        i++;
        for (let k = 0; k < 4; k++) {
          if (!at(/[0-9a-fA-F]/)) stop();
          i++;
        }
      } else if (at(/["\\/bfnrt]/)) {
        i++;
      } else {
        stop();
      }
    }
  };
  const value = (): void => {
    ws();
    const ch = text.charAt(i);
    if (ch === '{') {
      i++;
      ws();
      if (text.charAt(i) === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        string();
        ws();
        expect(':');
        value();
        ws();
        if (text.charAt(i) === '}') {
          i++;
          return;
        }
        expect(',');
      }
    }
    if (ch === '[') {
      i++;
      ws();
      if (text.charAt(i) === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text.charAt(i) === ']') {
          i++;
          return;
        }
        expect(',');
      }
    }
    if (ch === '"') return string();
    if (ch === 't' || ch === 'f' || ch === 'n') {
      for (const letter of ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null') expect(letter);
      return;
    }
    if (ch === '-') i++;
    if (text.charAt(i) === '0') i++;
    else digits();
    if (text.charAt(i) === '.') {
      i++;
      digits();
    }
    if (at(/[eE]/)) {
      i++;
      if (at(/[+-]/)) i++;
      digits();
    }
  };

  try {
    value();
    ws();
    if (i < text.length) stop();
    return null;
  } catch (error) {
    if (error instanceof Stop) return error.at;
    throw error;
  }
}

/** 1-based line and column of `offset` in `text`. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}
