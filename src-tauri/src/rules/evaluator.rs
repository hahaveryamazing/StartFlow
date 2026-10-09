use super::models::*;
use crate::context::{Availability, Field, Snapshot};
use chrono::{DateTime, Datelike, FixedOffset};
pub trait Clock {
    fn now(&self) -> DateTime<FixedOffset>;
}
pub struct FrozenClock(pub DateTime<FixedOffset>);
impl Clock for FrozenClock {
    fn now(&self) -> DateTime<FixedOffset> {
        self.0
    }
}
fn field<T>(field: &Field<T>, predicate: impl FnOnce(&T) -> bool) -> Match {
    match (field.status, &field.value) {
        (Availability::Available, Some(v)) => {
            if predicate(v) {
                Match::True
            } else {
                Match::False
            }
        }
        (Availability::Error, _) => Match::Error,
        _ => Match::Unknown,
    }
}
pub fn combine(operator: &str, values: &[Match]) -> Match {
    if values.contains(&Match::Error) {
        return Match::Error;
    }
    match operator {
        "not" => match values.first() {
            Some(Match::True) => Match::False,
            Some(Match::False) => Match::True,
            _ => Match::Unknown,
        },
        "and" => {
            if values.contains(&Match::False) {
                Match::False
            } else if values.contains(&Match::Unknown) || values.is_empty() {
                Match::Unknown
            } else {
                Match::True
            }
        }
        "or" => {
            if values.contains(&Match::True) {
                Match::True
            } else if values.contains(&Match::Unknown) || values.is_empty() {
                Match::Unknown
            } else {
                Match::False
            }
        }
        _ => Match::Error,
    }
}
pub fn evaluate(n: &Condition, s: &Snapshot, clock: &dyn Clock) -> Trace {
    if !n.enabled {
        return Trace {
            condition_id: n.id.clone(),
            result: Match::Unknown,
            explanation: "此条件已停用，不参与父组计算。".into(),
            children: vec![],
        };
    }
    let mut children = vec![];
    let (result, label) = match &n.expression {
        Expression::Group {
            operator,
            children: terms,
        } => {
            children = terms
                .iter()
                .filter(|t| t.enabled)
                .map(|t| evaluate(t, s, clock))
                .collect();
            (
                combine(
                    operator,
                    &children.iter().map(|t| t.result).collect::<Vec<_>>(),
                ),
                format!("{} 条件组", operator.to_uppercase()),
            )
        }
        Expression::Network { connected } => (
            field(&s.network_connected, |v| v == connected),
            "本地网络连接（不代表互联网）".into(),
        ),
        Expression::Wifi { network_id } => (
            field(&s.wifi_network_id, |v| v == network_id),
            "已配置的信任 Wi-Fi".into(),
        ),
        Expression::Monitors { minimum, maximum } => (
            field(&s.displays, |v| {
                v.len() >= *minimum as usize && v.len() <= *maximum as usize
            }),
            format!("显示器数量 {minimum}～{maximum}"),
        ),
        Expression::Power { source } => (
            field(&s.power_source, |v| v == source),
            if source == "ac" {
                "外接电源"
            } else {
                "电池供电"
            }
            .into(),
        ),
        Expression::Session { state } => {
            (field(&s.session, |v| v == state), "当前用户会话状态".into())
        }
        Expression::Weekdays { days } => (
            if days.contains(&clock.now().weekday().number_from_monday()) {
                Match::True
            } else {
                Match::False
            },
            "用户配置的星期".into(),
        ),
        Expression::Time { start, end } => {
            let a = super::validator::time(start);
            let b = super::validator::time(end);
            let t = clock.now().time();
            let v = match (a, b) {
                (Ok(a), Ok(b)) => {
                    if (a < b && t >= a && t < b) || (a > b && (t >= a || t < b)) {
                        Match::True
                    } else {
                        Match::False
                    }
                }
                _ => Match::Error,
            };
            (v, format!("本地时间 {start}～{end}"))
        }
        Expression::Process { task_id, state } => {
            let result = s
                .processes
                .get(task_id)
                .map(|v| match state.as_str() {
                    "running" => field(&v.running, |v| *v),
                    "stopped" => field(&v.running, |v| !*v),
                    "window" => field(&v.window, |v| *v),
                    "no_window" => field(&v.window, |v| !*v),
                    _ => Match::Error,
                })
                .unwrap_or(Match::Unknown);
            (result, "已配置应用状态".into())
        }
        Expression::Service { url } => (
            s.services
                .get(url)
                .map(|v| field(v, |v| *v))
                .unwrap_or(Match::Unknown),
            "用户指定的 HTTPS 服务".into(),
        ),
    };
    let status = match result {
        Match::True => "满足",
        Match::False => "不满足",
        Match::Unknown => "无法确定（未授权或不可用）",
        Match::Error => "检测错误",
    };
    Trace {
        condition_id: n.id.clone(),
        result,
        explanation: format!("{label}：{status}"),
        children,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn four_valued_logic_never_inverts_unknown() {
        assert_eq!(combine("not", &[Match::Unknown]), Match::Unknown);
        assert_eq!(
            combine("and", &[Match::True, Match::Unknown]),
            Match::Unknown
        );
        assert_eq!(combine("or", &[Match::True, Match::Error]), Match::Error);
        assert_eq!(combine("or", &[Match::False, Match::True]), Match::True);
    }
    #[test]
    fn injected_clock_supports_midnight() {
        let clock = FrozenClock(DateTime::parse_from_rfc3339("2026-10-08T00:30:00+08:00").unwrap());
        let n = Condition {
            id: crate::models::id(),
            enabled: true,
            expression: Expression::Time {
                start: "23:00".into(),
                end: "02:00".into(),
            },
        };
        assert_eq!(
            evaluate(&n, &Snapshot::default(), &clock).result,
            Match::True
        );
    }
    #[test]
    fn permission_denied_is_unknown_not_false() {
        let s = Snapshot {
            wifi_network_id: Field::absent(Availability::PermissionDenied, "denied"),
            ..Snapshot::default()
        };
        let n = Condition {
            id: crate::models::id(),
            enabled: true,
            expression: Expression::Wifi {
                network_id: crate::models::id(),
            },
        };
        assert_eq!(
            evaluate(
                &n,
                &s,
                &FrozenClock(DateTime::parse_from_rfc3339("2026-10-08T09:00:00+08:00").unwrap())
            )
            .result,
            Match::Unknown
        );
    }
}
