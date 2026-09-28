# Cartesia sales agent ↔ APEX

The APEX API exposes seven Cartesia endpoints at `https://apex.donmatthews.live/api/cartesia`. They serve the BuildMyBot.app and APEX Work Solutions sales agent. The current APEX outbound caller ID remains **+1 832-975-7665**. The owner escalation destination is **+1 832-880-4970**. This bridge records Cartesia calls in APEX; it does not replace APEX's Telnyx call transport.

## Runtime settings

Set `CARTESIA_TOOL_SECRET` and `CARTESIA_WEBHOOK_SECRET` to different random values in the APEX backend environment. In Cartesia's webhook tools, set bearer authentication to the tool secret. In the agent's call event webhook configuration, set the event secret. APEX rejects requests when the matching secret is absent.

The booking tools need `APEX_CAL_API_KEY` and numeric `APEX_CAL_EVENT_TYPE_ID` for an actual Cal.com consultation event type. Without them, the tools return 503 and the agent must offer a callback. No appointment is reported as booked merely because a prospect mentions a time. SMS needs the existing `TELNYX_API_KEY` and `APEX_FRONT_DESK_NUMBER`.

## Cartesia webhook tools

Create each as a **Webhook** tool, HTTP `POST`, `Content-Type: application/json`, bearer authentication with the tool secret. Set `pre_tool_speech=auto`, `execution_mode=immediate`, and a 10-second timeout. Use `system__conversation_id` as a **dynamic variable** for every `call_id` property; never ask the model to invent it. Use `system__called_number` as the `phone_number` dynamic variable on an outbound sales agent. For an inbound agent use `system__caller_id` instead. These are Cartesia system variables, not text for the model to populate.

| Tool name | URL suffix | Required model-supplied JSON fields | Other JSON fields |
| --- | --- | --- | --- |
| `lookup_lead_info_v2` | `/tools/lookup-lead` | none | `phone_number` from system variable |
| `capture_and_qualify_lead` | `/tools/capture-and-qualify-lead` | `business_name`, `interest_track` (`voice_bot`, `chat_agent`, `workflow_automation`, `full_stack`) | `call_id` and `phone_number` from system variables; `prospect_name`, `prospect_email`, `call_or_ticket_volume`, `current_tech_stack`, `qualification_notes` |
| `check_calendar_availability` | `/tools/check-calendar-availability` | `start_date`, `end_date` (`YYYY-MM-DD`), `timezone` (IANA), `preferred_time_of_day` (`morning`, `afternoon`, `any`) | none |
| `book_consultation` | `/tools/book-consultation` | `prospect_name`, `prospect_email`, `slot_time` (ISO 8601 with offset), `timezone` (IANA) | `call_id` and `phone_number` from system variables; `scope_summary` |
| `send_demo_link` | `/tools/send-demo-link` | `demo_type` (`buildmybot_live_demo`, `apex_overview`), `consent_to_text` (`true` only after explicit agreement) | `call_id` and `phone_number` from system variables |
| `record_call_outcome_v2` | `/tools/record-outcome` | `disposition` (`qualified`, `callback_requested`, `not_interested`, `no_decision`, `dnc`) | `call_id` and `phone_number` from system variables; `prospect_name`, `notes`; `opt_out_quote` required for `dnc` |

For the three model supplied values on `check_calendar_availability`, do not infer a date from “next Thursday” without resolving it in the prospect's time zone. Offer up to three actual returned slots. Call `book_consultation` only after the prospect agrees to one. Treat `booked: true` as a confirmed booking; `booked: false` means the host still needs to confirm it.

`send_demo_link` sends a fixed template to the consented number. The BuildMyBot link opens `https://www.buildmybot.app/`; the APEX link is `https://apexwork.org/`. Confirm that a live interactive demo is available before describing either landing page as one. The model cannot compose arbitrary outbound SMS text. `dnc` requires an explicit spoken opt-out quote and creates a number-level suppression checked before future APEX outbound calls. Version 2 of the lookup and outcome tools is attached to the canonical agent; the old tool definitions are no longer used.

## Approved Telnyx caller ID in Cartesia

Cartesia's phone-number API lives at `/agents/phone-numbers`. For a Telnyx-owned number, Cartesia requires a SIP trunk provider with outbound routing configured in Telnyx and Cartesia; its provider API does not accept a Telnyx Call Control API key as a provider. Configure that carrier connection first. Startup uses the sole SIP trunk if exactly one exists; when several exist, set `CARTESIA_SIP_TRUNK_PROVIDER_ID` to the Telnyx provider ID. It will import +1 832-975-7665 into Cartesia if it is not already present. It does not assign an inbound agent to the number: outbound calls only need its `from_number_id`, and inbound routing must stay under the existing owner configuration. A number appearing in Cartesia is not proof the Telnyx SIP trunk can originate calls; verify with an approved self-test and check the displayed caller ID.

## Call controls and call events

Enable Cartesia's built-in **End call** tool. Enable **Transfer call** with a fixed phone destination of `+18328804970` when the prospect requests Matthew, a human handoff is useful, or the conversation becomes frustrated. Cartesia currently requires a Twilio or SIP-trunked phone call for its native transfer; a browser preview cannot validate PSTN transfer.

Configure Cartesia's call event webhook URL as `https://apex.donmatthews.live/api/cartesia/events`, with the event secret. Subscribe to `call_completed`, `call_failed`, and `post_call_analysis`. APEX uses Cartesia's `call_id` to upsert one `call_outcomes` row, retaining the mid-call disposition while appending the final transcript, summary, and end reason. The APEX Sales Ops call outcome list then sees the Cartesia records. Cartesia retries may deliver events twice; these APEX upserts are idempotent for the stored fields.

## Agent instructions

> You are Alex, a clearly identified AI sales assistant for BuildMyBot.app and APEX Work Solutions (apexwork.org). Ask a short opening question and listen. If the prospect responds with a brief yes, yep, sure, or okay, continue the pitch immediately in one sentence and ask one relevant question. Use `lookup_lead_info_v2` only when CRM details are needed; do not block the first reply on a lookup. Never invent a customer result, integration, guarantee, price, or case study. Capture confirmed details and record the real outcome before a normal call ends. Only a clear request to stop future contact is DNC. Send `record_call_outcome_v2` with `dnc` and the exact spoken `opt_out_quote` only after that request; an ordinary yes, silence, or declining an offer is not DNC. If a lookup reports an existing suppression, end politely without writing a new DNC. Ask before texting. Offer only calendar slots returned by the tool and confirm a booking only if it returns `booked: true`. If a tool is slow, say briefly what you are checking and allow interruption. Offer a transfer to Matthew when appropriate.

Keep Cartesia's attached knowledge base limited to verified BuildMyBot and APEX product details. A knowledge-base answer cannot substitute for an actual calendar booking or SMS delivery response.

## Verification

After the backend deploy and Cartesia tool configuration, test with a Cartesia phone call (not only the browser preview): lead lookup; qualification; calendar slot check; confirmed booking; consented SMS; an explicit DNC; a human transfer; and the completed call row in APEX Sales Ops. Check that +1 832-975-7665 is the originating number on **APEX Telnyx calls**. Cartesia calls need their own configured number/trunk before making the same caller-ID claim. Measure tool and turn latency from real call logs; no endpoint can promise a fixed 400 ms response when a calendar, database, or carrier is involved.
