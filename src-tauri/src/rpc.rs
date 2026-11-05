use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::{Aria2Version, DownloadItem, GlobalStat};

#[derive(Debug)]
pub struct Aria2Client {
    http: Client,
    url: String,
    secret: String,
}

#[derive(Debug, Serialize)]
struct RpcRequest {
    jsonrpc: String,
    id: String,
    method: String,
    params: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    #[allow(dead_code)]
    id: Option<String>,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "aria2 RPC error {}: {}", self.code, self.message)
    }
}

impl Aria2Client {
    pub fn new(host: &str, port: u16, secret: &str) -> Self {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client configuration is valid");
        Self {
            http,
            url: format!("http://{}:{}/jsonrpc", host, port),
            secret: secret.to_string(),
        }
    }

    pub fn set_connection(&mut self, host: String, port: u16, secret: String) {
        self.url = format!("http://{}:{}/jsonrpc", host, port);
        self.secret = secret;
    }

    fn build_params(&self, extra: Vec<Value>) -> Vec<Value> {
        let mut params = Vec::new();
        if !self.secret.is_empty() {
            params.push(json!(format!("token:{}", self.secret)));
        }
        params.extend(extra);
        params
    }

    async fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, String> {
        let request = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params: self.build_params(params),
        };

        let response = self
            .http
            .post(&self.url)
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "RPC timeout: aria2 did not respond".to_string()
                } else if e.is_connect() {
                    "RPC unavailable: could not connect to aria2".to_string()
                } else {
                    format!("RPC transport error: {}", e)
                }
            })?
            .error_for_status()
            .map_err(|e| format!("RPC HTTP error: {}", e))?;

        let rpc_response: RpcResponse = response
            .json()
            .await
            .map_err(|e| format!("RPC invalid response: {}", e))?;

        if let Some(error) = rpc_response.error {
            return Err(error.to_string());
        }

        rpc_response
            .result
            .ok_or_else(|| "RPC empty response from aria2".to_string())
    }

    fn string_result(result: Value) -> Result<String, String> {
        result
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Invalid string response from aria2".to_string())
    }

    // ── Core API ──

    pub async fn get_version(&self) -> Result<Aria2Version, String> {
        let result = self.call("aria2.getVersion", vec![]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn add_uri(&self, uris: Vec<String>, options: Value) -> Result<String, String> {
        Self::string_result(self.call("aria2.addUri", vec![json!(uris), options]).await?)
    }

    pub async fn add_torrent(&self, torrent_base64: String, options: Value) -> Result<Vec<String>, String> {
        let result = self
            .call("aria2.addTorrent", vec![json!(torrent_base64), json!([]), options])
            .await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn add_metalink(&self, metalink_base64: String, options: Value) -> Result<Vec<String>, String> {
        let result = self
            .call("aria2.addMetalink", vec![json!(metalink_base64), options])
            .await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn tell_active(&self) -> Result<Vec<DownloadItem>, String> {
        let result = self.call("aria2.tellActive", vec![]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn tell_waiting(&self, offset: i64, num: i64) -> Result<Vec<DownloadItem>, String> {
        let result = self.call("aria2.tellWaiting", vec![json!(offset), json!(num)]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn tell_stopped(&self, offset: i64, num: i64) -> Result<Vec<DownloadItem>, String> {
        let result = self.call("aria2.tellStopped", vec![json!(offset), json!(num)]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn tell_status(&self, gid: &str) -> Result<DownloadItem, String> {
        let result = self.call("aria2.tellStatus", vec![json!(gid)]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn get_global_stat(&self) -> Result<GlobalStat, String> {
        let result = self.call("aria2.getGlobalStat", vec![]).await?;
        serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
    }

    pub async fn get_uris(&self, gid: &str) -> Result<Value, String> {
        self.call("aria2.getUris", vec![json!(gid)]).await
    }

    pub async fn get_peers(&self, gid: &str) -> Result<Value, String> {
        self.call("aria2.getPeers", vec![json!(gid)]).await
    }

    pub async fn get_servers(&self, gid: &str) -> Result<Value, String> {
        self.call("aria2.getServers", vec![json!(gid)]).await
    }

    pub async fn get_option(&self, gid: &str) -> Result<Value, String> {
        self.call("aria2.getOption", vec![json!(gid)]).await
    }

    pub async fn change_option(&self, gid: &str, options: Value) -> Result<String, String> {
        Self::string_result(self.call("aria2.changeOption", vec![json!(gid), options]).await?)
    }

    pub async fn get_global_option(&self) -> Result<Value, String> {
        self.call("aria2.getGlobalOption", vec![]).await
    }

    pub async fn change_global_option(&self, options: Value) -> Result<String, String> {
        Self::string_result(self.call("aria2.changeGlobalOption", vec![options]).await?)
    }

    pub async fn change_position(&self, gid: &str, position: i64, how: &str) -> Result<i64, String> {
        let result = self.call("aria2.changePosition", vec![json!(gid), json!(position), json!(how)]).await?;
        result.as_i64().ok_or_else(|| "Invalid queue position response".to_string())
    }

    pub async fn pause(&self, gid: &str) -> Result<String, String> {
        Self::string_result(self.call("aria2.pause", vec![json!(gid)]).await?)
    }

    pub async fn unpause(&self, gid: &str) -> Result<String, String> {
        Self::string_result(self.call("aria2.unpause", vec![json!(gid)]).await?)
    }

    pub async fn remove(&self, gid: &str) -> Result<String, String> {
        Self::string_result(self.call("aria2.remove", vec![json!(gid)]).await?)
    }

    pub async fn force_remove(&self, gid: &str) -> Result<String, String> {
        Self::string_result(self.call("aria2.forceRemove", vec![json!(gid)]).await?)
    }

    pub async fn remove_download_result(&self, gid: &str) -> Result<String, String> {
        Self::string_result(self.call("aria2.removeDownloadResult", vec![json!(gid)]).await?)
    }

    pub async fn purge_download_result(&self) -> Result<String, String> {
        Ok(self.call("aria2.purgeDownloadResult", vec![]).await?.to_string())
    }

    pub async fn pause_all(&self) -> Result<String, String> {
        Ok(self.call("aria2.pauseAll", vec![]).await?.to_string())
    }

    pub async fn unpause_all(&self) -> Result<String, String> {
        Ok(self.call("aria2.unpauseAll", vec![]).await?.to_string())
    }

    pub async fn shutdown(&self) -> Result<String, String> {
        Self::string_result(self.call("aria2.shutdown", vec![]).await?)
    }
}
