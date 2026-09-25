export function stripReplyFallback(body) {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  if (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}


export function createMessagingService(runtime) {
  const client = runtime.client;
  const HTML_ESCAPE_RE = /[&<>"]/g;
  const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function escapeHtml(str) {
    return str.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]);
  }

  /**
   * Build { body, formatted_body, mentions } for a message that contains
   * @-mentions, per MSC3952 (intentional mentions — the m.mentions field
   * that actually triggers a recipient's notification/highlight) plus the
   * older formatted_body convention (an HTML <a href="https://matrix.to/#/
   * @user:server"> pill) that's still what makes a mention render as a
   * clickable pill rather than plain text in practically every client,
   * Element included — m.mentions alone covers notifications, not
   * rendering.
   *
   * `mentions` describes exactly which slices of `text` are mentions, as
   * { userId, offset, length } triples (offset/length in UTF-16 code
   * units, matching normal JS string indexing) — e.g. room-view.js's
   * composer records these itself at the moment it inserts "@DisplayName"
   * for a picked autocomplete entry, rather than this function trying to
   * re-derive "which @Name in the text was a real mention" after the
   * fact, which breaks the instant two mentioned users share a display
   * name or a mention's name is also just something someone typed. Plain
   * body is left untouched either way, so non-HTML clients still show
   * readable "@DisplayName" text.
   *
   * Returns null (nothing to add) when `mentions` is empty/absent, so
   * callers can spread the result straight into their content object.
   */
  function buildMentionFields(text, mentions) {
    if (!mentions || mentions.length === 0) return null;

    // Defend against overlapping/out-of-order ranges from a caller bug —
    // sort and drop anything that overlaps the previous kept range rather
    // than producing malformed/overlapping HTML.
    const ranges = [...mentions]
      .filter(m => m && m.userId && Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length > 0)
      .sort((a, b) => a.offset - b.offset);

    const userIds = new Set();
    let html = '';
    let cursor = 0;
    for (const { userId, offset, length } of ranges) {
      if (offset < cursor || offset + length > text.length) continue; // overlap or out of bounds — skip
      html += escapeHtml(text.slice(cursor, offset));
      const label = escapeHtml(text.slice(offset, offset + length));
      html += `<a href="https://matrix.to/#/${encodeURIComponent(userId)}">${label}</a>`;
      userIds.add(userId);
      cursor = offset + length;
    }
    html += escapeHtml(text.slice(cursor));

    if (userIds.size === 0) return null;
    return {
      formatted_body: html,
      mentions: { user_ids: [...userIds] },
    };
  }

  /**
   * Send a plain m.text message, optionally as a reply to an existing
   * event and/or carrying @-mentions. Per current spec (MSC2781 — the
   * fallback-removal proposal that landed in the spec, see
   * stripReplyFallback's comment above), a reply is *just* a normal
   * message carrying an m.relates_to m.in_reply_to relation — no
   * quoted-text fallback. room-view.js is expected to resolve
   * replyToEventId into the real event itself (getEventById below, which
   * fetches it if it isn't already loaded) and render its own quote UI
   * from that, rather than trusting anything folded into this message's
   * own body.
   *
   * This does mean a client that doesn't understand m.in_reply_to at all
   * will show the reply as an ordinary, context-free message — that's the
   * accepted tradeoff of MSC2781 (see the MSC's rationale on the fallback
   * having become more of a liability than a compatibility aid). It's not
   * this plugin's job to prop up clients that haven't caught up.
   *
   * `mentions`, if given, is passed straight to buildMentionFields() —
   * see its docs for the exact shape. Omit it (or pass an empty array)
   * for a message with no @-mentions; the m.text content is unchanged
   * from before in that case.
   *
   * Goes through the same client.sendEvent() used by sendReaction/
   * redactEvent below — encryption (if the room is encrypted) is applied
   * transparently by the SDK on any event sent this way, same as those
   * two, so there's nothing extra to do here for E2EE rooms.
   */
  function sendTextMessage(roomId, text, { replyToEventId, mentions } = {}) {
    if (!client) return Promise.reject(new Error('matrix-chat: no active client'));

    const content = { msgtype: 'm.text', body: text };
    if (replyToEventId) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyToEventId } };
    }

    const mentionFields = buildMentionFields(text, mentions);
    if (mentionFields) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = mentionFields.formatted_body;
      content['m.mentions'] = mentionFields.mentions;
    }

    runtime.assertCurrent();
    return client.sendEvent(roomId, 'm.room.message', content);
  }

  /**
   * Edit an existing m.text/m.emote message — m.relates_to rel_type
   * m.replace, per the spec. body carries the "* " fallback shown by
   * clients that don't understand edits; m.new_content carries the real
   * replacement and is what an edit-aware client (this one included — see
   * resolveEffectiveContent() in room-view.js) actually renders. Same
   * client.sendEvent() path as sendTextMessage's reply case above, so
   * encrypted rooms are handled the same transparent way.
   *
   * `mentions` (see buildMentionFields' docs for the shape) describes
   * @-mentions in newText specifically — it's applied only inside
   * m.new_content, since that's the body an edit-aware client actually
   * renders/notifies on; the "* " fallback body is left as plain text for
   * clients that don't understand edits at all, same as before.
   */
  function editTextMessage(roomId, eventId, newText, { mentions } = {}) {
    if (!client) return Promise.reject(new Error('matrix-chat: no active client'));

    const newContent = { msgtype: 'm.text', body: newText };
    const mentionFields = buildMentionFields(newText, mentions);
    if (mentionFields) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = mentionFields.formatted_body;
    }

    const content = {
      msgtype: 'm.text',
      body: `* ${newText}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    };
    if (mentionFields) {
      content['m.mentions'] = mentionFields.mentions;
    }

    runtime.assertCurrent();
    return client.sendEvent(roomId, 'm.room.message', content);
  }

  /**
   * React to an existing event with an emoji — m.reaction, rel_type
   * m.annotation. `key` is the reaction itself (the emoji), since Matrix's
   * annotation relation uses the reaction as its own key rather than a
   * separate reaction id — sending the same key twice onto the same event
   * from the same user is a duplicate the homeserver doesn't reject on its
   * own, so callers (room-view.js) are expected to check for an existing
   * reaction with that key first rather than relying on this to dedupe.
   */
  function sendReaction(roomId, eventId, key) {
    if (!client) return Promise.reject(new Error('matrix-chat: no active client'));
    runtime.assertCurrent();
    return client.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: eventId,
        key,
      },
    });
  }

  /**
   * Redact (delete) an event — used by room-view.js to retract one of the
   * local user's own reactions when a reaction pill they've already
   * toggled on is clicked again. Not reaction-specific at the API level
   * (redaction works on any event the local user has permission to
   * redact — their own events always, others' depending on room power
   * levels), it's just the only place in this plugin that currently needs
   * it.
   */
  function redactEvent(roomId, eventId, reason) {
    if (!client) return Promise.reject(new Error('matrix-chat: no active client'));
    runtime.assertCurrent();
    return client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
  }

  /**
   * Leaves a room — used by room-list.js's right-click "Leave" context
   * menu, on both ordinary rooms and spaces. A plain client.leave() call;
   * matrix-js-sdk doesn't distinguish spaces from rooms for membership
   * purposes (isSpaceRoom() is just a content flag on the room's
   * m.room.create event, checked client-side), so this needs no
   * space-specific branch and works for both. room-list.js temporarily
   * filters the room while this request and the following sync settle;
   * the client cache itself remains owned by matrix-js-sdk.
   */
  function leaveRoom(roomId) {
    if (!client) return Promise.reject(new Error('matrix-chat: no active client'));
    runtime.assertCurrent();
    return client.leave(roomId);
  }


  return { sendTextMessage, editTextMessage, sendReaction, redactEvent, leaveRoom };
}
