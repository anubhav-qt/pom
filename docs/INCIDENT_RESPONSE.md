# Incident Response Plan — Paribelle OMS

**Owner:** [Papa — fill in full name]
**Applies to:** the Paribelle OMS application, its database, and any credentials
or Amazon Information it holds.
**Last reviewed:** [date you adopt this]
**Next review due:** 6 months from last review.

This is a two-person operation. The plan below is sized to that — it defines
real roles held by real people, not a placeholder org chart.

---

## 1. Roles

| Role | Who | Responsibility |
|---|---|---|
| **Incident Owner** | Papa (account owner) | Makes the call on scope and response, owns communication to Amazon, has final authority to revoke access or take the app offline. |
| **Technical Responder** | [staff member / you] | Rotates credentials, patches the vulnerability, investigates logs, restores service. |

Both roles can act independently if the other is unreachable — with a two-person
team, waiting for sign-off is not an option. Whoever notices an incident first
starts response immediately and briefs the other as soon as possible.

---

## 2. What counts as an incident

Any of the following:

- A password, refresh token, API secret, or database credential is exposed,
  leaked, or suspected compromised (e.g. committed to a public repo, sent
  unencrypted, found in a leaked-credentials list).
- Evidence of unauthorized access to the application or database (unrecognized
  login, unexpected data changes, requests we did not make).
- Loss or theft of a device with an active session or stored credentials.
- Amazon notifies us of suspicious activity on the Selling Partner API
  connection.
- A vulnerability is discovered that could allow unauthorized access to Amazon
  Information (e.g. an auth bypass, an injection flaw).

---

## 3. Response steps

1. **Contain.** Rotate the affected credential immediately:
   - Amazon refresh token → Seller Central → Partner Network → Develop Apps →
     Authorize app again (this issues a new token; revoke/ignore the old one).
   - LWA client secret → Develop Apps → regenerate.
   - App login password → reset via the seed script (`npm run seed`) or, once
     built, the in-app password reset.
   - Database credential → rotate in the hosting provider (Neon) and update
     `DATABASE_URL` everywhere it's deployed.
2. **Assess scope.** Check the `sync_runs` table and application logs for
   activity in the affected window. Identify what data, if any, was actually
   accessible — order data, financial data, or credentials only.
3. **Notify Amazon**, if Amazon Information was or may have been exposed:
   email **security@amazon.com** within **24 hours of detection**, describing
   what happened, what data was affected, and what containment steps were
   taken. Do this even if the assessment is still in progress — an initial
   notice with "investigation ongoing" is expected and acceptable; don't wait
   for a complete picture before notifying.
4. **Remediate.** Fix the root cause (patch code, correct a misconfiguration,
   revoke a leaked credential) before resuming normal use of the affected
   system.
5. **Record.** Write down what happened, when it was detected, what was done,
   and when it was resolved. Keep this with the current version of this
   document.

---

## 4. Review

This plan is reviewed **every 6 months**, or immediately after any real
incident, whichever comes first. Review means: confirm the named roles are
still the right people, confirm the containment steps still match how
credentials are actually rotated, and update anything that has drifted.

| Review date | Reviewed by | Changes made |
|---|---|---|
| [fill in] | | Initial adoption |

---

## 5. Amazon notification checklist

When emailing **security@amazon.com**, include:

- Your Seller Central account / merchant ID.
- What happened and when it was detected.
- What Amazon Information (if any) was involved.
- Containment steps already taken (e.g. "refresh token rotated at [time]").
- A contact for follow-up.
