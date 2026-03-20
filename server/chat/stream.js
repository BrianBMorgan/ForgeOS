"use strict";
/**
 * ForgeOS Chat Engine -- Claude Code architecture
 *
 * Claude streams tokens to the client in real time.
 * When Claude calls a tool, server executes it and returns the result.
 * No agent loop. No nudges. No guards. No fake user messages.
 * Claude decides when it is done. Period.
 */
const Anthropic = require("@anthropic-ai/sdk");
const brain = require("../memory/brain");
const { executeTool, TOOLS, buildSystemPrompt } = require("../agent/forge");

async function streamChat({ projectId, userMessage, history, skillContext, attachments, onEvent }) {
  history = history || [];
  skillContext = skillContext || "";
  attachments = attachments || [];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch memory context
  let memoryBlock = "";
  try {
    memoryBlock = await Promise.race([
      brain.buildContext(userMessage, projectId),
      new Promise(function(_, rej) { setTimeout(function() { rej(new Error("timeout")); }, 4000); }),
    ]);
  } catch {}

  const systemPrompt = buildSystemPrompt(memoryBlock, skillContext);

  // Scrub orphaned tool_use blocks from history
  const messages = [];
  for (var i = 0; i < history.length; i++) {
    var msg = history[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      var hasToolUse = msg.content.some(function(b) { return b.type === "tool_use"; });
      if (hasToolUse) {
        var next = history[i + 1];
        var nextHasResult = next && Array.isArray(next.content) &&
          next.content.some(function(b) { return b.type === "tool_result"; });
        if (!nextHasResult) { console.log("[stream] Dropped orphaned tool_use at", i); continue; }
      }
    }
    messages.push({ role: msg.role, content: msg.content });
  }

  // Build user message
  var userContent;
  if (attachments && attachments.length > 0) {
    userContent = [{ type: "text", text: userMessage }];
    for (var a = 0; a < attachments.length; a++) {
      var att = attachments[a];
      var b64 = att.dataUrl.split(",")[1] || att.dataUrl;
      userContent.push({ type: "image", source: { type: "base64", media_type: att.mimeType || "image/png", data: b64 } });
    }
  } else {
    userContent = userMessage;
  }
  messages.push({ role: "user", content: userContent });

  var fullAssistantMessage = "";
  var MAX_TOOL_ROUNDS = 50;
  var START_TIME = Date.now();
  var MAX_MS = 20 * 60 * 1000;

  // ── Main loop — Claude drives, we execute ────────────────────────────────────
  for (var round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - START_TIME > MAX_MS) {
      console.log("[stream] Hard timeout at round", round);
      break;
    }

    var currentText = "";
    var toolBlocks = [];
    var currentToolBlock = null;
    var currentToolJson = "";

    // Stream tokens directly to client as they arrive
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: systemPrompt,
      tools: TOOLS,
      messages: messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          currentToolBlock = { id: event.content_block.id, name: event.content_block.name };
          currentToolJson = "";
          // Emit tool start status immediately
          var sm = toolStatusLabel(event.content_block.name, {});
          if (sm) onEvent({ type: "tool_status", content: sm });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta" && event.delta.text) {
          // Stream each token to client as it arrives — word by word
          currentText += event.delta.text;
          onEvent({ type: "thinking", content: currentText });
        } else if (event.delta.type === "input_json_delta") {
          currentToolJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolBlock) {
          var inp = {};
          try { inp = JSON.parse(currentToolJson || "{}"); } catch {}
          currentToolBlock.input = inp;
          // Emit refined status with full input now available
          var sm2 = toolStatusLabel(currentToolBlock.name, inp);
          if (sm2) onEvent({ type: "tool_status", content: sm2 });
          toolBlocks.push(currentToolBlock);
          currentToolBlock = null;
          currentToolJson = "";
        }
      }
    }

    const response = await stream.finalMessage();
    messages.push({ role: "assistant", content: response.content });

    // Capture text for return value
    var textBlocks = response.content.filter(function(b) { return b.type === "text"; });
    if (textBlocks.length > 0) {
      var text = textBlocks.map(function(b) { return b.text; }).join("\n").trim();
      if (text) fullAssistantMessage = text;
    }

    // Claude is done — no tool calls
    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    // Execute every tool Claude called, collect results
    var toolResults = [];
    var toolCallBlocks = response.content.filter(function(b) { return b.type === "tool_use"; });

    for (var t = 0; t < toolCallBlocks.length; t++) {
      var toolUse = toolCallBlocks[t];
      console.log("[stream] round=" + round + " tool=" + toolUse.name, JSON.stringify(toolUse.input).slice(0, 120));

      var result = await executeTool(toolUse.name, toolUse.input, function(evt) {
        if (evt.type === "file_written") {
          onEvent({ type: "tool_status", content: "\u2713 Written: " + evt.path });
        } else if (evt.type === "agent_message") {
          onEvent({ type: "agent_message", content: evt.content });
        } else if (evt.type === "tool_status") {
          onEvent({ type: "tool_status", content: evt.content });
        }
      });

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: String(result) });
    }

    messages.push({ role: "user", content: toolResults });
    // Continue — Claude will decide what to do next
  }

  // Store to Brain
  if (projectId && fullAssistantMessage) {
    brain.extractMemory({
      projectId: projectId,
      userRequest: userMessage,
      buildSummary: fullAssistantMessage.slice(0, 500),
      files: [],
    }).catch(function() {});
  }

  return fullAssistantMessage || "Done.";
}

function toolStatusLabel(name, inp) {
  switch (name) {
    case "github_create_branch": return "Creating branch " + (inp.branch || "") + "...";
    case "github_ls":            return "Listing " + (inp.branch || "main") + "/" + (inp.path || "") + "...";
    case "github_read":          return "Reading " + (inp.filepath || "") + " from " + (inp.branch || "main") + "...";
    case "github_write":         return "Pushing " + (inp.filepath || "") + " to " + (inp.branch || "main") + "...";
    case "github_patch":         return "Patching " + (inp.filepath || "") + " on " + (inp.branch || "main") + "...";
    case "render_status":        return "Checking Render deploy status...";
    case "memory_search":        return "Searching Brain: \"" + ((inp.query || "").slice(0, 50)) + "\"...";
    case "fetch_url":            return "Fetching " + (inp.url || "").replace("https://", "").slice(0, 60) + "...";
    case "ask_user":             return null;
    default:                     return "Running " + name + "...";
  }
}

module.exports = { streamChat };
