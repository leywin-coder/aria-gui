use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

static CDP_PORT: u16 = 9222;
static CDP_URL: &str = "http://127.0.0.1:9222/json";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CdpPage {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub url: String,
}

pub struct BrowserProcess {
    child: Child,
    stop: Arc<AtomicBool>,
}

impl BrowserProcess {
    pub fn spawn() -> Result<Self, String> {
        let port = CDP_PORT;
        let stop = Arc::new(AtomicBool::new(false));

        let chrome = Self::find_chrome();
        let mut cmd = Command::new(&chrome);
        cmd.arg("--headless=new")
           .arg("--disable-gpu")
           .arg(format!("--remote-debugging-port={port}"))
           .arg("--no-first-run")
           .arg("--no-default-browser-check")
           .arg("--disable-production-tip")
           .args(["--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"])
           .args(["--window-size=1920,1080"])
           .args(["--ignore-certificate-errors"])
           .args(["--disable-features=IsolateOrigins,site-per-process"])
           .args(["--app=http://localhost:9001"])
           .current_dir(PathBuf::from("/tmp"))
           .stdin(Stdio::null())
           .stdout(Stdio::null())
           .stderr(Stdio::piped());

        let child = cmd.spawn().map_err(|e| format!("Chrome failed: {e}"))?;

        Ok(BrowserProcess { child, stop })
    }

    fn find_chrome() -> PathBuf {
        const CANDIDATES: &[&str] = &[
            "/data/leywin/.hermes/tools/chromium-1208/chrome-linux64/chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/opt/google/chrome/chrome",
            "chrome",
        ];

        for &bin in CANDIDATES {
            if Path::new(bin).exists() {
                return PathBuf::from(bin);
            }
        }

        CANDIDATES[0].into()
    }

    pub async fn pages(&self) -> Result<Vec<CdpPage>, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;

        let resp = client.get(format!("{}/list", CDP_URL))
            .send()
            .await
            .map_err(|e| format!("CDP list: {e}"))?;

        let json: Vec<serde_json::Value> = resp.json().await
            .map_err(|e| format!("Parse list: {e}"))?;

        let pages = json.iter()
            .filter_map(|page| {
                serde_json::from_value::<CdpPage>(page.clone()).ok()
            })
            .collect();

        Ok(pages)
    }

    pub async fn navigate(&self, url: String) -> Result<(), String> {
        let pages = self.pages().await?;
        let page_id = pages.into_iter().next().map(|p| p.id);

        if let Some(id) = page_id {
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| format!("HTTP client: {e}"))?;

            client.post(format!("{}/navigate", CDP_URL))
                .json(&serde_json::json!({ "id": id, "url": url }))
                .send()
                .await
                .map_err(|e| format!("CDP navigate: {e}"))?;
        }

        Ok(())
    }

    pub async fn evaluate(&self, script: String) -> Result<String, String> {
        let pages = self.pages().await?;
        let page_id = pages.into_iter().next().map(|p| p.id);

        if let Some(id) = page_id {
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| format!("HTTP client: {e}"))?;

            let resp = client.post(format!("{}///execute", CDP_URL))
                .json(&serde_json::json!({
                    "id": id,
                    "expression": script,
                    "returnByValue": true
                }))
                .send()
                .await
                .map_err(|e| format!("CDP execute: {e}"))?;

            let json: serde_json::Value = resp.json().await
                .map_err(|e| format!("Parse execute: {e}"))?;

            json.get("result")
                .and_then(|r| r.get("result"))
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .ok_or_else(|| "No result".to_string())
        } else {
            Err("No page active".to_string())
        }
    }

    pub async fn intercept_network(&self) -> Result<tokio::sync::mpsc::Receiver<String>, String> {
        let pages = self.pages().await?;
        let page_id = pages.into_iter().next().map(|p| p.id);

        if let Some(id) = page_id {
            let stop = Arc::clone(&self.stop);
            let (tx, rx) = tokio::sync::mpsc::channel(128);

            thread::spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(_) => return,
                };
                let client = reqwest::Client::new();
                let interval = std::time::Duration::from_millis(500);

                while !stop.load(Ordering::SeqCst) {
                    thread::sleep(interval);
                    if stop.load(Ordering::SeqCst) { break; }

                    let url = format!("{}/list", CDP_URL);
                    let response = runtime.block_on(client.get(&url).send());
                    if let Ok(response) = response {
                        if let Ok(json) = runtime.block_on(response.json::<Vec<serde_json::Value>>()) {
                            for page in json {
                                if let Ok(page) = serde_json::from_value::<CdpPage>(page) {
                                    if page.id == id && page.url.starts_with("http") && !page.url.ends_with('/') {
                                        let _ = tx.blocking_send(page.url);
                                    }
                                }
                            }
                        }
                    }
                }
            });

            Ok(rx)
        } else {
            Err("No page active".to_string())
        }
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}