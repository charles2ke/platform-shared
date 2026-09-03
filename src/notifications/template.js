export function renderTemplate(template, variables = {}) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((current, segment) => current?.[segment], variables);
    return value === undefined || value === null ? '' : String(value);
  });
}
