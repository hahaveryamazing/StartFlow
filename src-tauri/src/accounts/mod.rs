pub mod commands;
pub mod models;
pub mod repository;
pub mod service;
pub mod vault;
#[derive(Default)]
pub struct Accounts(pub std::sync::Mutex<()>);
#[cfg(test)]
mod tests;
