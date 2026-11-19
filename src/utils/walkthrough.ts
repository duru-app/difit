import type { Walkthrough, WalkthroughCase, WalkthroughStep } from '../types/diff.js';

const STEP_FIELDS = new Set([
  'file',
  'line',
  'endLine',
  'description',
  'callPath',
  'variables',
  'stateChanges',
  'error',
]);
const CASE_FIELDS = new Set(['title', 'setup', 'steps']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLineNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

function invalid(what: string): never {
  throw new Error(`Invalid walkthrough: ${what}`);
}

function ignoredFields(
  value: Record<string, unknown>,
  known: Set<string>,
  where: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !known.has(key))
    .map((key) => `${where}: ignored unknown field "${key}"`);
}

const CALL_PATH_ENTRY = /^(.+):(\d+)(?:-(\d+))?$/;

export interface CallPathTarget {
  file: string;
  line: number;
  endLine: number;
}

export function callPathTarget(entry: string): CallPathTarget | null {
  const [, file, from, to] = CALL_PATH_ENTRY.exec(entry) ?? [];
  if (file === undefined || from === undefined) return null;
  const line = Number(from);
  const endLine = to === undefined ? line : Number(to);
  if (line < 1 || endLine < line) return null;
  return { file: file.replace(/^\.\//, ''), line, endLine };
}

function parseCallPath(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) invalid(`${where} "callPath" must be a list of "path:line" entries`);
  return value.map((entry) => {
    const target = typeof entry === 'string' ? callPathTarget(entry.trim()) : null;
    if (!target) {
      invalid(
        `${where} "callPath" entry ${JSON.stringify(entry)} must be "path:line" or "path:line-endLine"`,
      );
    }
    const { file, line, endLine } = target;
    return `${file}:${line}${endLine === line ? '' : `-${endLine}`}`;
  });
}

function parseValues(value: unknown, where: string, field: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    invalid(`${where} "${field}" must map names to string values`);
  }
  return { ...(value as Record<string, string>) };
}

function parseStep(value: unknown, where: string, warnings: string[]): WalkthroughStep {
  if (!isRecord(value)) invalid(`${where} must be an object`);
  const { file, line, endLine, description, callPath, variables, stateChanges, error } = value;
  if (typeof file !== 'string' || file.trim() === '') invalid(`${where} needs "file"`);
  if (!isLineNumber(line)) invalid(`${where} needs "line" as a line number from 1`);
  if (endLine !== undefined && (!isLineNumber(endLine) || endLine < line)) {
    invalid(`${where} "endLine" must be a line number not before "line"`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    invalid(`${where} needs "description"`);
  }
  if (error !== undefined && typeof error !== 'boolean') {
    invalid(`${where} "error" must be true or false`);
  }
  const calls = callPath === undefined ? [] : parseCallPath(callPath, where);
  const values = variables === undefined ? {} : parseValues(variables, where, 'variables');
  const changes =
    stateChanges === undefined ? {} : parseValues(stateChanges, where, 'stateChanges');
  warnings.push(...ignoredFields(value, STEP_FIELDS, where));
  return {
    file: file.replace(/^\.\//, ''),
    line,
    ...(endLine === undefined || endLine === line ? {} : { endLine }),
    description,
    ...(calls.length > 0 ? { callPath: calls } : {}),
    ...(Object.keys(values).length > 0 ? { variables: values } : {}),
    ...(Object.keys(changes).length > 0 ? { stateChanges: changes } : {}),
    ...(error === true ? { error } : {}),
  };
}

function cloneStep({
  callPath,
  variables,
  stateChanges,
  ...rest
}: WalkthroughStep): WalkthroughStep {
  return {
    ...rest,
    ...(callPath === undefined ? {} : { callPath: [...callPath] }),
    ...(variables === undefined ? {} : { variables: { ...variables } }),
    ...(stateChanges === undefined ? {} : { stateChanges: { ...stateChanges } }),
  };
}

export const caseLabel = (index: number) => `case ${index + 1}`;

function parseCase(value: unknown, where: string, warnings: string[]): WalkthroughCase {
  const inCase = (what: string) => (where ? `${where} ${what}` : what);
  if (!isRecord(value)) invalid(`${where || 'a case'} must be an object`);
  const { title, setup, steps } = value;
  if (title !== undefined && typeof title !== 'string') invalid(inCase('"title" must be a string'));
  if (setup !== undefined && typeof setup !== 'string') invalid(inCase('"setup" must be a string'));
  if (!Array.isArray(steps) || steps.length === 0) {
    invalid(`${where || 'a case'} needs at least one step`);
  }
  warnings.push(...ignoredFields(value, CASE_FIELDS, where || 'case'));
  return {
    ...(title?.trim() ? { title } : {}),
    ...(setup?.trim() ? { setup } : {}),
    steps: steps.map((step, index) => parseStep(step, inCase(`step ${index + 1}`), warnings)),
  };
}

// Throws on a shape the viewer cannot play; fields it does not know yet only warn.
export function parseWalkthrough(value: unknown): {
  cases: WalkthroughCase[];
  warnings: string[];
} {
  if (!isRecord(value)) invalid('expected a JSON object with "cases"');
  const { cases } = value;
  if (!Array.isArray(cases) || cases.length === 0) invalid('"cases" needs one case');
  const warnings = ignoredFields(value, new Set(['cases']), 'walkthrough');
  return {
    cases: cases.map((item, index) =>
      parseCase(item, cases.length > 1 ? caseLabel(index) : '', warnings),
    ),
    warnings,
  };
}

export function cloneWalkthrough(walkthrough: Walkthrough): Walkthrough {
  return {
    commit: walkthrough.commit,
    cases: walkthrough.cases.map(({ title, setup, steps }) => ({
      ...(title === undefined ? {} : { title }),
      ...(setup === undefined ? {} : { setup }),
      steps: steps.map(cloneStep),
    })),
  };
}
