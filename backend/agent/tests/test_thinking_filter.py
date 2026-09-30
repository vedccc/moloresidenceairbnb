import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import thinking_filter  # noqa: E402


def test_strips_channel_thought_block():
    raw = "<|channel|>analysis I should be warm and brief.<|channel|>final Sure, checkout at noon is fine."
    assert thinking_filter.strip_thinking_tokens(raw) == "Sure, checkout at noon is fine."


def test_strips_think_tags():
    raw = "<think>plan the answer</think>Of course, happy to help."
    assert thinking_filter.strip_thinking_tokens(raw) == "Of course, happy to help."


def test_leaves_clean_text_untouched():
    clean = "Yes, our earliest check-in is 3pm."
    assert thinking_filter.strip_thinking_tokens(clean) == clean


def test_collapses_leftover_whitespace():
    raw = "<think>x</think>   Hello there."
    assert thinking_filter.strip_thinking_tokens(raw) == "Hello there."


def test_truncated_analysis_without_final_marker_is_nonempty():
    # A completion cut short by max_tokens can emit an analysis/thought
    # channel marker with no closing "final" marker. The filter must never
    # turn non-empty input into empty output (dead air is worse than
    # imperfect text reaching TTS).
    raw = ("<|channel|>analysis The guest wants late checkout, let me weigh "
           "pricing tiers before answering")
    result = thinking_filter.strip_thinking_tokens(raw)
    assert result != ""
    assert "checkout" in result


def test_mid_sentence_marker_removal_keeps_words_separated():
    raw = "Yes indeed<think>oops</think>that's correct."
    assert thinking_filter.strip_thinking_tokens(raw) == "Yes indeed that's correct."
