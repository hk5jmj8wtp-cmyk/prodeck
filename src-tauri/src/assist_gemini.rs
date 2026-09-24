//! Adapt Ask ProDeck's common message/tool contract to Gemini generateContent.
//! Preserve each returned part verbatim for Google's thought signatures.
use serde_json::{json, Value};
use std::collections::HashMap;

pub const DEFAULT_MODEL: &str = "gemini-3.8-flash";
const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";

pub fn model_url(model: &str) -> Result<String, String> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    if model.is_empty()
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err(
            "Enter a Gemini model ID, such as gemini-3.8-flash, in Settings → Troubleshooter."
                .into(),
        );
    }
    Ok(format!("{ENDPOINT}/{model}:generateContent"))
}

pub fn request(body: &Value) -> Result<Value, String> {
    let messages = body["messages"]
        .as_array()
        .ok_or("messages must be an array")?;
    let mut contents = Vec::new();
    let mut calls: HashMap<String, (String, Option<Value>)> = HashMap::new();
    for message in messages {
        let role = match message["role"].as_str() {
            Some("assistant") => "model",
            Some("user") => "user",
            _ => return Err("Unsupported conversation role".into()),
        };
        let mut parts = Vec::new();
        match &message["content"] {
            Value::String(text) => parts.push(json!({"text": text})),
            Value::Array(blocks) => {
                for block in blocks {
                    match block["type"].as_str() {
                        Some("tool_use") if role == "model" => {
                            let id = block["id"].as_str().ok_or("Tool call has no ID")?;
                            let name = block["name"].as_str().ok_or("Tool call has no name")?;
                            let part = block.get("gemini_part").cloned().unwrap_or_else(|| json!({
                            "functionCall": {"name": name, "args": block.get("input").cloned().unwrap_or(json!({}))}
                        }));
                            calls.insert(
                                id.into(),
                                (name.into(), part["functionCall"].get("id").cloned()),
                            );
                            parts.push(part);
                        }
                        Some("tool_result") if role == "user" => {
                            let id = block["tool_use_id"]
                                .as_str()
                                .ok_or("Tool result has no ID")?;
                            let (name, native_id) =
                                calls.get(id).ok_or("Tool result has no matching call")?;
                            let value = match &block["content"] {
                                Value::String(text) => {
                                    serde_json::from_str(text).unwrap_or(json!(text))
                                }
                                value => value.clone(),
                            };
                            let mut response = json!({"name": name, "response": {"result": value}});
                            if let Some(id) = native_id {
                                response["id"] = id.clone();
                            }
                            parts.push(json!({"functionResponse": response}));
                        }
                        Some("text") => {
                            let part = if role == "model" {
                                block.get("gemini_part")
                            } else {
                                None
                            };
                            parts.push(
                                part.cloned()
                                    .unwrap_or_else(|| json!({"text": block["text"]})),
                            );
                        }
                        Some("gemini_context") if role == "model" => {
                            if let Some(part) = block.get("gemini_part") {
                                parts.push(part.clone());
                            }
                        }
                        _ => return Err("Unsupported message content for Gemini".into()),
                    }
                }
            }
            _ => return Err("Message content must be text or blocks".into()),
        }
        if !parts.is_empty() {
            contents.push(json!({"role": role, "parts": parts}));
        }
    }
    let mut out = json!({
        "contents": contents,
        "generationConfig": {"maxOutputTokens": body["max_tokens"].as_u64().unwrap_or(1500).clamp(1, 1500)}
    });
    if let Some(system) = body.get("system") {
        let parts = match system {
            Value::String(text) => vec![json!({"text": text})],
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| b.get("text").map(|t| json!({"text": t})))
                .collect(),
            _ => return Err("System instructions must be text".into()),
        };
        out["systemInstruction"] = json!({"parts": parts});
    }
    if let Some(tools) = body["tools"].as_array().filter(|t| !t.is_empty()) {
        let declarations: Vec<Value> = tools.iter().map(|t| json!({
            "name": t["name"], "description": t["description"], "parameters": t["input_schema"]
        })).collect();
        out["tools"] = json!([{"functionDeclarations": declarations}]);
        out["toolConfig"] = match body["tool_choice"]["type"].as_str() {
            Some("none") => json!({"functionCallingConfig": {"mode": "NONE"}}),
            Some("any") => json!({"functionCallingConfig": {"mode": "ANY"}}),
            Some("tool") => {
                json!({"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [body["tool_choice"]["name"]]}})
            }
            _ => json!({"functionCallingConfig": {"mode": "AUTO"}}),
        };
    }
    Ok(out)
}

pub fn response(body: &Value) -> Result<Value, String> {
    let candidate = body["candidates"]
        .as_array()
        .and_then(|c| c.first())
        .ok_or("Gemini returned no answer. The prompt may have been blocked; try rephrasing it.")?;
    let finish = candidate["finishReason"].as_str().unwrap_or("");
    if !matches!(finish, "STOP" | "MAX_TOKENS" | "") {
        return Err(format!(
            "Gemini could not finish this answer ({finish}). Try rephrasing the question."
        ));
    }
    let parts = candidate["content"]["parts"]
        .as_array()
        .ok_or("Gemini returned an empty answer")?;
    let mut content = Vec::new();
    let mut tools = false;
    let mut has_text = false;
    for part in parts {
        let block = if let Some(call) = part.get("functionCall") {
            let name = call["name"]
                .as_str()
                .ok_or("Gemini returned a tool call without a name")?;
            let input = call.get("args").cloned().unwrap_or(json!({}));
            if !input.is_object() {
                return Err("Gemini returned invalid tool arguments".into());
            }
            tools = true;
            json!({"type":"tool_use", "id": call.get("id").cloned().unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string())), "name":name, "input":input, "gemini_part":part})
        } else if part["thought"].as_bool() != Some(true) && part["text"].is_string() {
            has_text |= !part["text"].as_str().unwrap_or("").trim().is_empty();
            json!({"type":"text", "text":part["text"], "gemini_part":part})
        } else {
            json!({"type":"gemini_context", "gemini_part":part})
        };
        content.push(block);
    }
    if !tools && !has_text {
        return Err("Gemini returned no answer within the response limit. Try a shorter question or another model.".into());
    }
    if tools && finish == "MAX_TOKENS" {
        return Err("Gemini's tool request was cut short. Try a shorter question.".into());
    }
    Ok(json!({
        "content":content,
        "stop_reason": if tools { "tool_use" } else if finish == "MAX_TOKENS" { "max_tokens" } else { "end_turn" },
        "usage": {"input_tokens":body["usageMetadata"]["promptTokenCount"], "output_tokens":body["usageMetadata"]["candidatesTokenCount"]}
    }))
}

pub fn readable_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_default();
    match status {
        401 | 403 => "The Gemini key was rejected. Check the API key and project access in Settings → Troubleshooter.".into(),
        400 if msg.to_lowercase().contains("api key") => "The Gemini API key is invalid. Check it in Settings → Troubleshooter.".into(),
        404 => "That Gemini model is unavailable for this key. Choose another model in Settings → Troubleshooter.".into(),
        429 => "Gemini's quota or rate limit has been reached. Check your Google AI Studio quota or try again later.".into(),
        500..=599 => "Gemini is temporarily unavailable. Try again in a minute.".into(),
        _ => format!("Gemini refused the request ({status}): {}", msg.chars().take(250).collect::<String>()),
    }
}

pub async fn complete(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    body: &Value,
) -> Result<Value, String> {
    complete_at(client, key, model, body, &model_url(model)?).await
}

// Endpoint injection is private and used only by the local HTTP regression test.
async fn complete_at(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    body: &Value,
    endpoint: &str,
) -> Result<Value, String> {
    let mut request = request(body)?;
    // Gemini counts reasoning against the output limit; reserve room for it
    // so the existing answer limit doesn't cut off every thinking-only reply.
    let name = model.strip_prefix("models/").unwrap_or(model);
    if name.starts_with("gemini-3") {
        request["generationConfig"]["thinkingConfig"] = json!({"thinkingLevel":"low"});
        let answer_limit = request["generationConfig"]["maxOutputTokens"]
            .as_u64()
            .unwrap_or(1500);
        request["generationConfig"]["maxOutputTokens"] = json!(answer_limit + 4096);
    } else if name.starts_with("gemini-2.5") {
        request["generationConfig"]["thinkingConfig"] = json!({"thinkingBudget":512});
        let answer_limit = request["generationConfig"]["maxOutputTokens"]
            .as_u64()
            .unwrap_or(1500);
        request["generationConfig"]["maxOutputTokens"] = json!(answer_limit + 512);
    }
    let resp = client
        .post(endpoint)
        .header("x-goog-api-key", key)
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Gemini didn't answer in time. Try again.".into()
            } else {
                format!("Couldn't reach Gemini: {e}")
            }
        })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(readable_error(status, &text).replace(key, "[redacted]"));
    }
    let body = serde_json::from_str(&text).map_err(|e| format!("Bad reply from Gemini: {e}"))?;
    response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translates_instructions_tools_and_token_limit() {
        let out = request(&json!({"system":"Use only the routing map", "messages":[{"role":"user","content":"No sound"}], "tools":[{"name":"status","description":"Live state","input_schema":{"type":"object","properties":{}}}], "max_tokens":99999})).unwrap();
        assert_eq!(
            out["systemInstruction"]["parts"][0]["text"],
            "Use only the routing map"
        );
        assert_eq!(out["contents"][0]["role"], "user");
        assert_eq!(out["tools"][0]["functionDeclarations"][0]["name"], "status");
        assert_eq!(out["generationConfig"]["maxOutputTokens"], 1500);
        assert_eq!(out["toolConfig"]["functionCallingConfig"]["mode"], "AUTO");
    }
    #[test]
    fn parallel_tools_and_thought_signatures_survive_round_trip() {
        let parts = json!([
            {"text":"private summary", "thought":true,"thoughtSignature":"context-sig"},
            {"functionCall":{"name":"channel","args":{"number":39},"id":"call-1"},"thoughtSignature":"opaque-sig"},
            {"functionCall":{"name":"channel","args":{"number":53}}}
        ]);
        let out =
            response(&json!({"candidates":[{"content":{"parts":parts},"finishReason":"STOP"}]}))
                .unwrap();
        assert_eq!(out["stop_reason"], "tool_use");
        assert_eq!(out["content"][0]["type"], "gemini_context");
        let second_id = &out["content"][2]["id"];
        let req = request(&json!({"messages":[
            {"role":"user","content":"Check both channels"},
            {"role":"assistant","content":out["content"]},
            {"role":"user","content":[
                {"type":"tool_result","tool_use_id":"call-1","content":"{\"muted\":false}"},
                {"type":"tool_result","tool_use_id":second_id,"content":"{\"muted\":true}"}
            ]}
        ]}))
        .unwrap();
        assert_eq!(req["contents"][1]["parts"], parts);
        assert_eq!(
            req["contents"][2]["parts"][0]["functionResponse"],
            json!({"id":"call-1","name":"channel","response":{"result":{"muted":false}}})
        );
        assert!(req["contents"][2]["parts"][1]["functionResponse"]
            .get("id")
            .is_none());
        assert_eq!(
            req["contents"][2]["parts"][1]["functionResponse"]["response"]["result"]["muted"],
            true
        );
    }
    #[test]
    fn text_reply_matches_the_existing_agent_contract() {
        let out = response(&json!({"candidates":[{"content":{"parts":[{"text":"Check [ch 39].","thoughtSignature":"text-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10}})).unwrap();
        assert_eq!(out["content"][0]["text"], "Check [ch 39].");
        assert_eq!(out["stop_reason"], "end_turn");
        assert_eq!(out["usage"]["input_tokens"], 100);
    }
    #[test]
    fn reports_blocked_empty_and_malformed_responses() {
        assert!(response(&json!({"promptFeedback":{"blockReason":"SAFETY"}})).is_err());
        assert!(response(&json!({"candidates":[{"finishReason":"SAFETY"}]}))
            .unwrap_err()
            .contains("SAFETY"));
        assert!(response(&json!({"candidates":[{"content":{"parts":[]}}]})).is_err());
        assert!(request(&json!({"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"missing","content":"ok"}]}]})).is_err());
    }
    #[test]
    fn model_url_is_fixed_to_google_and_errors_name_gemini() {
        assert_eq!(
            model_url("models/gemini-3.8-flash").unwrap(),
            format!("{ENDPOINT}/gemini-3.8-flash:generateContent")
        );
        assert!(model_url("x?key=anything").is_err());
        assert!(model_url("https://example.org").is_err());
        assert!(readable_error(403, "{}").contains("Gemini key"));
        assert!(readable_error(429, "{}").contains("quota"));
        assert!(readable_error(404, "{}").contains("model"));
    }
    #[tokio::test]
    async fn http_tool_round_trip_uses_google_header_and_replays_signed_parts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/models/gemini-3.8-flash:generateContent",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let mut captured = Vec::new();
            for round in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                assert!(header.contains("x-goog-api-key: google-test"));
                assert!(!header.contains("anthropic"));
                assert!(!header.lines().next().unwrap().contains("google-test"));
                let len: usize = header
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                while bytes.len() < header_end + len {
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                captured.push(
                    serde_json::from_slice::<Value>(&bytes[header_end..header_end + len]).unwrap(),
                );
                let parts = if round == 0 {
                    json!([{"functionCall":{"name":"status","args":{},"id":"test-call"},"thoughtSignature":"signed-context"}])
                } else {
                    json!([{"text":"The console is connected."}])
                };
                let body = json!({"candidates":[{"content":{"role":"model","parts":parts},"finishReason":"STOP"}]}).to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            captured
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let mut body = json!({"messages":[{"role":"user","content":"Is the console connected?"}], "tools":[{"name":"status","description":"Live status","input_schema":{"type":"object","properties":{}}}],"max_tokens":1500});
        let first = complete_at(&client, "google-test", DEFAULT_MODEL, &body, &url)
            .await
            .unwrap();
        assert_eq!(first["stop_reason"], "tool_use");
        body["messages"].as_array_mut().unwrap().extend([
            json!({"role":"assistant","content":first["content"]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"test-call","content":"{\"desk_connected\":true}"}]})
        ]);
        let last = complete_at(&client, "google-test", DEFAULT_MODEL, &body, &url)
            .await
            .unwrap();
        assert_eq!(last["content"][0]["text"], "The console is connected.");
        let requests = server.await.unwrap();
        assert_eq!(
            requests[0]["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );
        assert_eq!(requests[0]["generationConfig"]["maxOutputTokens"], 5596);
        assert_eq!(
            requests[1]["contents"][1]["parts"][0]["thoughtSignature"],
            "signed-context"
        );
        assert_eq!(
            requests[1]["contents"][2]["parts"][0]["functionResponse"]["response"]["result"]
                ["desk_connected"],
            true
        );
    }
}
