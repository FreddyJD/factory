use super::*;
use crate::{
    provider::{Inference, InferenceResult},
    wire::{self, Protocol},
};
use futures_util::future::BoxFuture;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Mutex;

#[derive(Clone, Copy)]
enum Behavior {
    Normal,
    Overflow,
    PartialOverflow,
    Other,
    BadSummary,
    SummaryLength,
    SummaryTools,
    SummaryOversize,
    RepeatedOverflow,
}
struct Scripted {
    requests: Mutex<Vec<Vec<Value>>>,
    calls: AtomicUsize,
    behavior: Behavior,
}
impl Inference for Scripted {
    fn complete<'a>(
        &'a self,
        _: &'a str,
        messages: Vec<Value>,
        _: Vec<Value>,
        output: Option<usize>,
        _: &'a str,
        _: CancellationToken,
        deltas: mpsc::Sender<String>,
    ) -> BoxFuture<'a, InferenceResult> {
        Box::pin(async move {
            let summary = messages[0]["content"] == SUMMARY_SYSTEM;
            self.requests.lock().await.push(messages);
            if summary {
                assert!(output.is_some_and(|n| n <= 2048));
                match self.behavior {
                    Behavior::SummaryLength => {
                        return Ok(Completion {
                            reason: "length".into(),
                            ..Default::default()
                        })
                    }
                    Behavior::SummaryTools => {
                        return Ok(Completion {
                            reason: "stop".into(),
                            calls: vec![crate::provider::ToolCall {
                                id: "forbidden".into(),
                                name: "bash".into(),
                                arguments: "{}".into(),
                            }],
                            ..Default::default()
                        })
                    }
                    Behavior::SummaryOversize => {
                        return Ok(Completion {
                            reason: "stop".into(),
                            text: "too large".repeat(10_000),
                            ..Default::default()
                        })
                    }
                    _ => (),
                }
                return Ok(Completion {
                    text: if matches!(self.behavior, Behavior::BadSummary) { "" } else { "Checkpoint: edit completed; shell outcome uncertain. Verify worktree; next run tests." }.into(),
                    reason: "stop".into(), ..Default::default()
                });
            }
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            match self.behavior {
                Behavior::Overflow | Behavior::PartialOverflow if call == 0 => {
                    if matches!(self.behavior, Behavior::PartialOverflow) {
                        deltas.send("partial".into()).await.unwrap();
                    }
                    return Err(InferenceError::ContextOverflow);
                }
                Behavior::Other => return Err("unrelated failure".into()),
                Behavior::RepeatedOverflow => return Err(InferenceError::ContextOverflow),
                _ => (),
            }
            Ok(Completion {
                text: "Complete".into(),
                reason: "stop".into(),
                ..Default::default()
            })
        })
    }
}
fn provider(behavior: Behavior) -> Arc<Scripted> {
    Arc::new(Scripted {
        requests: Mutex::new(vec![]),
        calls: AtomicUsize::new(0),
        behavior,
    })
}
fn model() -> Model {
    Model {
        id: "fixture".into(),
        name: "Fixture".into(),
        context: 16_000,
    }
}
fn transcript(protocol: Protocol, rounds: usize, size: usize) -> Vec<Value> {
    let mut history =
        vec![json!({"role":"user","content":"Fix the bug; preserve existing changes"})];
    for index in 0..rounds {
        let id = format!("call_{index}");
        let mut message = json!({"role":"assistant","content":"","tool_calls":[{"id":id,"type":"function","function":{"name":"bash","arguments":"{}"}}]});
        if protocol != Protocol::Chat {
            let items = if protocol == Protocol::Responses {
                vec![
                    json!({"type":"reasoning","encrypted_content":format!("cipher-{index}")}),
                    json!({"type":"function_call","call_id":id,"name":"bash","arguments":"{}","status":"completed"}),
                ]
            } else {
                vec![
                    json!({"type":"thinking","thinking":"private","signature":format!("signature-{index}")}),
                    json!({"type":"tool_use","id":id,"name":"bash","input":{}}),
                ]
            };
            message["provider_state"] = json!({"version":1,"provider":"github-copilot","protocol":protocol.label(),"model":"fixture","items":items});
        }
        history.push(message);
        history.push(json!({"role":"tool","tool_call_id":id,"content":format!("{}\nInterrupted; outcome may be unknown. Do not automatically replay.", "output".repeat(size))}));
    }
    history
}

#[test]
fn estimates_tokens_not_bytes_and_honors_large_and_small_windows() {
    let history = transcript(Protocol::Chat, 6, 7100);
    assert!(serde_json::to_vec(&history).unwrap().len() > 250_000);
    let result = project(&history, "policy", 128_000, &[]).unwrap();
    assert_eq!(&result[1..], &history);
    let small = project(
        &[json!({"role":"user","content":"hi"})],
        "policy",
        1024,
        &[],
    )
    .unwrap();
    assert!(fits(&small, &[], Limits::window(1024).budget()).unwrap());
    assert_eq!(Limits::window(1024).output, 256);
    assert!(project(&history, "policy", 32_000, &[]).is_err());
}

#[test]
fn inspection_projection_keeps_actions_questions_calls_and_unicode_intact() {
    let mut history = transcript(Protocol::Responses, 1, 200);
    history[1]["tool_calls"][0]["function"]["name"] = json!("read");
    history[1]["provider_state"]["items"][1]["name"] = json!("read");
    history[2]["content"] = json!("\u{20ac}".repeat(30_000));
    history.extend(transcript(Protocol::Responses, 1, 1000).into_iter().skip(1));
    history[3]["tool_calls"][0]["id"] = json!("newest");
    history[3]["provider_state"]["items"][1]["call_id"] = json!("newest");
    history[4]["tool_call_id"] = json!("newest");
    let original = history.clone();
    let result = project(&history, "policy", 16_000, &[]).unwrap();
    assert_eq!(history, original);
    assert_eq!(result[2], history[1]);
    assert!(result[3]["content"]
        .as_str()
        .unwrap()
        .starts_with(&"\u{20ac}".repeat(682)));
    assert!(result[3]["content"]
        .as_str()
        .unwrap()
        .contains("Factory context limit"));
    assert_eq!(&result[4..], &history[3..]);
    wire::body(Protocol::Responses, "fixture", &result, &[], 4096).unwrap();
    for name in ["question", "edit", "bash", "skill", "mcp_external"] {
        let mut action = transcript(Protocol::Chat, 1, 30_000);
        action[1]["tool_calls"][0]["function"]["name"] = json!(name);
        assert!(project(&action, "policy", 16_000, &[]).is_err());
    }
}

#[test]
fn image_accounting_excludes_base64_and_reports_actual_attachment_limits() {
    let image = json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "A".repeat(400_000))}});
    let message = json!({"role":"user","content":[image]});
    let (tokens, count, bytes) = cost(&message).unwrap();
    assert!(tokens < 9000);
    assert_eq!((count, bytes), (1, 300_000));
    assert!(project(std::slice::from_ref(&message), "policy", 32_000, &[]).is_ok());
    let error = project(
        &[json!({"role":"user","content":vec![image; 5]})],
        "policy",
        100_000,
        &[],
    )
    .unwrap_err();
    assert!(error.contains("5 images"));
    let image = json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "AAAA".repeat(images::MAX_TOTAL / 3 + 1))}});
    assert!(project(
        &[json!({"role":"user","content":[image]})],
        "policy",
        100_000,
        &[]
    )
    .unwrap_err()
    .contains("decoded bytes"));
}

#[test]
fn checkpoint_boundaries_reject_pending_or_orphan_results() {
    let history = transcript(Protocol::Chat, 2, 1);
    assert_eq!(boundaries(&history).unwrap(), vec![1, 3, 5]);
    assert!(boundaries(&history[..4]).is_err());
    assert!(boundaries(&history[2..]).is_err());
    let mut malformed = history.clone();
    malformed[2]["tool_call_id"] = json!("unknown");
    assert!(boundaries(&malformed).is_err());
}

#[tokio::test]
async fn action_heavy_turns_compact_across_every_wire_without_losing_latest_batch() {
    for protocol in [
        Protocol::Chat,
        Protocol::Responses,
        Protocol::Messages,
        Protocol::MessagesV1,
    ] {
        let scripted = provider(Behavior::Normal);
        let provider: Provider = scripted.clone();
        let history = transcript(protocol, 8, 2000);
        let original = history.clone();
        let mut memory = Memory::default();
        let request = prepare(
            &provider,
            &model(),
            &history,
            "policy",
            &[],
            &mut memory,
            Limits::window(16_000),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(memory.covered, history.len() - 2);
        assert_eq!(history, original);
        assert!(fits(&request, &[], Limits::window(16_000).budget()).unwrap());
        assert!(request.contains(&history[0]));
        assert_eq!(&request[request.len() - 2..], &history[history.len() - 2..]);
        let payload = wire::body(protocol, "fixture", &request, &[], 4096)
            .unwrap()
            .to_string();
        assert_eq!(
            payload.matches("cipher-").count(),
            usize::from(protocol == Protocol::Responses)
        );
        assert_eq!(
            payload.matches("signature-").count(),
            usize::from(matches!(
                protocol,
                Protocol::Messages | Protocol::MessagesV1
            ))
        );
        for messages in scripted.requests.lock().await.iter() {
            assert!(fits(messages, &[], Limits::window(16_000).budget()).unwrap());
            let text = serde_json::to_string(messages).unwrap();
            assert!(!text.contains("cipher-"));
            assert!(!text.contains("signature-"));
        }
        // Checkpoint survives serialization and the next unanswered user is never covered.
        let mut loaded: Memory =
            serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
        let mut next = history.clone();
        next.push(json!({"role":"user","content":"Now verify the fix"}));
        let before = scripted.requests.lock().await.len();
        let request = prepare(
            &provider,
            &model(),
            &next,
            "policy",
            &[],
            &mut loaded,
            Limits::window(16_000),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(request.last(), next.last());
        assert_eq!(scripted.requests.lock().await.len(), before);
    }
}

#[tokio::test]
async fn oversized_latest_transaction_starts_a_clean_continuation() {
    let scripted = provider(Behavior::Normal);
    let provider: Provider = scripted;
    let history = transcript(Protocol::Messages, 1, 20_000);
    let mut memory = Memory::default();
    let result = prepare(
        &provider,
        &model(),
        &history,
        "policy",
        &[],
        &mut memory,
        Limits::window(16_000),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(memory.covered, history.len());
    assert_eq!(result.last(), history.first());
    assert!(!result
        .iter()
        .any(|m| m["role"] == "tool" || m["role"] == "assistant"));
    wire::body(Protocol::Messages, "fixture", &result, &[], 4096).unwrap();
}

#[tokio::test]
async fn invalid_summaries_and_cancellation_never_advance_memory() {
    let history = transcript(Protocol::Chat, 4, 5000);
    let mut memory = Memory::default();
    for behavior in [
        Behavior::BadSummary,
        Behavior::SummaryLength,
        Behavior::SummaryTools,
        Behavior::SummaryOversize,
    ] {
        let provider: Provider = provider(behavior);
        assert!(prepare(
            &provider,
            &model(),
            &history,
            "policy",
            &[],
            &mut memory,
            Limits::window(16_000),
            CancellationToken::new()
        )
        .await
        .unwrap_err()
        .contains("checkpoint"));
        assert_eq!(memory.covered, 0);
        assert!(memory.summary.is_empty());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            prepare(
                &provider,
                &model(),
                &history,
                "policy",
                &[],
                &mut memory,
                Limits::window(16_000),
                cancel
            )
            .await
            .unwrap_err(),
            "Cancelled"
        );
        assert_eq!(memory.covered, 0);
    }
}

#[tokio::test]
async fn retries_only_clean_context_rejection_once_with_smaller_request() {
    for behavior in [
        Behavior::Overflow,
        Behavior::PartialOverflow,
        Behavior::Other,
        Behavior::RepeatedOverflow,
    ] {
        let scripted = provider(behavior);
        let provider: Provider = scripted.clone();
        let history = transcript(Protocol::Chat, 3, 1000);
        let original = history.clone();
        let (sender, mut receiver) = mpsc::channel(64);
        let result = complete(
            &provider,
            &model(),
            &history,
            "policy",
            &[],
            &mut Memory::default(),
            "user",
            CancellationToken::new(),
            sender,
        )
        .await;
        assert_eq!(history, original);
        let requests = scripted.requests.lock().await;
        let main: Vec<_> = requests
            .iter()
            .filter(|m| m[0]["content"] != SUMMARY_SYSTEM)
            .collect();
        if matches!(behavior, Behavior::Overflow) {
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(main.len(), 2);
            assert!(total(main[1], &[]).unwrap().0 < total(main[0], &[]).unwrap().0);
        } else {
            assert!(result.is_err());
            assert_eq!(
                main.len(),
                if matches!(behavior, Behavior::RepeatedOverflow) {
                    2
                } else {
                    1
                }
            );
        }
        if matches!(behavior, Behavior::PartialOverflow) {
            assert_eq!(receiver.recv().await.unwrap(), "partial");
        }
    }
}

#[tokio::test]
async fn irreducible_input_and_schemas_fail_before_summarizing_or_sending() {
    let scripted = provider(Behavior::Normal);
    let provider: Provider = scripted.clone();
    for (input, tools) in [
        ("x".repeat(60_000), vec![]),
        (
            "hello".into(),
            vec![json!({"description":"schema".repeat(20_000)})],
        ),
    ] {
        let error = prepare(
            &provider,
            &model(),
            &[json!({"role":"user","content":input})],
            "policy",
            &tools,
            &mut Memory::default(),
            Limits::window(16_000),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("latest user input"));
    }
    assert!(scripted.requests.lock().await.is_empty());
}
