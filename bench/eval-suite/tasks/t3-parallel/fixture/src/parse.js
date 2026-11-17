// Part A: ledger text parser. See README.md for the format and the API.

export class ParseError extends Error {
  constructor(line, reason) {
    super(`line ${line}: ${reason}`);
    this.name = 'ParseError';
    this.line = line;
    this.reason = reason;
  }
}

export function isValidDate(str) {
  throw new Error('not implemented');
}

export function parse(text) {
  throw new Error('not implemented');
}
