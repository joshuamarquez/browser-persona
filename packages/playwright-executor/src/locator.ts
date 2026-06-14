import type { StepTarget } from '@browser-persona/shared';

export interface LocatorSpec {
  kind: 'selector' | 'role' | 'label' | 'name' | 'text';
  selector?: string;
  role?: string;
  name?: string;
  exact?: boolean;
}

export function resolveLocatorSpec(target: StepTarget | undefined): LocatorSpec | null {
  if (!target) return null;

  if (target.selector) {
    return { kind: 'selector', selector: target.selector };
  }

  const accessibleName = target.ariaLabel ?? target.text;
  if (target.role && accessibleName) {
    return { kind: 'role', role: target.role, name: accessibleName };
  }

  if (target.ariaLabel) {
    return { kind: 'label', name: target.ariaLabel };
  }

  if (target.name) {
    return { kind: 'name', name: target.name };
  }

  if (target.text) {
    return { kind: 'text', name: target.text, exact: false };
  }

  return null;
}

export function locatorExpression(spec: LocatorSpec, pageVar = 'page'): string {
  switch (spec.kind) {
    case 'selector':
      return `${pageVar}.locator(${jsString(spec.selector ?? '')})`;
    case 'role':
      return `${pageVar}.getByRole(${jsString(spec.role ?? 'button')}, { name: ${jsString(spec.name ?? '')} })`;
    case 'label':
      return `${pageVar}.getByLabel(${jsString(spec.name ?? '')})`;
    case 'name':
      return `${pageVar}.locator(${jsString(`[name="${escapeAttr(spec.name ?? '')}"]`)})`;
    case 'text':
      return `${pageVar}.getByText(${jsString(spec.name ?? '')}${spec.exact === false ? ', { exact: false }' : ''})`;
    default:
      return `${pageVar}.locator('body')`;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function jsString(value: string): string {
  return JSON.stringify(value);
}
