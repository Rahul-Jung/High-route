'use strict';
const { run } = require('../db');

/** Appends one row to the custom_requests audit trail. Never updated or
 *  deleted — see the custom_request_events comment in schema.sql. Every
 *  status transition on a custom_requests row or one of its proposals
 *  should call this, so the CRM can always answer "what happened and when". */
function logRequestEvent({
  customRequestId, proposalId = null, eventType,
  fromStatus = null, toStatus = null, actorType, actorId = null, message = null,
}) {
  return run(
    `INSERT INTO custom_request_events (custom_request_id, proposal_id, event_type, from_status, to_status, actor_type, actor_id, message)
     VALUES (?,?,?,?,?,?,?,?)`,
    [customRequestId, proposalId, eventType, fromStatus, toStatus, actorType, actorId, message]
  ).lastInsertRowid;
}

module.exports = { logRequestEvent };
