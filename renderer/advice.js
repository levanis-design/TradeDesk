'use strict';
// "What decision is yours?" Plain wording built from the rating, what you hold and your cash.
// Pure and rule-based: no model is involved here, so the same inputs always give the same words.
// It never sizes a trade and never says "you should". It states the choice and the facts around it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Advice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct0 = (n) => `${Math.round(n * 100)}%`;
  const units = (q) => String(Math.round(q * 1e6) / 1e6);

  const DISCLAIMER = 'This is a summary of a language-model analysis, not financial advice. It can be wrong. TradeDesk places no orders. The decision is yours.';
  const TAX = 'Selling can create a taxable gain or loss. Check the tax rules that apply to you before you act.';
  const CONCENTRATED = 0.25;   // a single holding above this share of the portfolio is called out

  // Leaning words, one per rating.
  const LEAN = {
    Buy: 'The analysis leans strongly towards adding.',
    Overweight: 'The analysis leans towards adding a little.',
    Hold: 'The analysis sees no reason to change anything.',
    Underweight: 'The analysis leans towards reducing.',
    Sell: 'The analysis leans strongly towards getting out.',
    REVIEW: 'The model did not produce a readable rating.',
  };

  function positionFacts({ ticker, position, price, weight, cash }) {
    const facts = [];
    if (position) {
      let t = `You hold ${units(position.quantity)} units of ${ticker}`;
      if (isNum(position.averagePrice)) t += ` at an average cost of ${money(position.averagePrice)}`;
      facts.push(t + '.');
      if (isNum(price) && isNum(position.averagePrice) && position.averagePrice > 0) {
        const r = price / position.averagePrice - 1;
        const abs = (price - position.averagePrice) * position.quantity;
        facts.push(`At ${money(price)} that is ${r >= 0 ? 'a gain' : 'a loss'} of ${money(Math.abs(abs))} (${r >= 0 ? '+' : '−'}${(Math.abs(r) * 100).toFixed(1)}%) on paper.`);
      }
      if (isNum(weight)) facts.push(`It is about ${pct0(weight)} of the portfolio you entered.`);
    } else {
      facts.push(`You hold no ${ticker} in the holdings you entered.`);
    }
    if (isNum(cash)) facts.push(`Cash entered: ${money(cash)}.`);
    return facts;
  }

  // input: { ticker, rating, position|null, price, cash, weight, haveHoldings, watchFor: [strings] }
  function decide(input) {
    const { ticker, rating, position = null, price = null, cash = null, weight = null, watchFor = [] } = input;
    const held = !!(position && position.quantity > 0);
    const facts = positionFacts({ ticker, position: held ? position : null, price, weight, cash });
    const cautions = [];
    const lean = LEAN[rating] || LEAN.REVIEW;
    let label; let question; let options; let tone;

    if (rating === 'Buy' || rating === 'Overweight') {
      const strong = rating === 'Buy';
      tone = 'up';
      if (held) {
        label = strong ? 'Add' : 'Add a little';
        question = `Add to your ${ticker} position, or leave it as it is?`;
        options = [
          { label: strong ? 'Add' : 'Add a little', detail: 'Buy more. How much is your call; the analysis does not size a trade.' },
          { label: 'Leave it', detail: 'Keep what you hold and change nothing.' },
        ];
        if (isNum(weight) && weight >= CONCENTRATED) cautions.push(`${ticker} is already about ${pct0(weight)} of your portfolio. Adding raises how much one stock matters to you.`);
      } else {
        label = strong ? 'Open a position' : 'Consider a small position';
        question = `Open a position in ${ticker}, or stay out?`;
        options = [
          { label: strong ? 'Open a position' : 'Open a small position', detail: 'Buy some. How much is your call; the analysis does not size a trade.' },
          { label: 'Stay out', detail: 'Do nothing. A missed rise costs you nothing you have today.' },
        ];
        if (isNum(cash) && cash <= 0) cautions.push('The cash you entered is zero, so a purchase would need money from somewhere else.');
      }
    } else if (rating === 'Hold') {
      tone = 'flat';
      if (held) {
        label = 'Keep holding';
        question = `Keep your ${ticker} as it is?`;
        options = [
          { label: 'Keep holding', detail: 'Change nothing now.' },
          { label: 'Act anyway', detail: 'If you have your own reason to add or trim, the analysis does not oppose it or support it.' },
        ];
      } else {
        label = 'No action';
        question = `Nothing is asked of you for ${ticker}.`;
        options = [{ label: 'No action', detail: 'The analysis does not favour opening a position.' }];
      }
    } else if (rating === 'Underweight' || rating === 'Sell') {
      const strong = rating === 'Sell';
      tone = 'down';
      if (held) {
        label = strong ? 'Exit' : 'Trim';
        question = strong ? `Sell your ${ticker}, or keep it despite the analysis?` : `Trim your ${ticker}, or keep it as it is?`;
        options = [
          { label: strong ? 'Sell all' : 'Trim', detail: strong ? 'Close the position.' : 'Sell part of it. How much is your call.' },
          { label: 'Keep it', detail: 'Hold on despite the analysis. Be able to say why.' },
        ];
        if (isNum(price) && isNum(position.averagePrice) && price > position.averagePrice) cautions.push(TAX);
        else cautions.push('If this sale is at a loss, tax rules differ by country and account. Check before you act.');
        if (isNum(weight) && weight >= CONCENTRATED) cautions.push(`${ticker} is about ${pct0(weight)} of your portfolio, so this choice moves your overall risk a lot.`);
      } else {
        label = 'Do not touch';
        question = `Stay away from ${ticker}?`;
        options = [{ label: 'Stay away', detail: 'You hold none, and the analysis argues against opening a position now.' }];
      }
    } else {
      tone = 'review';
      label = 'Read it yourself';
      question = `The model gave no readable rating for ${ticker}.`;
      options = [{ label: 'Read the reports', detail: 'Do not treat this as a Hold. Read the text and decide on your own judgement.' }];
    }

    return {
      ticker, rating, label, question, tone, lean, options, facts, cautions,
      watchFor: (watchFor || []).filter(Boolean).slice(0, 3),
      disclaimer: DISCLAIMER,
    };
  }

  return { decide, DISCLAIMER, TAX, CONCENTRATED, LEAN };
});
