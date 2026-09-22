'use strict';
const { run } = require('../db');

/** In-app notifications only — this demo has no outbound email/SMS provider
 *  wired up (see README), so "notify the customer"/"notify the admin" means
 *  a row here that shows up as an unread badge + list in dashboard.html /
 *  admin.html, not a real message sent anywhere. */
function notify({ recipientType, recipientId = null, type, title, body = null, linkUrl = null, customRequestId = null }) {
  return run(
    `INSERT INTO notifications (recipient_type, recipient_id, type, title, body, link_url, custom_request_id)
     VALUES (?,?,?,?,?,?,?)`,
    [recipientType, recipientId, type, title, body, linkUrl, customRequestId]
  ).lastInsertRowid;
}

/** recipientId is null: every admin session sees it — this app has no
 *  per-admin assignment of CRM leads to route it to just one of them. */
function notifyAdmins(opts) {
  return notify({ ...opts, recipientType: 'admin', recipientId: null });
}

function notifyRider(riderId, opts) {
  return notify({ ...opts, recipientType: 'rider', recipientId: riderId });
}

module.exports = { notify, notifyAdmins, notifyRider };
