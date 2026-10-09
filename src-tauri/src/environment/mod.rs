pub mod events;
pub mod providers;
#[cfg(windows)]
pub mod subscriptions;
#[cfg(windows)]
pub mod windows;
use crate::{context::Snapshot, rules::models::Config};
// Providers supply observations only; this interface cannot dispatch system actions.
pub trait EnvironmentProvider: Send {
    fn capture(
        &mut self,
        config: &Config,
        legacy: &crate::models::Config,
        session: &str,
    ) -> Snapshot;
}
pub struct SystemProvider;
impl EnvironmentProvider for SystemProvider {
    fn capture(
        &mut self,
        config: &Config,
        legacy: &crate::models::Config,
        session: &str,
    ) -> Snapshot {
        providers::capture(config, legacy, session)
    }
}
#[cfg(test)]
pub struct MockProvider(pub Snapshot);
#[cfg(test)]
impl EnvironmentProvider for MockProvider {
    fn capture(&mut self, _: &Config, _: &crate::models::Config, _: &str) -> Snapshot {
        self.0.clone()
    }
}
