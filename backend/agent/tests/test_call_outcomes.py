# tests/test_call_outcomes.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import call_outcomes as co


def tool(name, result):
    """A tool-trace entry in the shape MoloAgent._record_tool writes."""
    return {"name": name, "args": {}, "result": result, "kb_source": "general", "at": "now"}


# ── the bug this module exists to fix ───────────────────────────────────────

def test_a_guest_who_asked_questions_and_hung_up_is_not_abandoned():
    # THE regression. The old rule labelled any call with no tool call
    # 'abandoned' — and the model answers most questions straight from the
    # loaded KB without calling search_kb, so ordinary Q&A calls were logged as
    # if nobody had spoken.
    outcomes = co.merge([], ["question_answered"], caller_turns=4)
    assert "abandoned" not in outcomes
    assert outcomes == ["question_answered"]


def test_abandoned_survives_only_a_genuinely_empty_call():
    assert co.merge([], [], caller_turns=0) == ["abandoned"]


def test_abandoned_is_stripped_when_the_caller_actually_spoke():
    # Even if the model insists on it.
    assert co.merge([], ["abandoned", "complaint"], caller_turns=3) == ["complaint"]


def test_a_tool_ran_so_it_was_never_abandoned_however_quiet_the_caller():
    # Transfer refused because the desk was shut: the caller reached the agent,
    # asked for a human, and got an answer. Not an abandoned call.
    assert co.merge(["transfer_unavailable"], [], caller_turns=0) == ["transfer_unavailable"]


# ── tool trace -> outcomes (hard evidence) ──────────────────────────────────

def test_a_filed_ticket_and_an_answered_question_both_land():
    # The example the client gave: asks about the Wi-Fi, then reports a fault.
    outcomes = co.from_tool_calls([
        tool("search_kb", "The Wi-Fi password is molo2024."),
        tool("raise_maintenance_ticket", "Maintenance ticket created (high priority). Tell the guest..."),
    ])
    assert outcomes == ["maintenance_ticket_raised", "question_answered"]


def test_answered_and_unanswered_questions_coexist():
    outcomes = co.from_tool_calls([
        tool("search_kb", "Check-out is at 11am."),
        tool("search_kb", "NO_KB_MATCH: nothing in the loaded knowledge base covers this question."),
    ])
    assert outcomes == ["question_answered", "unresolved"]


def test_the_long_no_kb_match_variant_still_counts_as_a_miss():
    # search_kb rewrites a miss into a much longer instruction when the guest
    # isn't identified yet — but it keeps the sentinel, and that is what we key
    # off.
    outcomes = co.from_tool_calls([
        tool("search_kb", "NO_KB_MATCH and the guest is NOT identified yet. Do NOT tell the guest..."),
    ])
    assert outcomes == ["unresolved"]


def test_only_an_unambiguous_room_match_counts_as_a_reservation_lookup():
    assert co.from_tool_calls([
        tool("identify_guest", "MATCHED (one place): room 3a is at Pułaskiego 6."),
    ]) == ["reservation_looked_up"]
    # Ambiguous and no-match are prefixed by the tool itself; neither told the
    # guest anything about their reservation.
    assert co.from_tool_calls([
        tool("identify_guest", "ambiguous: MATCHED (multiple places): room 12 exists at..."),
    ]) == []
    assert co.from_tool_calls([
        tool("identify_guest", "no match: I couldn't find a room '99' in any Molo property."),
    ]) == []


def test_a_booking_link_counts_only_once_the_sms_actually_went_out():
    sent = co.from_tool_calls([tool("send_booking_link", "{'sms_sent': True, 'url_built': True}")])
    assert sent == ["booking_link_sent"]
    # Built but never delivered is not a link the caller received.
    failed = co.from_tool_calls([tool("send_booking_link", "{'sms_sent': False, 'url_built': True}")])
    assert failed == ["unresolved"]


def test_availability_is_recorded_whatever_the_answer_was():
    for result in ("{'status': 'available', 'options': 3}",
                   "{'status': 'full', 'alternatives': []}",
                   "{'status': 'partial', 'max_nights': 2}"):
        assert co.from_tool_calls([tool("suggest_available_rooms", result)]) == ["availability_checked"]
    # A KWHotel error told the caller nothing.
    assert co.from_tool_calls([tool("suggest_available_rooms", "error: timeout")]) == []


def test_a_transfer_is_only_a_transfer_when_it_dialled():
    assert co.from_tool_calls([
        tool("transfer_call", "dialing front desk")]) == ["transferred_to_human"]
    for refusal in ("refused, front desk closed: Our front desk is open...",
                    "transfer not configured",
                    "same as caller — refused",
                    "error: SIP trunk unavailable"):
        assert co.from_tool_calls([tool("transfer_call", refusal)]) == ["transfer_unavailable"]


def test_a_ticket_that_could_not_be_filed_is_unresolved():
    assert co.from_tool_calls([
        tool("raise_maintenance_ticket", "I couldn't file that ticket just now."),
    ]) == ["unresolved"]


def test_an_unknown_tool_is_ignored_rather_than_guessed_at():
    assert co.from_tool_calls([tool("some_future_tool", "did a thing")]) == []
    assert co.from_tool_calls(None) == []


# ── transcript -> outcomes (model half) ─────────────────────────────────────

def test_only_known_labels_survive_parsing():
    # The column has a CHECK constraint: an invented label would make the whole
    # end-of-call write fail, losing the transcript and the cost with it.
    assert co.parse_labels("question_answered, invented_label, complaint") == [
        "question_answered", "complaint"]


def test_labels_are_found_inside_a_chatty_reply():
    assert co.parse_labels("Sure! The labels are: question_answered and complaint.") == [
        "question_answered", "complaint"]


def test_the_model_cannot_claim_a_ticket_or_a_link():
    # Those come from the tool trace alone. Letting the classifier assert them
    # would mean a transcript could invent a maintenance ticket that no one
    # ever filed.
    assert co.parse_labels("maintenance_ticket_raised, booking_link_sent") == []
    assert "maintenance_ticket_raised" not in co.CLASSIFIABLE


def test_an_empty_or_broken_reply_yields_nothing():
    assert co.parse_labels("") == []
    assert co.parse_labels(None) == []


def test_thinking_is_disabled_and_the_token_budget_is_generous():
    # Gemini 2.5 Flash thinks by default and thinking tokens are drawn from
    # max_output_tokens. The first live call spent a 40-token budget thinking
    # and returned the truncated word "question", so every label was dropped.
    # Both halves of the fix are asserted; either alone would have prevented it.
    from google.genai import types

    cfg = co.classify_config(types)
    assert cfg.thinking_config.thinking_budget == 0
    assert cfg.max_output_tokens >= 100
    assert cfg.temperature == 0.0


def test_repeated_labels_collapse():
    assert co.parse_labels("complaint, complaint, complaint") == ["complaint"]


# ── merging ─────────────────────────────────────────────────────────────────

def test_outcomes_come_back_in_rank_order():
    merged = co.merge(["question_answered", "maintenance_ticket_raised"], [], caller_turns=2)
    assert merged == ["maintenance_ticket_raised", "question_answered"]


def test_other_is_dropped_as_soon_as_anything_real_is_known():
    assert co.merge(["booking_link_sent"], ["other"], caller_turns=5) == ["booking_link_sent"]


def test_other_survives_alone_when_nothing_else_fits():
    assert co.merge([], ["other"], caller_turns=2) == ["other"]
    # A call with turns but no labels at all still gets something.
    assert co.merge([], [], caller_turns=2) == ["other"]


def test_the_two_halves_combine_without_duplicating():
    merged = co.merge(["question_answered"], ["question_answered", "complaint"], caller_turns=6)
    assert merged == ["question_answered", "complaint"]


def test_primary_is_the_highest_ranked_outcome():
    # What call_logs.outcome holds, and therefore what the home dashboard's
    # category chart groups by.
    assert co.primary(["question_answered", "maintenance_ticket_raised"]) == "maintenance_ticket_raised"
    assert co.primary([]) is None


def test_every_vocabulary_entry_is_ranked_exactly_once():
    assert len(set(co.OUTCOMES)) == len(co.OUTCOMES)
    assert set(co.CLASSIFIABLE) <= set(co.OUTCOMES)


# ── caller turns ────────────────────────────────────────────────────────────

def test_caller_turns_count_only_the_caller():
    lines = [
        "assistant: Hi, welcome to Molo Residence...",
        "user: hi, what's the wifi password?",
        "assistant: It's molo2024.",
        "user: thanks",
    ]
    assert co.count_caller_turns(lines) == 2
    assert co.count_caller_turns(["assistant: Hi, welcome to Molo Residence..."]) == 0
    assert co.count_caller_turns([]) == 0


def test_a_line_with_no_role_prefix_is_not_a_caller_turn():
    assert co.count_caller_turns(["something went wrong", "user: hello"]) == 1
