# Escalation Policy

This document defines the escalation tiers, SLA thresholds, and procedures used when a service case cannot be resolved at the current support level.

---

## Overview

All incoming cases are triaged and assigned a priority level. If resolution is not achieved within the SLA window, the case must be escalated to the next tier. **Never let a case exceed its SLA without escalating.**

---

## Priority Levels

| Priority | Label | Description | Initial Response | Resolution SLA |
|----------|-------|-------------|-----------------|---------------|
| P1 | Critical | Complete service outage or data loss | 15 minutes | 2 hours |
| P2 | High | Major feature broken, workaround unavailable | 1 hour | 8 hours |
| P3 | Medium | Partial degradation, workaround available | 4 hours | 2 business days |
| P4 | Low | Minor issue, cosmetic, or enhancement request | 1 business day | 5 business days |

---

## Escalation Tiers

### Tier 1 — Front-Line Support
- **Who:** Support Engineers (Jordan Lee and peers)
- **Handles:** P3, P4 cases; initial triage for all cases
- **Escalate when:** P1/P2 arrives, or P3 exceeds SLA

### Tier 2 — Senior / Specialist Support
- **Who:** Service Lead (Alex Rivera), Field Technicians (Sam Patel)
- **Handles:** P2 cases, escalated P3 cases, field-related issues
- **Escalate when:** P1 arrives, or P2 exceeds SLA

### Tier 3 — Engineering / Management
- **Who:** Engineering On-Call, Operations Manager, Department Head
- **Handles:** P1 cases, incidents with business impact, escalated P2 cases
- **Escalate when:** P1 not resolved within 1 hour, or requires executive awareness

---

## Escalation Procedure

1. **Document** the current state in the case notes: steps taken, outcome, reason for escalation
2. **Notify** the next-tier contact via both Slack DM and email
3. **Update** the case status to `Escalated` and re-assign to the escalation contact
4. **Stay engaged** — the original assignee remains on the case until handoff is confirmed
5. **Communicate** to the affected party that escalation is in progress

---

## P1 Incident Response Steps

1. Immediately post in `#incidents` Slack channel: `P1 ACTIVE: [brief description]`
2. Page the on-call engineer via PagerDuty
3. Notify the Service Lead (Alex Rivera) directly
4. Create a war-room bridge (Google Meet link in the `#incidents` post)
5. Assign an incident commander (typically the Service Lead)
6. Update `#incidents` every 30 minutes until resolved
7. After resolution, file a post-mortem within 48 hours

---

## Escalation Contacts

| Tier | Name | Role | Slack | Email | Phone |
|------|------|------|-------|-------|-------|
| Tier 2 | Alex Rivera | Service Lead | @alex | alex@example.com | ext. 1001 |
| Tier 2 | Sam Patel | Field Technician | @sam | sam@example.com | ext. 1003 |
| Tier 3 | On-Call Engineer | Engineering | #incidents (PagerDuty) | oncall@example.com | PagerDuty |
| Tier 3 | Operations Manager | Mgmt | @ops-manager | opsmanager@example.com | ext. 1010 |

---

## Post-Mortem Requirements

All P1 incidents and any P2 incidents exceeding SLA require a post-mortem document filed within 48 hours of resolution. Post-mortems must include:

- **Timeline** of events
- **Root cause** analysis
- **Impact** assessment (users affected, downtime duration)
- **Resolution** steps taken
- **Action items** with owners and due dates to prevent recurrence

Post-mortems are stored in Confluence under **Service Org > Post-Mortems**.

---

## Exceptions

Any exception to this policy (e.g., skipping a tier, extending an SLA) must be approved in writing by the Service Lead or Operations Manager and documented in the case.
