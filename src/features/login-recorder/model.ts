import type { Account } from '../../types/accounts';
import type {
  LocatorField,
  LocatorRule,
  LocatorSet,
  LoginConfig,
  Recording,
} from '../../types/web-login';
export const requiredFields: LocatorField[] = [
  'username',
  'password',
  'submit',
  'success',
  'identity',
];
export const fieldNames: Record<LocatorField, string> = {
  username: '账号输入框',
  password: '密码输入框',
  submit: '登录按钮',
  success: '登录成功标识',
  identity: '账号身份标识',
  challenge: '人工验证标识（可选）',
  failure: '登录失败标识（可选）',
};
export const matchNames = {
  ok: '唯一匹配',
  absent: '当前页面未找到',
  ambiguous: '匹配多个元素，请重新选择',
  invalid: '元素类型、可见性或规则无效',
  form_mismatch: '表单目标不符合授权范围',
  identity_mismatch: '账号身份不匹配或仍有密码框',
};
export const locatorText = (rule?: LocatorRule) =>
  rule
    ? rule.kind === 'role'
      ? `Role · ${rule.role} · ${rule.name}`
      : `${{ css: 'CSS', label: 'Label', placeholder: 'Placeholder', test_id: 'TestId' }[rule.kind]} · ${rule.value}`
    : '尚未选择';
export function initialRules(config?: LoginConfig): Partial<LocatorSet> {
  if (!config) return {};
  if (config.locators) return config.locators;
  return Object.fromEntries(
    [...requiredFields, 'challenge', 'failure'].map((field) => [
      field,
      {
        kind: 'css',
        value: config[`${field}_selector` as keyof LoginConfig],
      },
    ]),
  ) as Partial<LocatorSet>;
}
export function draftToConfig(
  account: Account,
  recording: Recording,
  rules: Partial<LocatorSet>,
  name: string,
  timeout: number,
  existing?: LoginConfig,
): LoginConfig {
  if (
    recording.account_id !== account.id ||
    recording.origin !== account.target ||
    !recording.form_action_url ||
    !recording.verified_login ||
    !recording.verified_success ||
    requiredFields.some(
      (f) => !rules[f] || JSON.stringify(rules[f]) !== JSON.stringify(recording.rules[f]),
    ) ||
    Object.entries(rules).some(
      ([field, rule]) =>
        JSON.stringify(rule) !== JSON.stringify(recording.rules[field as LocatorField]),
    ) ||
    recording.credential_ref !== account.credential_ref
  )
    throw Error('请完成控件选择，并分别验证登录页及成功页的定位。');
  if (!name.trim() || timeout < 3 || timeout > 120 || !Number.isInteger(timeout))
    throw Error('请输入名称和 3～120 秒的超时。');
  const locators = {
    ...rules,
    challenge: rules.challenge ?? {
      kind: 'css',
      value:
        '[data-human-verification], input[autocomplete="one-time-code"], [data-captcha], [data-mfa], [data-passkey]',
    },
    failure: rules.failure ?? { kind: 'css', value: '[data-login-error]' },
  } as LocatorSet;
  return {
    id: existing?.id ?? crypto.randomUUID(),
    account_id: account.id,
    name: name.trim(),
    origin: account.target,
    login_url: recording.login_url,
    form_action_url: recording.form_action_url,
    username_selector: '#sf-username',
    password_selector: '#sf-password',
    submit_selector: '#sf-submit',
    success_selector: '#sf-success',
    identity_selector: '#sf-identity',
    challenge_selector: '[data-human-verification]',
    failure_selector: '[data-login-error]',
    timeout_seconds: timeout,
    schema_version: 2,
    credential_ref: recording.credential_ref,
    locators,
  };
}
