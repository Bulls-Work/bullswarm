# Triage at scale

**Reach for it when:** there are many similar items to sort, label or route,
such as tickets, emails, bug reports, feedback, leads or documents, and each
item needs a small judgment rather than deep work.

**Shape**

```
batch-1 ┐
batch-2 ├→ sample-check → drafts (for the classes that need them)
batch-N ┘                      → a separate act run, only for approved items
```

**Steps**
- **batch-N**
  - Role: transform. Deliverable: structured data, one JSON file per batch.
  - Batches of 25–100 items.
  - The brief carries the categories, one example per category, and the
    output schema.
  - Evidence: schema.
- **sample-check**
  - Role: check. Deliverable: a report.
  - It reviews a random sample (about 5%) against the same rubric and reports
    the error rate and any category that is often wrong.
- **drafts**
  - Role: produce. Deliverable: files, one draft per item that needs a
    response.
  - It depends on the batches and the sample check.

**The caller decides:**
- the categories and the batch size;
- whether cheaper pools may take the batches (usually yes; the schema evidence
  makes their work checkable);
- the acceptable error rate;
- which drafts go to the person.

Sending is a separate act run after approval.

**What backs "done":**
- schema: on every batch;
- review: the sampled error rate;
- choice: the person approves drafts.

**More than one provider:** mostly for economy, spreading batches across spare
quota. For diversity, route the sample check to a different model than the
batches.

**Pitfalls**
- Categories that overlap. Fix the rubric before scaling up.
- Batches too large for one attempt.
- Trusting the classification without the sample check.
- An act step hidden inside the drafting step. Keep sending separate and
  explicit.

**Neighbors:** extract-to-data (records instead of labels) · bulk-transform (a
change instead of a label) · triage-then-act (the follow-up that sends).
