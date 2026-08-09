import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Nest resolves a constructor parameter by its emitted design-time type unless
 * a token is given. The packaged build is minified, that metadata no longer
 * names the class, and the dependency arrives as `undefined` — the controller
 * then throws `Cannot read properties of undefined` on its first request.
 *
 * Unit tests cannot see it: they run unminified, so type-based injection works
 * there and the defect only appears once the app is installed. It has cost two
 * install cycles, most recently `POST /v1/uploads` answering 500 on a build
 * whose whole suite was green. This test is the cheap guard: every injected
 * constructor parameter in the gateway must name its token.
 */
const CONSTRUCTOR_WITH_PARAMS = /constructor\s*\(\s*([^)]*?)\s*\)/gsu;
const MODIFIER = /\b(?:private|protected|public|readonly)\b/u;

const CLASS_DECLARATION = /(?:^|\n)\s*(?:export\s+)?(abstract\s+)?class\s+\w+/gu;

function declaringClassIsAbstract(source: string, constructorIndex: number): boolean {
  let abstractSoFar = false;
  for (const declaration of source.matchAll(CLASS_DECLARATION)) {
    if ((declaration.index ?? 0) > constructorIndex) {
      break;
    }
    abstractSoFar = Boolean(declaration[1]);
  }
  return abstractSoFar;
}

function injectedParametersMissingToken(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(CONSTRUCTOR_WITH_PARAMS)) {
    // An abstract base is never resolved by Nest: its subclass passes the
    // dependencies positionally through `super(...)`, so the emitted metadata
    // on the base plays no part and a token there would be noise.
    if (declaringClassIsAbstract(source, match.index ?? 0)) {
      continue;
    }
    const params = match[1];
    if (!params.trim()) {
      continue;
    }
    // Split on commas that separate parameters; decorator arguments are the
    // only nested parentheses these constructors carry, so tracking depth is
    // enough to keep `@Inject(Foo) x: Foo` in one piece.
    let depth = 0;
    let current = '';
    const parts: string[] = [];
    for (const char of params) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || !MODIFIER.test(trimmed)) {
        continue;
      }
      if (!trimmed.includes('@Inject')) {
        offenders.push(trimmed.replace(/\s+/gu, ' '));
      }
    }
  }
  return offenders;
}

function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(full));
    } else if (/\.(?:controller|service)\.ts$/u.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('Nest dependency injection in the proxy gateway', () => {
  it('names an injection token on every injected constructor parameter', () => {
    const root = path.resolve(__dirname, '../../modules/proxy-gateway/server');
    const files = collectSources(root);

    expect(files.length).toBeGreaterThan(0);

    const offences = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      if (!/@(?:Controller|Injectable)\b/u.test(source)) {
        return [];
      }
      return injectedParametersMissingToken(source).map(
        (param) => `${path.relative(root, file).replace(/\\/gu, '/')}: ${param}`,
      );
    });

    expect(offences).toEqual([]);
  });
});
