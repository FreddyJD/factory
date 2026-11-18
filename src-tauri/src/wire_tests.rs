use super::*;

fn frame(value: Value) -> String {
    format!(
        "event: {}\r\ndata: {value}\r\n\r\n",
        value["type"].as_str().unwrap_or("message")
    )
}
fn stream(protocol: Protocol, events: Vec<Value>, fragmented: bool) -> Result<Completion> {
    let input = events.into_iter().map(frame).collect::<String>();
    let input = input.trim_end_matches(['\r', '\n']);
    let mut decoder = Decoder::new(protocol, "fixture");
    if fragmented {
        for byte in input.as_bytes() {
            decoder.push(&[*byte])?;
        }
    } else {
        decoder.push(input.as_bytes())?;
    }
    decoder.end()?;
    decoder.finish()
}
fn function() -> Value {
    json!({"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\"filePath\":\"README.md\"}","status":"completed"})
}
fn response_events() -> Vec<Value> {
    let call = function();
    let reasoning =
        json!({"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"final-ciphertext"});
    vec![
        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"provisional"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":reasoning}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read","arguments":"","status":"in_progress"}}),
        json!({"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\"filePath\":"}),
        json!({"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"\"README.md\"}"}),
        json!({"type":"response.function_call_arguments.done","output_index":1,"item_id":"fc_1","arguments":call["arguments"]}),
        json!({"type":"response.output_item.done","output_index":1,"item":call}),
        json!({"type":"response.completed","response":{"status":"completed","error":null,"output":[reasoning,call]}}),
    ]
}
fn messages_events() -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private reasoning"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signature-"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"complete"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"redacted-state"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"caf\u{e9}"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{}}}),
        json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"filePath\":"}}),
        json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"\"README.md\"}"}}),
        json!({"type":"content_block_stop","index":3}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        json!({"type":"message_stop"}),
    ]
}
fn tools() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"read","description":"Read file","parameters":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"],"additionalProperties":false,"$defs":{"unused":{"type":"string"}}}}}),
    ]
}

#[test]
fn user_images_translate_to_every_protocol_and_survive_tool_continuations() {
    let url = "data:image/png;base64,aW1hZ2U=";
    let messages = vec![
        json!({"role":"system","content":"Policy"}),
        json!({"role":"user","content":[{"type":"text","text":"Fix this"},{"type":"image_url","image_url":{"url":url}}]}),
        json!({"role":"assistant","tool_calls":[{"id":"call","function":{"name":"read","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"call","content":"result"}),
    ];
    let saved: Vec<Value> =
        serde_json::from_slice(&serde_json::to_vec(&messages).unwrap()).unwrap();
    for protocol in [
        Protocol::Chat,
        Protocol::Responses,
        Protocol::Messages,
        Protocol::MessagesV1,
    ] {
        let request = body(protocol, "fixture", &saved, &tools(), 8192).unwrap();
        match protocol {
            Protocol::Chat => assert_eq!(
                request["messages"][1]["content"][1]["image_url"]["url"],
                url
            ),
            Protocol::Responses => {
                assert_eq!(request["input"][0]["content"][0]["type"], "input_text");
                assert_eq!(
                    request["input"][0]["content"][1],
                    json!({"type":"input_image","image_url":url})
                );
            }
            _ => assert_eq!(
                request["messages"][0]["content"][1],
                json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="}})
            ),
        }
    }
    assert_eq!(
        chat_messages(&messages, false)[1]["content"],
        messages[1]["content"]
    );
    for protocol in [Protocol::Responses, Protocol::Messages] {
        let request = body(
            protocol,
            "fixture",
            &[json!({"role":"user","content":[{"type":"image_url","image_url":{"url":url}}]})],
            &[],
            8192,
        )
        .unwrap();
        assert!(request.to_string().contains("aW1hZ2U="));
        assert!(body(
            protocol,
            "fixture",
            &[json!({"role":"user","content":[{"type":"unknown"}]})],
            &[],
            8192
        )
        .is_err());
    }
}

#[test]
fn responses_tool_roundtrip_retains_final_encrypted_state_exactly_once() {
    for fragmented in [false, true] {
        let completion = stream(Protocol::Responses, response_events(), fragmented).unwrap();
        assert_eq!(completion.reason, "tool_calls");
        assert_eq!(completion.calls.len(), 1);
        assert_eq!(completion.calls[0].id, "call_1");
        assert_eq!(
            completion.calls[0].arguments,
            "{\"filePath\":\"README.md\"}"
        );
        let saved =
            serde_json::from_slice::<Value>(&serde_json::to_vec(&assistant(&completion)).unwrap())
                .unwrap();
        let messages = vec![
            json!({"role":"system","content":"Policy"}),
            json!({"role":"user","content":"Inspect"}),
            saved,
            json!({"role":"tool","tool_call_id":"call_1","content":"File content"}),
        ];
        let request = body(Protocol::Responses, "fixture", &messages, &tools(), 8192).unwrap();
        assert_eq!(request["input"][1]["encrypted_content"], "final-ciphertext");
        assert_eq!(request["input"][2]["id"], "fc_1");
        assert_eq!(request["input"][3]["type"], "function_call_output");
        assert_eq!(request["input"][3]["call_id"], "call_1");
        assert_eq!(request["input"].as_array().unwrap().len(), 4);
        assert_eq!(request["tools"][0]["strict"], false);
        assert!(request.get("messages").is_none());
        assert_eq!(request["store"], false);
        assert_eq!(request["include"][0], "reasoning.encrypted_content");
        let chat = chat_messages(&messages, false);
        assert!(chat[2].get("provider_state").is_none());
        assert!(!chat[2].to_string().contains("ciphertext"));
    }
}
#[test]
fn messages_tool_roundtrip_preserves_thinking_signatures_order_and_tool_results() {
    for fragmented in [false, true] {
        let completion = stream(Protocol::MessagesV1, messages_events(), fragmented).unwrap();
        assert_eq!(completion.text, "caf\u{e9}");
        assert_eq!(completion.calls[0].id, "call_1");
        let request = body(
            Protocol::MessagesV1,
            "fixture",
            &[
                json!({"role":"system","content":"Policy"}),
                json!({"role":"user","content":"Inspect"}),
                assistant(&completion),
                json!({"role":"tool","tool_call_id":"call_1","content":"done"}),
                json!({"role":"user","content":"continue"}),
            ],
            &tools(),
            4096,
        )
        .unwrap();
        assert_eq!(request["system"][0]["text"], "Policy");
        let content = &request["messages"][1]["content"];
        assert_eq!(content[0]["signature"], "signature-complete");
        assert_eq!(content[1]["data"], "redacted-state");
        assert_eq!(content[2]["text"], "caf\u{e9}");
        assert_eq!(content[3]["type"], "tool_use");
        assert_eq!(
            request["messages"][2]["content"][0]["tool_use_id"],
            "call_1"
        );
        assert_eq!(request["messages"][2]["content"][1]["text"], "continue");
        assert_eq!(request["max_tokens"], 4096);
        let schema = &request["tools"][0]["input_schema"];
        assert!(schema.get("$schema").is_none());
        assert!(schema.get("$defs").is_some());
        assert_eq!(schema["additionalProperties"], false);
        assert!(tools()[0]["function"]["parameters"]
            .get("$schema")
            .is_some());
        assert!(request.to_string().find("eager_input_streaming").is_none());
    }
}
#[test]
fn responses_visible_text_deltas_do_not_duplicate_final_snapshots() {
    let item = json!({"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]});
    let events = vec![
        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}),
        json!({"type":"response.content_part.added","output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hel"}),
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"lo"}),
        json!({"type":"response.output_text.done","output_index":0,"item_id":"msg_1","content_index":0,"text":"hello"}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"status":"completed","output":[item]}}),
    ];
    let mut decoder = Decoder::new(Protocol::Responses, "fixture");
    let mut emitted = String::new();
    for event in events {
        for delta in decoder.push(frame(event).as_bytes()).unwrap() {
            emitted.push_str(&delta);
        }
    }
    assert_eq!(emitted, "hello");
    assert_eq!(decoder.finish().unwrap().text, "hello");
}
#[test]
fn malformed_or_failed_responses_never_authorize_tools() {
    for terminal in [
        json!({"type":"response.completed"}),
        json!({"type":"response.completed","response":{}}),
        json!({"type":"response.completed","response":{"output":[],"status":"failed"}}),
        json!({"type":"response.incomplete","response":{"output":[function()]}}),
        json!({"type":"response.failed"}),
        json!({"type":"error","error":{"message":"secret"}}),
    ] {
        let mut events = response_events();
        events.pop();
        events.push(terminal);
        assert!(stream(Protocol::Responses, events, true).is_err());
    }
    let mut events = response_events();
    events.pop();
    assert!(stream(Protocol::Responses, events, false).is_err());
}
#[test]
fn malformed_messages_never_authorize_tools() {
    let mut events = messages_events();
    events.pop();
    assert!(stream(Protocol::MessagesV1, events, false).is_err());
    let mut events = messages_events();
    events[15]["delta"]["stop_reason"] = json!("max_tokens");
    assert!(stream(Protocol::MessagesV1, events, false).is_err());
    let mut events = messages_events();
    events.retain(|e| e["delta"]["type"] != "signature_delta");
    assert!(stream(Protocol::MessagesV1, events, false).is_err());
    let mut events = messages_events();
    events.insert(
        16,
        json!({"type":"error","error":{"message":"upstream private body"}}),
    );
    assert!(stream(Protocol::MessagesV1, events, false).is_err());
}
#[test]
fn responses_mismatched_terminal_arguments_and_duplicate_call_ids_fail() {
    let mut events = response_events();
    events.last_mut().unwrap()["response"]["output"][1]["arguments"] =
        json!("{\"filePath\":\"different\"}");
    assert!(stream(Protocol::Responses, events, false).is_err());
    let events = vec![
        json!({"type":"response.completed","response":{"status":"completed","output":[function(),function()]}}),
    ];
    assert!(stream(Protocol::Responses, events, false).is_err());
    let mut invalid = function();
    invalid["arguments"] = json!("[1,2]");
    assert!(stream(
        Protocol::Responses,
        vec![json!({"type":"response.completed","response":{"output":[invalid]}})],
        false
    )
    .is_err());
}
#[test]
fn replay_is_protocol_model_bound_and_rejects_tampering() {
    let completion = stream(Protocol::Responses, response_events(), false).unwrap();
    let mut saved = assistant(&completion);
    let messages = vec![json!({"role":"user","content":"Inspect"}), saved.clone()];
    let request = body(
        Protocol::Responses,
        "different-model",
        &messages,
        &tools(),
        4096,
    )
    .unwrap();
    assert!(!request.to_string().contains("final-ciphertext"));
    let request = body(Protocol::MessagesV1, "fixture", &messages, &tools(), 4096).unwrap();
    assert!(!request.to_string().contains("final-ciphertext"));
    saved["tool_calls"][0]["function"]["name"] = json!("write");
    assert!(body(Protocol::Responses, "fixture", &[saved], &tools(), 4096).is_err());
}
#[test]
fn legacy_assistant_text_uses_valid_responses_easy_message() {
    let request = body(
        Protocol::Responses,
        "fixture",
        &[
            json!({"role":"user","content":"hello"}),
            json!({"role":"assistant","content":"answer"}),
        ],
        &tools(),
        4096,
    )
    .unwrap();
    assert_eq!(
        request["input"][1],
        json!({"role":"assistant","content":"answer"})
    );
}
#[test]
fn endpoint_routes_are_metadata_driven() {
    for (endpoints, expected) in [
        (json!(["/responses"]), Some(Protocol::Responses)),
        (json!(["/v1/messages"]), Some(Protocol::MessagesV1)),
        (json!(["/messages"]), Some(Protocol::Messages)),
        (
            json!(["/responses", "/chat/completions"]),
            Some(Protocol::Responses),
        ),
        (json!([]), None),
        (json!(["/embeddings"]), None),
        (Value::Null, None),
    ] {
        assert_eq!(
            Protocol::select(&json!({"supported_endpoints":endpoints})),
            expected
        );
    }
    assert_eq!(Protocol::select(&json!({})), Some(Protocol::Chat));
}
#[test]
fn empty_signed_thinking_with_valid_signature_is_preserved() {
    let completion=stream(Protocol::Messages,vec![json!({"type":"message_start","message":{"role":"assistant"}}),json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"signature"}}),json!({"type":"content_block_stop","index":0}),json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),json!({"type":"message_stop"})],false).unwrap();
    assert_eq!(
        completion.state.unwrap()["items"][0]["signature"],
        "signature"
    );
}
#[test]
fn sse_multiline_data_and_crlf_are_supported() {
    let input="event: response.completed\r\ndata: {\"type\":\"response.completed\",\r\ndata: \"response\":{\"status\":\"completed\",\"output\":[]}}\r\n\r\n";
    let mut decoder = Decoder::new(Protocol::Responses, "fixture");
    decoder.push(input.as_bytes()).unwrap();
    assert_eq!(decoder.finish().unwrap().reason, "stop");
}
#[test]
fn sparse_response_indexes_are_not_tool_ordinals() {
    let events = vec![
        json!({"type":"response.output_item.done","output_index":100,"item":function()}),
        json!({"type":"response.completed","response":{"output":[function()]}}),
    ];
    assert!(stream(Protocol::Responses, events, false).is_err());
    let mut d = Decoder::new(Protocol::Responses, "fixture");
    d.push(
        frame(json!({"type":"response.output_item.added","output_index":40,"item":function()}))
            .as_bytes(),
    )
    .unwrap();
    assert!(d.finish().is_err());
}

#[tokio::test]
async fn native_http_tool_roundtrips_preserve_wire_state() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::mpsc,
    };
    for protocol in [Protocol::Responses, Protocol::MessagesV1] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for round in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = Vec::new();
                let mut chunk = [0; 4096];
                let request = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    buffer.extend_from_slice(&chunk[..count]);
                    assert!(buffer.len() < 100_000);
                    if let Some(index) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers =
                            String::from_utf8_lossy(&buffer[..index]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap();
                        if buffer.len() >= index + 4 + length {
                            assert!(
                                headers.starts_with(&format!("post {} http/1.1", protocol.path()))
                            );
                            break serde_json::from_slice::<Value>(
                                &buffer[index + 4..index + 4 + length],
                            )
                            .unwrap();
                        }
                    }
                };
                if round == 1 {
                    match protocol {
                        Protocol::Responses => {
                            assert_eq!(
                                request["input"][1]["encrypted_content"],
                                "final-ciphertext"
                            );
                            assert_eq!(request["input"][3]["type"], "function_call_output");
                        }
                        _ => {
                            assert_eq!(
                                request["messages"][1]["content"][0]["signature"],
                                "signature-complete"
                            );
                            assert_eq!(
                                request["messages"][2]["content"][0]["tool_use_id"],
                                "call_1"
                            );
                        }
                    }
                }
                let events = if round == 0 {
                    if protocol == Protocol::Responses {
                        response_events()
                    } else {
                        messages_events()
                    }
                } else if protocol == Protocol::Responses {
                    vec![
                        json!({"type":"response.completed","response":{"status":"completed","output":[{"id":"answer","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done","annotations":[]}]}]}}),
                    ]
                } else {
                    vec![
                        json!({"type":"message_start","message":{"role":"assistant"}}),
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                        json!({"type":"message_stop"}),
                    ]
                };
                let payload = events
                    .into_iter()
                    .map(frame)
                    .collect::<String>()
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",payload.len()).as_bytes()).await.unwrap();
                for part in payload.as_bytes().chunks(7) {
                    socket.write_all(part).await.unwrap();
                }
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut messages = vec![
            json!({"role":"system","content":"Policy"}),
            json!({"role":"user","content":"Read a file"}),
        ];
        for round in 0..2 {
            let request = body(protocol, "fixture", &messages, &tools(), 8192).unwrap();
            let response = client
                .post(format!("http://{address}{}", protocol.path()))
                .json(&request)
                .send()
                .await
                .unwrap();
            let (tx, mut rx) = mpsc::channel(64);
            let completion = crate::provider::read_completion(
                response,
                protocol,
                "fixture",
                tokio_util::sync::CancellationToken::new(),
                tx,
            )
            .await
            .unwrap();
            while rx.try_recv().is_ok() {}
            if round == 0 {
                assert_eq!(completion.reason, "tool_calls");
                let id = completion.calls[0].id.clone();
                messages.push(assistant(&completion));
                messages.push(json!({"role":"tool","tool_call_id":id,"content":"file contents"}));
            } else {
                assert_eq!(completion.text, "done");
                assert!(completion.calls.is_empty());
            }
        }
        server.await.unwrap();
    }
}

#[test]
fn malformed_stream_items_return_errors_not_panics() {
    for item in [json!("bad"), json!([]), Value::Null] {
        assert!(stream(Protocol::Responses,vec![json!({"type":"response.output_item.added","output_index":0,"item":item}),json!({"type":"response.function_call_arguments.done","output_index":0,"arguments":"{}"})],false).is_err());
    }
    assert!(stream(Protocol::Responses,vec![json!({"type":"response.output_item.added","output_index":0,"item":{"id":"a","type":"message","content":[]}}),json!({"type":"response.function_call_arguments.done","output_index":0,"arguments":"{}"})],false).is_err());
}
#[test]
fn empty_sse_fields_are_bounded_across_chunks() {
    let mut decoder = Decoder::new(Protocol::Responses, "fixture");
    let mut failed = false;
    for _ in 0..10_000 {
        if decoder.push(b"data:\n").is_err() {
            failed = true;
            break;
        }
    }
    assert!(failed);
}
