use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Invalid URL")]
    InvalidUrl,
    #[error("Missing engine binary: {0}")]
    MissingEngine(String),
    #[error("Failed to run external process: {0}")]
    Process(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

impl AppError {
    pub fn user_message(&self) -> String {
        self.to_string()
    }
}
