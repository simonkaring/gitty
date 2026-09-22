use crate::dto::RepositoryLocation;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneRequest {
    pub source: String,
    pub parent: RepositoryLocation,
    pub directory_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub phase: String,
    pub percent: Option<u8>,
    pub message: String,
}
