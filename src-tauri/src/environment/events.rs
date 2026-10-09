use crate::rules::models::EventKind;
use std::collections::BTreeMap;
#[derive(Default)]
pub struct Debouncer {
    pub pending: BTreeMap<String, (EventKind, u64)>,
}
impl Debouncer {
    pub fn observe(&mut self, kind: EventKind, now_ms: u64, window_ms: u64) {
        self.pending.insert(
            format!("{kind:?}"),
            (kind, now_ms.saturating_add(window_ms)),
        );
    }
    pub fn due(&mut self, now_ms: u64) -> Vec<EventKind> {
        let keys: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, (_, due))| *due <= now_ms)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| self.pending.remove(&k).map(|v| v.0))
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_changes_coalesce() {
        let mut d = Debouncer::default();
        d.observe(EventKind::Network, 0, 5000);
        d.observe(EventKind::Network, 2000, 5000);
        assert!(d.due(5000).is_empty());
        assert_eq!(d.due(7000), vec![EventKind::Network]);
        assert!(d.due(8000).is_empty());
        for i in 0..1000 {
            d.observe(EventKind::Displays, i, 5000);
        }
        assert_eq!(d.pending.len(), 1);
    }
}
