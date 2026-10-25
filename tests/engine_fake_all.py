"""Real engine with both fakes applied (deterministic prices and a fake Yahoo ticker). For the UI harness only."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for name in ("engine_fake_prices.py", "engine_fake_quote.py"):
    src = open(os.path.join(HERE, name), encoding="utf-8").read().replace("sys.exit(E.main())", "pass")
    exec(compile(src, name, "exec"), {"__name__": "fake", "__file__": os.path.join(HERE, name)})
import tradedesk_engine as E  # noqa: E402  (already patched by the exec'd files: same module object)
sys.exit(E.main())
