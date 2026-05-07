// lib/transformer.js — converts a captured chat_conversations GET
// response into the Mode B ingest contract shape.
//
// Actual observed shape: TBD as of 0.2.0. Pass-1 popup capture bug
// prevented inspection. First real capture will inform tightening —
// see Prompt 05/06/2026-29 verified-with-known-issue note. Update
// mappings here once a real payload is in ai-archive.
//
// The transformer is intentionally defensive (Prompt 05/06/2026-31,
// Dean's question-1 answer):
//   - Accepts `text` OR `content`. If both present, prefer `content`
//     (the structured form) and keep `text` as a fallback string.
//   - Accepts `human` and `user` as user-role; `assistant` as
//     assistant-role. Anything else is logged once per conversation
//     and passed through unchanged so signal isn't normalized away.
//   - Keeps artifacts, tool_use, tool_result, attachments, and files
//     as structured fields. No flattening — server side / pass 3
//     decides rendering later.
//
// Loaded via importScripts() in background.js. Exposes one global on
// self.linksblueTransformer with two methods:
//   - transformConversation(parsedJson) → conversation meta + all
//     normalized messages (background.js slices from_index → end).
//   - transformMessage(rawMessage)        → one chat_message normalized.
//
// TODO (pass 3): if a Mode B payload's new_messages array would
// exceed the server's body limit, split across multiple POSTs.
// Response 05/06/2026-31c bumped the server limit from 100kb to
// 10mb; very long conversations may eventually need client-side
// chunking.

(function () {
  function normalizeRole(rawSender) {
    if (rawSender == null) return null;
    var s = String(rawSender).toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant') return 'assistant';
    return null; // signal "unknown" — caller logs and passes through
  }

  function pickContent(rawMessage) {
    // Prefer structured `content` (likely an array of blocks). Fall
    // back to plain `text`. Keep both available so ingest / pass 3
    // have full signal.
    var hasContent = rawMessage && (rawMessage.content !== undefined && rawMessage.content !== null);
    var hasText = rawMessage && (typeof rawMessage.text === 'string');
    if (hasContent && hasText) return { content: rawMessage.content, text: rawMessage.text };
    if (hasContent) return { content: rawMessage.content };
    if (hasText) return { content: rawMessage.text, text: rawMessage.text };
    return { content: null };
  }

  function transformMessage(rawMessage, unknownRoleLog) {
    if (!rawMessage || typeof rawMessage !== 'object') return null;

    var rawSender = rawMessage.sender || rawMessage.role || rawMessage.type || null;
    var role = normalizeRole(rawSender);
    if (role === null) {
      if (rawSender !== null && unknownRoleLog && !unknownRoleLog.fired) {
        unknownRoleLog.fired = true;
        try { console.log('[linksblue-chrome-capture] unknown message role "' + rawSender + '" — passed through unchanged'); } catch (_) {}
      }
      role = rawSender ? String(rawSender) : 'unknown';
    }

    var picked = pickContent(rawMessage);
    var msg = {
      role: role,
      content: picked.content,
      timestamp: rawMessage.created_at || rawMessage.timestamp || rawMessage.time || null,
      message_id: rawMessage.uuid || rawMessage.id || null,
    };
    if (picked.text !== undefined && picked.text !== picked.content) {
      msg.text = picked.text;
    }

    // Pass through structured signal — never flatten.
    var passThrough = ['artifacts', 'tool_use', 'tool_result', 'attachments', 'files', 'model'];
    for (var i = 0; i < passThrough.length; i++) {
      var k = passThrough[i];
      if (rawMessage[k] !== undefined && rawMessage[k] !== null) msg[k] = rawMessage[k];
    }

    return msg;
  }

  function transformConversation(parsedJson) {
    if (!parsedJson || typeof parsedJson !== 'object') return null;
    if (typeof parsedJson.uuid !== 'string') return null;

    var convUuid = parsedJson.uuid;
    var title = (typeof parsedJson.name === 'string' && parsedJson.name.trim())
      ? parsedJson.name
      : 'Untitled conversation';
    var nowIso = new Date().toISOString();
    var startedAt = (typeof parsedJson.created_at === 'string' && parsedJson.created_at)
      ? parsedJson.created_at
      : ((typeof parsedJson.started_at === 'string' && parsedJson.started_at) ? parsedJson.started_at : nowIso);
    var lastUpdated = (typeof parsedJson.updated_at === 'string' && parsedJson.updated_at)
      ? parsedJson.updated_at
      : nowIso;

    var rawMessages = Array.isArray(parsedJson.chat_messages)
      ? parsedJson.chat_messages
      : (Array.isArray(parsedJson.messages) ? parsedJson.messages : []);

    var unknownRoleLog = { fired: false };
    var allMessages = [];
    for (var i = 0; i < rawMessages.length; i++) {
      var m = transformMessage(rawMessages[i], unknownRoleLog);
      if (m) allMessages.push(m);
    }

    return {
      conversation_uuid: convUuid,
      platform: 'claude_web',
      title: title,
      started_at: startedAt,
      last_updated: lastUpdated,
      source_id: 'claude_web:' + convUuid,
      all_messages: allMessages,
    };
  }

  self.linksblueTransformer = {
    transformConversation: transformConversation,
    transformMessage: transformMessage,
    normalizeRole: normalizeRole,
  };
})();
