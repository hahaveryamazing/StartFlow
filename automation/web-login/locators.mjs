const roles = new Set(['textbox', 'button', 'link', 'heading', 'status']);
export function validateLocator(rule) {
  if (!rule || typeof rule !== 'object') throw Error('locator_invalid');
  const keys = Object.keys(rule).sort().join(',');
  if (rule.kind === 'role') {
    if (keys !== 'kind,name,role' || !roles.has(rule.role)) throw Error('locator_invalid');
  } else if (
    !['css', 'label', 'placeholder', 'test_id'].includes(rule.kind) ||
    keys !== 'kind,value'
  ) {
    throw Error('locator_invalid');
  }
  const value = rule.kind === 'role' ? rule.name : rule.value;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))
    throw Error('locator_invalid');
  if (rule.kind === 'css' && />>|^(?:xpath|text|javascript)=|^\/\//.test(value))
    throw Error('locator_invalid');
  return rule;
}
export function locatorFor(page, rule) {
  validateLocator(rule);
  switch (rule.kind) {
    case 'role':
      return page.getByRole(rule.role, { name: rule.name, exact: true });
    case 'label':
      return page.getByLabel(rule.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(rule.value, { exact: true });
    case 'test_id':
      return page.getByTestId(rule.value);
    default:
      return page.locator('css=' + rule.value);
  }
}
export function configLocator(page, config, field) {
  return config.locators
    ? locatorFor(page, config.locators[field])
    : page.locator('css=' + config[field + '_selector']);
}
export async function uniqueControl(page, rule, field) {
  const locator = locatorFor(page, rule);
  const count = await locator.count();
  if (count !== 1) throw Error('locator_invalid');
  const valid = await locator.evaluate((e, field) => {
    if (
      e.getClientRects().length === 0 ||
      getComputedStyle(e).visibility === 'hidden' ||
      e.disabled ||
      e.readOnly
    )
      return false;
    if (field === 'username')
      return e instanceof HTMLInputElement && ['text', 'email', 'tel'].includes(e.type);
    if (field === 'password') return e instanceof HTMLInputElement && e.type === 'password';
    if (field === 'submit')
      return (
        (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && e.type === 'submit'
      );
    return (
      !(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && !e.isContentEditable
    );
  }, field);
  if (!valid) throw Error('locator_invalid');
  return locator;
}
export async function inspectForm(page, config) {
  const locs = ['username', 'password', 'submit'].map((field) =>
    configLocator(page, config, field),
  );
  for (const locator of locs) if ((await locator.count()) !== 1) throw Error('locator_invalid');
  const [u, p, b] = await Promise.all(locs.map((l) => l.elementHandle()));
  try {
    return await page.evaluate(
      ({ u, p, b, c }) => {
        if (
          !(u instanceof HTMLInputElement) ||
          !['text', 'email', 'tel'].includes(u.type) ||
          !(p instanceof HTMLInputElement) ||
          p.type !== 'password' ||
          !(b instanceof HTMLButtonElement || b instanceof HTMLInputElement) ||
          b.type !== 'submit'
        )
          return false;
        if (!p.form || u.form !== p.form || b.form !== p.form) return false;
        const f = p.form;
        const action = new URL(
          b.getAttribute('formaction') || f.getAttribute('action') || location.href,
          location.href,
        );
        return (
          action.href === c.form_action_url &&
          action.origin === c.origin &&
          action.protocol === 'https:' &&
          !action.search &&
          !action.hash &&
          !action.username &&
          !action.password &&
          f.method === 'post' &&
          (b.getAttribute('formmethod') || 'post').toLowerCase() === 'post' &&
          [null, '', '_self'].includes(b.getAttribute('formtarget') || f.getAttribute('target')) &&
          [u, p, b].every(
            (e) =>
              !e.disabled &&
              !e.readOnly &&
              e.getClientRects().length > 0 &&
              getComputedStyle(e).visibility !== 'hidden',
          )
        );
      },
      { u, p, b, c: config },
    );
  } finally {
    for (const handle of [u, p, b]) await handle?.dispose().catch(() => {});
  }
}
