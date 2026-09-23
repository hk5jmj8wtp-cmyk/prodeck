use crate::audio::AudioState;
use crate::settings::SettingsState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct TranscriptionInner {
    pub running: AtomicBool,
    /// Lyrics Follow expects next — Whisper's decoder prompt.
    pub prompt: std::sync::Mutex<String>,
}

pub type TranscriptionState = Arc<TranscriptionInner>;

impl TranscriptionInner {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            prompt: std::sync::Mutex::new(String::new()),
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct TranscriptionConfig {
    pub configured: bool,
    pub whisper_bin: Option<String>,
    pub whisper_model: Option<String>,
}

#[tauri::command]
pub fn transcription_status(settings: tauri::State<'_, SettingsState>) -> TranscriptionConfig {
    let s = settings.lock().unwrap_or_else(|p| p.into_inner());
    let configured = s
        .whisper_bin
        .as_ref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false)
        && resolve_model(&s).is_some();
    TranscriptionConfig {
        configured,
        whisper_bin: s.whisper_bin.clone(),
        whisper_model: resolve_model(&s),
    }
}

/// Manually push a caption line (useful for testing the lower-third without a
/// transcription engine installed).
#[tauri::command]
pub fn inject_caption(text: String, app: AppHandle) {
    emit_caption(&app, &text);
}

fn emit_caption(app: &AppHandle, text: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    app.emit(
        "caption:line",
        serde_json::json!({ "text": text, "ts": ts }),
    )
    .ok();
}

/// Follow's listener. whisper-server keeps the model loaded (a CLI run per
/// window reloads ~600 MB each time); every HOP it hears the last WINDOW of
/// audio, so windows overlap and a line is recognised ~1–3 s after it is
/// sung instead of 3–7 s. Each window goes out as `caption:heard` with its
/// wall-clock span and Whisper's own confidence, which is how Follow tells
/// a sung line from the model "hearing" words in a guitar solo. Every other
/// window (no overlap) also goes out as `caption:line` for the lower third.
const WINDOW_MS: u64 = 4000;
const HOP_MS: u64 = 2000;
/// A marker path so a whisper-server orphaned by a crash can be found and
/// stopped on the next start (it would otherwise hold ~1 GB forever).
const INFERENCE_PATH: &str = "/prodeck-inference";

fn resolve_model(s: &crate::settings::Settings) -> Option<String> {
    s.whisper_model
        .clone()
        .filter(|m| std::path::Path::new(m).exists())
        .or_else(crate::settings::detect_whisper_model)
}

fn server_bin(cli: &str) -> Option<String> {
    let p = std::path::Path::new(cli).with_file_name("whisper-server");
    p.exists().then(|| p.to_string_lossy().to_string())
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok().map(|a| a.port())
}

#[tauri::command]
pub fn transcription_set_prompt(text: String, state: tauri::State<'_, TranscriptionState>) {
    // Whisper's prompt window is ~224 tokens; keep it well inside that.
    let t: String = text.chars().take(600).collect();
    *state.prompt.lock().unwrap_or_else(|p| p.into_inner()) = t;
}

#[tauri::command]
pub fn start_transcription(
    state: tauri::State<'_, TranscriptionState>,
    audio: tauri::State<'_, AudioState>,
    settings: tauri::State<'_, SettingsState>,
    app: AppHandle,
) -> Result<(), String> {
    let (bin, model, actx) = {
        let s = settings.lock().unwrap_or_else(|p| p.into_inner());
        (s.whisper_bin.clone(), resolve_model(&s), s.whisper_audio_ctx)
    };
    let bin = bin.ok_or("Whisper isn't installed (set its path in Settings)")?;
    let model = model.ok_or("No Whisper model found (Settings → Captions, or put one in ProDeck/models)")?;
    if !std::path::Path::new(&bin).exists() {
        return Err(format!("Whisper binary not found at {bin}"));
    }
    if state.running.swap(true, Ordering::AcqRel) {
        return Ok(()); // already listening
    }
    app.emit("caption:status", "loading").ok();

    let running = state.inner().clone();
    let audio = audio.inner().clone();
    let app2 = app.clone();

    // A synchronous command runs with no Tokio runtime entered; Tauri's
    // spawner targets the managed runtime from any thread.
    tauri::async_runtime::spawn(async move {
        let mut server: Option<(tokio::process::Child, u16)> = None;
        if let Some(sbin) = server_bin(&bin) {
            let _ = std::process::Command::new("/usr/bin/pkill").args(["-f", INFERENCE_PATH]).status();
            if let Some(port) = free_port() {
                let mut cmd = tokio::process::Command::new(&sbin);
                cmd.args(["-m", &model, "-l", "en", "-t", "4", "-nt", "--host", "127.0.0.1"])
                    // Greedy, no temperature fallback: same words on sung lyrics in
                    // testing, and no 5–7 s windows when Whisper doubts itself.
                    .args(["-nf", "-bs", "1", "-bo", "1"])
                    .args(["--port", &port.to_string(), "--inference-path", INFERENCE_PATH])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true);
                if actx > 0 {
                    cmd.args(["-ac", &actx.to_string()]);
                }
                match cmd.spawn() {
                    Ok(child) => server = Some((child, port)),
                    Err(e) => crate::diag::log(format!("[follow] whisper-server failed to start: {e}")),
                }
            }
        }
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().ok();
        if let (Some((_, port)), Some(c)) = (&server, &client) {
            // Model load: a second or two for turbo; give it 30.
            for _ in 0..60 {
                if c.get(format!("http://127.0.0.1:{port}/")).send().await.is_ok() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
        app2.emit("caption:status", "listening").ok();

        let mut ring: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
        let mut n: u64 = 0;
        audio.drain(); // start fresh, not with 30 s of backlog
        while running.running.load(Ordering::Acquire) {
            tokio::time::sleep(std::time::Duration::from_millis(HOP_MS)).await;
            if !running.running.load(Ordering::Acquire) {
                break;
            }
            let (samples, sr) = audio.drain();
            let end = now_ms();
            if sr == 0 {
                continue;
            }
            ring.extend(resample_to_16k(&samples, sr));
            let keep = (16 * WINDOW_MS) as usize;
            while ring.len() > keep {
                ring.pop_front();
            }
            if ring.len() < 16 * 1500 {
                continue;
            }
            n += 1;
            let window: Vec<f32> = ring.iter().copied().collect();
            let start = end.saturating_sub(window.len() as u64 / 16);
            let rms = (window.iter().map(|v| v * v).sum::<f32>() / window.len() as f32).sqrt();
            if rms < 0.003 {
                // ~-50 dBFS: nothing to hear. Say so — Follow's song lock
                // uses silence to know a song has ended.
                app2.emit("caption:heard", serde_json::json!({ "text": "", "start": start, "end": end, "quiet": true })).ok();
                continue;
            }
            let prompt = running.prompt.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let t0 = now_ms();
            let heard = match (&server, &client) {
                (Some((_, port)), Some(c)) => infer_server(c, *port, &window, &prompt).await,
                _ => infer_cli(&bin, &model, &window).await,
            };
            match heard {
                Ok(h) => {
                    let text = clean_whisper_text(&h.text);
                    app2.emit(
                        "caption:heard",
                        serde_json::json!({
                            "text": text, "start": start, "end": end, "ms": now_ms() - t0,
                            "langP": h.lang_p, "logprob": h.logprob, "noSpeech": h.no_speech,
                        }),
                    )
                    .ok();
                    let sung = h.lang_p.map(|p| p >= 0.5).unwrap_or(true);
                    if n % 2 == 0 && sung && !text.is_empty() {
                        emit_caption(&app2, &text);
                    }
                }
                Err(e) => {
                    app2.emit("caption:status", format!("whisper error: {e}")).ok();
                }
            }
        }
        if let Some((mut child, _)) = server {
            let _ = child.kill().await;
        }
        app2.emit("caption:status", "stopped").ok();
    });

    Ok(())
}

struct Heard {
    text: String,
    lang_p: Option<f64>,
    logprob: Option<f64>,
    no_speech: Option<f64>,
}

async fn infer_server(c: &reqwest::Client, port: u16, window: &[f32], prompt: &str) -> Result<Heard, String> {
    let wav = wav_bytes(window)?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(wav).file_name("w.wav").mime_str("audio/wav").map_err(|e| e.to_string())?)
        .text("response_format", "verbose_json")
        .text("temperature", "0");
    if !prompt.trim().is_empty() {
        form = form.text("prompt", prompt.to_string());
    }
    let v: serde_json::Value = c
        .post(format!("http://127.0.0.1:{port}{INFERENCE_PATH}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let segs = v.get("segments").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let mean = |k: &str| {
        let xs: Vec<f64> = segs.iter().filter_map(|s| s.get(k).and_then(|x| x.as_f64())).collect();
        (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64)
    };
    Ok(Heard {
        text: v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        lang_p: v.get("detected_language_probability").and_then(|x| x.as_f64()),
        logprob: mean("avg_logprob"),
        no_speech: mean("no_speech_prob"),
    })
}

/// No whisper-server next to the CLI: one CLI run per window (slower —
/// the model reloads every time — but it works).
async fn infer_cli(bin: &str, model: &str, window: &[f32]) -> Result<Heard, String> {
    let path = write_wav(window)?;
    let out = tokio::process::Command::new(bin)
        .args(["-m", model, "-f", path.to_string_lossy().as_ref(), "-l", "en", "-nt", "-np"])
        .output()
        .await;
    let _ = std::fs::remove_file(&path);
    let out = out.map_err(|e| e.to_string())?;
    Ok(Heard { text: String::from_utf8_lossy(&out.stdout).to_string(), lang_p: None, logprob: None, no_speech: None })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn stop_transcription(state: tauri::State<'_, TranscriptionState>, app: AppHandle) {
    state.running.store(false, Ordering::Release);
    app.emit("caption:status", "stopped").ok();
}

fn resample_to_16k(input: &[f32], sr: u32) -> Vec<f32> {
    if sr == 16000 {
        return input.to_vec();
    }
    let ratio = 16000f64 / sr as f64;
    let out_len = (input.len() as f64 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let s0 = input.get(i0).copied().unwrap_or(0.0);
        let s1 = input.get(i0 + 1).copied().unwrap_or(s0);
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

fn wav_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: 16000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut cur = std::io::Cursor::new(Vec::with_capacity(samples.len() * 2 + 44));
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).map_err(|e| e.to_string())?;
        for &s in samples {
            w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?;
        }
        w.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cur.into_inner())
}

fn write_wav(samples: &[f32]) -> Result<std::path::PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("prodeck_cap_{ts}.wav"));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer.write_sample(v).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(path)
}

/// whisper.cpp emits bracketed non-speech markers and stray whitespace; strip
/// them so only clean caption text reaches the UI.
fn clean_whisper_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Drop pure annotation lines like "[BLANK_AUDIO]" or "(music)".
        let is_annotation = (line.starts_with('[') && line.ends_with(']'))
            || (line.starts_with('(') && line.ends_with(')'))
            || (line.starts_with('*') && line.ends_with('*'));
        if is_annotation {
            continue;
        }
        // Music glyphs and the words Whisper writes for an instrumental.
        let line = line.replace(['♪', '♫', '¶', '#'], " ");
        let line = line.trim();
        if line.is_empty() || matches!(line.trim_end_matches('.').to_lowercase().as_str(), "music" | "upbeat music" | "..." | "") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
    }
    out.trim().to_string()
}
