use super::Settings;
use crate::error::{AppError, Result};
#[derive(Clone)]
pub struct Prepared {
    pub settings: Settings,
    pub body: serde_json::Value,
    pub created: std::time::Instant,
    pub kind: String,
}
pub trait AIProvider: Send + Sync {
    fn generate(
        &self,
        request: Prepared,
        key: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>;
}
pub struct StandardProvider;
impl AIProvider for StandardProvider {
    fn generate(
        &self,
        request: Prepared,
        key: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| AppError::new("ai", "AI 请求服务初始化失败。"))?;
            let mut builder = client
                .post(&request.settings.endpoint)
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&request.body)?);
            if let Some(key) = key {
                builder = builder.bearer_auth(key);
            }
            let mut response = builder.send().await.map_err(|_| {
                AppError::new(
                    "ai",
                    "无法连接所配置的模型，或请求超时；核心本地功能仍可用。",
                )
            })?;
            if !response.status().is_success() {
                return Err(AppError::new(
                    "ai",
                    "模型服务返回失败，请检查接口、模型名称和凭据。",
                ));
            }
            if response.content_length().is_some_and(|n| n > 128 * 1024) {
                return Err(AppError::new("ai", "模型输出超过安全大小限制。"));
            }
            let mut bytes = vec![];
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| AppError::new("ai", "模型响应读取失败。"))?
            {
                if bytes.len() + chunk.len() > 128 * 1024 {
                    return Err(AppError::new("ai", "模型输出超过安全限制。"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new("ai", "模型返回非兼容 JSON 响应。"))?;
            let message = value
                .pointer("/choices/0/message")
                .ok_or_else(|| AppError::new("ai", "模型响应缺少消息。"))?;
            if message
                .get("tool_calls")
                .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
            {
                return Err(AppError::new(
                    "ai",
                    "模型工具调用被拒绝；助手只能生成配置。",
                ));
            }
            let content = message
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("ai", "模型未提供结构化配置文本。"))?;
            if content.len() > 64 * 1024 {
                return Err(AppError::new("ai", "配置文本超过安全限制。"));
            }
            Ok(content.to_owned())
        })
    }
}
#[cfg(test)]
pub struct MockProvider(pub String);
#[cfg(test)]
impl AIProvider for MockProvider {
    fn generate(
        &self,
        _: Prepared,
        _: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        let output = self.0.clone();
        Box::pin(async move { Ok(output) })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn injected_provider_returns_draft_only() {
        let expected = r#"{"type":"explanation","explanation":"基于真实规则的说明"}"#;
        let provider = MockProvider(expected.into());
        let output = provider
            .generate(
                Prepared {
                    settings: crate::ai::Settings::default(),
                    body: serde_json::json!({}),
                    created: std::time::Instant::now(),
                    kind: "explanation".into(),
                },
                None,
            )
            .await
            .unwrap();
        assert!(matches!(
            serde_json::from_str::<crate::ai::Configuration>(&output).unwrap(),
            crate::ai::Configuration::Explanation { .. }
        ));
    }
}
