/** Replace `{{param}}` placeholders with run parameters. */
export function interpolateParams(
  template: string,
  parameters: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in parameters) {
      return String(parameters[key]);
    }
    return `{{${key}}}`;
  });
}

export function interpolateParamsInValue(
  value: string | boolean | undefined,
  parameters: Record<string, string | number | boolean>,
): string | boolean | undefined {
  if (typeof value === 'string') {
    return interpolateParams(value, parameters);
  }
  return value;
}
