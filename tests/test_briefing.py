import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
import briefing as B  # noqa: E402

SECTIONS = {
    "decision": "**Rating**: Overweight\n\n**Executive Summary**: Add a modest position. Cloud revenue grew 28% and margins widened for a third quarter.\n\n- Data-center demand remains strong through next year.\n- Valuation is full but supported by earnings growth.",
    "bull": "Bull Analyst: Free cash flow reached a record $22 billion, which funds buybacks and R&D.",
    "bear": "Bear Analyst: Export controls could cut China sales by a fifth, and the stock trades at 40 times earnings.",
    "market": "RSI is 61 and price sits above the 50-day average.",
    "risk_conservative": "Conservative Analyst: A drawdown of 20 percent is plausible if guidance disappoints.",
}


class FakeLLM:
    def __init__(self, text):
        self.text = text
        self.prompts = []

    def invoke(self, messages):
        self.prompts.append(messages)
        return type("M", (), {"content": self.text})()


class Briefing(unittest.TestCase):
    def test_norm_ignores_markdown_quotes_and_case(self):
        self.assertEqual(B.norm("**Free** cash  FLOW’s"), "free cash flow's")

    def test_valid_quotes_are_kept_and_invented_ones_dropped(self):
        parsed = {
            "for": [
                {"reason": "Cash flow is at a record", "source": "bull", "quote": "Free cash flow reached a record $22 billion"},
                {"reason": "Demand is strong", "source": "decision", "quote": "Data-center demand remains strong through next year"},
                {"reason": "Invented growth claim", "source": "bull", "quote": "Revenue will triple by 2030 according to management"},
            ],
            "against": [{"reason": "China risk", "source": "bear", "quote": "Export controls could cut China sales by a fifth"}],
            "would_change": [],
        }
        v = B.validate(parsed, B.collect(SECTIONS))
        self.assertEqual(len(v["for"]), 2)
        self.assertEqual(v["dropped"], 1)
        self.assertEqual(v["against"][0]["source"], "bear")

    def test_wrong_source_is_corrected_when_the_quote_exists_elsewhere(self):
        parsed = {"for": [{"reason": "Valuation is supported", "source": "market", "quote": "Valuation is full but supported by earnings growth"}], "against": [], "would_change": []}
        v = B.validate(parsed, B.collect(SECTIONS))
        self.assertEqual(v["for"][0]["source"], "decision")

    def test_short_quotes_do_not_count(self):
        parsed = {"for": [{"reason": "Stock is up a lot", "source": "bull", "quote": "record"}], "against": [], "would_change": []}
        self.assertEqual(B.validate(parsed, B.collect(SECTIONS))["for"], [])

    def test_model_path_with_json_in_code_fence_and_think_tags(self):
        good = ('<think>let me see</think>```json\n{"for": ['
                '{"reason": "Cash flow is at a record", "source": "bull", "quote": "Free cash flow reached a record $22 billion"},'
                '{"reason": "Demand is strong", "source": "decision", "quote": "Data-center demand remains strong through next year"}],'
                '"against": [{"reason": "China risk", "source": "bear", "quote": "Export controls could cut China sales by a fifth"}],'
                '"would_change": [{"reason": "Weak guidance", "source": "risk", "quote": "A drawdown of 20 percent is plausible if guidance disappoints"}]}\n```')
        llm = FakeLLM(good)
        r = B.make("NVDA", "Overweight", SECTIONS, llm)
        self.assertEqual(r["mode"], "model")
        self.assertEqual((len(r["for"]), len(r["against"]), len(r["would_change"])), (2, 1, 1))
        self.assertIn("TRADEDESK_BRIEF", llm.prompts[0][1]["content"])

    def test_not_json_falls_back_to_rules_with_real_sentences(self):
        r = B.make("NVDA", "Overweight", SECTIONS, FakeLLM("Sure! Here is a summary of the stock."))
        self.assertEqual(r["mode"], "rules")
        self.assertTrue(r["for"] and r["against"])
        full = B.norm(" ".join(SECTIONS.values()))
        for item in r["for"] + r["against"]:
            self.assertIn(B.norm(item["quote"]), full, "rule-based reasons are copied, not written")
        self.assertTrue(r["note"])

    def test_all_invented_falls_back(self):
        bad = '{"for": [{"reason": "Great company", "source": "bull", "quote": "This company will definitely double next year"}], "against": [], "would_change": []}'
        r = B.make("NVDA", "Overweight", SECTIONS, FakeLLM(bad))
        self.assertEqual(r["mode"], "rules")
        self.assertEqual(r["dropped"], 1)

    def test_model_error_never_raises(self):
        class Boom:
            def invoke(self, m):
                raise RuntimeError("connection refused")
        r = B.make("NVDA", "Hold", SECTIONS, Boom())
        self.assertEqual(r["mode"], "rules")

    def test_no_text_no_crash(self):
        r = B.make("NVDA", "Hold", {}, FakeLLM("{}"))
        self.assertEqual((r["for"], r["against"]), ([], []))

    def test_prompt_respects_budget(self):
        big = {"decision": "x " * 20000, "bull": "y " * 20000}
        msgs = B.build_prompt("T", "Hold", B.collect(big))
        self.assertLess(len(msgs[1]["content"]), 9000)


if __name__ == "__main__":
    unittest.main()
