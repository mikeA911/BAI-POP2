=== CHANGES SUMMARY ===
# CareCall Updates — July 25, 2026

## Files changed
- supabase/functions/telnyx-call-events/index.ts
- supabase/functions/assistant-tools/index.ts

## telnyx-call-events changes
1. AMD event name fix: handles `call.machine.premium.detection.ended` (premium AMD)
2. Human AMD variants: `human_residence`, `human_business`, `silence` all start Sarah
3. Retry logic for ai_assistant_start (503 transient errors)
4. BUG 1 FIX: First retry delay reduced from 1000ms to 200ms — Sarah speaks faster
5. New conversation events handled: call.conversation.created, call.conversation.ended,
   call.conversation_insights.generated (transcripts), call.recording.saved
6. looksLikeInsights tightened — call.* events never misrouted to insights handler

## assistant-tools changes
1. Tool routing: reads x-telnyx-call-control-id header (Telnyx single-prompt format)
2. Tool detection from body keys (Telnyx calls base URL, not path-based routing)
3. BUG 2 FIX: 23505 duplicate booking returns existing appointment as success
   (prevents Sarah getting confused on tool retry after transient 520 error)

## Deploy instructions
1. supabase/functions/telnyx-call-events/index.ts → deploy with Verify JWT OFF
2. supabase/functions/assistant-tools/index.ts → deploy with Verify JWT OFF
3. No migration changes required for these fixes
