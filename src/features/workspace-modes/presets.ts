import { condition, newRule, type Mode, type Expression } from '../../types/v3';
export function modeRuleDraft(index: number, mode: Mode) {
  if (index === 3) return null;
  const rule = newRule(mode.targets[0]?.scene_id);
  rule.mode_id = mode.id;
  rule.name = `${mode.name}环境建议`;
  rule.priority = mode.priority;
  rule.description =
    index === 0
      ? '工作日工作时间的建议草稿；请在规则编辑器添加你的办公 Wi-Fi，未关联具体网络。'
      : index === 1
        ? '双屏建议草稿；请按需添加已配置剪辑程序的运行条件。'
        : '电池和单屏的便携建议草稿。';
  const expressions: Expression[] =
    index === 0
      ? [
          { type: 'network', connected: true },
          { type: 'weekdays', days: [1, 2, 3, 4, 5] },
          { type: 'time', start: '09:00', end: '18:00' },
        ]
      : index === 1
        ? [{ type: 'monitors', minimum: 2, maximum: 16 }]
        : [
            { type: 'power', source: 'battery' },
            { type: 'monitors', minimum: 1, maximum: 1 },
          ];
  rule.condition = condition({
    type: 'group',
    operator: 'and',
    children: expressions.map(condition),
  });
  rule.triggers =
    index === 1 ? ['displays'] : index === 2 ? ['power', 'displays'] : ['network', 'unlock'];
  return rule;
}
