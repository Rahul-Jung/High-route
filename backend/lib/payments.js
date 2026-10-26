'use strict';
/* ===========================================================================
   PAYMENTS — the integration boundary.

   No payment provider is connected to this platform. Until this file says
   otherwise, nothing on the site may behave as though money moved.

   WHY THIS EXISTS
   ---------------
   The two rider-facing pay endpoints (POST /api/bookings/:id/pay and
   POST /api/proposals/:id/pay) used to accept any well-formed card number,
   expiry and CVV, mark the money as received, and — for a custom trip —
   create the confirmed booking on the spot. Two problems with that:

     1. It is a simulated payment presented as a real one. The brief is
        explicit (section 13: "do not simulate successful payment"; section
        25: "no fake booking confirmations"), and so is this site's own
        Booking Conditions page.
     2. Full card numbers and CVVs were being POSTed to this server. A server
        that receives raw card data is in PCI-DSS scope whether or not it
        stores anything, and this one is not built or audited for that. The
        right integration never lets card data touch our server at all — the
        provider's hosted fields or checkout page collect it, and we only
        ever see a token and a webhook.

   WHAT HAPPENS NOW
   ----------------
   By default both pay endpoints refuse with 503 `payments_not_configured`,
   before the request body is looked at, and the frontend does not render a
   card form in the first place (it asks GET /api/payments/config).

   Bookings are still created and held exactly as before; payment is
   recorded by an admin when it actually arrives (bank transfer, cash, a
   card taken over the phone) through the existing admin endpoints:

     PATCH /api/bookings/:id/payment
     PATCH /api/admin/custom-requests/:id/payment

   Those are honest: a person records money a person has seen.

   THE DEMO SWITCH
   ---------------
   ALLOW_SIMULATED_PAYMENTS=1 restores the old card-form behaviour for a
   demonstration environment. It is off unless set, every response made
   under it says it is simulated, and it must never be set on a deployment
   real customers can reach.

   TO CONNECT A REAL PROVIDER
   --------------------------
   Replace the card form with the provider's hosted fields or redirect,
   create the payment intent server-side, and update amount_paid_cents only
   from the provider's signed webhook — never from the browser's own claim
   that a charge succeeded.
   =========================================================================== */
const { sendJson } = require('./util');

function simulatedPaymentsAllowed() {
  return process.env.ALLOW_SIMULATED_PAYMENTS === '1';
}

/** What a customer is told to do instead of paying online. Kept in one
 *  place so the API refusal, the dashboard and the custom checkout all say
 *  the same thing. */
const HOW_TO_PAY =
  'Online card payment is not connected yet, so nothing can be charged here and nothing has been. ' +
  'Your booking is held. Contact us and we will send bank-transfer details; when the money arrives we ' +
  'record it against your booking and your dashboard updates.';

const INTEGRATION_REQUIRED =
  'A payment provider (for example Stripe) using hosted card fields, a server-side payment intent and a ' +
  'signed webhook to record the payment. Card data must never be sent to this server.';

/** Public, for the frontend to decide whether to render a card form at all. */
function paymentConfig() {
  const simulated = simulatedPaymentsAllowed();
  return {
    // No real provider is integrated in either mode.
    online: false,
    simulated,
    card_form: simulated,
    message: simulated
      ? 'SIMULATED PAYMENTS ARE ON. Any well-formed card is accepted and no money moves. This mode is for demonstrations only.'
      : HOW_TO_PAY,
    how_to_pay: HOW_TO_PAY,
    contact_url: 'contact.html',
    integration_required: INTEGRATION_REQUIRED,
  };
}

/** Call first thing in a pay handler. Returns true when it has already sent
 *  the refusal, in which case the handler must return without reading the
 *  request body — so a card that was sent anyway is never validated, used
 *  or logged. */
function refuseIfPaymentsDisabled(res) {
  if (simulatedPaymentsAllowed()) return false;
  sendJson(res, 503, {
    error: HOW_TO_PAY,
    code: 'payments_not_configured',
    integration_required: INTEGRATION_REQUIRED,
  });
  return true;
}

module.exports = { simulatedPaymentsAllowed, paymentConfig, refuseIfPaymentsDisabled, HOW_TO_PAY };
