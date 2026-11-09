import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = postcss.parse(readFileSync(resolve(__dirname, 'global.css'), 'utf8'));

const rulesMatching = (predicate: (selector: string) => boolean) => {
  const rules: Rule[] = [];
  stylesheet.walkRules((rule) => {
    if (predicate(rule.selector)) rules.push(rule);
  });
  return rules;
};

const declarationsOf = (rules: Rule[]) => {
  const declarations: Declaration[] = [];
  for (const rule of rules) {
    rule.walkDecls((declaration) => {
      declarations.push(declaration);
    });
  }
  return declarations;
};

describe('global.css keyboard cursor highlight', () => {
  const cursorColorDeclarations = declarationsOf(
    rulesMatching((selector) => selector.includes('keyboard-cursor')),
  ).filter(({ prop }) => prop === 'background-color' || prop === 'box-shadow');

  it('takes its colors from custom properties only', () => {
    expect(cursorColorDeclarations.length).toBeGreaterThan(0);
    for (const { value } of cursorColorDeclarations) {
      expect(value).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
    }
  });

  it('turns neutral in a review pinned to a commit', () => {
    const cursorProperties = new Set(
      cursorColorDeclarations.flatMap(({ value }) =>
        [...value.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name),
      ),
    );
    const fixupReviewProperties = new Set(
      declarationsOf(rulesMatching((selector) => selector === '[data-fixup-review]')).map(
        ({ prop }) => prop,
      ),
    );

    expect(cursorProperties.size).toBeGreaterThan(0);
    for (const property of cursorProperties) {
      expect(fixupReviewProperties).toContain(property);
    }
  });
});

describe('global.css files only a fixup changed', () => {
  const declarationsFor = (selector: string) =>
    Object.fromEntries(
      declarationsOf(rulesMatching((candidate) => candidate === selector)).map(
        ({ prop, value }) => [prop, value],
      ),
    );

  it('draws their added lines in the yellow of the fixup lines under a thread', () => {
    expect(
      declarationsFor(':root:not([data-color-vision="deuteranopia"]) [data-fixup-only-file]'),
    ).toMatchObject({
      '--color-diff-addition-bg': 'var(--color-fixup-addition-bg)',
      '--color-diff-addition-border': 'var(--color-github-warning)',
    });
  });

  it("derives that yellow fill from the theme's warning colour", () => {
    const theme: Record<string, string> = {};
    stylesheet.walkAtRules('theme', (rule) => {
      rule.walkDecls(({ prop, value }) => {
        theme[prop] = value;
      });
    });
    expect(theme['--color-fixup-addition-bg']).toBe(
      'color-mix(in srgb, var(--color-github-warning) 15%, transparent)',
    );
  });

  it('tints their file header with the fixup yellow', () => {
    const header = declarationsFor('[data-fixup-only-file] [data-file-header]');
    expect(header['background-color']).toContain('var(--color-github-warning)');
    expect(header['border-top-color']).toBe('var(--color-github-warning)');
  });
});

describe('global.css agent message colors', () => {
  const propertiesOf = (predicate: (selector: string) => boolean) =>
    new Set(declarationsOf(rulesMatching(predicate)).map(({ prop }) => prop));
  const themeProperties = new Set<string>();
  stylesheet.walkAtRules('theme', (rule) => {
    rule.walkDecls((declaration) => {
      themeProperties.add(declaration.prop);
    });
  });

  it('defines the agent colors for both themes', () => {
    const lightProperties = propertiesOf((selector) => selector === '[data-theme="light"]');
    for (const property of ['--color-agent', '--color-agent-bg']) {
      expect(themeProperties).toContain(property);
      expect(lightProperties).toContain(property);
    }
  });
});
