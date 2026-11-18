use crate::{
    provider::{Completion, ToolCall},
    workspace::Result,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_STATE: usize = 4_000_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Chat,
    Responses,
    MessagesV1,
    Messages,
}
impl Protocol {
    pub fn path(self) -> &'static str {
        match self {
            Self::Chat => "/chat/completions",
            Self::Responses => "/responses",
            Self::MessagesV1 => "/v1/messages",
            Self::Messages => "/messages",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::MessagesV1 | Self::Messages => "messages",
        }
    }
    pub fn select(metadata: &Value) -> Option<Self> {
        let Some(endpoints) = metadata.get("supported_endpoints") else {
            return Some(Self::Chat);
        };
        let endpoints = endpoints.as_array()?;
        [
            Self::MessagesV1,
            Self::Messages,
            Self::Responses,
            Self::Chat,
        ]
        .into_iter()
        .find(|p| endpoints.iter().any(|e| e == p.path()))
    }
}

pub fn assistant(completion: &Completion) -> Value {
    let mut message = json!({"role":"assistant","content":completion.text});
    if let Some(opaque) = &completion.opaque {
        message["reasoning_opaque"] = opaque.clone();
    }
    if let Some(state) = &completion.state {
        message["provider_state"] = state.clone();
    }
    if !completion.calls.is_empty() {
        message["tool_calls"]=json!(completion.calls.iter().map(|c|json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.arguments}})).collect::<Vec<_>>());
    }
    message
}

pub fn chat_messages(messages: &[Value], copilot: bool) -> Vec<Value> {
    messages
        .iter()
        .cloned()
        .map(|mut message| {
            if let Some(object) = message.as_object_mut() {
                object.remove("provider_state");
                if !copilot {
                    object.remove("reasoning_opaque");
                }
            }
            message
        })
        .collect()
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Provider {key} is missing or invalid"))
}
fn user_content(message: &Value, protocol: Protocol) -> Result<Vec<Value>> {
    let parts = if let Some(text) = message["content"].as_str() {
        vec![json!({"type":"text","text":text})]
    } else {
        message["content"]
            .as_array()
            .ok_or("Invalid user content")?
            .clone()
    };
    parts
        .iter()
        .map(|part| match part["type"].as_str() {
            Some("text") => Ok(if protocol == Protocol::Responses {
                json!({"type":"input_text","text":string(part,"text")?})
            } else {
                json!({"type":"text","text":string(part,"text")?})
            }),
            Some("image_url") => {
                let url = string(&part["image_url"], "url")?;
                let (mime, data) = crate::images::data(url)?;
                Ok(if protocol == Protocol::Responses {
                    json!({"type":"input_image","image_url":url})
                } else {
                    json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
                })
            }
            _ => Err("Unsupported user content part".into()),
        })
        .collect()
}
fn object_arguments(value: &str) -> Result<Value> {
    let parsed: Value =
        serde_json::from_str(value).map_err(|_| "Provider tool arguments are not complete JSON")?;
    if !parsed.is_object() {
        return Err("Provider tool arguments must be a JSON object".into());
    }
    Ok(parsed)
}
fn validate_calls(calls: &[ToolCall]) -> Result<()> {
    if calls.len() > 32 {
        return Err("Provider returned more than 32 tools in one response".into());
    }
    let mut ids = HashSet::new();
    for call in calls {
        if call.id.is_empty()
            || call.id.len() > 256
            || call.name.is_empty()
            || call.name.len() > 128
            || call.arguments.len() > 1_000_000
            || !ids.insert(&call.id)
        {
            return Err("Provider returned invalid or duplicate tool calls".into());
        }
        object_arguments(&call.arguments)?;
    }
    Ok(())
}
fn canonical_calls(message: &Value) -> Result<Vec<ToolCall>> {
    let mut result = Vec::new();
    for call in message["tool_calls"].as_array().into_iter().flatten() {
        result.push(ToolCall {
            id: string(call, "id")?.into(),
            name: string(&call["function"], "name")?.into(),
            arguments: string(&call["function"], "arguments")?.into(),
        });
    }
    validate_calls(&result)?;
    Ok(result)
}

fn normalize(protocol: Protocol, items: &[Value]) -> Result<(String, Vec<ToolCall>)> {
    if items.len() > 256 || serde_json::to_vec(items).map_err(|e| e.to_string())?.len() > MAX_STATE
    {
        return Err("Provider continuation state exceeds limits".into());
    }
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in items {
        match (protocol, string(item, "type")?) {
            (Protocol::Responses, "message") => {
                if item["role"] != "assistant" {
                    return Err("Unexpected Responses message role".into());
                }
                for part in item["content"]
                    .as_array()
                    .ok_or("Missing Responses message content")?
                {
                    match part["type"].as_str() {
                        Some("output_text") => text.push_str(string(part, "text")?),
                        Some("refusal") => return Err("The model refused this request".into()),
                        _ => return Err("Unsupported Responses output content".into()),
                    }
                }
            }
            (Protocol::Responses, "function_call") => {
                if item["status"].as_str().is_some_and(|s| s != "completed") {
                    return Err("Responses tool is not completed".into());
                }
                calls.push(ToolCall {
                    id: string(item, "call_id")?.into(),
                    name: string(item, "name")?.into(),
                    arguments: string(item, "arguments")?.into(),
                });
            }
            (Protocol::Responses, "reasoning") => {}
            (Protocol::Messages | Protocol::MessagesV1, "text") => {
                text.push_str(string(item, "text")?)
            }
            (Protocol::Messages | Protocol::MessagesV1, "tool_use") => {
                let input = item.get("input").ok_or("Messages tool input missing")?;
                if !input.is_object() {
                    return Err("Messages tool input must be an object".into());
                }
                calls.push(ToolCall {
                    id: string(item, "id")?.into(),
                    name: string(item, "name")?.into(),
                    arguments: input.to_string(),
                });
            }
            (Protocol::Messages | Protocol::MessagesV1, "thinking") => {
                string(item, "thinking")?;
                if string(item, "signature")?.is_empty() {
                    return Err("Thinking block signature is incomplete".into());
                }
            }
            (Protocol::Messages | Protocol::MessagesV1, "redacted_thinking") => {
                if string(item, "data")?.is_empty() {
                    return Err("Redacted thinking data is incomplete".into());
                }
            }
            _ => {
                return Err(
                    "The provider returned an unsupported output item; no tools executed".into(),
                )
            }
        }
    }
    if text.len() > 2_000_000 {
        return Err("Provider output exceeds 2 MB".into());
    }
    validate_calls(&calls)?;
    Ok((text, calls))
}
fn replay<'a>(
    protocol: Protocol,
    model: &str,
    message: &'a Value,
) -> Result<Option<&'a Vec<Value>>> {
    let Some(state) = message.get("provider_state") else {
        return Ok(None);
    };
    if state["provider"] != "github-copilot"
        || state["model"] != model
        || state["protocol"] != protocol.label()
    {
        return Ok(None);
    }
    if state["version"] != 1 {
        return Err("Unknown provider continuation state version".into());
    }
    let items = state["items"]
        .as_array()
        .ok_or("Invalid provider continuation items")?;
    let (text, calls) = normalize(protocol, items)?;
    let expected = canonical_calls(message)?;
    if message["content"].as_str().unwrap_or("") != text
        || calls.len() != expected.len()
        || calls.iter().zip(expected).any(|(a, b)| {
            a.id != b.id
                || a.name != b.name
                || object_arguments(&a.arguments).ok() != object_arguments(&b.arguments).ok()
        })
    {
        return Err("Provider continuation state does not match the saved assistant turn".into());
    }
    Ok(Some(items))
}

pub fn body(
    protocol: Protocol,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    output: usize,
) -> Result<Value> {
    match protocol {
        Protocol::Chat => Ok(
            json!({"model":model,"messages":chat_messages(messages,true),"tools":tools,"stream":true}),
        ),
        Protocol::Responses => {
            let mut input = Vec::new();
            let mut instructions = Vec::new();
            for message in messages {
                match string(message,"role")?{
                "system"=>instructions.push(string(message,"content")?.to_string()),
                "user"=>input.push(json!({"role":"user","content":user_content(message, protocol)?})),
                "assistant"=>if let Some(items)=replay(protocol,model,message)?{input.extend(items.clone());}else{
                    if let Some(text)=message["content"].as_str().filter(|s|!s.is_empty()){input.push(json!({"role":"assistant","content":text}));}
                    for call in canonical_calls(message)?{input.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments}));}
                },
                "tool"=>input.push(json!({"type":"function_call_output","call_id":string(message,"tool_call_id")?,"output":string(message,"content")?})),
                _=>return Err("Unsupported role in Responses history".into()),
            }
            }
            let tools=tools.iter().map(|t|{let f=&t["function"];json!({"type":"function","name":f["name"],"description":f["description"],"parameters":f["parameters"],"strict":false})}).collect::<Vec<_>>();
            Ok(
                json!({"model":model,"instructions":instructions.join("\n\n"),"input":input,"tools":tools,"tool_choice":"auto","store":false,"include":["reasoning.encrypted_content"],"max_output_tokens":output,"stream":true}),
            )
        }
        Protocol::Messages | Protocol::MessagesV1 => {
            let mut system = Vec::new();
            let mut translated = Vec::<Value>::new();
            for message in messages {
                let role = string(message, "role")?;
                let (role, blocks) = match role {
                    "system" => {
                        system.push(json!({"type":"text","text":string(message,"content")?}));
                        continue;
                    }
                    "user" => ("user", user_content(message, protocol)?),
                    "tool" => (
                        "user",
                        vec![
                            json!({"type":"tool_result","tool_use_id":string(message,"tool_call_id")?,"content":string(message,"content")?}),
                        ],
                    ),
                    "assistant" => {
                        let blocks = if let Some(items) = replay(protocol, model, message)? {
                            items.clone()
                        } else {
                            let mut blocks = Vec::new();
                            if let Some(text) =
                                message["content"].as_str().filter(|s| !s.is_empty())
                            {
                                blocks.push(json!({"type":"text","text":text}));
                            }
                            for call in canonical_calls(message)? {
                                blocks.push(json!({"type":"tool_use","id":call.id,"name":call.name,"input":object_arguments(&call.arguments)?}));
                            }
                            blocks
                        };
                        ("assistant", blocks)
                    }
                    _ => return Err("Unsupported role in Messages history".into()),
                };
                if blocks.is_empty() {
                    continue;
                }
                if let Some(previous) = translated.last_mut().filter(|m| m["role"] == role) {
                    previous["content"]
                        .as_array_mut()
                        .ok_or("Invalid Messages history")?
                        .extend(blocks);
                } else {
                    translated.push(json!({"role":role,"content":blocks}));
                }
            }
            let tools = tools
                .iter()
                .map(|t| {
                    let f = &t["function"];
                    let mut schema = f["parameters"].clone();
                    if let Some(object) = schema.as_object_mut() {
                        object.remove("$schema");
                        object.entry("type").or_insert(json!("object"));
                        object.entry("properties").or_insert(json!({}));
                    }
                    json!({"name":f["name"],"description":f["description"],"input_schema":schema})
                })
                .collect::<Vec<_>>();
            Ok(
                json!({"model":model,"system":system,"messages":translated,"tools":tools,"max_tokens":output,"stream":true}),
            )
        }
    }
}

#[derive(Default)]
struct Frames {
    buffer: Vec<u8>,
    data: Vec<String>,
    event: String,
    size: usize,
}
impl Frames {
    fn push(&mut self, bytes: &[u8], eof: bool) -> Result<Vec<(String, String)>> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() + self.size > MAX_STATE {
            return Err("Provider stream frame exceeds 4 MB".into());
        }
        let mut events = Vec::new();
        while let Some(index) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=index).collect();
            self.line(&line, &mut events)?;
        }
        if eof {
            let tail = std::mem::take(&mut self.buffer);
            if !tail.is_empty() {
                self.line(&tail, &mut events)?;
            }
            self.line(b"\n", &mut events)?;
        }
        Ok(events)
    }
    fn line(&mut self, line: &[u8], events: &mut Vec<(String, String)>) -> Result<()> {
        self.size = self.size.saturating_add(line.len() + 1);
        if self.size > MAX_STATE || self.data.len() > 8192 {
            return Err("Provider frame exceeds limits".into());
        }
        let line = std::str::from_utf8(line)
            .map_err(|_| "Invalid provider stream UTF-8")?
            .trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push((std::mem::take(&mut self.event), self.data.join("\n")));
                self.data.clear();
            }
            self.size = 0;
            self.event.clear();
            return Ok(());
        }
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            self.data.push(data.into());
        } else if let Some(event) = line.strip_prefix("event:") {
            self.event = event.trim().into();
        }
        Ok(())
    }
}

struct Item {
    value: Value,
    closed: bool,
    arguments: String,
    fragments: bool,
}
pub struct Decoder {
    protocol: Protocol,
    model: String,
    frames: Frames,
    items: BTreeMap<usize, Item>,
    reason: Option<String>,
    terminal: bool,
    emitted: String,
    aggregate: usize,
}
impl Decoder {
    pub fn new(protocol: Protocol, model: &str) -> Self {
        Self {
            protocol,
            model: model.into(),
            frames: Frames::default(),
            items: BTreeMap::new(),
            reason: None,
            terminal: false,
            emitted: String::new(),
            aggregate: 0,
        }
    }
    pub fn done(&self) -> bool {
        self.terminal
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.consume(bytes, false)
    }
    pub fn end(&mut self) -> Result<Vec<String>> {
        self.consume(&[], true)
    }
    fn consume(&mut self, bytes: &[u8], eof: bool) -> Result<Vec<String>> {
        if self.terminal {
            return Ok(Vec::new());
        }
        let mut deltas = Vec::new();
        for (event_name, data) in self.frames.push(bytes, eof)? {
            if self.terminal {
                break;
            }
            if data == "[DONE]" {
                continue;
            }
            let mut value: Value =
                serde_json::from_str(&data).map_err(|_| "Malformed provider stream JSON")?;
            if !value.is_object() {
                return Err("Provider stream event must be an object".into());
            }
            if value.get("type").is_none() && !event_name.is_empty() {
                value["type"] = json!(event_name);
            }
            if value.get("error").is_some() || value["type"] == "error" {
                return Err("Inference provider returned a stream error; no tools executed".into());
            }
            match self.protocol {
                Protocol::Responses => self.responses(&value)?,
                Protocol::Messages | Protocol::MessagesV1 => self.messages(&value)?,
                Protocol::Chat => return Err("Wrong stream decoder".into()),
            }
            self.aggregate = self
                .items
                .values()
                .map(|item| item.value.to_string().len() + item.arguments.len())
                .sum();
            if self.aggregate > MAX_STATE {
                return Err("Provider output state exceeds 4 MB".into());
            }
            let text = self.text()?;
            if !text.starts_with(&self.emitted) {
                return Err("Provider changed text that was already streamed".into());
            }
            if text.len() > self.emitted.len() {
                deltas.push(text[self.emitted.len()..].to_string());
                self.emitted = text;
            }
        }
        Ok(deltas)
    }
    fn index(value: &Value) -> Result<usize> {
        let index = value.as_u64().ok_or("Provider item index missing")? as usize;
        if index >= 256 {
            return Err("Provider item index exceeds limit".into());
        }
        Ok(index)
    }
    fn text(&self) -> Result<String> {
        let mut text = String::new();
        for item in self.items.values() {
            match (self.protocol, item.value["type"].as_str()) {
                (Protocol::Responses, Some("message")) => {
                    for content in item.value["content"].as_array().into_iter().flatten() {
                        if content["type"] == "output_text" {
                            text.push_str(string(content, "text")?);
                        }
                    }
                }
                (Protocol::Messages | Protocol::MessagesV1, Some("text")) => {
                    text.push_str(string(&item.value, "text")?)
                }
                _ => {}
            }
        }
        if text.len() > 2_000_000 {
            return Err("Provider text exceeds limits".into());
        }
        Ok(text)
    }
    fn responses(&mut self, value: &Value) -> Result<()> {
        match string(value, "type")? {
            "response.output_item.added" => {
                let index = Self::index(&value["output_index"])?;
                if self.items.contains_key(&index) {
                    return Err("Duplicate Responses output item".into());
                }
                if !value["item"].is_object() {
                    return Err("Responses output item must be an object".into());
                }
                self.items.insert(
                    index,
                    Item {
                        value: value["item"].clone(),
                        closed: false,
                        arguments: String::new(),
                        fragments: false,
                    },
                );
            }
            "response.function_call_arguments.delta" => {
                let item = self.response_item(value)?;
                if item.value["type"] != "function_call" {
                    return Err("Argument delta targeted a non-tool item".into());
                }
                item.arguments.push_str(string(value, "delta")?);
                item.fragments = true;
                if item.arguments.len() > 1_000_000 {
                    return Err("Tool arguments exceed limit".into());
                }
            }
            "response.function_call_arguments.done" => {
                let item = self.response_item(value)?;
                if item.value["type"] != "function_call" {
                    return Err("Argument snapshot targeted a non-tool item".into());
                }
                let arguments = string(value, "arguments")?;
                if item.fragments && item.arguments != arguments {
                    return Err(
                        "Responses argument snapshot differs from streamed arguments".into(),
                    );
                }
                item.value["arguments"] = json!(arguments);
            }
            "response.output_text.delta" => {
                let index = Self::index(&value["content_index"])?;
                let item = self.response_item(value)?;
                if item.value["type"] != "message" {
                    return Err("Text delta targeted a non-message item".into());
                }
                let parts = item.value["content"]
                    .as_array_mut()
                    .ok_or("Missing message content")?;
                while parts.len() <= index {
                    parts.push(json!({"type":"output_text","text":""}));
                }
                let text = parts[index]["text"]
                    .as_str()
                    .ok_or("Invalid text part")?
                    .to_string();
                parts[index]["text"] = json!(text + string(value, "delta")?);
            }
            "response.output_text.done" => {
                let index = Self::index(&value["content_index"])?;
                let item = self.response_item(value)?;
                let text = string(value, "text")?;
                if let Some(previous) = item.value["content"][index]["text"].as_str() {
                    if previous != text {
                        return Err("Responses final text differs from streamed text".into());
                    }
                }
            }
            "response.content_part.added" => {
                let index = Self::index(&value["content_index"])?;
                let item = self.response_item(value)?;
                let parts = item.value["content"]
                    .as_array_mut()
                    .ok_or("Missing message content")?;
                if index < parts.len() {
                    return Err("Duplicate Responses content part".into());
                }
                if index != parts.len() {
                    return Err("Out-of-order Responses content part".into());
                }
                parts.push(value["part"].clone());
            }
            "response.output_item.done" => {
                let index = Self::index(&value["output_index"])?;
                let final_item = value["item"].clone();
                if !final_item.is_object() {
                    return Err("Invalid completed Responses item".into());
                }
                if let Some(previous) = self.items.get(&index) {
                    if previous.closed {
                        return Err("Responses output item closed twice".into());
                    }
                    Self::reconcile(previous, &final_item)?;
                }
                self.items.insert(
                    index,
                    Item {
                        value: final_item,
                        closed: true,
                        arguments: String::new(),
                        fragments: false,
                    },
                );
            }
            "response.completed" => {
                if !value["response"].is_object() || !value["response"]["output"].is_array() {
                    return Err("Responses completion is missing its final output snapshot".into());
                }
                if value["response"]["error"].is_object()
                    || value["response"]["status"]
                        .as_str()
                        .is_some_and(|s| s != "completed")
                {
                    return Err("Responses did not complete successfully".into());
                }
                if let Some(output) = value["response"]["output"].as_array() {
                    if output.len() > 256 {
                        return Err("Too many Responses output items".into());
                    }
                    for (index, final_item) in output.iter().enumerate() {
                        if let Some(previous) = self.items.get(&index) {
                            Self::reconcile(previous, final_item)?;
                        }
                        self.items.insert(
                            index,
                            Item {
                                value: final_item.clone(),
                                closed: true,
                                arguments: String::new(),
                                fragments: false,
                            },
                        );
                    }
                    if self.items.len() != output.len() {
                        return Err("Responses terminal output omitted streamed items".into());
                    }
                }
                if self.items.values().any(|item| !item.closed) {
                    return Err("Responses contains unclosed output items".into());
                }
                self.terminal = true;
                self.reason = Some("completed".into());
            }
            "response.failed" | "response.incomplete" => {
                return Err(
                    "Responses request failed or exhausted its output budget; no tools executed"
                        .into(),
                )
            }
            _ => {}
        }
        Ok(())
    }
    fn response_item(&mut self, value: &Value) -> Result<&mut Item> {
        let index = Self::index(&value["output_index"])?;
        let item = self
            .items
            .get_mut(&index)
            .ok_or("Responses delta preceded its output item")?;
        if item.closed {
            return Err("Responses delta follows a closed item".into());
        }
        if value.get("item_id").is_some() && value["item_id"] != item.value["id"] {
            return Err("Responses item identity changed".into());
        }
        Ok(item)
    }
    fn reconcile(previous: &Item, final_item: &Value) -> Result<()> {
        if previous.value["id"] != final_item["id"] || previous.value["type"] != final_item["type"]
        {
            return Err("Responses item identity changed".into());
        }
        // The terminal snapshot owns metadata such as encrypted reasoning and logprobs.
        // Validate the completed payload, not byte-for-byte equality of the whole item.
        if previous.closed && previous.value["type"] == "message" {
            let before = previous.value["content"]
                .as_array()
                .ok_or("Missing Responses message content")?;
            let after = final_item["content"]
                .as_array()
                .ok_or("Missing Responses message content")?;
            if previous.value["role"] != final_item["role"]
                || before.len() != after.len()
                || before.iter().zip(after).any(|(a, b)| {
                    a["type"] != b["type"] || a["text"] != b["text"] || a["refusal"] != b["refusal"]
                })
            {
                return Err("Responses completed message changed in terminal snapshot".into());
            }
        }
        if previous.value["type"] == "function_call" {
            if previous.value["call_id"] != final_item["call_id"]
                || previous.value["name"] != final_item["name"]
            {
                return Err("Responses tool identity changed".into());
            }
            if (previous.closed && previous.value["arguments"] != final_item["arguments"])
                || (previous.fragments
                    && previous.arguments != final_item["arguments"].as_str().unwrap_or(""))
                || (!previous.fragments
                    && previous.value["arguments"].as_str().is_some_and(|s| {
                        !s.is_empty() && Some(s) != final_item["arguments"].as_str()
                    }))
            {
                return Err("Responses final arguments differ from streamed arguments".into());
            }
        }
        Ok(())
    }
    fn messages(&mut self, value: &Value) -> Result<()> {
        match string(value, "type")? {
            "content_block_start" => {
                if !value["content_block"].is_object() {
                    return Err("Messages content block must be an object".into());
                }
                let index = Self::index(&value["index"])?;
                if self.items.contains_key(&index) {
                    return Err("Duplicate Messages content block".into());
                }
                self.items.insert(
                    index,
                    Item {
                        value: value["content_block"].clone(),
                        closed: false,
                        arguments: String::new(),
                        fragments: false,
                    },
                );
            }
            "content_block_delta" => {
                let index = Self::index(&value["index"])?;
                let item = self
                    .items
                    .get_mut(&index)
                    .ok_or("Messages delta preceded its block")?;
                if item.closed {
                    return Err("Messages delta followed a closed block".into());
                }
                let delta = &value["delta"];
                match string(delta, "type")? {
                    "input_json_delta" => {
                        if item.value["type"] != "tool_use" {
                            return Err("JSON delta targeted a non-tool block".into());
                        }
                        item.arguments.push_str(string(delta, "partial_json")?);
                        item.fragments = true;
                        if item.arguments.len() > 1_000_000 {
                            return Err("Messages tool arguments exceed limits".into());
                        }
                    }
                    "text_delta" | "thinking_delta" | "signature_delta" => {
                        let (kind, key) = match delta["type"].as_str() {
                            Some("text_delta") => ("text", "text"),
                            Some("thinking_delta") => ("thinking", "thinking"),
                            _ => ("thinking", "signature"),
                        };
                        if item.value["type"] != kind {
                            return Err("Messages delta targeted the wrong content block".into());
                        }
                        let previous = item.value[key].as_str().unwrap_or("");
                        item.value[key] = json!(previous.to_string() + string(delta, key)?);
                    }
                    _ => return Err("Unsupported Messages content delta".into()),
                }
            }
            "content_block_stop" => {
                let index = Self::index(&value["index"])?;
                let item = self
                    .items
                    .get_mut(&index)
                    .ok_or("Messages closed an unknown block")?;
                if item.closed {
                    return Err("Messages block closed twice".into());
                }
                if item.value["type"] == "tool_use" && item.fragments {
                    item.value["input"] = object_arguments(&item.arguments)?;
                }
                item.closed = true;
            }
            "message_delta" => {
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.reason = Some(reason.into());
                }
            }
            "message_stop" => {
                if self.items.values().any(|i| !i.closed) {
                    return Err("Messages ended with an unclosed block".into());
                }
                if self.reason.is_none() {
                    return Err("Messages stop reason missing".into());
                }
                self.terminal = true;
            }
            "message_start" | "ping" => {}
            _ => {}
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Completion> {
        if !self.terminal {
            return Err("Incomplete inference stream; no tools executed".into());
        }
        let items: Vec<_> = self.items.into_values().map(|item| item.value).collect();
        let (text, calls) = normalize(self.protocol, &items)?;
        let reason =
            match self.protocol {
                Protocol::Responses => {
                    if calls.is_empty() {
                        "stop"
                    } else {
                        "tool_calls"
                    }
                }
                _ => match self.reason.as_deref() {
                    Some("tool_use") if !calls.is_empty() => "tool_calls",
                    Some("end_turn" | "stop_sequence") if calls.is_empty() => "stop",
                    Some("max_tokens") if calls.is_empty() => "length",
                    _ => return Err(
                        "Messages stopped without a complete executable turn; no tools executed"
                            .into(),
                    ),
                },
            };
        Ok(Completion {
            text,
            calls,
            reason: reason.into(),
            opaque: None,
            state: Some(
                json!({"version":1,"provider":"github-copilot","protocol":self.protocol.label(),"model":self.model,"items":items}),
            ),
        })
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
